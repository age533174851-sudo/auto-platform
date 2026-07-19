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
    plan = planPosition(v.signal!, ctx.config, ctx.currentOpenRisk);

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

  // TESTNET/LIVE: 큐에 적재 (여기서 주문하지 않는다 — 워커가 처리)
  let jobId: string | undefined;
  if (sb && raw?.connectionId) {
    try {
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
