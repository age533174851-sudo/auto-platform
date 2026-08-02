// src/lib/engine/riskContext.ts
// Risk Manager에 넘길 실계좌 상태를 모은다.
// 계좌 자산 / 가용 증거금 / 오늘 손익 / 사용자 한도 / 현재 열린 위험.
// 조회 실패 시에도 안전한 기본값으로 폴백하되, 그 사실을 notes에 남긴다.
import type { RiskConfig } from './riskManager';

export interface RiskContext {
  config: RiskConfig;
  currentOpenRisk: number;
  consecutiveLosses: number;   // Veto의 CONSECUTIVE_LOSSES 판정용    // 현재 열린 포지션들의 합산 위험액 ($)
  source: 'exchange' | 'fallback';
  warnings: string[];
}

// 한도 기본값 — 사용자가 risk_limits에 설정하지 않았을 때
//
// maxLeverage는 "절대 상한"이지 "적용 배율"이 아니다. 실제 배율은 이 값이
// 아니라 아래 세 단계가 순서대로 깎아서 정한다:
//   1) Expansion Mode — 시장 조건 점수와 과거 MAE로 상한을 낮춘다.
//      평가 근거(일봉·거래량 등)가 없으면 일반 모드 상한(기본 10배)까지만.
//   2) Risk Manager — 허용 손실액 ÷ 손절 거리로 포지션 크기를 정하고
//      거기서 배율을 역산한다. 배율은 입력이 아니라 결과다.
//   3) 청산 거리가 손절 거리의 1.3배 이하면 주문 자체를 거부한다.
//
// 이 값이 5였을 때는 Expansion이 43배를 허용해도 min(5, 43)=5가 되어
// Expansion Mode가 아무 역할도 하지 못했다. 상한을 열어 두고 위 세 단계가
// 실제 제한을 담당하게 한다.
const DEFAULTS = {
  maxLeverage: 100,
  riskPerTradePct: undefined as number | undefined,  // undefined면 전략군 기본 사용
  maxAccountRiskPct: 5,
  maxDailyLossPct: 3,
  maxNotionalPct: 300,
  feeRatePct: 0.1,
  slippagePct: 0.05,
};

// 계좌 조회 실패 시 쓰는 보수적 기본 자산 (실주문 전 단계이므로 시뮬 값)
const FALLBACK_EQUITY = 10000;

export async function buildRiskContext(
  sb: any,
  opts: {
    userId?: string | null; connectionId?: string | null; mode?: string;
    /**
     * 이 실행에만 적용하는 상한. 자동매매 예약 줄(`autotrade_schedules`)의
     * `leverage_cap`이 여기로 들어온다.
     *
     * **없으면(null/undefined) 안 건드린다** — 0으로 읽으면 배율 상한이 0이
     * 되어 주문이 통째로 막힌다. '정하지 않음'과 '0으로 정함'은 다르다.
     */
    leverageCap?: number | null;
    /** 1회 위험 비율(%). 예약 줄의 `risk_pct`. */
    riskPct?: number | null;
  }
): Promise<RiskContext> {
  const warnings: string[] = [];
  let accountEquity = FALLBACK_EQUITY;
  let availableMargin: number | undefined;
  let source: RiskContext['source'] = 'fallback';

  // ── 1) 사용자 한도 ──
  let limits = { ...DEFAULTS };
  if (sb && opts.userId) {
    try {
      const { data } = await sb.from('risk_limits').select('*').eq('user_id', opts.userId).maybeSingle();
      if (data) {
        limits = {
          maxLeverage: Number(data.max_leverage) || DEFAULTS.maxLeverage,
          riskPerTradePct: data.risk_per_trade_pct != null ? Number(data.risk_per_trade_pct) : undefined,
          maxAccountRiskPct: Number(data.max_account_risk_pct) || DEFAULTS.maxAccountRiskPct,
          maxDailyLossPct: Number(data.max_daily_loss_pct) || DEFAULTS.maxDailyLossPct,
          maxNotionalPct: Number(data.max_notional_pct) || DEFAULTS.maxNotionalPct,
          feeRatePct: data.fee_rate_pct != null ? Number(data.fee_rate_pct) : DEFAULTS.feeRatePct,
          slippagePct: data.slippage_pct != null ? Number(data.slippage_pct) : DEFAULTS.slippagePct,
        };
      } else {
        warnings.push('사용자 위험 한도 미설정 — 기본값 사용 (최대 5배, 일일 -3%)');
      }
    } catch {
      warnings.push('위험 한도 조회 실패 — 기본값 사용');
    }
  } else {
    warnings.push('사용자 미지정 — 기본 한도 사용');
  }

  // ── 1.5) 이 실행에만 적용하는 값 ──
  //
  // 화면(자동매매 카드)에서 '배율 상한'·'1회 위험'을 입력받아 예약 줄에
  // 저장한다. **그 값을 여기서 읽지 않으면 화면이 거짓말을 한다** — 100을
  // 넣고 저장까지 됐는데 엔진은 기본값으로 돈다. 실제로 그 상태였다.
  //
  // 못 읽는 값은 무시한다. NaN·0·음수를 그대로 넣으면 상한 0(주문 전면
  // 차단) 또는 위험 0%(수량 0)가 된다. 모르는 것을 유리하게도, 불리하게도
  // 읽지 않는다 — 안 건드리는 것이 맞다.
  const capIn = opts.leverageCap;
  if (capIn != null) {
    const cap = Number(capIn);
    if (Number.isFinite(cap) && cap >= 1 && cap <= 125) {
      limits.maxLeverage = cap;
      // 상한이지 적용 배율이 아니다. 실제 배율은 손절 거리에서 역산되고
      // 이 값에서 잘린다 — 화면에도 같은 말이 적혀 있다.
      warnings.push(`예약 설정의 배율 상한 ${cap}배 적용 (실제 배율은 손절 거리에서 역산)`);
    } else {
      warnings.push(`예약 설정의 배율 상한(${capIn})을 쓰지 못했습니다 — 1~125 범위가 아닙니다. 기본 상한 ${limits.maxLeverage}배로 돕니다`);
    }
  }
  const riskIn = opts.riskPct;
  if (riskIn != null) {
    const rp = Number(riskIn);
    if (Number.isFinite(rp) && rp > 0 && rp <= 100) {
      limits.riskPerTradePct = rp;
      warnings.push(`예약 설정의 1회 위험 ${rp}% 적용`);
    } else {
      warnings.push(`예약 설정의 1회 위험(${riskIn})을 쓰지 못했습니다 — 0 초과 100 이하가 아닙니다`);
    }
  }

  // ── 2) 실계좌 잔고 (연결이 있을 때만) ──
  if (sb && opts.connectionId) {
    try {
      const testnet = String(opts.mode || 'TESTNET').toUpperCase() !== 'LIVE';
      // 예전에는 여기서 `exchange`·`encrypted_secret` 칸을 골랐다. 둘 다
      // 존재하지 않는 칸이라 질의가 통째로 실패했고, error를 안 봤기 때문에
      // conn이 조용히 null이 됐다. 그래서 **연결이 멀쩡해도 잔고를 한 번도
      // 못 읽었고, 계좌 자산이 언제나 폴백 $10,000이었다** — 포지션 크기가
      // 전부 가짜 자산 기준으로 계산됐다는 뜻이다. 경고조차 없었다.
      const { loadConnection } = await import('../exchanges/connection');
      const { conn, error: connErr } = await loadConnection(sb, opts.connectionId, opts.userId);

      if (!conn) {
        warnings.push(`계좌 조회 불가 — ${connErr} (기본 자산 $${FALLBACK_EQUITY} 가정)`);
      } else {
        const key = conn.apiKey;
        const secret = conn.apiSecret;

        if (conn.exchange === 'binance') {
          const { getFuturesBalance } = await import('@/lib/exchanges/binanceFutures');
          const r: any = await getFuturesBalance(key, secret, testnet);
          const usdt = r?.balances?.find((b: any) => b.asset === 'USDT');
          if (usdt) {
            accountEquity = Number(usdt.balance) || FALLBACK_EQUITY;
            availableMargin = Number(usdt.availableBalance);
            source = 'exchange';
          } else {
            // 응답은 왔는데 USDT가 없다 — 잔고 0일 수도, 응답 모양이 다를
            // 수도 있다. 어느 쪽이든 $10,000으로 계산하면 안 된다.
            warnings.push(`잔고 응답에 USDT가 없습니다 — 기본 자산 $${FALLBACK_EQUITY} 가정 (${r?.error || '이유 미상'})`);
          }
        } else if (conn.exchange === 'gate') {
          const { getAccountGateFutures } = await import('@/lib/exchanges/gateFutures');
          const a: any = await getAccountGateFutures(key, secret, testnet);
          accountEquity = Number(a?.total) || FALLBACK_EQUITY;
          availableMargin = Number(a?.available);
          source = 'exchange';
        } else {
          warnings.push(`${conn.exchange} 연결로는 선물 잔고를 읽지 않습니다 — 기본 자산 $${FALLBACK_EQUITY} 가정`);
        }
      }
    } catch (e: any) {
      warnings.push(`계좌 조회 실패 — 기본 자산 $${FALLBACK_EQUITY} 가정 (${e?.message || e})`);
    }
  }

  // ── 3) 오늘 실현손익 (일일 손실 한도 판정용) ──
  //
  // **이 값이 틀리면 일일 손실 한도가 통째로 없는 것과 같다.**
  //
  // 여기는 원래 `orders` 표를 읽고 있었다. 그런 표는 없다 — 실주문은
  // `live_orders`, 청산 손익은 `daily_slot_uses`와 `paper_positions`에
  // 있다. supabase-js는 없는 표에 대해 던지지 않고 { data:null, error }를
  // 돌려주는데, 이 코드는 error를 안 봤다. 그래서 dailyPnl이 **언제나
  // 0**이었고, "오늘 -3% 넘으면 신규 진입 중단"이 한 번도 걸린 적이 없다.
  //
  // 0은 '오늘 안 잃었다'로 읽힌다. 못 읽은 것을 안 잃은 것으로 세면
  // 한도는 있는 척만 하는 장치가 된다.
  let dailyPnl = 0;
  // **못 읽었으면 0이 아니라 '모른다'다.** riskManager가 이 값을 보고
  // 한도를 평가할 수 있는지 없는지를 가른다.
  let dailyPnlKnown = false;
  if (sb && opts.userId) {
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const sinceIso = since.toISOString();
    const failed: string[] = [];
    let sum = 0;

    // 두 경로에서 온다. 실전·사다리는 슬롯 표, 모의는 모의 포지션 표.
    // 어느 한쪽이라도 못 읽으면 합계를 모르는 것이다 — 읽힌 쪽만 더해서
    // 아는 척하면 실제보다 손실이 작게 잡히고, 그건 한도를 느슨하게
    // 만드는 방향으로 틀린다.
    const sources: Array<{ table: string; column: string; timeCol: string }> = [
      { table: 'daily_slot_uses', column: 'realized_pnl', timeCol: 'closed_at' },
      { table: 'paper_positions', column: 'realized_pnl', timeCol: 'closed_at' },
    ];
    for (const s of sources) {
      try {
        const { data, error } = await sb
          .from(s.table)
          .select(s.column)
          .eq('user_id', opts.userId)
          .eq('status', 'closed')
          .gte(s.timeCol, sinceIso);
        if (error) { failed.push(`${s.table}: ${error.message}`); continue; }
        if (!Array.isArray(data)) { failed.push(`${s.table}: 응답이 배열이 아닙니다`); continue; }
        for (const r of data) {
          const v = Number((r as any)[s.column]);
          // 청산됐는데 손익이 비어 있으면 그 줄은 못 읽은 것이다.
          // 0으로 세면 손실 하나가 통째로 사라진다.
          if (!Number.isFinite(v)) { failed.push(`${s.table}: 손익이 비어 있는 줄이 있습니다`); break; }
          sum += v;
        }
      } catch (e: any) {
        failed.push(`${s.table}: ${e?.message || e}`);
      }
    }

    if (failed.length === 0) {
      dailyPnl = sum;
      dailyPnlKnown = true;
    } else {
      warnings.push(`오늘 실현손익을 확인하지 못했습니다 — 일일 손실 한도를 평가할 수 없습니다 (${failed.join(' / ')})`);
    }
  } else {
    warnings.push('사용자 미지정 — 오늘 실현손익을 확인할 수 없습니다');
  }

  // ── 4) 현재 열린 위험 (승인된 계획 중 아직 청산 안 된 것) ──
  let currentOpenRisk = 0;
  if (sb && opts.userId) {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data } = await sb
        .from('position_plans')
        .select('risk_amount')
        .eq('user_id', opts.userId)
        .eq('approved', true)
        .gte('created_at', since);
      if (Array.isArray(data)) {
        currentOpenRisk = data.reduce((a: number, r: any) => a + (Number(r.risk_amount) || 0), 0);
      }
    } catch { /* 없으면 0 */ }
  }

  // ── 연속 손실 (Veto 입력) ──
  let consecutiveLosses = 0;
  if (sb && opts.userId) {
    try {
      const { data } = await sb.from('paper_positions')
        .select('realized_pnl').eq('user_id', opts.userId).eq('status', 'closed')
        .order('closed_at', { ascending: false }).limit(20);
      if (Array.isArray(data)) {
        for (const r of data) {
          if (Number(r.realized_pnl) < 0) consecutiveLosses++;
          else break;
        }
      }
    } catch { /* 없으면 0 */ }
  }

  return {
    config: {
      accountEquity,
      availableMargin,
      dailyPnl,
      dailyPnlKnown,
      maxLeverage: limits.maxLeverage,
      riskPerTradePct: limits.riskPerTradePct,
      maxAccountRiskPct: limits.maxAccountRiskPct,
      maxDailyLossPct: limits.maxDailyLossPct,
      maxNotionalPct: limits.maxNotionalPct,
      feeRatePct: limits.feeRatePct,
      slippagePct: limits.slippagePct,
    },
    currentOpenRisk,
    consecutiveLosses,
    source,
    warnings,
  };
}
