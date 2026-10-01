// src/lib/engine/executionCost.ts
//
// **비용을 빼기 전의 여유는 여유가 아니다.**
//
// ②가 구한 것은 거래소 브래킷·배율·마진 구조만으로 나오는 청산 여유다
// (`headroomKind: 'RAW'`). 그런데 실제로 진입하면 세 가지가 곧바로 그
// 여유를 먹는다: 수수료, 예상 체결가와 기준가의 차(슬리피지), 보유 중
// 지나갈 펀딩.
//
// 100배에서 RAW 여유는 0.6% 남짓이다. 왕복 taker 수수료만 0.08% 수준이고
// 슬리피지가 거기 더해진다 — **여유의 상당 부분**이다. 빼지 않으면
// "청산거리가 충분하다"가 사실이 아니게 된다.
//
// 세 비용을 한 숫자로 뭉개지 않는다
// ─────────────────────────────────
// `costPct` 하나만 남기면 무엇이 여유를 먹었는지 말할 수 없다. 운영자가
// 고칠 수 있는 것은 각각 다르다 — 수수료는 계정 등급, 슬리피지는 크기와
// 호가, 펀딩은 보유 시간이다. 그래서 구성 요소를 전부 남긴다.
//
// 기존 상수를 정본으로 승격하지 않는다
// ────────────────────────────────────
// `scalpSignal.roundTripCostPct = 0.15`가 이미 있고 **생산 판단에 쓰인다** —
// 신호의 목표가 그 비용보다 작으면 신호를 죽인다. 그러나 그것은 "이 자리가
// 먹을 게 있는 자리인가"라는 다른 질문이고, 숫자도 하드코딩(수수료 0.1% +
// 슬리피지 0.05%)이다. 여기서는 **계정의 실제 수수료와 실제 호가**를 쓴다.
// 두 판단을 같은 숫자로 섞지 않는다.
//
// 모르면 막는다
// ─────────────
// 수수료를 못 읽거나, 호가가 없거나, 깊이가 모자라거나, 펀딩 정보를 못
// 읽으면 거부다. **임의의 `0.05% 슬리피지` 상수를 만들지 않는다.**
//
// ★ 신선도 문턱은 여기서 만들지 않는다
//   가격이 얼마나 오래됐으면 못 쓰는가는 ④의 일이다. 여기서는 관측 시각과
//   출처를 결과에 **보존만** 한다 — ④가 그것을 검사할 수 있도록.

/** 이 주문이 호가를 먹는 쪽인가(taker) 놓는 쪽인가(maker) */
export type OrderFillKind = 'TAKER' | 'MAKER';

export interface CommissionRates {
  /** 비율이다. 0.0004 = 0.04% */
  takerRate: number;
  makerRate: number;
  /** **계정의 실제 수수료만 받는다.** 기본값 표를 출처로 인정하지 않는다 */
  source: 'EXCHANGE_ACCOUNT';
  observedAtMs: number;
}

export interface DepthBook {
  /** `[가격, 수량]`. 순서는 여기서 정렬한다 */
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  observedAtMs: number;
  source: 'EXCHANGE_DEPTH';
}

export interface FundingContext {
  /** 최근 펀딩률(비율). **부호 그대로** 받는다 */
  rate: number;
  nextFundingTimeMs: number;
  /** **8시간을 박지 않는다.** 종목·시점에 따라 다르다 */
  intervalHours: number;
  intervalSource: 'EXCHANGE_FUNDING_INFO' | 'SHORTEST_LISTED';
  observedAtMs: number;
}

export type ExecutionCostCode =
  | 'OK'
  | 'SIDE_UNKNOWN'
  | 'REFERENCE_PRICE_UNUSABLE'
  | 'QUANTITY_UNUSABLE'
  | 'LEVERAGE_UNUSABLE'
  | 'FILL_KIND_UNKNOWN'
  | 'COMMISSION_MISSING'
  | 'BOOK_MISSING'
  | 'BOOK_SIDE_EMPTY'
  | 'BOOK_CROSSED'
  | 'DEPTH_INSUFFICIENT'
  | 'FUNDING_MISSING'
  | 'FUNDING_INTERVAL_UNUSABLE'
  | 'HOLD_HORIZON_UNUSABLE'
  | 'COST_NOT_FINITE'
  | 'COST_NEGATIVE';

export interface ExecutionCostInput {
  side: 'LONG' | 'SHORT' | null | undefined;
  /** ②가 쓴 기준가(마크가). 슬리피지는 이 값과 예상 체결가의 차다 */
  referencePrice: number | null | undefined;
  quantity: number | null | undefined;
  leverage: number | null | undefined;
  /** 계약의 주문 유형에서 온다. **짐작하지 않는다** */
  fillKind: OrderFillKind | null | undefined;
  commission: CommissionRates | null | undefined;
  book: DepthBook | null | undefined;
  funding: FundingContext | null | undefined;
  nowMs: number | null | undefined;
  /** 계약이 선언한 최대 보유 시간(ms). 펀딩 평가 구간이다 */
  holdHorizonMs: number | null | undefined;
}

export interface ExecutionCostAssessment {
  ok: boolean;
  code: ExecutionCostCode;
  reason: string;
  trustworthy: boolean;

  fillKind: OrderFillKind | null;
  /** 실제로 적용한 수수료율(비율) */
  commissionRate: number | null;

  /** 체결되는 쪽 호가를 수량만큼 먹어서 구한 예상 체결가 */
  expectedFillPrice: number | null;
  notionalAtFill: number | null;

  entryFeeUsd: number | null;
  exitFeeReserveUsd: number | null;
  entrySlippageUsd: number | null;
  exitSlippageReserveUsd: number | null;
  fundingReserveUsd: number | null;
  /** 보유 구간에 지나갈 펀딩 시점 수 */
  fundingEvents: number | null;
  /**
   * 지금 관측된 펀딩 방향. **예약 금액에는 쓰지 않는다** —
   * 부호는 구간 안에서 뒤집힐 수 있어 수취를 믿지 않는다.
   */
  fundingSideNow: 'PAY' | 'RECEIVE' | 'NEUTRAL' | null;

  totalCostUsd: number | null;
  /** 체결 명목가 대비 % */
  totalCostNotionalPct: number | null;

  /** ④가 신선도를 검사할 수 있도록 **보존만** 한다 */
  bookObservedAtMs: number | null;
  fundingObservedAtMs: number | null;
  commissionObservedAtMs: number | null;
  fundingIntervalSource: FundingContext['intervalSource'] | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const fail = (
  code: ExecutionCostCode, reason: string,
  partial: Partial<ExecutionCostAssessment> = {},
): ExecutionCostAssessment => ({
  ok: false, code, reason, trustworthy: false,
  fillKind: null, commissionRate: null,
  expectedFillPrice: null, notionalAtFill: null,
  entryFeeUsd: null, exitFeeReserveUsd: null,
  entrySlippageUsd: null, exitSlippageReserveUsd: null,
  fundingReserveUsd: null, fundingEvents: null, fundingSideNow: null,
  totalCostUsd: null, totalCostNotionalPct: null,
  bookObservedAtMs: null, fundingObservedAtMs: null, commissionObservedAtMs: null,
  fundingIntervalSource: null,
  ...partial,
});

/**
 * 수량만큼 호가를 먹었을 때의 **가중평균 체결가**.
 *
 * **중간가나 마크가를 체결가처럼 쓰지 않는다.** LONG 진입은 매도호가(ask)를
 * 위로 먹고, SHORT 진입은 매수호가(bid)를 아래로 먹는다. 반대쪽을 쓰면
 * 슬리피지가 유리한 쪽으로 계산되어 비용이 사라진다.
 *
 * 깊이가 모자라면 **null이다.** 남은 수량을 마지막 호가로 채우면 "이 크기가
 * 호가에 안 들어간다"는 사실이 숫자 하나로 뭉개진다.
 */
export function vwapForEntry(
  side: 'LONG' | 'SHORT', quantity: number, book: DepthBook,
): number | null {
  const q = num(quantity);
  if (q == null || q <= 0) return null;
  const raw = side === 'LONG' ? book.asks : book.bids;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const levels = raw
    .map(l => [num(l?.[0]), num(l?.[1])] as [number | null, number | null])
    .filter((l): l is [number, number] => l[0] != null && l[1] != null && l[0] > 0 && l[1] > 0)
    // LONG은 싼 매도호가부터, SHORT은 비싼 매수호가부터 채워진다.
    .sort((a, b) => (side === 'LONG' ? a[0] - b[0] : b[0] - a[0]));
  if (levels.length === 0) return null;

  let left = q;
  let cost = 0;
  for (const [price, size] of levels) {
    const take = Math.min(left, size);
    cost += take * price;
    left -= take;
    if (left <= 0) break;
  }
  if (left > 0) return null;   // 깊이 부족
  const vwap = cost / q;
  return Number.isFinite(vwap) && vwap > 0 ? vwap : null;
}

/**
 * 이 진입의 실행·보유 비용은 얼마인가.
 *
 * **순수 함수다.** 거래소에 묻지 않는다 — 부르는 쪽이 읽어서 넘긴다.
 */
export function assessExecutionCost(
  i: ExecutionCostInput | null | undefined,
): ExecutionCostAssessment {
  const inp = i ?? ({} as ExecutionCostInput);

  const sideRaw = String(inp.side ?? '').trim().toUpperCase();
  if (sideRaw !== 'LONG' && sideRaw !== 'SHORT') {
    return fail('SIDE_UNKNOWN',
      `방향을 읽지 못했습니다 (${String(inp.side)}) — 어느 쪽 호가를 먹는지 모르면`
      + ' 슬리피지를 유리한 쪽으로 계산하게 됩니다');
  }
  const side = sideRaw as 'LONG' | 'SHORT';

  const ref = num(inp.referencePrice);
  if (ref == null || ref <= 0) {
    return fail('REFERENCE_PRICE_UNUSABLE', `기준가가 ${String(inp.referencePrice)}입니다`);
  }
  const qty = num(inp.quantity);
  if (qty == null || qty <= 0) {
    return fail('QUANTITY_UNUSABLE', `수량이 ${String(inp.quantity)}입니다`);
  }
  const lev = num(inp.leverage);
  if (lev == null || lev <= 1) {
    return fail('LEVERAGE_UNUSABLE', `배율이 ${String(inp.leverage)}입니다`);
  }

  // ── 주문 유형 → 수수료율 ──
  //
  // **짐작하지 않는다.** 시장가면 taker다. 이 값은 계약의 주문 유형에서
  // 와야 하고, 체결 방식이 불확실하면 부르는 쪽이 보수적인 쪽(taker)을
  // 넘긴다 — 여기서 고르지 않는다.
  const fillKind = inp.fillKind === 'TAKER' || inp.fillKind === 'MAKER' ? inp.fillKind : null;
  if (fillKind == null) {
    return fail('FILL_KIND_UNKNOWN',
      `주문이 호가를 먹는 쪽인지 놓는 쪽인지 알 수 없습니다 (${String(inp.fillKind)})`
      + ' — maker/taker를 임의로 고르지 않습니다');
  }

  const com = inp.commission ?? null;
  const taker = com == null ? null : num(com.takerRate);
  const maker = com == null ? null : num(com.makerRate);
  if (com == null || com.source !== 'EXCHANGE_ACCOUNT'
      || taker == null || maker == null
      || !(taker >= 0 && taker < 1) || !(maker >= 0 && maker < 1)) {
    return fail('COMMISSION_MISSING',
      '계정의 실제 수수료율을 읽지 못했습니다 — 기본값 표로 100배 비용을 정하지 않습니다',
      { fillKind });
  }
  const rate = fillKind === 'TAKER' ? taker : maker;
  const comObs = num(com.observedAtMs);

  // ── 예상 체결가 ──
  const book = inp.book ?? null;
  if (book == null || book.source !== 'EXCHANGE_DEPTH') {
    return fail('BOOK_MISSING',
      '거래소 호가를 읽지 못했습니다 — 슬리피지를 상수로 지어내지 않습니다',
      { fillKind, commissionRate: rate, commissionObservedAtMs: comObs });
  }
  const bookObs = num(book.observedAtMs);
  const base = { fillKind, commissionRate: rate, commissionObservedAtMs: comObs,
                 bookObservedAtMs: bookObs };

  const bestBid = Math.max(...(book.bids || []).map(l => num(l?.[0]) ?? -Infinity));
  const bestAsk = Math.min(...(book.asks || []).map(l => num(l?.[0]) ?? Infinity));
  const needSide = side === 'LONG' ? book.asks : book.bids;
  if (!Array.isArray(needSide) || needSide.length === 0) {
    return fail('BOOK_SIDE_EMPTY',
      `${side} 진입이 먹어야 하는 ${side === 'LONG' ? '매도' : '매수'}호가가 비어 있습니다`,
      base);
  }
  // 호가가 교차한 책은 **쓰지 않는다.** 그런 응답으로 계산하면 음수
  // 슬리피지가 나오고, 그건 비용이 아니라 이익처럼 읽힌다.
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && !(bestAsk > bestBid)) {
    return fail('BOOK_CROSSED',
      `매수호가 ${bestBid}가 매도호가 ${bestAsk}보다 낮지 않습니다 — 교차한 호가로 계산하지 않습니다`,
      base);
  }

  const fill = vwapForEntry(side, qty, book);
  if (fill == null) {
    return fail('DEPTH_INSUFFICIENT',
      `호가 깊이가 수량 ${qty}를 받지 못합니다 — 모자란 만큼을 마지막 호가로 채우지 않습니다`
      + ' (그러면 "이 크기가 호가에 안 들어간다"는 사실이 사라집니다)',
      base);
  }
  const notional = fill * qty;

  // ── 슬리피지 ──
  //
  // **유리한 쪽은 0으로 깎는다.** LONG이 기준가보다 싸게 체결될 것 같다는
  // 예상을 안전 여유로 더하면, 그 예상이 틀린 날 청산된다.
  const adverse = side === 'LONG' ? fill - ref : ref - fill;
  const entrySlippageUsd = Math.max(0, adverse) * qty;
  // 나갈 때의 호가는 **아직 모른다.** 진입에서 **관측한** 충격과 같은
  // 크기를 예약한다 — 지어낸 상수가 아니라 측정값이다.
  const exitSlippageReserveUsd = entrySlippageUsd;

  // ── 수수료 ──
  const entryFeeUsd = notional * rate;
  // 나갈 때의 명목가는 모른다. 진입 명목가를 대리값으로 쓴다 — 청산 쪽으로
  // 갈수록 명목가가 작아지므로 이 대리값은 **보수적**이다(LONG 기준).
  const exitFeeReserveUsd = notional * rate;

  // ── 펀딩 ──
  const f = inp.funding ?? null;
  const now = num(inp.nowMs);
  const horizon = num(inp.holdHorizonMs);
  const withFee = { ...base, expectedFillPrice: fill, notionalAtFill: notional,
                    entryFeeUsd, exitFeeReserveUsd, entrySlippageUsd, exitSlippageReserveUsd };
  if (f == null) {
    return fail('FUNDING_MISSING', '펀딩 정보를 읽지 못했습니다', withFee);
  }
  const fRate = num(f.rate);
  const nextAt = num(f.nextFundingTimeMs);
  const intervalH = num(f.intervalHours);
  const fObs = num(f.observedAtMs);
  if (fRate == null || nextAt == null || nextAt <= 0) {
    return fail('FUNDING_MISSING',
      `펀딩률(${String(f.rate)}) 또는 다음 펀딩 시각(${String(f.nextFundingTimeMs)})을 읽지 못했습니다`,
      { ...withFee, fundingObservedAtMs: fObs });
  }
  if (intervalH == null || !(intervalH > 0) || intervalH > 24) {
    // **8시간을 박지 않는다.** 못 읽었으면 막는다.
    return fail('FUNDING_INTERVAL_UNUSABLE',
      `펀딩 주기가 ${String(f.intervalHours)}시간입니다 — 8시간으로 가정하지 않습니다`,
      { ...withFee, fundingObservedAtMs: fObs, fundingIntervalSource: f.intervalSource ?? null });
  }
  if (now == null || horizon == null || !(horizon > 0)) {
    return fail('HOLD_HORIZON_UNUSABLE',
      `보유 평가 구간을 정할 수 없습니다 (지금 ${String(inp.nowMs)} · 구간 ${String(inp.holdHorizonMs)})`,
      { ...withFee, fundingObservedAtMs: fObs });
  }

  // 구간 안에 **앞으로** 지나갈 펀딩 시점을 센다.
  //
  // ★ `nextFundingTimeMs`가 과거일 수 있다(응답이 낡았거나 시계가 어긋남).
  //   그대로 세면 **이미 지나간 펀딩**까지 센다 — 실제로 시험 픽스처에서
  //   그 일이 났고, 비용이 명목가의 10%로 나왔다. 지금 이후의 첫 시점으로
  //   끌어올린 뒤 센다. 얼마나 낡은 것을 못 쓸 것인가는 ④의 일이므로
  //   여기서 시간 문턱을 만들지는 않는다.
  const stepMs = intervalH * 3_600_000;
  const until = now + horizon;
  let first = nextAt;
  if (first < now) {
    const skipped = Math.ceil((now - first) / stepMs);
    first = first + skipped * stepMs;
  }
  let events = 0;
  for (let t = first; t <= until; t += stepMs) {
    events += 1;
    // 터무니없는 입력에서 멈추지 않는 일이 없게 한다.
    if (events > 1_000) break;
  }
  const fundingSideNow: 'PAY' | 'RECEIVE' | 'NEUTRAL' =
    fRate === 0 ? 'NEUTRAL' : (side === 'LONG' ? fRate > 0 : fRate < 0) ? 'PAY' : 'RECEIVE';
  // **수취 예상치로 위험한 진입을 통과시키지 않는다.** 부호는 구간 안에서
  // 뒤집힐 수 있으므로 크기만 예약한다 — 방향은 관측에만 남긴다.
  const fundingReserveUsd = events * Math.abs(fRate) * notional;

  const parts = [entryFeeUsd, exitFeeReserveUsd, entrySlippageUsd,
                 exitSlippageReserveUsd, fundingReserveUsd];
  if (!parts.every(v => Number.isFinite(v))) {
    return fail('COST_NOT_FINITE', '비용 구성 요소 중 숫자가 아닌 것이 있습니다',
      { ...withFee, fundingObservedAtMs: fObs });
  }
  const totalCostUsd = parts.reduce((a, b) => a + b, 0);
  if (!(totalCostUsd >= 0)) {
    return fail('COST_NEGATIVE', `총 비용이 ${totalCostUsd}입니다 — 비용이 음수일 수 없습니다`,
      { ...withFee, fundingObservedAtMs: fObs });
  }

  return {
    ok: true, code: 'OK', reason: '', trustworthy: true,
    ...withFee,
    fundingReserveUsd, fundingEvents: events, fundingSideNow,
    fundingObservedAtMs: fObs,
    fundingIntervalSource: f.intervalSource ?? null,
    totalCostUsd,
    totalCostNotionalPct: (totalCostUsd / notional) * 100,
  };
}

// ── 비용을 청산 계산에 **연결한다** ─────────────────────────
//
// **퍼센트끼리 빼지 않는다.**
//
// `raw청산거리% − 비용%`는 회계가 아니다. 비용이 실제로 하는 일은 두 가지다:
//
//   ① 슬리피지는 **진입가를 옮긴다.** 청산가 식의 `entryPrice`가 마크가가
//      아니라 예상 체결가여야 한다.
//   ② 수수료·펀딩은 **격리 증거금을 줄인다.** 격리 포지션의 청산 조건은
//      `증거금 + 미실현손익 = 유지증거금`이고, 수수료와 펀딩은 그 증거금
//      쪽에서 빠진다.
//
// ②를 식에 넣는 방법: 청산가 식의 `1/leverage`는 곧 `증거금/명목가`다.
// 증거금이 비용만큼 줄었으면 그 비율이 커진 것이고, 그것은 **배율이 오른
// 것과 같다.** 그래서 `실효배율 = 명목가 / (증거금 − 비용)`을 구해 같은
// 식에 넣는다 — 근사가 아니라 **줄어든 증거금을 대입한 것과 동일하다.**
//
// 전제: 수수료·펀딩이 격리 포지션의 증거금에서 빠진다. 지갑에서 빠지고
// 포지션 증거금은 그대로라면 이 계산은 **더 보수적**이다(여유를 덜 준다).
// 보수적인 쪽으로 틀리는 것은 받아들인다.

export type EffectiveMarginCode =
  | 'OK'
  | 'COST_NOT_ASSESSED'
  | 'MARGIN_UNUSABLE'
  | 'COST_EXCEEDS_MARGIN';

export interface EffectiveMargin {
  code: EffectiveMarginCode;
  reason: string;
  /** 비용 전 격리 증거금 */
  marginAtEntryUsd: number | null;
  /** 비용을 뺀 뒤 남는 증거금 */
  marginAfterCostUsd: number | null;
  /** 그 증거금이 뜻하는 배율. 청산가 식에 그대로 넣는다 */
  effectiveLeverage: number | null;
  /** 청산 계산에 쓸 진입가 — 마크가가 아니라 예상 체결가다 */
  effectiveEntryPrice: number | null;
}

/**
 * 비용을 반영한 **증거금과 배율**. 청산거리는 이 값으로 다시 푼다.
 */
export function effectiveMarginAfterCost(
  cost: ExecutionCostAssessment | null | undefined,
  leverage: number | null | undefined,
): EffectiveMargin {
  const no = (code: EffectiveMarginCode, reason: string,
              p: Partial<EffectiveMargin> = {}): EffectiveMargin => ({
    code, reason, marginAtEntryUsd: null, marginAfterCostUsd: null,
    effectiveLeverage: null, effectiveEntryPrice: null, ...p,
  });
  if (!cost || cost.ok !== true) {
    return no('COST_NOT_ASSESSED',
      `비용을 확정하지 못했습니다 (${cost?.code ?? '판정 없음'}) — 실질 여유를 계산할 수 없습니다`);
  }
  const lev = num(leverage);
  const notional = num(cost.notionalAtFill);
  const total = num(cost.totalCostUsd);
  const fill = num(cost.expectedFillPrice);
  if (lev == null || lev <= 1 || notional == null || notional <= 0
      || total == null || total < 0 || fill == null || fill <= 0) {
    return no('MARGIN_UNUSABLE',
      `증거금을 계산할 값이 모자랍니다 (배율 ${String(leverage)} · 명목가 ${String(notional)}`
      + ` · 비용 ${String(total)})`);
  }
  const marginAtEntryUsd = notional / lev;
  const marginAfterCostUsd = marginAtEntryUsd - total;
  if (!(marginAfterCostUsd > 0)) {
    // 비용이 증거금을 통째로 먹는다. 진입 즉시 청산 구간이다.
    return no('COST_EXCEEDS_MARGIN',
      `예상 비용 $${total.toFixed(6)}가 격리 증거금 $${marginAtEntryUsd.toFixed(6)}를`
      + ' 넘거나 같습니다 — 들어가는 순간 증거금이 남지 않습니다',
      { marginAtEntryUsd, marginAfterCostUsd, effectiveEntryPrice: fill });
  }
  return {
    code: 'OK', reason: '',
    marginAtEntryUsd, marginAfterCostUsd,
    effectiveLeverage: notional / marginAfterCostUsd,
    effectiveEntryPrice: fill,
  };
}
