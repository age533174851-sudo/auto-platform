// ─────────────────────────────────────────────────────────────
// TRAIGO Slippage Engine
// Estimates market order slippage based on volume and trade size
// ─────────────────────────────────────────────────────────────

export interface SlippageParams {
  orderSize:    number;   // in USD / KRW
  dailyVolume:  number;   // asset's 24h volume in same currency
  marketCap?:   number;   // optional
  assetType:    'major'|'mid'|'small'|'micro';
  exchange:     string;
}

export interface SlippageResult {
  rate:         number;   // slippage as decimal (e.g. 0.001 = 0.1%)
  amount:       number;   // slippage in currency
  warning:      string|null;
  riskLevel:    'low'|'medium'|'high'|'critical';
}

// ── Base slippage by asset type ───────────────────────────────
const BASE_SLIP: Record<string, number> = {
  major:  0.0002,   // BTC, ETH: 0.02%
  mid:    0.0005,   // SOL, BNB, XRP: 0.05%
  small:  0.002,    // smaller alts: 0.2%
  micro:  0.01,     // micro caps: 1%+
};

// ── Volume-size impact multiplier ─────────────────────────────
function volumeImpact(orderSize: number, dailyVolume: number): number {
  if (dailyVolume <= 0) return 5;
  const ratio = orderSize / dailyVolume;
  // Square-root model (standard market impact)
  return 1 + Math.sqrt(ratio) * 100;
}

// ── Classify asset by volume ──────────────────────────────────
export function classifyAsset(dailyVolume: number): 'major'|'mid'|'small'|'micro' {
  if (dailyVolume > 1_000_000_000) return 'major';   // >$1B
  if (dailyVolume > 100_000_000)   return 'mid';
  if (dailyVolume > 10_000_000)    return 'small';
  return 'micro';
}

// ── Main slippage calc ────────────────────────────────────────
export function calcSlippage(p: SlippageParams): SlippageResult {
  const type      = p.assetType || classifyAsset(p.dailyVolume);
  const baseRate  = BASE_SLIP[type];
  const impact    = volumeImpact(p.orderSize, p.dailyVolume);
  const rate      = Math.min(baseRate * impact, 0.05); // cap at 5%
  const amount    = p.orderSize * rate;

  let warning: string|null = null;
  let riskLevel: 'low'|'medium'|'high'|'critical' = 'low';

  if (rate > 0.02) {
    warning   = '⚠️ 슬리피지 위험 매우 높음 — 지정가 주문 강력 권장';
    riskLevel = 'critical';
  } else if (rate > 0.005) {
    warning   = '⚠️ 슬리피지 높음 — 지정가 주문 권장';
    riskLevel = 'high';
  } else if (rate > 0.001) {
    warning   = '주의: 슬리피지 발생 가능';
    riskLevel = 'medium';
  }

  return { rate, amount, warning, riskLevel };
}

// ── Order size safety check ───────────────────────────────────
export function checkOrderSafety(orderSize: number, dailyVolume: number): {
  safeMaxSize: number;
  pctOfVolume: number;
  isSafe: boolean;
  recommendation: string;
} {
  const pctOfVolume = dailyVolume > 0 ? (orderSize / dailyVolume) * 100 : 999;
  const safeMaxSize = dailyVolume * 0.001; // 0.1% of daily volume
  const isSafe = pctOfVolume < 0.1;
  return {
    safeMaxSize,
    pctOfVolume,
    isSafe,
    recommendation: isSafe
      ? '안전한 주문 크기'
      : `일일 거래량의 ${pctOfVolume.toFixed(2)}% — 분할 매수 권장`,
  };
}

// ── Format ───────────────────────────────────────────────────
export function fmtSlippage(rate: number): string {
  return (rate * 100).toFixed(3) + '%';
}
