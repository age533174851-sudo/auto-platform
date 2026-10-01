// src/lib/engine/liquidationDistance.ts
//
// **청산당할 자리를 모른 채 진입하지 않는다.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 저장소에는 청산 관련 판정이 이미 여럿 있었다. 그런데 전부
// **"손절이 청산보다 먼저 오는가"**를 묻는다:
//
//   leverageMath.stopFiresBeforeLiquidation   손절% < 청산거리%
//   exitPolicy.liquidationGuard               손절% < 청산거리%
//   leverageLadder.stopBeforeLiquidation      손절가 vs 거래소 청산가
//   preTradeChecklist.LIQUIDATION_DISTANCE    손절가 vs 거래소 청산가
//
// `NO_FIXED_SL`에는 **손절이 없다.** 그래서 네 판정 모두 성립하지 않고,
// 실제로 체크리스트는 `LIQUIDATION_DISTANCE`를 `FIXED_STOP_ONLY_CHECKS`에
// 넣어 Exact100X에서 **항목 자체를 뺀다**(그것이 맞다 — 없는 손절을
// 비교할 수는 없다).
//
// 그 결과 Exact100X 진입 경로에는 청산 관련 판정이 **하나도 없었다.**
// 진입 계획은 `liquidationPrice: 0, liquidationDistancePct: 0`을 적고
// 있었는데, 이 저장소의 규칙으로는 그것이 가장 나쁜 모양이다 —
// **UNKNOWN을 0으로 적지 않는다.** 0은 "0달러에 청산"으로 읽혀 청산거리가
// 100%가 되고, 가장 위험한 주문이 가장 안전해 보인다.
//
// 이 파일은 손절이 없어도 성립하는 질문 하나를 답한다:
//
//     지금 기준가에서 청산가까지 **불리한 방향으로** 남은 거리가
//     얼마이고, 그 거리를 **믿을 수 있는가.**
//
// 공식을 다시 쓰지 않는다
// ───────────────────────
// 청산가 산출식은 `safety/calcLiquidationPrice` 하나를 쓴다. 그쪽은
// 거래소 브래킷(구간별 유지증거금률·공제액)을 받는 정밀식이다. 여기서
// 또 쓰면 두 벌이 되고, 언젠가 한쪽만 고쳐진다.
//
// 이 파일이 더하는 것은 **정책**이다: 무엇을 신뢰할 수 있다고 볼 것인가,
// 방향이 말이 되는가, 여유가 충분한가, 모르면 어떻게 할 것인가.
//
// ★ 이것은 **진입 전 보호**다
// ───────────────────────────
// 이미 열린 포지션을 청산거리로 강제 종료하는 기능이 **아니다.** 그것은
// 종료 권한(exit authority)이고 아직 없다. 이 판정이 통과했다고 해서
// `NO_FIXED_SL`에 종료 수단이 생긴 것이 아니다.

import { calcLiquidationPrice, type BracketTier } from '../safety/liquidationPrice';

/** 유지증거금 구간. **거래소에서 읽은 값만 받는다** */
export interface MaintenanceTier {
  /** 유지증거금률 (0~1 비율. 0.004 = 0.4%) */
  mmr: number;
  /** 유지증거금 공제액(누적) */
  maintAmount: number;
  /**
   * 어디서 왔는가. 지금은 거래소 브래킷 하나뿐이다.
   *
   * **추정 테이블을 여기에 넣지 않는다.** `safety.MMR_BRACKETS`는
   * "BTCUSDT 대표값 · 추정치"라고 스스로 적어 두었다. 100배에서 구간을
   * 한 칸 잘못 짚으면 청산가가 통째로 달라진다.
   */
  source: 'EXCHANGE_BRACKET';
  /** 이 구간을 고를 때 쓴 명목가 */
  notional: number;
}

export type LiquidationAssessmentCode =
  /** 계산했고 계약이 요구하는 여유도 만족한다 */
  | 'OK'
  // ── 입력을 믿을 수 없다 ──
  | 'SIDE_UNKNOWN'
  | 'REFERENCE_PRICE_UNUSABLE'
  | 'QUANTITY_UNUSABLE'
  | 'LEVERAGE_UNUSABLE'
  | 'MARGIN_MODE_UNKNOWN'
  | 'MARGIN_MODE_UNSUPPORTED'
  | 'MAINTENANCE_TIER_MISSING'
  // ── 계산 결과를 믿을 수 없다 ──
  | 'LIQUIDATION_PRICE_UNCOMPUTABLE'
  | 'LIQUIDATION_PRICE_WRONG_SIDE'
  | 'DISTANCE_NOT_POSITIVE'
  // ── 계산은 됐는데 여유가 모자란다 ──
  | 'ADVERSE_DISTANCE_UNKNOWN'
  | 'ADVERSE_REACHES_LIQUIDATION';

export interface LiquidationDistanceInput {
  side: 'LONG' | 'SHORT' | null | undefined;
  /** 기준가. **거래소에서 읽은 값**이어야 한다 (신호가 들고 온 값이 아니라) */
  referencePrice: number | null | undefined;
  quantity: number | null | undefined;
  leverage: number | null | undefined;
  marginMode: 'isolated' | 'cross' | null | undefined;
  tier: MaintenanceTier | null | undefined;
  /**
   * **예상 adverse/변동성 위험 거리 (%).**
   *
   * ★ 이것은 **손절 주문이 아니다.** `NO_FIXED_SL`에서는 거래소에 손절이
   *   나가지 않는다. 이 값은 신호가 ATR로 계산한 "이 종목이 이 정도는
   *   불리하게 움직인다"는 **참고 거리**이고, 여기서는 청산거리와 비교할
   *   기준으로만 쓴다.
   *
   *   "고정 손절 주문 없음"과 "변동성 위험거리를 계산하지 않음"은 다른
   *   말이다. 이 값을 손절이라고 부르면 안 된다.
   */
  adverseDistancePct: number | null | undefined;
}

export interface LiquidationDistanceAssessment {
  /** 진입해도 되는가. **이것 하나만 보고 판정한다** */
  ok: boolean;
  code: LiquidationAssessmentCode;
  reason: string;
  /**
   * 계산을 **믿을 수 있는가.**
   *
   * `ok`와 다르다. 계산은 믿을 수 있는데 여유가 모자라 거부될 수 있고
   * (`ADVERSE_REACHES_LIQUIDATION`), 그때 화면은 "거리를 이만큼으로
   * 계산했고 그게 모자라다"고 말할 수 있어야 한다. 계산 자체가 안 된
   * 경우와 구별되지 않으면 운영자가 무엇을 고쳐야 할지 모른다.
   */
  trustworthy: boolean;

  side: 'LONG' | 'SHORT' | null;
  referencePrice: number | null;
  estimatedLiquidationPrice: number | null;
  /** 가격 단위 거리. 항상 0 이상이거나 null이다 (방향은 side가 말한다) */
  liquidationDistance: number | null;
  /**
   * 기준가 대비 % 거리.
   *
   * ★ **raw headroom이다** — 수수료·슬리피지·펀딩을 빼기 **전** 값이다.
   *   비용을 반영한 실질 여유(③)는 이 숫자와 **다른 이름**으로 와야 한다.
   *   같은 필드에 덮어쓰면 "비용 뺀 값"과 "빼기 전 값"이 구별되지 않는다.
   */
  liquidationDistancePct: number | null;
  /** 위 값이 어떤 종류의 여유인지. ③이 다른 값을 더할 때 섞이지 않게 한다 */
  headroomKind: 'RAW';

  leverage: number | null;
  marginMode: 'isolated' | 'cross' | null;
  tier: MaintenanceTier | null;
  adverseDistancePct: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 실패는 **값을 지어내지 않는다.** 모르는 칸은 null로 남는다 */
const fail = (
  code: LiquidationAssessmentCode, reason: string,
  partial: Partial<LiquidationDistanceAssessment> = {},
): LiquidationDistanceAssessment => ({
  ok: false, code, reason, trustworthy: false,
  side: null, referencePrice: null, estimatedLiquidationPrice: null,
  liquidationDistance: null, liquidationDistancePct: null, headroomKind: 'RAW',
  leverage: null, marginMode: null, tier: null, adverseDistancePct: null,
  ...partial,
});

/**
 * 이 진입 계획의 청산거리는 얼마이고, 들어가도 되는가.
 *
 * **순수 함수다.** 거래소에 묻지 않는다 — 부르는 쪽이 읽어서 넘긴다.
 * 그래야 시험이 값만으로 모든 경계를 돌릴 수 있다.
 *
 * 모르는 것은 전부 **거부**다(fail-closed). 100배에서 "확인하지 못함"을
 * 통과로 읽으면 그 한 번이 증거금 전액이다.
 */
export function assessLiquidationDistance(
  i: LiquidationDistanceInput | null | undefined,
): LiquidationDistanceAssessment {
  const inp = i ?? ({} as LiquidationDistanceInput);

  // ── ① 방향 ──
  const sideRaw = String(inp.side ?? '').trim().toUpperCase();
  if (sideRaw !== 'LONG' && sideRaw !== 'SHORT') {
    return fail('SIDE_UNKNOWN',
      `방향을 읽지 못했습니다 (${String(inp.side)}) — 어느 쪽이 불리한 방향인지 모르면`
      + ' 청산거리를 정의할 수 없습니다');
  }
  const side = sideRaw as 'LONG' | 'SHORT';

  // ── ② 기준가 ──
  const price = num(inp.referencePrice);
  if (price == null || price <= 0) {
    return fail('REFERENCE_PRICE_UNUSABLE',
      `기준가가 ${String(inp.referencePrice)}입니다 — 0 이하이거나 숫자가 아닌 값으로는`
      + ' 거리를 재지 않습니다', { side });
  }

  // ── ③ 수량 ──
  //
  // 정밀식은 수량이 있어야 공제액(maintAmount)을 가격으로 환산한다.
  // 수량 없이 부르면 평탄 MMR 근사식으로 떨어지는데, 100배에서 그
  // 근사는 청산가를 실제보다 **멀게** 적는다 — 위험한 방향이다.
  const qty = num(inp.quantity);
  if (qty == null || qty <= 0) {
    return fail('QUANTITY_UNUSABLE',
      `수량이 ${String(inp.quantity)}입니다 — 수량 없이 구한 청산가는 실제보다 멀게 나옵니다`,
      { side, referencePrice: price });
  }

  // ── ④ 배율 ──
  const lev = num(inp.leverage);
  if (lev == null || lev <= 1) {
    return fail('LEVERAGE_UNUSABLE',
      `배율이 ${String(inp.leverage)}입니다 — 1 이하에서는 이 식이 청산가를 내지 않습니다`,
      { side, referencePrice: price });
  }

  // ── ⑤ 마진 모드 ──
  const mode = inp.marginMode == null ? null : String(inp.marginMode).trim().toLowerCase();
  if (mode !== 'isolated' && mode !== 'cross') {
    return fail('MARGIN_MODE_UNKNOWN',
      `마진 모드를 읽지 못했습니다 (${String(inp.marginMode)}) — 담보 범위를 모르면`
      + ' 청산가가 정해지지 않습니다', { side, referencePrice: price, leverage: lev });
  }
  if (mode !== 'isolated') {
    // 교차는 **계좌 전체가 받친다.** 지갑 잔고와 다른 교차 포지션의 몫까지
    // 알아야 청산가가 나오는데, 이 경로는 그것을 읽지 않는다. 그리고
    // Exact100X 계약은 격리 전용이다 — 여기 오면 계약이 이미 깨진 것이다.
    return fail('MARGIN_MODE_UNSUPPORTED',
      `마진 모드가 ${mode}입니다 — 교차 청산가는 계좌 전체 잔고가 있어야 계산됩니다.`
      + ' 이 경로는 격리만 지원합니다',
      { side, referencePrice: price, leverage: lev, marginMode: mode as 'cross' });
  }
  const marginMode: 'isolated' = 'isolated';

  // ── ⑥ 유지증거금 구간 ──
  //
  // **추정 테이블로 때우지 않는다.** 거래소 브래킷을 못 읽었으면 거부다.
  const tier = inp.tier ?? null;
  const mmr = tier == null ? null : num(tier.mmr);
  const maintAmount = tier == null ? null : num(tier.maintAmount);
  if (tier == null || tier.source !== 'EXCHANGE_BRACKET'
      || mmr == null || !(mmr >= 0 && mmr < 1)
      || maintAmount == null || maintAmount < 0) {
    return fail('MAINTENANCE_TIER_MISSING',
      '거래소에서 유지증거금 구간(leverageBracket)을 읽지 못했습니다'
      + ' — 추정 표로 100배 청산가를 정하지 않습니다',
      { side, referencePrice: price, leverage: lev, marginMode });
  }

  // ── ⑦ 청산가 ──
  //
  // 식은 `safety/calcLiquidationPrice` 하나다. 브래킷을 직접 넘기므로
  // 그쪽의 하드코딩 추정 표로 떨어지지 않는다.
  const brackets: BracketTier[] = [[Infinity, mmr, maintAmount]];
  const raw = calcLiquidationPrice(price, lev, side === 'LONG' ? 'buy' : 'sell', qty, brackets);
  const liq = num(raw);
  // `calcLiquidationPrice`는 못 구하면 **0을 돌려준다.** 0을 청산가로 읽으면
  // LONG 청산거리가 100%가 된다 — 통과시키면 안 되는 모양이다.
  if (liq == null || liq <= 0) {
    return fail('LIQUIDATION_PRICE_UNCOMPUTABLE',
      '청산가를 계산하지 못했습니다 — 0을 청산가로 읽지 않습니다'
      + ' (0이면 청산거리가 100%가 되어 가장 위험한 주문이 가장 안전해 보입니다)',
      { side, referencePrice: price, leverage: lev, marginMode, tier });
  }

  const known = {
    side, referencePrice: price, estimatedLiquidationPrice: liq,
    leverage: lev, marginMode, tier,
  };

  // ── ⑧ 방향이 말이 되는가 ──
  //
  // LONG은 **아래로** 가면 청산, SHORT은 **위로** 가면 청산이다.
  // 반대편에 나온 청산가는 식이나 입력이 깨졌다는 뜻이고, 그 값으로 잰
  // 거리는 의미가 없다.
  const onCorrectSide = side === 'LONG' ? liq < price : liq > price;
  if (!onCorrectSide) {
    return fail('LIQUIDATION_PRICE_WRONG_SIDE',
      `${side}인데 청산가 ${liq}가 기준가 ${price}의 ${side === 'LONG' ? '위' : '아래'}에 있습니다`
      + ' — 방향이 맞지 않는 청산가로는 거리를 재지 않습니다', known);
  }

  // ── ⑨ 거리 ──
  const distance = side === 'LONG' ? price - liq : liq - price;
  if (!(distance > 0)) {
    return fail('DISTANCE_NOT_POSITIVE',
      `청산까지 남은 거리가 ${distance}입니다 — 이미 청산 구간이거나 거리를 잴 수 없습니다`,
      { ...known, liquidationDistance: null });
  }
  const distancePct = (distance / price) * 100;

  const measured = {
    ...known,
    liquidationDistance: distance,
    liquidationDistancePct: distancePct,
  };

  // ── ⑩ 여유가 충분한가 ──
  //
  // **임의의 % 문턱을 만들지 않는다.** 비교 대상은 신호가 ATR로 실제
  // 계산한 변동성 위험 거리다 — 지어낸 상수가 아니라 측정값이다.
  //
  // 뜻: "이 종목이 평소 이 정도는 불리하게 움직이는데, 그 움직임이 청산을
  // 친다면 들어가면 안 된다." 손절이 없으므로 그 움직임을 받아낼 것이
  // 증거금밖에 없다.
  //
  // 안전계수(×1.5 같은 것)는 **곱하지 않는다.** 그 숫자는 근거가 없다.
  const adverse = num(inp.adverseDistancePct);
  if (adverse == null || adverse <= 0) {
    return {
      ...fail('ADVERSE_DISTANCE_UNKNOWN',
        `변동성 위험 거리를 읽지 못했습니다 (${String(inp.adverseDistancePct)})`
        + ' — 청산거리가 충분한지 비교할 기준이 없습니다',
        measured),
      // 청산거리 **자체는** 믿을 수 있다. 모자란 것은 비교 기준이다.
      trustworthy: true,
      adverseDistancePct: null,
    };
  }

  // 경계: **같으면 거부다.** 예상 움직임이 정확히 청산에 닿는 것은 여유가
  // 아니다. 그래서 `>`이지 `>=`가 아니다.
  if (!(distancePct > adverse)) {
    return {
      ...fail('ADVERSE_REACHES_LIQUIDATION',
        `청산거리 ${distancePct.toFixed(4)}%가 변동성 위험 거리 ${adverse.toFixed(4)}%보다`
        + ' 크지 않습니다 — 평소 움직임이 청산에 닿습니다.'
        + ' 고정 손절이 없으므로 그 움직임을 받아낼 것은 증거금뿐입니다',
        measured),
      trustworthy: true,
      adverseDistancePct: adverse,
    };
  }

  return {
    ok: true, code: 'OK', reason: '', trustworthy: true,
    ...measured, headroomKind: 'RAW', adverseDistancePct: adverse,
  };
}

/**
 * 명목가로 유지증거금 구간을 고른다. **거래소 브래킷만 받는다.**
 *
 * `safety.getMaintMargin`은 브래킷이 없으면 하드코딩 추정 표로 떨어진다.
 * 그 동작은 기존 화면이 쓰고 있어 그대로 두고, Exact100X 경로는 떨어지지
 * 않는 쪽을 쓴다 — 추정 구간으로 100배 청산가를 정하지 않는다.
 */
export function tierFromBrackets(
  notional: number | null | undefined,
  tiers: BracketTier[] | null | undefined,
): MaintenanceTier | null {
  const n = num(notional);
  if (n == null || n <= 0) return null;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
  const hit = sorted.find(([cap]) => n <= cap) ?? sorted[sorted.length - 1];
  const mmr = num(hit?.[1]);
  const maintAmount = num(hit?.[2]);
  if (mmr == null || maintAmount == null) return null;
  return { mmr, maintAmount, source: 'EXCHANGE_BRACKET', notional: n };
}
