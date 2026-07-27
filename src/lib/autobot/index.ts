/**
 * src/lib/autobot/index.ts
 * 핵심 자동매매 로직 모듈 (참고용 — 실제 거래는 별도 인프라 필요)
 *
 * 기반: 유튜브 "아빠가 삼남매에게" 채널의 매매 시스템 사양
 *  - 다단계 종목 필터링
 *  - 20/30일 눌림목 + 이격도 진입
 *  - ATR 기반 동적 손익절
 *  - 연속 확인 횟수(휩쏘 방어)
 *  - 매수 마진 컨트롤 (±0.5%)
 *  - 3분할 매수
 *  - 시간대 제어
 */

// ─────────────────────────────────────────────────────────────
// 1. 다단계 종목 필터링
// ─────────────────────────────────────────────────────────────
export interface FilterCriteria {
  market?:        'KOSPI' | 'KOSDAQ' | 'ALL';
  minMarketCap?:  number;     // 최소 시가총액 (원)
  maxMarketCap?:  number;     // 최대 시가총액 (원)
  minVolume?:     number;     // 최소 거래대금 (원)
  minPrice?:      number;
  maxPrice?:      number;
  // 재무건전성
  minRoe?:        number;     // 최소 ROE %
  minOpMargin?:   number;     // 최소 영업이익률 %
  maxDebtRatio?:  number;     // 최대 부채비율 %
  // 추세 (AND)
  ma5OverMa20?:   boolean;
  ma20OverMa60?:  boolean;
  rsiMin?:        number;
  rsiMax?:        number;
}

export interface CandidateAsset {
  symbol:       string;
  name:         string;
  market:       'KOSPI' | 'KOSDAQ';
  price:        number;
  marketCap:    number;
  volume:       number;
  roe?:         number;
  opMargin?:    number;
  debtRatio?:   number;
  ma5?:         number;
  ma20?:        number;
  ma60?:        number;
  rsi?:         number;
}

/** 다단계 필터 통과 종목 반환 */
export function filterCandidates(
  assets: CandidateAsset[],
  c: FilterCriteria,
): CandidateAsset[] {
  const safeAssets = Array.isArray(assets) ? assets : [];
  return safeAssets.filter(a => {
    // 1차: 시장/시총/거래대금/가격
    if (c.market && c.market !== 'ALL' && a.market !== c.market) return false;
    if (c.minMarketCap != null && a.marketCap < c.minMarketCap)  return false;
    if (c.maxMarketCap != null && a.marketCap > c.maxMarketCap)  return false;
    if (c.minVolume    != null && a.volume    < c.minVolume)     return false;
    if (c.minPrice     != null && a.price     < c.minPrice)      return false;
    if (c.maxPrice     != null && a.price     > c.maxPrice)      return false;

    // 2차: 재무건전성
    if (c.minRoe       != null && (a.roe       ?? -999) < c.minRoe)       return false;
    if (c.minOpMargin  != null && (a.opMargin  ?? -999) < c.minOpMargin)  return false;
    if (c.maxDebtRatio != null && (a.debtRatio ??  999) > c.maxDebtRatio) return false;

    // 3차: 추세 (AND)
    if (c.ma5OverMa20  && !(Number.isFinite(a.ma5)  && Number.isFinite(a.ma20) && a.ma5!  > a.ma20!)) return false;
    if (c.ma20OverMa60 && !(Number.isFinite(a.ma20) && Number.isFinite(a.ma60) && a.ma20! > a.ma60!)) return false;
    if (c.rsiMin != null && (a.rsi ?? 0)   < c.rsiMin) return false;
    if (c.rsiMax != null && (a.rsi ?? 100) > c.rsiMax) return false;

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// 2. 눌림목 + 이격도 진입 조건 (20일/30일 주기)
// ─────────────────────────────────────────────────────────────
export interface PullbackInput {
  closes:        number[];   // 일봉 종가 배열
  maPeriod?:     number;     // 기본 20
  minDeviation?: number;     // 0.95 = MA의 95% 이하면 저점 판정 (기본 0.95)
  maxDeviation?: number;     // 0.98
}

export interface PullbackSignal {
  hit:          boolean;     // 진입 시그널
  currentPrice: number;
  ma:           number;
  deviation:    number;      // currentPrice / ma
  reason:       string;
}

/** 이격도 기반 눌림목 포착 — 추세 안에서 단기 역배열 진입 */
export function detectPullback(input: PullbackInput): PullbackSignal {
  const closes = Array.isArray(input.closes) ? input.closes : [];
  const period = input.maPeriod ?? 20;
  const minDev = input.minDeviation ?? 0.95;
  const maxDev = input.maxDeviation ?? 0.98;

  if (closes.length < period) {
    return { hit:false, currentPrice:0, ma:0, deviation:1, reason:'데이터 부족' };
  }

  const last = closes[closes.length - 1];
  const slice = closes.slice(-period);
  const ma = slice.reduce((s, v) => s + v, 0) / period;
  const dev = ma > 0 ? last / ma : 1;

  if (dev >= minDev && dev <= maxDev) {
    return {
      hit:true, currentPrice:last, ma, deviation:dev,
      reason:`${period}MA 대비 ${(dev*100).toFixed(2)}% (이격 ${minDev*100}~${maxDev*100}%)`,
    };
  }
  return {
    hit:false, currentPrice:last, ma, deviation:dev,
    reason:`이격도 ${(dev*100).toFixed(2)}% — 진입 조건 외`,
  };
}

// ─────────────────────────────────────────────────────────────
// 3. ATR (Average True Range) 기반 동적 손익절
// ─────────────────────────────────────────────────────────────
export interface ATRInput {
  highs:  number[];
  lows:   number[];
  closes: number[];
  period?: number;  // 기본 20
}

/** ATR 계산 (Wilder 방식) */
export function calcATR(input: ATRInput): number {
  const { highs, lows, closes } = input;
  const period = input.period ?? 20;
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) return 0;
  if (highs.length < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  if (trs.length < period) return 0;
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

export interface ATRExitInput {
  entryPrice:    number;
  currentPrice:  number;
  atr:           number;
  side:          'long' | 'short';
  takeMultiple?: number;   // ATR × N → 익절 (기본 1.2)
  stopMultiple?: number;   // ATR × N → 손절 (기본 1.0)
}

export interface ATRExitResult {
  takeProfitPrice: number;
  stopLossPrice:   number;
  shouldTakeProfit: boolean;
  shouldStopLoss:   boolean;
  unrealizedPct:    number;
  distanceToTP:     number;
  distanceToSL:     number;
}

/** ATR 기반 동적 익절/손절 가격 계산 */
export function calcATRExit(input: ATRExitInput): ATRExitResult {
  const { entryPrice, currentPrice, atr, side } = input;
  const tk = input.takeMultiple ?? 1.2;
  const st = input.stopMultiple ?? 1.0;

  const sign = side === 'long' ? 1 : -1;
  const tp = entryPrice + sign * atr * tk;
  const sl = entryPrice - sign * atr * st;
  const unrealizedPct = entryPrice > 0
    ? ((currentPrice - entryPrice) / entryPrice) * 100 * sign
    : 0;

  return {
    takeProfitPrice: tp,
    stopLossPrice:   sl,
    shouldTakeProfit: side === 'long' ? currentPrice >= tp : currentPrice <= tp,
    shouldStopLoss:   side === 'long' ? currentPrice <= sl : currentPrice >= sl,
    unrealizedPct,
    distanceToTP: Math.abs(currentPrice - tp),
    distanceToSL: Math.abs(currentPrice - sl),
  };
}

// ─────────────────────────────────────────────────────────────
// 4. 연속 확인 횟수 (휩쏘 방어)
// ─────────────────────────────────────────────────────────────
export class ConsecutiveConfirmer {
  private count = 0;
  constructor(public readonly required: number = 3) {}

  /** 조건 충족 시 호출 — required 횟수 연속이면 true */
  tick(conditionMet: boolean): boolean {
    if (conditionMet) {
      this.count++;
      return this.count >= this.required;
    }
    this.count = 0;
    return false;
  }

  reset()  { this.count = 0; }
  current(){ return this.count; }
}

// ─────────────────────────────────────────────────────────────
// 5. 매수 허용 마진 (±0.5%)
// ─────────────────────────────────────────────────────────────
export interface MarginCheckInput {
  triggerPrice: number;   // 발동가
  currentPrice: number;
  marginPct?:   number;   // ±0.5% = 0.005 (기본)
}

/** 발동가 근처 좁은 밴드에서만 매수 허용 */
export function isWithinBuyMargin(input: MarginCheckInput): boolean {
  const { triggerPrice, currentPrice } = input;
  const margin = input.marginPct ?? 0.005;
  if (triggerPrice <= 0) return false;
  const diff = Math.abs(currentPrice - triggerPrice) / triggerPrice;
  return diff <= margin;
}

// ─────────────────────────────────────────────────────────────
// 6. 3분할 매수 시스템
// ─────────────────────────────────────────────────────────────
export interface SplitBuyConfig {
  totalCapital:  number;
  splits:        number;    // 기본 3
  ratios?:       number[];  // 각 차수 비중 (합 = 1), 미지정 시 균등
  priceLevels:   number[];  // 각 차수 발동가 (내림차순 — 1차가 가장 높음)
}

export interface SplitBuyOrder {
  level:    number;          // 1, 2, 3
  price:    number;
  capital:  number;
  quantity: number;          // 추정 수량
}

/** 3분할 매수 주문 시퀀스 생성 */
export function planSplitBuy(c: SplitBuyConfig): SplitBuyOrder[] {
  const n = c.splits || 3;
  const safeLevels = (Array.isArray(c.priceLevels) ? c.priceLevels : []).slice(0, n);
  if (safeLevels.length === 0 || c.totalCapital <= 0) return [];
  const ratios = Array.isArray(c.ratios) && c.ratios.length === safeLevels.length
    ? c.ratios
    : safeLevels.map(() => 1 / safeLevels.length);
  return safeLevels.map((price, i) => {
    const cap = c.totalCapital * (ratios[i] ?? 0);
    return {
      level:    i + 1,
      price,
      capital:  cap,
      quantity: price > 0 ? cap / price : 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 7. 엔진 구동 시간대 통제
// ─────────────────────────────────────────────────────────────
export interface TradingHourWindow {
  startHour:   number;       // KST 0-23
  startMinute: number;
  endHour:     number;
  endMinute:   number;
  label:       string;
}

export const DEFAULT_TRADING_WINDOWS: TradingHourWindow[] = [
  { startHour: 9,  startMinute: 30, endHour: 11, endMinute: 30, label: '오전 안정 구간'   },
  { startHour: 14, startMinute: 10, endHour: 15, endMinute: 30, label: '종가 모멘텀 구간' },
];

/** 현재 시각이 운용 윈도우에 속하는지 — 변동성 큰 시간대 회피 */
export function isWithinTradingHours(
  windows: TradingHourWindow[] = DEFAULT_TRADING_WINDOWS,
  now: Date = new Date(),
): boolean {
  const safe = Array.isArray(windows) ? windows : [];
  const h = now.getHours();
  const m = now.getMinutes();
  const cur = h * 60 + m;
  return safe.some(w => {
    const start = w.startHour * 60 + w.startMinute;
    const end   = w.endHour   * 60 + w.endMinute;
    return cur >= start && cur <= end;
  });
}

// ─────────────────────────────────────────────────────────────
// 8. 전략 프리셋 (스캘핑, 지지선, 추세선)
// ─────────────────────────────────────────────────────────────
export type StrategyType = 'breakout_scalp' | 'support_bounce' | 'trendline_pull' | 'ma_pullback';

export interface StrategyPreset {
  id:           StrategyType;
  name:         string;
  desc:         string;
  takeProfitMult: number;  // ATR 익절 배수
  stopLossMult:   number;
  confirmCount:   number;  // 연속 확인
  buyMarginPct:   number;
  splits:         number;
}

export const STRATEGY_PRESETS: Record<StrategyType, StrategyPreset> = {
  breakout_scalp: {
    id:'breakout_scalp', name:'고점 돌파 스캘핑',
    desc:'돌파 직후 빠르게 익절 (휩쏘 위험 → 낮은 익절폭)',
    takeProfitMult: 0.5, stopLossMult: 0.8,
    confirmCount: 2, buyMarginPct: 0.003, splits: 1,
  },
  support_bounce: {
    id:'support_bounce', name:'지지선 매매',
    desc:'주요 지지선 반등 노림 — 3분할 진입',
    takeProfitMult: 1.5, stopLossMult: 1.0,
    confirmCount: 3, buyMarginPct: 0.005, splits: 3,
  },
  trendline_pull: {
    id:'trendline_pull', name:'추세선 눌림',
    desc:'상승추세 중 눌림목 진입',
    takeProfitMult: 1.2, stopLossMult: 1.0,
    confirmCount: 3, buyMarginPct: 0.005, splits: 2,
  },
  ma_pullback: {
    id:'ma_pullback', name:'이평선 눌림 (20/30일)',
    desc:'20MA 이격도 95~98% 진입',
    takeProfitMult: 1.2, stopLossMult: 1.0,
    confirmCount: 3, buyMarginPct: 0.005, splits: 3,
  },
};
