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

import { solveLiquidationPrice, type BracketTier } from '../safety/liquidationPrice';

/**
 * 최종으로 쓴 유지증거금 구간. **결과에만 나온다** — 입력으로 받지 않는다.
 *
 * 예전에는 부르는 쪽이 구간을 골라서 넘겼다. 그러면 구간 선택이 두 곳
 * (부르는 쪽 · 청산가 식)에 생기고, 더 나쁘게는 **진입 명목가로 한 번
 * 고른 구간**이 그대로 답이 됐다. 청산가에서의 명목가는 다른 구간일 수
 * 있다(아래 `solveLiquidationPrice` 머리말). 이제 구간은 판정이 푼다.
 */
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
  /** **청산가에서의** 명목가 — 이 구간을 고른 근거다 */
  notional: number;
  /** 표에서 몇 번째 구간인가 */
  index: number;
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
  /** 계정별 브래킷 조정 배수가 걸려 있다 — 적용법을 확인하지 못했다 */
  | 'BRACKET_COEF_UNSUPPORTED'
  // ── 계산 결과를 믿을 수 없다 ──
  | 'LIQUIDATION_PRICE_UNCOMPUTABLE'
  /** 어느 구간으로 계산해도 그 구간에 들어가지 않는다 */
  | 'TIER_NOT_SELF_CONSISTENT'
  /** 두 구간 이상이 자기일관이다 */
  | 'TIER_AMBIGUOUS'
  | 'LIQUIDATION_PRICE_WRONG_SIDE'
  | 'DISTANCE_NOT_POSITIVE'
  // ── 계산은 됐는데 여유가 모자란다 ──
  | 'ADVERSE_DISTANCE_UNKNOWN'
  | 'ADVERSE_REACHES_LIQUIDATION';

export interface LiquidationDistanceInput {
  side: 'LONG' | 'SHORT' | null | undefined;
  /**
   * **마크가.** 거리를 재는 기준이고, 청산이 실제로 발동하는 가격이다.
   * 거래소에서 읽은 값이어야 한다(신호가 들고 온 값이 아니라).
   */
  referencePrice: number | null | undefined;
  /**
   * **포지션이 열리는 가격.** 안 주면 `referencePrice`와 같다.
   *
   * 왜 나누는가: 청산가 식은 **진입가**가 정하고, 청산은 **마크가**가
   * 발동시킨다. 둘을 하나로 두면 진입 슬리피지가 거리에서 사라진다 —
   * 식이 진입가에 비례하므로 진입가를 올려도 **진입가 대비 %는 그대로**다.
   *
   *   마크 50,000 · 체결 50,005 · 100배 · MMR 0.4%
   *     체결가 대비 거리 0.6024%   ← 슬리피지가 안 보인다
   *     마크 대비 거리   0.5925%   ← 실제로 남은 거리
   *
   * 슬리피지는 여기서 **한 번만** 반영된다. 비용 표에 또 넣으면 이중
   * 반영이고, 그래서 `executionCost`의 총비용에는 진입 슬리피지가 없다.
   */
  entryPrice?: number | null;
  quantity: number | null | undefined;
  leverage: number | null | undefined;
  marginMode: 'isolated' | 'cross' | null | undefined;
  /**
   * **거래소 유지증거금 브래킷 전체.** 고른 구간 하나가 아니다.
   *
   * 구간은 청산가와 **함께** 정해진다 — 진입 명목가로 미리 고르면 청산가
   * 에서 경계를 넘은 경우를 잡지 못한다. 그래서 표를 통째로 받는다.
   */
  brackets: BracketTier[] | null | undefined;
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
  /**
   * 이 판정이 **어떤 종류의 여유**인가. 안 주면 `RAW`다.
   *
   * `RAW`는 거래소 브래킷·배율·마진 구조만으로 구한 여유(②)이고,
   * `EFFECTIVE`는 예상 체결가와 비용으로 증거금을 줄인 뒤의 실질 여유(③)다.
   * **같은 필드에 덮어쓰지 않는다** — 둘을 나란히 두어야 운영자가 비용이
   * 얼마나 먹었는지 볼 수 있다. 실패한 판정도 어느 쪽을 재려던 것인지
   * 말해야 한다.
   */
  headroomKind?: 'RAW' | 'EFFECTIVE';
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
  /** 거리를 잰 기준(마크가) */
  referencePrice: number | null;
  /** 청산가 식에 넣은 진입가. 마크가와 다르면 슬리피지가 반영된 것이다 */
  entryPrice: number | null;
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
  headroomKind: 'RAW' | 'EFFECTIVE';

  leverage: number | null;
  marginMode: 'isolated' | 'cross' | null;
  /** 최종으로 쓴 구간 (청산가에서의 명목가가 고른 것) */
  tier: MaintenanceTier | null;
  /**
   * 진입 명목가로 골랐을 구간 번호. `tier.index`와 다르면 **경계를 넘은
   * 것**이고, 예전 계산은 그 경우를 틀렸다. 관측에 남긴다.
   */
  entryTierIndex: number | null;
  entryNotional: number | null;
  adverseDistancePct: number | null;
}

/**
 * 숫자로 읽는다. **없는 것은 null이지 0이 아니다.**
 *
 * 예전 구현은 `Number(v)`만 썼다. 그런데 `Number(null) === 0`이고
 * `Number('') === 0`이라, **빠진 값이 조용히 0이 됐다.** 0은 여기서
 * 위험한 값이다 — 빠진 유지증거금률이 0이면 청산가가 멀어지고, 빠진
 * 펀딩 상한이 0이면 예약이 0이 된다. 둘 다 fail-open이다.
 * (시험이 실제로 그 구멍을 잡았다.)
 */
const num = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 실패는 **값을 지어내지 않는다.** 모르는 칸은 null로 남는다 */
const fail = (
  code: LiquidationAssessmentCode, reason: string,
  partial: Partial<LiquidationDistanceAssessment> = {},
): LiquidationDistanceAssessment => ({
  ok: false, code, reason, trustworthy: false,
  side: null, referencePrice: null, entryPrice: null, estimatedLiquidationPrice: null,
  liquidationDistance: null, liquidationDistancePct: null, headroomKind: 'RAW',
  leverage: null, marginMode: null, tier: null,
  entryTierIndex: null, entryNotional: null, adverseDistancePct: null,
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
  // 어느 여유를 재려던 것인지는 **성공·실패와 무관하게** 남는다.
  const kind: 'RAW' | 'EFFECTIVE' = i?.headroomKind === 'EFFECTIVE' ? 'EFFECTIVE' : 'RAW';
  return { ...assessCore(i), headroomKind: kind };
}

function assessCore(
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

  // 진입가. 안 주면 마크가와 같다(포지션을 마크가에 연다고 보는 경우).
  const entry = inp.entryPrice == null ? price : num(inp.entryPrice);
  if (entry == null || entry <= 0) {
    return fail('REFERENCE_PRICE_UNUSABLE',
      `진입가가 ${String(inp.entryPrice)}입니다 — 0 이하이거나 숫자가 아닌 값으로는`
      + ' 청산가를 구하지 않습니다', { side, referencePrice: price });
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

  // ── ⑥ 유지증거금 브래킷 ──
  //
  // **추정 테이블로 때우지 않는다.** 거래소 브래킷을 못 읽었으면 거부다.
  const brackets = Array.isArray(inp.brackets) ? inp.brackets : null;
  if (!brackets || brackets.length === 0) {
    return fail('MAINTENANCE_TIER_MISSING',
      '거래소에서 유지증거금 구간(leverageBracket)을 읽지 못했습니다'
      + ' — 추정 표로 100배 청산가를 정하지 않습니다',
      { side, referencePrice: price, entryPrice: entry, leverage: lev, marginMode });
  }
  for (const t of brackets) {
    // **상한은 Infinity일 수 있다.** 마지막 구간은 위가 없다는 뜻이고,
    // 저장소의 추정 표도 실제 응답(아주 큰 수)도 그 자리를 그렇게 쓴다.
    // 여기서 유한수만 받으면 마지막 구간이 통째로 막힌다.
    const cap = Number(t?.[0]);
    const m = num(t?.[1]); const amt = num(t?.[2]);
    if (!(cap > 0) || Number.isNaN(cap)
        || m == null || amt == null || !(m >= 0 && m < 1) || amt < 0) {
      return fail('MAINTENANCE_TIER_MISSING',
        `유지증거금 구간에 쓸 수 없는 값이 있습니다 (${JSON.stringify(t)})`
        + ' — 0.4와 0.004를 헷갈리면 청산가가 통째로 달라집니다',
        { side, referencePrice: price, entryPrice: entry, leverage: lev, marginMode });
    }
    // ★ **계정별 브래킷 조정 배수(notionalCoef).**
    //
    //   바이낸스는 계정에 따라 브래킷을 조정해 줄 수 있고 그 배수를 응답에
    //   담는다. 이 저장소는 그 칸을 **버리고 있었다** — 버리는 것은 "조정이
    //   없다"는 가정과 같은데 확인한 적이 없다.
    //
    //   지금은 보존만 하고 **적용하지 않는다.** 상한/하한에 이미 반영되어
    //   오는지, 따로 곱해야 하는지 확인하지 못했기 때문이다. 대신 1이 아닌
    //   값이 오면 막는다 — 모르는 조정이 걸린 계정의 청산가를 아는 척하지
    //   않는다. 추측해서 곱하는 것보다 막는 것이 낫다.
    const coef = t?.[3];
    if (coef != null && !(Number(coef) === 1)) {
      return fail('BRACKET_COEF_UNSUPPORTED',
        `이 계정의 유지증거금 브래킷에 조정 배수(notionalCoef=${String(coef)})가 걸려 있습니다`
        + ' — 적용 방식을 확인하지 못해 추측하지 않고 막습니다',
        { side, referencePrice: price, entryPrice: entry, leverage: lev, marginMode });
    }
  }

  // ── ⑦ 청산가와 구간을 **함께** 푼다 ──
  //
  //   진입 명목가로 구간을 한 번 고르고 끝내면 틀린다. 청산가에서의
  //   명목가가 다른 구간이면 그 구간의 값으로 다시 계산해야 한다
  //   (`solveLiquidationPrice` 머리말에 실측 예가 있다). 100배에서는
  //   청산까지 0.x%만 움직이므로 경계 근처에서 실제로 일어난다.
  // **식에는 진입가를 넣는다.** 거리는 아래에서 마크가로 잰다.
  const sol = solveLiquidationPrice({
    entryPrice: entry, leverage: lev, side: side === 'LONG' ? 'buy' : 'sell',
    quantity: qty, brackets,
  });
  const crossInfo = {
    entryTierIndex: sol.entryTierIndex, entryNotional: sol.entryNotional,
  };
  if (sol.code === 'NO_SELF_CONSISTENT_TIER') {
    return fail('TIER_NOT_SELF_CONSISTENT',
      '어느 유지증거금 구간으로 계산해도 그 청산가의 명목가가 같은 구간에 들어가지'
      + ' 않습니다 — 청산가를 확정할 수 없습니다',
      { side, referencePrice: price, entryPrice: entry, leverage: lev, marginMode, ...crossInfo });
  }
  if (sol.code === 'AMBIGUOUS_TIER') {
    return fail('TIER_AMBIGUOUS',
      '두 개 이상의 유지증거금 구간이 자기일관입니다 — 어느 쪽이 실제인지'
      + ' 말할 수 없어 막습니다',
      { side, referencePrice: price, entryPrice: entry, leverage: lev, marginMode, ...crossInfo });
  }
  const liq = num(sol.liquidationPrice);
  // 해를 못 찾으면 **0을 청산가로 적지 않는다.** 0이면 LONG 청산거리가
  // 100%가 되어 가장 위험한 주문이 가장 안전해 보인다.
  if (sol.code !== 'OK' || liq == null || liq <= 0) {
    return fail('LIQUIDATION_PRICE_UNCOMPUTABLE',
      `청산가를 계산하지 못했습니다 (${sol.code}) — 0을 청산가로 읽지 않습니다`,
      { side, referencePrice: price, entryPrice: entry, leverage: lev, marginMode, ...crossInfo });
  }
  const tier: MaintenanceTier = {
    mmr: sol.mmr as number, maintAmount: sol.maintAmount as number,
    source: 'EXCHANGE_BRACKET',
    notional: sol.liquidationNotional as number,
    index: sol.tierIndex as number,
  };

  const known = {
    side, referencePrice: price, entryPrice: entry, estimatedLiquidationPrice: liq,
    leverage: lev, marginMode, tier, ...crossInfo,
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
