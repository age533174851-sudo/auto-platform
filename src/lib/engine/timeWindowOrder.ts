// src/lib/engine/timeWindowOrder.ts
//
// **시간 분할 주문** (내부 이름 TIME_WINDOW_ORDER / TWAP)
//
//   BTC 시간 분할 매수
//   10:00 → 14:00 · 1,000 USDT · 15분마다 → 약 16회
//
// 기존 예약과 무엇이 다른가
// ─────────────────────────
//   가격 예약   BTC가 60,000이 되면 산다        — 조건 하나, 한 번
//   시간 예약   오후 3시에 산다                  — 시각 하나, 한 번
//   시간 분할   3시~6시 사이에 나눠서 산다        — 구간, 여러 번
//   DCA        매주 금요일마다                   — 무기한 반복
//
// 이 파일이 막으려는 것
// ─────────────────────
//  1. **놓친 조각을 몰아서 내는 것.** 10:00·10:15·10:30 예정인데
//     실행기가 10:10~10:40 죽어 있었다면, 10:40에 세 개를 한꺼번에
//     내면 안 된다. 그건 "네 시간에 걸쳐 나눠 산다"는 이 주문의 뜻을
//     정면으로 어긴다 — 한 번에 사려고 했으면 애초에 분할을 안 했다.
//     **이건 모의 세션의 따라잡기 금지와 같은 규칙이다.**
//  2. 같은 조각이 재시도로 두 번 나가는 것
//  3. 시세를 못 읽는데 시장가로 내는 것
//  4. 취소했다고 이미 체결된 것을 되돌리는 것
//  5. 브라우저 타이머로 도는 것 — 앱을 닫으면 절반만 사고 멈춘다

export type Side = 'BUY' | 'SELL';

/**
 * 누가 이 주문을 만들었는가.
 *
 * **실행 엔진은 하나지만 기록은 나눈다.** 수동 시간분할과 전략 TWAP을
 * 각자 다른 코드로 만들면 한쪽만 고치는 버그가 계속 난다. 반대로
 * 기록까지 섞으면 "내가 산 것"과 "전략이 산 것"을 구분할 수 없어서
 * 성과 분석이 통째로 뜻을 잃는다.
 */
export type OrderSource = 'MANUAL' | 'STRATEGY' | 'DCA' | 'SCHEDULED';

export const SOURCE_LABEL: Record<OrderSource, string> = {
  MANUAL: '직접 예약', STRATEGY: '전략', DCA: '적립', SCHEDULED: '예약',
};

export type SliceMode =
  /** 똑같이 나눈다 */
  | 'UNIFORM'
  /** 앞쪽을 크게 */
  | 'FRONT_LOADED'
  /** 뒤쪽을 크게 */
  | 'BACK_LOADED';

export const SLICE_MODE_LABEL: Record<SliceMode, string> = {
  UNIFORM: '균등', FRONT_LOADED: '초반 집중', BACK_LOADED: '후반 집중',
};

/**
 * 호가·체결량을 보고 크기를 바꾸는 방식.
 *
 * **아직 넣지 않는다.** 유동성이 좋을 때 더 많이 체결한다는 것은
 * 그럴듯하지만, 실제 호가 품질을 재 본 적이 없으면 "좋아 보일 때"의
 * 기준 자체가 추측이다. 테스트넷에서 슬리피지·부분체결을 실제로
 * 재고 나서 붙인다.
 */
export const SMART_LIQUIDITY_NOTE =
  '유동성 기반 분할은 아직 없습니다 — 실제 호가·체결 품질을 재 보기 전에는'
  + ' "좋을 때"의 기준이 추측이라, 나눠 사는 것이 아니라 몰아 사는 것이 될 수 있습니다';

export type RunStatus =
  | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'PARTIALLY_EXECUTED'
  | 'COMPLETED' | 'CANCELED' | 'BLOCKED' | 'ERROR';

export type SliceStatus =
  | 'PENDING' | 'SUBMITTING' | 'FILLED' | 'PARTIAL'
  | 'SKIPPED' | 'CANCELED' | 'UNKNOWN' | 'ERROR';

/** 놓친 조각을 어떻게 할 것인가 */
export type MissedSlicePolicy =
  /** 건너뛴다. **기본값** */
  | 'SKIP'
  /** 남은 구간에 다시 나눈다 */
  | 'RESCHEDULE_REMAINING';

export const DEFAULT_MISSED_POLICY: MissedSlicePolicy = 'SKIP';

function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface WindowPlanInput {
  startAtMs: any;
  endAtMs: any;
  /** 간격으로 나눌 때 */
  intervalMinutes?: any;
  /**
   * 횟수로 나눌 때.
   *
   * 사용자는 "10분마다"로도 "총 12번"으로도 생각한다. 둘 다 받고
   * 나머지는 계산해 준다 — 사용자가 나눗셈을 하게 만들지 않는다.
   */
  sliceCount?: any;
  /** 총 금액 또는 총 수량 중 하나 */
  totalNotional?: any;
  totalQuantity?: any;
  sliceMode?: SliceMode;
}

export interface PlannedSlice {
  /** 몇 번째 (0부터) */
  index: number;
  scheduledAtMs: number;
  /** 이 조각의 몫. 총량 대비 비율 */
  weight: number;
  notional: number | null;
  quantity: number | null;
}

export interface WindowPlan {
  ok: boolean;
  slices: PlannedSlice[];
  count: number;
  /** 1회 평균 */
  perSliceNotional: number | null;
  perSliceQuantity: number | null;
  reason: string;
  warnings: string[];
}

/** 조각이 이보다 많으면 수수료가 이익을 먹는다 */
export const MAX_SLICES = 500;

/**
 * 구간을 조각으로 나눈다.
 *
 * **끝 시각을 넘겨서 내지 않는다.** "14시까지"라고 했으면 14시 이후에는
 * 아무것도 나가면 안 된다 — 사용자가 그 시각 이후의 시장을 원치 않는다는
 * 뜻이고, 넘겨서 사면 그건 다른 주문이다.
 */
export function planWindow(input: WindowPlanInput | null | undefined): WindowPlan {
  const i = input ?? ({} as WindowPlanInput);
  const start = num(i.startAtMs);
  const end = num(i.endAtMs);
  const wantCount = num(i.sliceCount);
  const notional = num(i.totalNotional);
  const qty = num(i.totalQuantity);
  const mode: SliceMode = i.sliceMode ?? 'UNIFORM';
  const warnings: string[] = [];

  const bad = (reason: string): WindowPlan =>
    ({ ok: false, slices: [], count: 0, perSliceNotional: null, perSliceQuantity: null, reason, warnings });

  // ── 간격으로 받았는가, 횟수로 받았는가 ──
  //
  // 사용자는 "10분마다"로도 "총 12번"으로도 생각한다. 둘 다 받고
  // 나머지는 계산해 준다 — 사용자가 나눗셈을 하게 만들지 않는다.
  let iv = num(i.intervalMinutes);
  if (iv === null && wantCount !== null && start !== null && end !== null && end > start) {
    if (wantCount < 1) return bad('분할 횟수가 1보다 작습니다');
    // 마지막 조각이 종료 시각에 딱 떨어지도록 (count-1)로 나눈다.
    // count로 나누면 마지막 조각이 구간을 넘어간다.
    iv = wantCount === 1 ? (end - start) / 60_000 : (end - start) / (wantCount - 1) / 60_000;
  }

  if (start === null || end === null) return bad('시작·종료 시각을 읽지 못했습니다');
  if (end <= start) return bad('종료가 시작보다 빠르거나 같습니다');
  if (iv === null || iv <= 0) return bad('실행 간격이나 분할 횟수 중 하나는 있어야 합니다');
  if (notional === null && qty === null) {
    return bad('총 금액이나 총 수량 중 하나는 있어야 합니다 — 둘 다 없으면 얼마를 나눌지 알 수 없습니다');
  }
  if ((notional !== null && notional <= 0) || (qty !== null && qty <= 0)) {
    return bad('총량이 0 이하입니다');
  }

  const stepMs = iv * 60_000;
  // 시작 시각에 한 번 내고, 그 뒤로 간격마다. **끝 시각을 넘지 않는다.**
  const count = Math.floor((end - start) / stepMs) + 1;
  if (count < 1) return bad('구간이 간격보다 짧아 한 번도 나눌 수 없습니다');
  if (count > MAX_SLICES) {
    return bad(`분할이 ${count}회로 너무 많습니다 (최대 ${MAX_SLICES}회) —`
      + ' 조각이 잘게 쪼개질수록 수수료가 이익을 먹습니다. 간격을 늘리세요');
  }
  if (count === 1) {
    warnings.push('한 번에 다 나갑니다 — 분할이 아니라 예약 주문과 같습니다. 간격을 줄이거나 구간을 늘리세요');
  }

  // ── 몫 나누기 ──
  //
  // 균등이 기본이다. 초반/후반 집중은 선형 가중으로, 합이 1이 되게 맞춘다.
  const raw: number[] = [];
  for (let k = 0; k < count; k++) {
    if (mode === 'FRONT_LOADED') raw.push(count - k);
    else if (mode === 'BACK_LOADED') raw.push(k + 1);
    else raw.push(1);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map(r => r / sum);

  const slices: PlannedSlice[] = weights.map((w, k) => ({
    index: k,
    scheduledAtMs: start + k * stepMs,
    weight: w,
    notional: notional !== null ? notional * w : null,
    quantity: qty !== null ? qty * w : null,
  }));

  return {
    ok: true, slices, count,
    perSliceNotional: notional !== null ? notional / count : null,
    perSliceQuantity: qty !== null ? qty / count : null,
    reason: '', warnings,
  };
}

// ── 놓친 조각 ─────────────────────────────────────────────

export interface MissedVerdict {
  /** 지금 내야 하는 조각의 index들 */
  dueNow: number[];
  /** 시각이 지나 버려 건너뛴 조각 */
  skipped: number[];
  /** **언제나 false.** 몰아서 내지 않는다 */
  catchUp: false;
  note: string;
}

/**
 * 실행기가 잠시 멈췄다 깨어났다. 무엇을 낼 것인가.
 *
 * **놓친 것을 몰아서 내지 않는다.**
 *
 * 10:00·10:15·10:30 예정인데 10:10~10:40 죽어 있었다면, 10:40에 세 개를
 * 한꺼번에 내는 것은 "네 시간에 걸쳐 나눠 산다"는 이 주문의 뜻을 정면으로
 * 어긴다. 한 번에 사려고 했으면 애초에 분할을 안 했다. 그리고 몰아서
 * 내는 순간 시장 충격도 세 배가 된다.
 *
 * `catchUp`을 리터럴 `false` 타입으로 둔 것은 실수 방지다 —
 * 나중에 "밀린 것 처리" 옵션을 붙이려 하면 타입에서 먼저 막힌다.
 *
 * @param graceMs 조금 늦은 것까지는 지금 것으로 본다. 1초 늦었다고
 *                건너뛰면 정상 실행이 계속 사라진다.
 */
export function missedSliceVerdict(
  slices: PlannedSlice[] | null | undefined,
  doneIndexes: number[] | null | undefined,
  nowMs: any,
  policy: MissedSlicePolicy = DEFAULT_MISSED_POLICY,
  graceMs = 60_000,
): MissedVerdict {
  const list = Array.isArray(slices) ? slices : [];
  const done = new Set(Array.isArray(doneIndexes) ? doneIndexes : []);
  const now = num(nowMs);

  if (now === null) {
    return { dueNow: [], skipped: [], catchUp: false,
      note: '지금 시각을 몰라 아무 조각도 내지 않습니다' };
  }

  const dueNow: number[] = [];
  const skipped: number[] = [];

  for (const s of list) {
    if (done.has(s.index)) continue;
    if (s.scheduledAtMs > now) continue;          // 아직 아니다
    if (now - s.scheduledAtMs <= graceMs) {
      dueNow.push(s.index);                        // 지금 것
    } else {
      skipped.push(s.index);                       // 지나갔다
    }
  }

  // **지금 낼 것은 하나뿐이다.** 여러 개가 동시에 due로 잡히면 그건
  // 이미 몰아서 내는 것이다 — 가장 최근 하나만 낸다.
  const pick = dueNow.length > 0 ? [dueNow[dueNow.length - 1]] : [];
  const extra = dueNow.slice(0, -1);
  skipped.push(...extra);
  skipped.sort((a, b) => a - b);

  const note = skipped.length === 0 ? ''
    : policy === 'SKIP'
      ? `${skipped.length}개 조각의 시각이 지나 건너뜁니다 — 몰아서 내면`
        + ' 나눠 사려던 뜻이 사라지고 시장 충격도 그만큼 커집니다'
      : `${skipped.length}개 조각을 건너뛰고, 남은 금액은 남은 구간에 다시 나눕니다`;

  return { dueNow: pick, skipped, catchUp: false, note };
}

// ── 이 조각을 지금 내도 되는가 ────────────────────────────

export interface SliceGateInput {
  side: Side;
  /** 지금 시세 */
  price?: any;
  /** 시세가 최신인가 */
  priceFresh?: boolean | null;
  /** 매수 가격 상한 */
  maxPrice?: any;
  /** 매도 가격 하한 */
  minPrice?: any;
  /** 아직 결과를 모르는 앞 조각이 있는가 */
  hasUnresolved?: boolean | null;
  /** 장이 열려 있는가. 코인은 항상 true */
  marketOpen?: boolean | null;
}

export interface SliceGate {
  allow: boolean;
  /** 건너뛸 뿐인가(SKIP), 아예 막힌 것인가(BLOCK) */
  action: 'SUBMIT' | 'SKIP' | 'BLOCK';
  reason: string;
}

/**
 * 이 조각을 지금 내도 되는가.
 *
 * **시세를 못 읽으면 시장가로 내지 않는다.** 얼마에 살지 모르는 채
 * 시장가를 내는 것은 가격 상한을 정한 사용자의 뜻과 정반대다.
 *
 * **결과를 모르는 앞 조각이 있으면 새 조각을 내지 않는다.** 그 조각이
 * 사실은 체결됐다면 같은 자리를 두 번 사게 된다.
 */
export function sliceGate(input: SliceGateInput | null | undefined): SliceGate {
  const i = input ?? ({} as SliceGateInput);

  if (i.marketOpen === false) {
    return { allow: false, action: 'SKIP', reason: '장이 닫혀 있어 이 조각을 건너뜁니다' };
  }
  if (i.hasUnresolved === true) {
    return { allow: false, action: 'BLOCK',
      reason: '앞 조각의 결과를 아직 모릅니다 — 그 조각이 사실은 체결됐다면'
        + ' 같은 자리를 두 번 사게 됩니다. 대조가 끝난 뒤에 냅니다' };
  }

  const price = num(i.price);
  if (i.priceFresh === false) {
    return { allow: false, action: 'BLOCK',
      reason: '시세가 끊겼습니다 — 얼마에 살지 모르는 채로 시장가를 내면'
        + ' 가격 상한을 정한 뜻과 정반대가 됩니다' };
  }
  if (price === null) {
    return { allow: false, action: 'BLOCK', reason: '시세를 읽지 못해 이 조각을 내지 않습니다' };
  }

  const maxP = num(i.maxPrice), minP = num(i.minPrice);
  if (i.side === 'BUY' && maxP !== null && price > maxP) {
    return { allow: false, action: 'SKIP',
      reason: `현재가 ${price}가 상한 ${maxP}보다 높아 이 조각을 건너뜁니다` };
  }
  if (i.side === 'SELL' && minP !== null && price < minP) {
    return { allow: false, action: 'SKIP',
      reason: `현재가 ${price}가 하한 ${minP}보다 낮아 이 조각을 건너뜁니다` };
  }

  return { allow: true, action: 'SUBMIT', reason: '' };
}

// ── 같은 조각이 두 번 나가지 않게 ─────────────────────────

/**
 * 이 조각의 주문 열쇠.
 *
 * **조각 번호가 들어간다.** 시각으로 만들면 재시도할 때마다 달라져서
 * 같은 조각이 여러 번 나간다.
 */
export function sliceOrderKey(runId: any, index: any): string | null {
  const r = String(runId ?? '').trim();
  const n = num(index);
  if (!r || n === null || !Number.isInteger(n) || n < 0) return null;
  return `${r}#s${n}`;
}

// ── 취소 ──────────────────────────────────────────────────

export interface CancelPlan {
  /** 취소할 조각 */
  cancelIndexes: number[];
  /** **언제나 false.** 이미 체결된 것을 되돌리지 않는다 */
  unwindFilled: false;
  note: string;
}

/**
 * 취소하면 무엇이 일어나는가.
 *
 * **이미 산 것을 자동으로 되팔지 않는다.** 사용자가 "그만 사자"고 한
 * 것이지 "산 것을 물러 달라"고 한 것이 아니다. 되팔면 그 자체가 새
 * 주문이고, 손실을 확정시키며, 사용자는 시키지도 않은 매도를 보게 된다.
 */
export function cancelPlanOf(
  slices: PlannedSlice[] | null | undefined,
  doneIndexes: number[] | null | undefined,
): CancelPlan {
  const list = Array.isArray(slices) ? slices : [];
  const done = new Set(Array.isArray(doneIndexes) ? doneIndexes : []);
  const remaining = list.filter(s => !done.has(s.index)).map(s => s.index);

  return {
    cancelIndexes: remaining, unwindFilled: false,
    note: done.size > 0
      ? `남은 ${remaining.length}개만 취소합니다 — 이미 체결된 ${done.size}개는 그대로 둡니다.`
        + ' 되팔면 시키지도 않은 매도가 나가고 손실이 확정됩니다'
      : `${remaining.length}개를 모두 취소합니다 (체결된 것 없음)`,
  };
}

// ── 진행 상황 ─────────────────────────────────────────────

export interface Progress {
  doneCount: number;
  totalCount: number;
  filledNotional: number | null;
  remainingNotional: number | null;
  avgFillPrice: number | null;
  nextAtMs: number | null;
  note: string;
}

/**
 * 얼마나 진행됐는가.
 *
 * **평균 체결가는 체결된 조각만으로 낸다.** 아직 안 산 조각을 0으로
 * 세면 평균이 바닥으로 내려간다.
 */
export function progressOf(
  plan: WindowPlan | null | undefined,
  fills: Array<{ index: number; filledNotional?: any; avgPrice?: any }> | null | undefined,
  nowMs: any,
): Progress {
  const slices = plan?.slices ?? [];
  const list = Array.isArray(fills) ? fills : [];
  const now = num(nowMs);

  const usable = list.filter(f => num(f.filledNotional) !== null && num(f.avgPrice) !== null);
  const filledNotional = usable.length > 0
    ? usable.reduce((a, f) => a + (num(f.filledNotional) as number), 0) : null;

  // 금액 가중 평균. 조각마다 산 금액이 다르므로 단순 평균은 틀린다.
  const avgFillPrice = usable.length > 0 && filledNotional !== null && filledNotional > 0
    ? usable.reduce((a, f) =>
        a + (num(f.avgPrice) as number) * (num(f.filledNotional) as number), 0) / filledNotional
    : null;

  const total = slices.reduce((a, s) => a + (s.notional ?? 0), 0);
  const doneIdx = new Set(list.map(f => f.index));
  const next = now === null ? null
    : slices.filter(s => !doneIdx.has(s.index) && s.scheduledAtMs > now)
        .sort((a, b) => a.scheduledAtMs - b.scheduledAtMs)[0]?.scheduledAtMs ?? null;

  return {
    doneCount: list.length,
    totalCount: slices.length,
    filledNotional,
    remainingNotional: filledNotional !== null && total > 0 ? Math.max(0, total - filledNotional) : null,
    avgFillPrice,
    nextAtMs: next,
    note: list.length > usable.length
      ? `체결 정보를 못 읽은 조각이 ${list.length - usable.length}개 있어 평균 체결가에서 뺐습니다`
      : '',
  };
}

// ── 수동 분할청산 ────────────────────────────────────────

export interface ReduceOnlyCheck {
  ok: boolean;
  /** 강제로 켜야 하는가 */
  forceReduceOnly: boolean;
  /** 실제로 청산할 총 수량 */
  cappedQuantity: number | null;
  reason: string;
}

/**
 * 포지션을 나눠서 닫을 때.
 *
 * **두 가지를 강제한다:**
 *
 *   1. `reduceOnly`를 켠다. 안 켜면 마지막 조각이 나갈 때쯤 포지션이
 *      이미 다른 이유로 닫혀 있을 수 있고(손절이 먼저 걸렸다든가),
 *      그러면 그 조각이 **반대 포지션을 새로 연다.** 닫으려던 사람이
 *      정반대 방향 포지션을 갖게 된다
 *   2. 보유 수량을 넘지 못하게 한다. 0.2 갖고 0.3을 분할청산하면
 *      나머지 0.1이 신규 진입이 된다
 *
 * 보유 수량을 못 읽으면 **막는다.** 얼마를 갖고 있는지 모르는 채로
 * 청산 주문을 쪼개 내보내면, 넘치는 만큼이 그대로 신규 진입이다.
 */
export function reduceOnlyCheck(
  requestedQty: any,
  positionQty: any,
  isClosing: boolean,
): ReduceOnlyCheck {
  if (!isClosing) {
    return { ok: true, forceReduceOnly: false, cappedQuantity: num(requestedQty), reason: '' };
  }

  const req = num(requestedQty);
  const pos = num(positionQty);

  if (pos === null) {
    return { ok: false, forceReduceOnly: true, cappedQuantity: null,
      reason: '보유 수량을 읽지 못해 분할청산을 시작하지 않습니다 —'
        + ' 얼마를 갖고 있는지 모르는 채로 쪼개 내면 넘치는 만큼이 신규 진입이 됩니다' };
  }
  if (pos <= 0) {
    return { ok: false, forceReduceOnly: true, cappedQuantity: null,
      reason: '청산할 포지션이 없습니다' };
  }
  if (req === null || req <= 0) {
    return { ok: false, forceReduceOnly: true, cappedQuantity: null,
      reason: '청산 수량을 읽지 못했습니다' };
  }

  if (req > pos) {
    return { ok: true, forceReduceOnly: true, cappedQuantity: pos,
      reason: `보유 ${pos}보다 많은 ${req}를 청산하려 했습니다 — 보유량까지만 닫습니다.`
        + ' 넘치는 만큼은 반대 포지션을 새로 여는 것이라 자동으로 자릅니다' };
  }

  return { ok: true, forceReduceOnly: true, cappedQuantity: req, reason: '' };
}

export const REDUCE_ONLY_NOTE =
  '분할청산은 언제나 reduceOnly로 나갑니다 — 안 켜면 마지막 조각이 나갈 때쯤'
  + ' 포지션이 이미 닫혀 있을 수 있고, 그러면 그 조각이 반대 포지션을 새로 엽니다';

export const RUNTIME_NOTE =
  '시간 분할 주문은 브라우저 타이머로 돌리지 않습니다 — 앱을 닫으면 절반만 사고 멈추고,'
  + ' 그 사이 시장이 어디로 갔는지도 모릅니다. 서버 실행기가 필요합니다';
