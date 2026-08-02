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
      const { data: conn } = await sb
        .from('exchange_connections')
        .select('exchange, api_key, api_secret_enc, encrypted_secret, has_withdrawal')
        .eq('id', opts.connectionId)
        .maybeSingle();

      if (conn?.has_withdrawal) {
        warnings.push('출금 권한 키는 자동매매에 사용할 수 없습니다');
      } else if (conn) {
        const { decryptSecret } = await import('@/lib/exchanges/crypto');
        const key = conn.api_key;
        const secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
        const ex = String(conn.exchange || '').toLowerCase();

        if (ex.includes('binance')) {
          const { getFuturesBalance } = await import('@/lib/exchanges/binanceFutures');
          const r: any = await getFuturesBalance(key, secret, testnet);
          const usdt = r?.balances?.find((b: any) => b.asset === 'USDT');
          if (usdt) {
            accountEquity = Number(usdt.balance) || FALLBACK_EQUITY;
            availableMargin = Number(usdt.availableBalance);
            source = 'exchange';
          }
        } else if (ex.includes('gate')) {
          const { getAccountGateFutures } = await import('@/lib/exchanges/gateFutures');
          const a: any = await getAccountGateFutures(key, secret, testnet);
          accountEquity = Number(a?.total) || FALLBACK_EQUITY;
          availableMargin = Number(a?.available);
          source = 'exchange';
        }
      }
    } catch (e: any) {
      warnings.push(`계좌 조회 실패 — 기본 자산 $${FALLBACK_EQUITY} 가정 (${e?.message || e})`);
    }
  }

  // ── 3) 오늘 실현손익 (일일 손실 한도 판정용) ──
  let dailyPnl = 0;
  if (sb && opts.userId) {
    try {
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const { data } = await sb
        .from('orders')
        .select('realized_pnl')
        .eq('user_id', opts.userId)
        .gte('created_at', since.toISOString());
      if (Array.isArray(data)) {
        dailyPnl = data.reduce((a: number, r: any) => a + (Number(r.realized_pnl) || 0), 0);
      }
    } catch { /* orders 테이블 없으면 0 유지 */ }
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
