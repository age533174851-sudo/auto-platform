// src/lib/engine/riskContext.ts
// Risk Manager에 넘길 실계좌 상태를 모은다.
// 계좌 자산 / 가용 증거금 / 오늘 손익 / 사용자 한도 / 현재 열린 위험.
// 조회 실패 시에도 안전한 기본값으로 폴백하되, 그 사실을 notes에 남긴다.
import type { RiskConfig } from './riskManager';

export interface RiskContext {
  config: RiskConfig;
  currentOpenRisk: number;    // 현재 열린 포지션들의 합산 위험액 ($)
  source: 'exchange' | 'fallback';
  warnings: string[];
}

// 한도 기본값 — 사용자가 risk_limits에 설정하지 않았을 때
const DEFAULTS = {
  maxLeverage: 5,
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
  opts: { userId?: string | null; connectionId?: string | null; mode?: string }
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

  // ── 2) 실계좌 잔고 (연결이 있을 때만) ──
  if (sb && opts.connectionId) {
    try {
      const testnet = String(opts.mode || 'TESTNET').toUpperCase() !== 'LIVE';
      const { data: conn } = await sb
        .from('exchange_connections')
        .select('exchange, api_key_enc, api_secret_enc, has_withdrawal')
        .eq('id', opts.connectionId)
        .maybeSingle();

      if (conn?.has_withdrawal) {
        warnings.push('출금 권한 키는 자동매매에 사용할 수 없습니다');
      } else if (conn) {
        const { decryptSecret } = await import('@/lib/exchanges/crypto');
        const key = decryptSecret(conn.api_key_enc);
        const secret = decryptSecret(conn.api_secret_enc);
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
    source,
    warnings,
  };
}
