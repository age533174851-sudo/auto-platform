// src/lib/strategies/fearDca.ts
// 공포 DCA 전략 — 극단적 공포에서만 분할매수, 시드한도+쿨타임으로 과매수 방지

export interface FearDcaConfig {
  asset:          string;        // 'BTC', 'SPY' 등
  market:         'crypto' | 'stock' | 'etf';
  totalSeed:      number;        // 전체 시드 (KRW)
  buyPerTime:     number;        // 1회 매수금액 (KRW)
  maxInvestPct:   number;        // 최대 투입비율 (%, 예: 50)
  cooldownDays:   number;        // 쿨타임 (일, 예: 7)
  fearThreshold:  number;        // 공포 기준 (F&G ≤ 이값, 예: 20)
  greedExit:      number;        // 청산 기준 (F&G ≥ 이값, 예: 60)
  useFutures:     boolean;       // 선물 여부 (기본 false)
  enabled:        boolean;
}

export const DEFAULT_FEAR_DCA: FearDcaConfig = {
  asset: 'BTC', market: 'crypto', totalSeed: 1000000, buyPerTime: 20000,
  maxInvestPct: 50, cooldownDays: 7, fearThreshold: 20, greedExit: 60,
  useFutures: false, enabled: false,
};

interface DcaState {
  invested:    number;      // 누적 투입금액
  lastBuyAt:   number;      // 마지막 매수 시각
  buyCount:    number;      // 매수 횟수
  positions:   { qty: number; avgPrice: number }[];
}

const KEY = 'tg_fear_dca_state_v1';

function loadState(asset: string): DcaState {
  if (typeof window === 'undefined') return { invested: 0, lastBuyAt: 0, buyCount: 0, positions: [] };
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    return all[asset] || { invested: 0, lastBuyAt: 0, buyCount: 0, positions: [] };
  } catch { return { invested: 0, lastBuyAt: 0, buyCount: 0, positions: [] }; }
}

function saveState(asset: string, st: DcaState): void {
  if (typeof window === 'undefined') return;
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    all[asset] = st;
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

export interface DcaDecision {
  action: 'buy' | 'hold' | 'exit' | 'blocked';
  reason: string;
  amount?: number;
  investedPct?: number;
}

// 매수/청산 판단
export function evaluateFearDca(
  cfg: FearDcaConfig,
  fearGreed: number,          // 현재 F&G 값
  currentPrice: number,
): DcaDecision {
  const st = loadState(cfg.asset);
  const investedPct = cfg.totalSeed > 0 ? (st.invested / cfg.totalSeed) * 100 : 0;

  // 청산: 탐욕 구간
  if (fearGreed >= cfg.greedExit && st.positions.length > 0) {
    return { action: 'exit', reason: `탐욕 구간 (F&G ${fearGreed}≥${cfg.greedExit}) — 청산 신호`, investedPct };
  }

  // 매수 조건: 공포 구간
  if (fearGreed > cfg.fearThreshold) {
    return { action: 'hold', reason: `공포 아님 (F&G ${fearGreed}>${cfg.fearThreshold})`, investedPct };
  }

  // 제한 체크
  if (investedPct >= cfg.maxInvestPct) {
    return { action: 'blocked', reason: `최대 투입비율 도달 (${investedPct.toFixed(0)}%≥${cfg.maxInvestPct}%)`, investedPct };
  }
  const daysSince = (Date.now() - st.lastBuyAt) / (1000 * 60 * 60 * 24);
  if (st.lastBuyAt > 0 && daysSince < cfg.cooldownDays) {
    return { action: 'blocked', reason: `쿨타임 (${Math.ceil(cfg.cooldownDays - daysSince)}일 남음)`, investedPct };
  }
  if (st.invested + cfg.buyPerTime > cfg.totalSeed * (cfg.maxInvestPct / 100)) {
    return { action: 'blocked', reason: '이번 매수 시 한도 초과', investedPct };
  }

  return {
    action: 'buy',
    reason: `극단적 공포 (F&G ${fearGreed}≤${cfg.fearThreshold}) — 분할매수`,
    amount: cfg.buyPerTime,
    investedPct,
  };
}

// 매수 실행 기록
export function recordDcaBuy(asset: string, amount: number, price: number): void {
  const st = loadState(asset);
  st.invested += amount;
  st.lastBuyAt = Date.now();
  st.buyCount += 1;
  st.positions.push({ qty: amount / price, avgPrice: price });
  saveState(asset, st);
}

// 청산 (전량)
export function recordDcaExit(asset: string): void {
  saveState(asset, { invested: 0, lastBuyAt: 0, buyCount: 0, positions: [] });
}

export function getDcaState(asset: string) {
  return loadState(asset);
}
