// src/lib/ledger/coverageWindow.ts
//
// **"지금 이 순간까지 덮였는가"는 주기적 수집기가 만족할 수 없는 조건이다.**
//
// 확정된 root cause
// ─────────────────
// 지갑은 이렇게 물었다:
//
//   ledgerCovers({ coverage, periodFromMs: 오늘0시, periodToMs: Date.now() })
//   → if (coverage.toMs < periodToMs) 불완전
//
// 그런데 `covered_to`는 **마지막 수집 시각**이고, 수집은 15분마다 돈다
// (`LEDGER_SYNC_INTERVAL_MS`). 즉 지갑이 요청하는 시각 T와 마지막 수집
// 시각 S 사이에는 항상 0~15분의 차이가 있다.
//
//   covered_to(S) < now(T)   ← T > S인 한 언제나 참
//
// 그래서 연결이 정상이고 매 회차 수집이 성공해도 **오늘 손익과 매매손익은
// 영원히 "확인 불가"다.** 수집기를 아무리 고쳐도 이 판정으로는 값이 나올
// 수 없다. 사고가 아니라 판정식의 문제다.
//
// 어떻게 바꾸나
// ─────────────
// 질문을 바꾼다. "지금까지 덮였는가"가 아니라
// **"오늘 중 어디까지 덮였는가"**를 묻는다.
//
//   asOf = min(활성 연결들의 covered_to)
//
// 그리고 손익은 `[오늘 0시, asOf]` 구간에서만 계산하고, 화면은 **그
// 기준 시각을 같이 말한다.** 덮이지 않은 구간을 덮었다고 하지 않으면서도
// 값이 나온다.
//
// **허용 오차로 풀지 않는다.** "15분쯤 모자란 건 봐준다"로 하면, 그
// 15분의 수수료·펀딩이 빠진 채로 합계가 '완전'하다고 확정된다. 빠진
// 비용은 전부 수익으로 보인다 — 이 저장소가 계속 잡아 온 그 고장이다.
//
// 여전히 못 하는 것
// ─────────────────
// 한 번도 읽지 않은 연결이 있으면 **아무 값도 만들지 않는다.**
// `ledger_ingest_state`가 없다는 것을 "손익 0"으로 바꾸지 않는다.
import type { IngestStateRow } from './coverageSet';

/**
 * 이만큼 뒤처지면 "부분 자료"라고 말한다.
 *
 * 수집 주기(15분)의 3배다. 한두 회차를 건너뛴 것과 수집기가 멈춘 것을
 * 가르는 선이다. **값을 감추지는 않는다** — 다만 언제 기준인지 말한다.
 */
export const LEDGER_LAG_STALE_MS = 45 * 60_000;

export type LedgerWindowCode =
  /** 활성 연결 목록을 못 읽었다. **연결이 없다는 뜻이 아니다** */
  | 'CONNECTIONS_UNKNOWN'
  /** 수집 상태를 못 읽었다 */
  | 'INGEST_UNKNOWN'
  /** 이 환경에 활성 연결이 없다 */
  | 'NO_CONNECTION'
  /** 한 번도 원장을 읽지 않은 연결이 있다 */
  | 'MISSING_CONNECTIONS'
  /** 오늘 시작 이전 구간이 덮이지 않은 연결이 있다 */
  | 'BEFORE_DAY_START'
  /** 오늘 구간이 아직 한 뼘도 덮이지 않았다 */
  | 'NOT_COVERED_TODAY'
  /** `asOfMs`까지 모든 활성 연결이 덮었다 */
  | 'COVERED';

export interface LedgerWindow {
  code: LedgerWindowCode;
  /** 손익을 계산해도 되는가 */
  usable: boolean;
  /** 계산 구간의 끝. **usable일 때만 값이 있다** */
  asOfMs: number | null;
  /** 지금과 asOf의 차이. 화면이 "몇 분 전 기준"을 말할 수 있게 한다 */
  lagMs: number | null;
  /** 많이 뒤처졌는가. **값을 감추지 않고 부분 자료임을 명시한다** */
  stale: boolean;
  /** 한 번도 읽지 않은 연결 */
  missing: string[];
  /** 오늘 앞부분을 못 덮는 연결 */
  partial: string[];
  /** 수집 상태는 있는데 지금은 활성이 아닌 연결 — 판정에서 뺀다 */
  inactive: string[];
  reason: string;
}

const idsOf = (v: any): string[] =>
  (Array.isArray(v) ? v : []).map(x => String(x ?? '')).filter(Boolean);

const minsAgo = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/**
 * 오늘 손익을 **어디까지** 말해도 되는가.
 *
 * 못 말하는 경우와 부분만 말하는 경우를 가른다. 어느 쪽도 0이 아니다.
 */
export function ledgerWindowOf(i: {
  /** 이 환경의 활성 연결 id. **못 읽었으면 null** */
  expected: string[] | null | undefined;
  /** 수집 상태 행. **못 읽었으면 null** */
  states: IngestStateRow[] | null | undefined;
  /** 오늘 0시 */
  dayStartMs: number;
  nowMs: number;
  /** 뒤처짐 판정 기준. 시험에서 바꿔 넣을 수 있게 밖으로 뺀다 */
  staleAfterMs?: number;
}): LedgerWindow {
  const base = { asOfMs: null, lagMs: null, stale: false,
    missing: [] as string[], partial: [] as string[], inactive: [] as string[] };

  if (i?.expected == null) {
    return { ...base, code: 'CONNECTIONS_UNKNOWN', usable: false,
      reason: '거래소 연결 목록을 읽지 못했습니다 — 무엇을 수집해야 하는지 모르므로 '
        + '손익을 만들지 않습니다' };
  }
  if (i?.states == null) {
    return { ...base, code: 'INGEST_UNKNOWN', usable: false,
      reason: '원장 수집 상태를 읽지 못했습니다 — 수집되지 않았다는 뜻도, '
        + '손익이 0이라는 뜻도 아닙니다' };
  }

  const expected = idsOf(i.expected);
  if (expected.length === 0) {
    return { ...base, code: 'NO_CONNECTION', usable: false,
      reason: '이 환경에 활성 거래소 연결이 없습니다 — 대조할 원장이 없습니다' };
  }

  const byId = new Map<string, IngestStateRow>();
  for (const s of (Array.isArray(i.states) ? i.states : [])) {
    const id = String(s?.connectionId ?? '');
    if (id) byId.set(id, s);
  }
  const inactive = Array.from(byId.keys()).filter(id => !expected.includes(id));

  const missing: string[] = [];
  const partial: string[] = [];
  let asOf: number | null = null;

  for (const id of expected) {
    const row = byId.get(id);
    // **행이 없는 것과, 행은 있는데 한 번도 성공하지 못한 것은 같다.**
    // `covered_to`는 성공했을 때만 전진한다 — 실패 회차는 `last_error`만 남긴다.
    if (!row || row.fromMs == null || row.toMs == null) { missing.push(id); continue; }
    // 오늘 앞부분이 비어 있으면 오늘 손익을 만들 수 없다.
    if (row.fromMs > i.dayStartMs) { partial.push(id); continue; }
    asOf = asOf == null ? row.toMs : Math.min(asOf, row.toMs);
  }

  if (missing.length > 0) {
    return { ...base, code: 'MISSING_CONNECTIONS', usable: false, missing, partial, inactive,
      reason: `연결 ${missing.length}개는 거래소 원장을 한 번도 읽지 못했습니다 `
        + `(활성 ${expected.length}개 중) — 그 연결의 수수료·펀딩이 빠지면 `
        + '그만큼이 전부 수익으로 보입니다' };
  }
  if (partial.length > 0) {
    return { ...base, code: 'BEFORE_DAY_START', usable: false, missing, partial, inactive,
      reason: `연결 ${partial.length}개는 오늘 시작 이전 구간이 장부에 없습니다 — `
        + '그 기간의 수수료·펀딩을 모르면 오늘 손익을 만들 수 없습니다' };
  }

  // **덮인 지점을 지금보다 앞으로 끌어올리지 않는다.**
  const end = Math.min(asOf as number, i.nowMs);
  if (end <= i.dayStartMs) {
    return { ...base, code: 'NOT_COVERED_TODAY', usable: false, missing, partial, inactive,
      reason: '오늘 구간이 아직 수집되지 않았습니다 — 다음 수집 회차가 지나면 값이 생깁니다' };
  }

  const lagMs = Math.max(0, i.nowMs - end);
  const stale = lagMs > (i.staleAfterMs ?? LEDGER_LAG_STALE_MS);
  return {
    code: 'COVERED', usable: true, asOfMs: end, lagMs, stale,
    missing, partial, inactive,
    reason: stale
      ? `${minsAgo(lagMs)}분 전까지의 자료입니다 — 그 뒤 구간은 아직 수집되지 않았습니다`
      : `${minsAgo(lagMs)}분 전 기준입니다`,
  };
}
