// /api/webhook/signal
// 표준 신호 수신 엔드포인트 (Signal Gateway).
//
// 설계 원칙:
//  1. 신호는 "무엇을 할지"만 담는다. 주문 금액·레버리지는 절대 받지 않는다(백엔드가 결정).
//  2. 받은 즉시 기록 + 큐에 넣고 202로 빠르게 응답한다 (TradingView는 3초 초과 시 취소).
//  3. signalId 기준 멱등 — 같은 신호가 두 번 와도 주문은 한 번만.
//  4. 페이로드에 거래소 키가 들어오면 저장 전에 제거한다.
//
// TradingView 알림 메시지 예시:
// {
//   "webhookToken": "<TRADINGVIEW_WEBHOOK_SECRET>",
//   "signalId": "{{ticker}}-{{interval}}-{{timenow}}-LONG",
//   "strategyId": "BTC_SCALP_V1",
//   "symbol": "{{ticker}}",
//   "signal": "LONG",
//   "confidence": 0.8,
//   "entryPrice": {{close}},
//   "stopLoss": 64350,
//   "takeProfit": 66300,
//   "timeframe": "{{interval}}"
// }
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { validateSignal } from '@/lib/engine/signalGateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOKEN = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '';

// 타이밍 공격 방지 비교
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

// 저장 전 민감정보 제거
const SENSITIVE = ['webhookToken', 'token', 'secret', 'apiKey', 'api_key', 'apiSecret', 'api_secret', 'password', 'key'];
function scrub(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const out: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.some(s => k.toLowerCase() === s.toLowerCase())) { out[k] = '[REDACTED]'; continue; }
    out[k] = typeof v === 'object' ? scrub(v) : v;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();

  // ── 1) 파싱 (TradingView가 text/plain으로 보내는 경우도 처리) ──
  let raw: any;
  try {
    const text = await req.text();
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON 파싱 실패' }, { status: 400 });
  }

  // ── 2) 토큰 인증 ──
  if (!TOKEN) {
    return NextResponse.json({ ok: false, error: '서버에 TRADINGVIEW_WEBHOOK_SECRET이 설정되지 않았습니다' }, { status: 500 });
  }
  const provided = raw?.webhookToken || req.headers.get('x-webhook-token') || '';
  if (!safeEqual(String(provided), TOKEN)) {
    return NextResponse.json({ ok: false, error: '인증 실패' }, { status: 401 });
  }

  // ── 3) 표준 신호 검증 ──
  const v = validateSignal(raw);
  const signalId: string = String(raw?.signalId || '').trim()
    || `${raw?.strategyId || 'unknown'}-${raw?.symbol || '?'}-${raw?.signal || '?'}-${Math.floor(Date.now() / 1000)}`;

  // Supabase는 선택적 — 없어도 202는 돌려준다(TradingView 재시도 폭주 방지)
  let sb: any = null;
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    sb = getSupabaseAdmin();
  } catch { /* DB 없이도 계속 */ }

  const baseRow = {
    signal_id: signalId,
    user_id: raw?.userId || null,
    strategy_id: raw?.strategyId || 'unknown',
    symbol: raw?.symbol || '?',
    signal: raw?.signal || '?',
    bucket: v.signal?.bucket || null,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    entry_price: typeof raw?.entryPrice === 'number' ? raw.entryPrice : null,
    stop_loss: typeof raw?.stopLoss === 'number' ? raw.stopLoss : null,
    take_profit: typeof raw?.takeProfit === 'number' ? raw.takeProfit : null,
    timeframe: raw?.timeframe || null,
    source: raw?.source || 'tradingview',
    warnings: v.warnings?.length ? v.warnings : null,
    raw_payload: scrub(raw),
    signal_ts: typeof raw?.timestamp === 'number'
      ? new Date(raw.timestamp > 1e12 ? raw.timestamp : raw.timestamp * 1000).toISOString()
      : receivedAt,
  };

  // 검증 실패 → 기록만 하고 400
  if (!v.valid) {
    if (sb) { try { await sb.from('signals').insert({ ...baseRow, status: 'rejected', reject_reason: v.errors.join('; ') }); } catch {} }
    return NextResponse.json({ ok: false, error: '신호 검증 실패', errors: v.errors, warnings: v.warnings }, { status: 400 });
  }

  // ── 4) 멱등: signal_id UNIQUE 제약으로 원자적 중복 차단 ──
  let duplicate = false;
  let inserted: any = null;
  if (sb) {
    const { data, error } = await sb.from('signals').insert({ ...baseRow, status: 'received' }).select('id').single();
    if (error) {
      // UNIQUE 위반 = 이미 처리한 신호
      if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message || '')) {
        duplicate = true;
      } else {
        // DB 오류라도 202로 응답 (TradingView 재시도 폭주 방지). 로그만 남긴다.
        try { const { log } = await import('@/lib/log/logger'); log.error('signal-webhook', `DB 기록 실패: ${error.message}`); } catch {}
      }
    } else {
      inserted = data;
    }
  }

  if (duplicate) {
    return NextResponse.json({ accepted: true, duplicate: true, signalId, message: '이미 처리된 신호' }, { status: 202 });
  }

  // ── 5) Risk Manager: 포지션 계획 산출 (주문은 하지 않는다) ──
  let plan: any = null;
  try {
    const { buildRiskContext } = await import('@/lib/engine/riskContext');
    const { planPosition } = await import('@/lib/engine/riskManager');
    const ctx = await buildRiskContext(sb, {
      userId: raw?.userId || null,
      connectionId: raw?.connectionId || null,
      mode: raw?.mode || 'TESTNET',
    });

    // ── Risk Veto 게이트 ──
    // 외부 신호도 반드시 Veto를 통과해야 한다.
    // 이 관문이 없으면 웹훅이 FOMC 직전 고배율 주문의 우회로가 된다.
    const { applyVetoToSignal } = await import('@/lib/engine/tradingPipeline');
    const vetoGate = await applyVetoToSignal(sb, {
      side: v.signal!.signal === 'SHORT' ? 'SHORT' : 'LONG',
      symbol: v.signal!.symbol,
      leverage: ctx.config.maxLeverage,
      dailyHighs: Array.isArray(raw?.dailyHighs) ? raw.dailyHighs : undefined,
      dailyLows: Array.isArray(raw?.dailyLows) ? raw.dailyLows : undefined,
      dailyCloses: Array.isArray(raw?.dailyCloses) ? raw.dailyCloses : undefined,
      fundingRate: typeof raw?.fundingRate === 'number' ? raw.fundingRate : undefined,
      consecutiveLosses: ctx.consecutiveLosses,
      dataAgeMinutes: typeof raw?.timestamp === 'number'
        ? (Date.now() - (raw.timestamp > 1e12 ? raw.timestamp : raw.timestamp * 1000)) / 60000
        : undefined,
    });

    if (!vetoGate.allowed) {
      // Veto에 걸린 신호는 계획 자체를 만들지 않는다
      if (sb) {
        try {
          await sb.from('position_plans').insert({
            signal_id: signalId, user_id: raw?.userId || null,
            strategy_id: v.signal!.strategyId, symbol: v.signal!.symbol,
            side: v.signal!.signal === 'SHORT' ? 'SHORT' : 'LONG',
            bucket: v.signal!.bucket, approved: false,
            reject_code: 'RISK_VETO', reject_reason: vetoGate.reason,
            account_equity: ctx.config.accountEquity,
            notes: vetoGate.veto.hits.map(h => `${h.label}: ${h.reason}`),
          });
        } catch {}
        if (inserted?.id) {
          try { await sb.from('signals').update({ status: 'rejected', reject_reason: vetoGate.reason }).eq('id', inserted.id); } catch {}
        }
      }
      return NextResponse.json({
        accepted: true, signalId, approved: false,
        rejectCode: 'RISK_VETO', rejectReason: vetoGate.reason,
        vetoDetails: {
          blockedBy: vetoGate.blockedBy,
          hits: vetoGate.veto.hits.map(h => ({ code: h.code, label: h.label, reason: h.reason })),
          calendar: vetoGate.calendar,
          volatility: { available: vetoGate.volatility.available, note: vetoGate.volatility.note },
        },
        message: '신호는 접수했지만 위험 규칙에 의해 주문하지 않습니다',
      }, { status: 202 });
    }

    // ── Expansion Mode 게이트 ──
    // 웹훅은 TradingView가 보낸 페이로드에 일봉이 실려 있을 때만 평가할 수 있다.
    // 평가하지 못하면 result가 null이고, Risk Manager가 일반 모드 상한으로
    // 제한한다(fail-closed). 즉 데이터를 안 보내면 고배율이 나갈 수 없다.
    const { buildExpansionGate } = await import('@/lib/strategies/expansionMode');
    const expansionGate = buildExpansionGate({
      dailyHighs: Array.isArray(raw?.dailyHighs) ? raw.dailyHighs : undefined,
      dailyLows: Array.isArray(raw?.dailyLows) ? raw.dailyLows : undefined,
      dailyCloses: Array.isArray(raw?.dailyCloses) ? raw.dailyCloses : undefined,
      currentVolume: typeof raw?.currentVolume === 'number' ? raw.currentVolume : undefined,
      avgVolume: typeof raw?.avgVolume === 'number' ? raw.avgVolume : undefined,
      fundingRate: typeof raw?.fundingRate === 'number' ? raw.fundingRate : undefined,
      oiChangePct: typeof raw?.oiChangePct === 'number' ? raw.oiChangePct : undefined,
    }, {
      userMaxLeverage: ctx.config.maxLeverage,
      normalMaxLeverage: ctx.config.normalMaxLeverage,
    });

    plan = planPosition(
      v.signal!,
      { ...ctx.config, expansion: expansionGate.result },
      ctx.currentOpenRisk,
    );

    if (sb) {
      try {
        await sb.from('position_plans').insert({
          signal_id: signalId,
          user_id: raw?.userId || null,
          strategy_id: v.signal!.strategyId,
          symbol: plan.symbol, side: plan.side, bucket: v.signal!.bucket,
          approved: plan.approved,
          reject_code: plan.rejectCode || null,
          reject_reason: plan.rejectReason || null,
          account_equity: ctx.config.accountEquity,
          risk_amount: plan.riskAmount,
          stop_distance_pct: plan.stopDistancePct,
          effective_stop_pct: plan.effectiveStopPct,
          position_size: plan.positionSize,
          quantity: plan.quantity,
          required_margin: plan.requiredMargin,
          leverage: plan.leverage,
          liquidation_price: plan.liquidationPrice,
          liquidation_dist_pct: plan.liquidationDistancePct,
          notes: plan.notes?.length ? plan.notes : null,
        });
      } catch { /* 기록 실패해도 응답은 계속 */ }

      if (inserted?.id) {
        try {
          await sb.from('signals').update({
            status: plan.approved ? 'planned' : 'rejected',
            reject_reason: plan.approved ? null : plan.rejectReason,
          }).eq('id', inserted.id);
        } catch {}
      }
    }
  } catch (e: any) {
    try { const { log } = await import('@/lib/log/logger'); log.error('signal-webhook', `위험 계산 실패: ${e?.message || e}`); } catch {}
  }

  // Risk Manager가 거부하면 큐에 넣지 않는다 (주문 권한의 마지막 문)
  if (plan && !plan.approved) {
    return NextResponse.json({
      accepted: true, signalId, approved: false,
      rejectCode: plan.rejectCode, rejectReason: plan.rejectReason,
      message: '신호는 접수했지만 위험 규칙에 의해 주문하지 않습니다',
    }, { status: 202 });
  }

  // ── 6) 가상 체결 (PAPER 모드) 또는 큐 적재 ──
  const mode = String(raw?.mode || 'PAPER').toUpperCase();

  // PAPER: 실주문 없이 즉시 체결시켜 손익을 추적한다
  if (mode === 'PAPER' && plan?.approved && sb) {
    const userId = raw?.userId || 'paper-default';
    try {
      const { openPaperPosition, closeOpposingPositions } = await import('@/lib/engine/paperStore');

      // 반대 방향 포지션이 있으면 먼저 청산 (REVERSE)
      let reversed = 0;
      try {
        reversed = await closeOpposingPositions(sb, userId, v.signal!.symbol, plan.side, v.signal!.entryPrice);
      } catch {}

      const r = await openPaperPosition(sb, {
        userId,
        signalId,
        strategyId: v.signal!.strategyId,
        bucket: v.signal!.bucket,
        plan,
        entryPrice: v.signal!.entryPrice,
        stopLoss: v.signal!.stopLoss,
        takeProfit: v.signal!.takeProfit,
      });

      if (inserted?.id) {
        try { await sb.from('signals').update({ status: r.ok ? 'executed' : 'failed' }).eq('id', inserted.id); } catch {}
      }

      return NextResponse.json({
        accepted: true, signalId, approved: true, mode: 'PAPER',
        executed: r.ok,
        duplicate: r.duplicate || undefined,
        positionId: r.positionId,
        reversedPositions: reversed || undefined,
        fill: r.fill ? {
          side: r.fill.side,
          fillPrice: Number(r.fill.fillPrice.toFixed(2)),
          quantity: Number(r.fill.quantity.toFixed(8)),
          notional: Number(r.fill.notional.toFixed(2)),
          leverage: r.fill.leverage,
          margin: Number(r.fill.margin.toFixed(2)),
          entryFee: Number(r.fill.entryFee.toFixed(4)),
          liquidationPrice: Number(r.fill.liquidationPrice.toFixed(2)),
        } : undefined,
        error: r.error,
      }, { status: 202 });
    } catch (e: any) {
      try { const { log } = await import('@/lib/log/logger'); log.error('signal-webhook', `가상 체결 실패: ${e?.message || e}`); } catch {}
      return NextResponse.json({ accepted: true, signalId, approved: true, mode: 'PAPER', executed: false, error: e?.message || '가상 체결 실패' }, { status: 202 });
    }
  }

  // TESTNET/LIVE: 실제 거래소 주문
  if ((mode === 'TESTNET' || mode === 'LIVE') && plan?.approved && sb && raw?.connectionId) {
    // 실거래는 명시적 환경변수로 잠금 해제해야 함 (실수 방지)
    if (mode === 'LIVE' && process.env.ALLOW_LIVE_TRADING !== 'true') {
      return NextResponse.json({
        accepted: true, signalId, approved: true, mode, executed: false,
        error: '실거래가 잠겨 있습니다. ALLOW_LIVE_TRADING=true 설정 후 사용하세요',
      }, { status: 202 });
    }

    try {
      // 소유권 검사 — connectionId와 userId 모두 페이로드에서 오고, sb는
      // service-role이라 RLS가 적용되지 않는다. 검사가 없으면 웹훅 시크릿을
      // 아는 사람이 임의의 connectionId를 지정해 남의 API 키로 주문할 수 있다.
      if (!raw?.userId) {
        throw new Error('userId가 없어 연결 소유권을 확인할 수 없습니다');
      }

      const { data: conn } = await sb.from('exchange_connections')
        .select('exchange, api_key, api_secret_enc, encrypted_secret, has_withdrawal, user_id')
        .eq('id', raw.connectionId)
        .eq('user_id', raw.userId)
        .maybeSingle();

      if (!conn) throw new Error('거래소 연결을 찾을 수 없거나 해당 사용자의 연결이 아닙니다');
      if (conn.has_withdrawal) throw new Error('출금 권한이 있는 키는 자동매매에 사용할 수 없습니다');

      const { decryptSecret } = await import('@/lib/exchanges/crypto');
      const { executeOrder } = await import('@/lib/engine/orderExecutor');

      const exchange = String(conn.exchange || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
      const clientOrderId = `TG${signalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}`;

      const r = await executeOrder(sb, {
        userId: raw.userId || null,
        connectionId: raw.connectionId,
        signalId, clientOrderId,
        exchange: exchange as 'binance' | 'gate',
        mode: mode as 'TESTNET' | 'LIVE',
        plan,
        stopLoss: v.signal!.stopLoss,
        takeProfit: v.signal!.takeProfit,
        apiKey: conn.api_key,
        apiSecret: decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? ''),
      });

      if (inserted?.id) {
        try { await sb.from('signals').update({ status: r.ok ? 'executed' : 'failed' }).eq('id', inserted.id); } catch {}
      }

      return NextResponse.json({
        accepted: true, signalId, approved: true, mode,
        executed: r.ok, status: r.status,
        duplicate: r.duplicate || undefined,
        clientOrderId: r.clientOrderId,
        exchangeOrderId: r.exchangeOrderId,
        filledQty: r.filledQty, avgPrice: r.avgPrice,
        slOrderId: r.slOrderId, tpOrderId: r.tpOrderId,
        message: r.message,
      }, { status: 202 });
    } catch (e: any) {
      try { const { log } = await import('@/lib/log/logger'); log.error('signal-webhook', `주문 실패: ${e?.message || e}`); } catch {}
      return NextResponse.json({
        accepted: true, signalId, approved: true, mode, executed: false,
        error: e?.message || '주문 실패',
      }, { status: 202 });
    }
  }

  // 그 외: 큐에 적재 (워커가 처리)
  let jobId: string | undefined;
  if (sb && raw?.connectionId) {
    try {
      // 실행자가 없으면 적재하지 않는다 (queueGuard 주석 참조).
      const { checkExecutorBeforeQueue, executorUnavailableBody } =
        await import('@/lib/jobs/queueGuard');
      const executor = await checkExecutorBeforeQueue(sb);
      if (!executor.canQueue) {
        return NextResponse.json(executorUnavailableBody(executor),
          { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }

      const { enqueueJob } = await import('@/lib/jobs');
      const q = await enqueueJob(sb, {
        userId: raw.userId || 'system',
        connectionId: raw.connectionId,
        action: 'PLACE_ORDER',
        exchange: raw.exchange || undefined,
        mode: raw.mode || 'TESTNET',
        symbol: v.signal!.symbol,
        side: v.signal!.signal === 'SHORT' ? 'sell' : 'buy',
        payload: {
          kind: 'standard_signal',
          signalId,
          signal: v.signal,          // 표준 신호 원본 (금액·레버리지 없음)
          clientOrderId: `TRAIGO-${signalId}`.slice(0, 36),
          // 워커가 늦게 집어도 오래된 신호는 실행하지 않는다
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      });
      if (q.ok) jobId = q.jobId;
      if (jobId && inserted?.id) {
        try { await sb.from('signals').update({ status: 'queued', job_id: jobId }).eq('id', inserted.id); } catch {}
      }
    } catch (e: any) {
      try { const { log } = await import('@/lib/log/logger'); log.error('signal-webhook', `큐 적재 실패: ${e?.message || e}`); } catch {}
    }
  }

  // ── 6) 즉시 202 ──
  return NextResponse.json({
    accepted: true,
    signalId,
    bucket: v.signal!.bucket,
    queued: !!jobId,
    jobId,
    warnings: v.warnings?.length ? v.warnings : undefined,
    note: raw?.connectionId ? undefined : 'connectionId가 없어 기록만 하고 큐에 넣지 않았습니다',
  }, { status: 202 });
}

// 연결 확인용
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/webhook/signal',
    method: 'POST',
    tokenConfigured: !!TOKEN,
    expects: {
      webhookToken: '<TRADINGVIEW_WEBHOOK_SECRET>',
      signalId: '고유 ID (멱등 키)',
      strategyId: 'string', symbol: 'string',
      signal: 'LONG | SHORT | CLOSE',
      confidence: '0~1', entryPrice: 'number', stopLoss: 'number',
      takeProfit: 'number (선택)', timeframe: 'string',
    },
    rejects: ['amount', 'quantity', 'leverage — 주문 크기는 백엔드가 결정합니다'],
  });
}
