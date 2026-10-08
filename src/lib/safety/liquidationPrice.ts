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
/**
 * 한 구간. `[상한 명목가, 유지증거금률, 공제액(누적), 브래킷 조정 배수?]`
 *
 * 네 번째 칸(`notionalCoef`)은 **계정별 브래킷 조정 배수**다. 바이낸스가
 * `/fapi/v1/leverageBracket` 응답에 줄 수 있고, 이 저장소는 지금까지 그
 * 값을 **버리고 있었다.** 버린다는 것은 "그런 조정이 없다"고 가정하는
 * 것과 같은데, 우리는 그것을 확인한 적이 없다.
 *
 * 그래서 **보존한다.** 값을 어떻게 적용해야 하는지(상한/하한에 이미
 * 반영되어 오는지, 따로 곱해야 하는지)는 확인하지 못했으므로 **적용하지
 * 않는다.** 대신 1이 아닌 값이 오면 Exact100X 경로가 막는다 — 모르는
 * 조정이 걸린 계정의 청산가를 아는 척하지 않는다.
 */
export type BracketTier =
  [cap: number, mmr: number, maintAmount: number, notionalCoef?: number];

/**
 * 이 명목가가 **몇 번째 구간**인가. 경계 해석이 사는 **유일한 자리**다.
 *
 * 왜 인덱스를 돌려주는가: 자기일관성 해를 찾으려면 "어느 구간인가"를
 * 비교해야 하는데, `{mmr, maintAmount}`만 받으면 값이 같은 두 구간을
 * 구별할 수 없다.
 *
 * 경계는 `notional <= cap`이다 — 기존 `getMaintMargin`이 쓰던 그대로이고,
 * 여기 한 곳에만 적는다. 두 파일이 각자 `<`와 `<=`를 고르면 구간 경계
 * 바로 위아래에서 답이 갈린다.
 *
 * 오름차순으로 **정렬해서 본다.** 실제 입력(`parseBrackets` 결과와
 * `MMR_BRACKETS`)은 이미 오름차순이라 동작이 바뀌지 않지만, 순서가
 * 흐트러진 표가 들어오면 예전에는 첫 줄이 조용히 이겼다.
 */
export function sortedTiers(table: BracketTier[]): BracketTier[] {
  return [...table].sort((a, b) => a[0] - b[0]);
}

export function tierIndexFor(notional: number, table: BracketTier[]): number {
  for (let i = 0; i < table.length; i++) {
    if (notional <= table[i][0]) return i;
  }
  return table.length - 1;
}

export function getMaintMargin(
  notional: number,
  brackets?: BracketTier[] | null,   // 실제 거래소 브래킷 (없으면 하드코딩 fallback)
): { mmr: number; maintAmount: number } {
  // **경계 해석을 여기서 다시 쓰지 않는다** — `tierIndexFor` 하나다.
  const table = sortedTiers((brackets && brackets.length) ? brackets : MMR_BRACKETS);
  const t = table[tierIndexFor(notional, table)];
  return { mmr: t[1], maintAmount: t[2] };
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

// ── 구간을 **자기일관되게** 고른다 ───────────────────────────
//
// **한 번 고른 구간으로 끝내면 틀린다.**
//
// 위 `calcLiquidationPrice`는 *진입* 명목가로 구간을 고른 뒤 그 구간의
// MMR·공제액으로 청산가를 낸다. 그런데 바이낸스 규칙은 **청산가에서의
// 명목가**가 처음 가정한 구간과 다르면 그 구간의 값으로 다시 계산하라고
// 한다. 100배에서는 청산까지 0.x%만 움직이면 되므로, 진입 명목가가 구간
// 경계 근처면 그 0.x% 사이에 경계를 넘는다.
//
// 실측(BTCUSDT 대표 구간):
//   LONG  진입 명목가 50,100(2구간) → 청산가에서 49,798(1구간)
//   SHORT 진입 명목가 499,500(2구간) → 청산가에서 502,035(3구간)
//
// 두 경우 모두 지금 식은 청산거리를 **실제보다 멀게** 적는다. 즉 틀리는
// 방향이 낙관적이다 — 100배에서 가장 나쁜 종류의 오차다.
//
// 어떻게 푸는가
// ─────────────
// 반복(fixed-point)으로 수렴시키지 않는다. 수렴하지 않거나 두 값을
// 오가는 경우를 다시 판정해야 하고, 그 판정이 또 하나의 규칙이 된다.
//
// 대신 **구간을 전부 평가한다.** 구간 수는 10개 안쪽이다.
//   · 각 구간의 MMR·공제액으로 청산가를 구하고
//   · 그 청산가에서의 명목가가 **바로 그 구간**에 들어가는지 본다
//   · 들어가는 구간이 정확히 하나일 때만 답이다
//
// 0개면 답이 없고, 2개 이상이면 어느 쪽인지 말할 수 없다. 둘 다 거부다 —
// **모르는 것을 통과로 읽지 않는다.**

export type LiquidationSolveCode =
  | 'OK'
  | 'INPUT_UNUSABLE'
  | 'NO_BRACKETS'
  /** 어느 구간으로 계산해도 그 구간에 들어가지 않는다 */
  | 'NO_SELF_CONSISTENT_TIER'
  /** 두 구간 이상이 자기일관이다 — 어느 쪽인지 말할 수 없다 */
  | 'AMBIGUOUS_TIER';

export interface LiquidationSolution {
  code: LiquidationSolveCode;
  /** 자기일관 해일 때만 값이 있다 */
  liquidationPrice: number | null;
  /** 최종으로 쓴 구간 */
  mmr: number | null;
  maintAmount: number | null;
  tierIndex: number | null;
  /** 그 청산가에서의 명목가 — 구간 선택의 근거다 */
  liquidationNotional: number | null;
  /** 진입 명목가로 골랐을 구간. 최종과 다르면 경계를 넘은 것이다 */
  entryTierIndex: number | null;
  entryNotional: number | null;
}

const noSolution = (
  code: LiquidationSolveCode, partial: Partial<LiquidationSolution> = {},
): LiquidationSolution => ({
  code, liquidationPrice: null, mmr: null, maintAmount: null, tierIndex: null,
  liquidationNotional: null, entryTierIndex: null, entryNotional: null, ...partial,
});

/**
 * 청산가와 유지증거금 구간을 **서로 맞을 때까지** 함께 푼다.
 *
 * 순수 함수다. 거래소에 묻지 않는다.
 */
export function solveLiquidationPrice(args: {
  entryPrice: number;
  leverage: number;
  side: 'buy' | 'sell';
  quantity: number;
  brackets: BracketTier[] | null | undefined;
}): LiquidationSolution {
  const { entryPrice: p, leverage: L, side, quantity: q } = args;
  if (![p, L, q].every(v => Number.isFinite(v)) || p <= 0 || q <= 0 || L <= 1) {
    return noSolution('INPUT_UNUSABLE');
  }
  if (!Array.isArray(args.brackets) || args.brackets.length === 0) {
    return noSolution('NO_BRACKETS');
  }
  const table = sortedTiers(args.brackets);

  const entryNotional = p * q;
  const entryTierIndex = tierIndexFor(entryNotional, table);
  const seen = { entryTierIndex, entryNotional };

  const hits: Array<{ i: number; lp: number; n: number }> = [];
  for (let i = 0; i < table.length; i++) {
    const mmr = table[i][1];
    const maintAmount = table[i][2];
    if (!Number.isFinite(mmr) || !Number.isFinite(maintAmount)) continue;
    // 식은 위 `calcLiquidationPrice`와 **같은 식**이다. 여기서 다시 쓰는
    // 이유는 구간을 고정해서 평가해야 하기 때문이고, 고른 구간을 그대로
    // 넘기는 길이 `calcLiquidationPrice`에는 없다 — 그쪽은 명목가로 다시
    // 고른다. 그래서 한 구간짜리 표를 만들어 **그 함수에 위임한다.**
    const lp = calcLiquidationPrice(p, L, side, q, [[Infinity, mmr, maintAmount]]);
    if (!Number.isFinite(lp) || lp <= 0) continue;
    const n = q * lp;
    if (tierIndexFor(n, table) === i) hits.push({ i, lp, n });
  }

  if (hits.length === 0) return noSolution('NO_SELF_CONSISTENT_TIER', seen);
  if (hits.length > 1) return noSolution('AMBIGUOUS_TIER', seen);

  const h = hits[0];
  return {
    code: 'OK',
    liquidationPrice: h.lp,
    mmr: table[h.i][1],
    maintAmount: table[h.i][2],
    tierIndex: h.i,
    liquidationNotional: h.n,
    ...seen,
  };
}
