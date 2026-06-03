// src/lib/risk/regime.ts
// 시장 상태(레짐) 감지 — 상승/하락/횡보 × 변동성

export type TrendRegime = 'uptrend' | 'downtrend' | 'sideways';
export type VolRegime   = 'high_vol' | 'normal_vol' | 'low_vol';

export interface MarketRegime {
  trend: TrendRegime;
  volatility: VolRegime;
  label: string;
  trendScore: number;
  volPct: number;
  recommendation: string;
  allowEntry: boolean;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[values.length - period];
  for (let i = values.length - period + 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function atr(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 0;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += Math.abs(closes[i] - closes[i - 1]);
  return sum / period;
}

export function detectRegime(closes: number[]): MarketRegime {
  const price = closes[closes.length - 1] || 0;
  const ema20 = ema(closes, 20);
  const ema60 = ema(closes, 60);
  const atrVal = atr(closes, 14);
  const volPct = price > 0 ? (atrVal / price) * 100 : 0;

  let trend: TrendRegime = 'sideways';
  let trendScore = 0;
  if (ema20 != null && ema60 != null && price > 0) {
    const gap = ((ema20 - ema60) / ema60) * 100;
    const pricePos = ((price - ema60) / ema60) * 100;
    trendScore = Math.max(-100, Math.min(100, (gap * 8) + (pricePos * 2)));
    if (trendScore > 12) trend = 'uptrend';
    else if (trendScore < -12) trend = 'downtrend';
  }

  let volatility: VolRegime = 'normal_vol';
  if (volPct >= 4) volatility = 'high_vol';
  else if (volPct < 1.2) volatility = 'low_vol';

  const trendKr = trend === 'uptrend' ? '상승 추세' : trend === 'downtrend' ? '하락 추세' : '횡보';
  const volKr = volatility === 'high_vol' ? '고변동' : volatility === 'low_vol' ? '저변동' : '보통변동';
  const label = `${trendKr} · ${volKr}`;

  let recommendation = '', allowEntry = true;
  if (volatility === 'high_vol') { recommendation = '고변동 — 포지션 축소/관망 권장'; allowEntry = false; }
  else if (trend === 'downtrend') { recommendation = '하락 추세 — 롱 위험, 숏/관망'; allowEntry = false; }
  else if (trend === 'uptrend') { recommendation = '상승 추세 — 추세추종 유리'; allowEntry = true; }
  else { recommendation = '횡보 — 반전매매(RSI/볼밴) 유리'; allowEntry = true; }

  return { trend, volatility, label, trendScore: +trendScore.toFixed(1), volPct: +volPct.toFixed(2), recommendation, allowEntry };
}

export function regimeAllowsEntry(
  regime: MarketRegime, action: 'buy' | 'sell',
  marketFilter?: 'any' | 'trend_only' | 'range_only' | 'avoid_highvol',
): { allowed: boolean; reason: string } {
  if (regime.volatility === 'high_vol') return { allowed: false, reason: `고변동장 진입 차단 (변동성 ${regime.volPct}%)` };
  if (regime.trend === 'downtrend' && action === 'buy') return { allowed: false, reason: '하락 추세에서 롱 진입 차단' };
  if (regime.trend === 'uptrend' && action === 'sell') return { allowed: false, reason: '상승 추세에서 숏 진입 차단' };
  if (marketFilter === 'trend_only' && regime.trend === 'sideways') return { allowed: false, reason: '추세장 전용 — 횡보장 차단' };
  if (marketFilter === 'range_only' && regime.trend !== 'sideways') return { allowed: false, reason: '횡보장 전용 — 추세장 차단' };
  return { allowed: true, reason: `${regime.label} — 진입 허용` };
}
