// src/lib/safety/liquidationPrice.ts
//
// **청산가 산출식 한 곳.**
//
// 왜 `safety/index.ts`에서 떼어 냈나
// ──────────────────────────────────
// 식 자체는 그대로다 — 한 글자도 바꾸지 않았다. 옮긴 이유는 **무게**다.
// `safety/index.ts`는 수수료·펀딩·손익 모듈을 전부 끌어오는데, 청산가를
// 쓰려는 쪽(진입 전 보호)은 그것들이 필요 없다. 실제로 100X 계약 검사기가
// 진입 모듈을 따로 컴파일할 때 그 무게 때문에 멈췄다.
//
// 그때 식을 **복사**하는 것이 가장 쉬운 길이고, 이 저장소가 반복해서
// 당한 고장이 정확히 그것이다(`경로가 둘인데 한쪽만 고침`). 그래서
// 복사 대신 떼어 내고, `safety/index.ts`는 여기서 다시 내보낸다 —
// 기존에 `@/lib/safety`에서 가져다 쓰던 자리는 그대로 돈다.

// ─────────────────────────────────────────────────────────────
// Liquidation Price Calculator
// ─────────────────────────────────────────────────────────────
// Binance USDT-M 유지증거금 계단 (BTCUSDT 대표값, 명목가 USDT 기준)
// [상한 명목가, MMR, 유지증거금 공제액(누적)] — 심볼/시점따라 다르므로 추정치
export const MMR_BRACKETS: Array<[number, number, number]> = [
  [50_000,       0.004, 0],
  [500_000,      0.005, 50],
  [1_000_000,    0.010, 2_550],
  [5_000_000,    0.025, 17_550],
  [20_000_000,   0.050, 142_550],
  [50_000_000,   0.100, 1_142_550],
  [100_000_000,  0.125, 2_392_550],
  [Infinity,     0.150, 4_892_550],
];
export type BracketTier = [cap: number, mmr: number, maintAmount: number];

export function getMaintMargin(
  notional: number,
  brackets?: BracketTier[] | null,   // 실제 거래소 브래킷 (없으면 하드코딩 fallback)
): { mmr: number; maintAmount: number } {
  const table = (brackets && brackets.length) ? brackets : MMR_BRACKETS;
  for (const [cap, mmr, amt] of table) {
    if (notional <= cap) return { mmr, maintAmount: amt };
  }
  const last = table[table.length - 1];
  return { mmr: last[1], maintAmount: last[2] };
}

export function calcLiquidationPrice(
  entryPrice: number,
  leverage:   number,
  side:       'buy' | 'sell',
  quantity?:  number,            // 제공 시 계단식 MMR + 유지증거금 공제 반영 (Futures 정밀식)
  brackets?:  BracketTier[] | null,  // 실제 거래소 leverageBracket (없으면 fallback 테이블)
): number {
  if (leverage <= 1 || entryPrice <= 0) return 0;
  // quantity 없으면: 평탄 MMR(0.5%) 근사식 (하위호환)
  if (!quantity || quantity <= 0) {
    const factor = (1 - 0.005) / leverage;
    return side === 'buy' ? entryPrice * (1 - factor) : entryPrice * (1 + factor);
  }
  // quantity 있으면: 계단식 유지증거금 기반 정밀식 (실제 브래킷 우선)
  const notional = entryPrice * quantity;
  const { mmr, maintAmount } = getMaintMargin(notional, brackets);
  const lp = side === 'buy'
    ? (entryPrice * (1 - 1 / leverage) - maintAmount / quantity) / (1 - mmr)
    : (entryPrice * (1 + 1 / leverage) + maintAmount / quantity) / (1 + mmr);
  return lp > 0 ? lp : 0;
}
