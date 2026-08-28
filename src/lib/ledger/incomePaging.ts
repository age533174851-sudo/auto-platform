// src/lib/ledger/incomePaging.ts
//
// **"한 페이지를 읽었다"는 "그 구간을 다 읽었다"가 아니다.**
//
// 발견된 구멍
// ───────────
//   Binance  getFuturesIncome(startTime, limit)   ← 단일 요청. endTime·page 없음
//   Gate     getGateAccountBook(from, limit)      ← 단일 요청
//
// 그런데 성공 경로는 응답이 limit만큼 꽉 차 있어도 `covered_to`를 지금까지
// 전진시켰다:
//
//   실제 1,200건 → 첫 페이지 1,000건 → 1,000건 기록 성공
//   → covered_to = NOW → **나머지 200건은 영원히 안 읽힌다**
//   → 지갑은 "이 구간까지 덮임"이라고 믿는다
//
// 이건 중복보다 나쁘다. 빠진 수수료는 전부 수익으로 보인다.
//
// 문서를 믿지 않고 응답을 본다
// ────────────────────────────
// 두 거래소의 공식 문서는 이 환경에서 열리지 않는다(egress 차단). 그래서
// **검증하지 못한 파라미터를 추가하지 않는다** — `page`·`offset`·`endTime`을
// 상상해서 붙이면 계약을 지어내는 것이고, 그건 이 저장소가 계속 잡아 온
// 고장과 같은 종류다.
//
// 대신 **이미 쓰고 있어 동작이 확인된 파라미터**(`startTime`/`from` + `limit`)만
// 쓰고, 정렬은 **응답에서 직접 확인한다.** 문서가 뭐라고 하든 그 페이지가
// 실제로 오름차순이면 그 사실이 증거다.
//
//   오름차순 + 포화  → 가장 오래된 limit개를 받은 것이다.
//                      `max(time)` **직전까지는** 빠짐없이 받았다 →
//                      다음 창을 `max(time)`부터 다시 읽어 끝까지 훑는다
//   내림차순 + 포화  → 가장 새로운 limit개를 받은 것이다.
//                      **옛 끝이 비어 있고, from만으로는 거기 닿을 수 없다** →
//                      전진 금지. 그 사실을 진단에 적는다
//   뒤죽박죽 + 포화  → 아무것도 증명할 수 없다 → 전진 금지
//
// 거래소마다 따로 판정한다. 한쪽의 규칙을 다른 쪽에 복사하지 않는다 —
// 이 함수는 **그 응답**만 보고 답한다.

/** 한 회차에 훑을 페이지 상한. 라우트의 maxDuration(60초) 안에 들어와야 한다 */
export const MAX_PAGES_PER_RUN = 8;

export type PageOrder =
  /** 셀 것이 없다 */
  | 'EMPTY'
  /** 한 건뿐이라 방향을 말할 수 없다 */
  | 'SINGLE'
  /** 시각이 증가한다 (같은 값 허용) */
  | 'ASCENDING'
  /** 시각이 감소한다 (같은 값 허용) */
  | 'DESCENDING'
  /** 오르내린다 — 순서를 믿을 수 없다 */
  | 'UNORDERED';

/**
 * 이 페이지의 시각 정렬. **응답이 증거다.**
 *
 * 한 방향으로만 움직여야 그 방향이라고 말한다. 한 번이라도 반대로 가면
 * `UNORDERED`다 — "대체로 오름차순"은 증명이 아니다.
 */
export function pageOrderOf(times: Array<number | null | undefined>): PageOrder {
  const t = (Array.isArray(times) ? times : [])
    .map(Number).filter(n => Number.isFinite(n));
  if (t.length === 0) return 'EMPTY';
  if (t.length === 1) return 'SINGLE';
  let up = false, down = false;
  for (let i = 1; i < t.length; i += 1) {
    if (t[i] > t[i - 1]) up = true;
    else if (t[i] < t[i - 1]) down = true;
  }
  if (up && down) return 'UNORDERED';
  if (up) return 'ASCENDING';
  if (down) return 'DESCENDING';
  return 'SINGLE';   // 전부 같은 시각 — 방향이 없다
}

export type PageCode =
  /** limit에 못 미쳤다 — 이 구간을 다 읽었다 */
  | 'COMPLETE'
  /** 포화 + 오름차순. 다음 창으로 전진해 계속 읽는다 */
  | 'ADVANCE'
  /** 포화인데 시각이 안 움직인다 (같은 시각에 limit개 이상) */
  | 'STUCK'
  /** 포화인데 정렬을 증명하지 못했다 — 전진 금지 */
  | 'UNPROVEN';

export interface PageVerdict {
  code: PageCode;
  order: PageOrder;
  /** 다음 요청의 시작 시각. `ADVANCE`일 때만 값이 있다 */
  nextFromMs: number | null;
  /**
   * **여기까지는 빠짐없이 읽었다고 말할 수 있는 시각.**
   *
   * `COMPLETE`면 null이다 — 부르는 쪽이 '지금까지'로 채운다.
   * 포화면 절대 '지금'이 아니다.
   */
  provenThroughMs: number | null;
  /** 완전 수집으로 기록해도 되는가 */
  complete: boolean;
  reason: string;
}

/**
 * 이 페이지로 무엇을 말할 수 있는가.
 *
 * **`rows.length >= limit`이면 그 구간을 다 읽었다는 증거가 없다.**
 */
export function pageVerdictOf(i: {
  times: Array<number | null | undefined>;
  /** 이번 요청에 실은 limit */
  limit: number;
  /** 이번 창의 시작 시각 */
  windowFromMs: number;
}): PageVerdict {
  const times = (Array.isArray(i?.times) ? i.times : [])
    .map(Number).filter(n => Number.isFinite(n));
  const limit = Number(i?.limit);
  const order = pageOrderOf(times);

  // 상한이 이상하면 포화 여부를 판정할 수 없다 — 완전하다고 하지 않는다.
  if (!Number.isFinite(limit) || limit <= 0) {
    return { code: 'UNPROVEN', order, nextFromMs: null, provenThroughMs: null, complete: false,
      reason: '요청 상한을 알 수 없어 이 구간을 다 읽었는지 판정하지 못했습니다' };
  }

  if (times.length < limit) {
    return { code: 'COMPLETE', order, nextFromMs: null, provenThroughMs: null, complete: true,
      reason: '' };
  }

  // ── 포화 ──
  if (order === 'ASCENDING') {
    const maxT = times[times.length - 1];
    if (!(maxT > i.windowFromMs)) {
      // 같은 시각에 limit개 이상이 몰려 있다. 창을 옮겨도 제자리다 —
      // **같은 첫 페이지를 무한히 다시 읽는 구조를 만들지 않는다.**
      return { code: 'STUCK', order, nextFromMs: null, provenThroughMs: null, complete: false,
        reason: `한 시각에 ${limit}건 이상이 몰려 있어 창을 옮길 수 없습니다` };
    }
    return {
      code: 'ADVANCE', order, nextFromMs: maxT,
      // **`maxT`에 있는 사건은 잘렸을 수 있다.** 그 직전까지만 증명된다.
      provenThroughMs: maxT - 1,
      complete: false,
      reason: '',
    };
  }

  if (order === 'SINGLE') {
    // 페이지 전체가 **같은 시각**이다(또는 상한이 1이다). 창을 그 시각으로
    // 옮겨도 같은 사건들을 다시 받는다 — 전진할 수 없다.
    // **같은 첫 페이지를 무한히 다시 읽는 구조를 만들지 않는다.**
    return { code: 'STUCK', order, nextFromMs: null, provenThroughMs: null, complete: false,
      reason: `한 시각에 ${limit}건 이상이 몰려 있어 창을 옮길 수 없습니다` };
  }

  if (order === 'DESCENDING') {
    // 가장 새로운 limit개를 받았다 — 비어 있는 쪽은 **옛 끝**이다.
    // 시작 시각(from)만으로는 거기 닿을 수 없다. 전진하지 않는다.
    return { code: 'UNPROVEN', order, nextFromMs: null, provenThroughMs: null, complete: false,
      reason: `응답이 상한(${limit})에 닿았고 최신순이라 옛 구간이 잘렸습니다 — `
        + '시작 시각만으로는 그 구간에 닿을 수 없습니다' };
  }

  return { code: 'UNPROVEN', order, nextFromMs: null, provenThroughMs: null, complete: false,
    reason: `응답이 상한(${limit})에 닿았는데 시각 정렬을 증명하지 못했습니다 (${order})` };
}

export interface DrainState {
  /** 지금까지 모은 모든 페이지의 시각 */
  pages: number;
  /** 이 회차를 완전 수집으로 기록해도 되는가 */
  complete: boolean;
  /** 완전하지 않을 때, 빠짐없이 읽었다고 말할 수 있는 시각 */
  provenThroughMs: number | null;
  reason: string;
}

/**
 * 페이지 상한에 걸려 끝까지 못 읽었다.
 *
 * **여기서 '완전'이라고 적지 않는다.** 다음 회차가 `provenThroughMs`부터
 * 이어 읽으므로 제자리걸음이 아니다 — 전진하되 거짓말하지 않는다.
 */
export function pageBudgetExhausted(provenThroughMs: number | null): DrainState {
  return {
    pages: MAX_PAGES_PER_RUN, complete: false, provenThroughMs,
    reason: `한 회차 페이지 상한(${MAX_PAGES_PER_RUN})에 걸려 이 구간을 다 읽지 못했습니다 — `
      + '다음 회차가 이어서 읽습니다',
  };
}
