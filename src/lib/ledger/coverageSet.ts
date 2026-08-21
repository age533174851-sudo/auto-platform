// src/lib/ledger/coverageSet.ts
//
// **있는 행만 검사하면, 없는 행은 영원히 통과한다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 지갑의 "오늘 매매손익"은 이 환경의 모든 연결이 오늘 구간을 다 읽었을
// 때만 숫자를 만든다. 그 판정이 이렇게 돼 있었다:
//
//   const rows = ledger_ingest_state에서 읽은 행
//   complete = rows.every(r => 이 행이 오늘을 덮는가)
//
// `every()`는 **배열에 있는 것만 본다.** 연결이 셋인데 수집 상태 행이
// 하나뿐이면, 그 하나가 오늘을 덮는 순간 `every()`는 참이다. 나머지 두
// 연결은 **한 번도 수집된 적이 없는데 검사에 아예 등장하지 않는다.**
//
// 그러면 화면에는 "오늘 구간이 모두 덮여 있습니다"가 뜨고, 수집 안 된
// 두 연결의 수수료와 펀딩이 통째로 빠진 매매손익이 숫자로 확정된다.
// 빠진 비용은 전부 수익으로 보인다.
//
// 이 저장소가 반복해서 잡아 온 고장과 같은 모양이다 —
// **없는 것을 0으로 읽는다.** 여기서는 "없는 행을 통과로 읽는다"다.
//
// 어떻게 바꾸나
// ─────────────
// **기대 집합과 덮인 집합을 대조한다.** 활성 연결 목록이 기대 집합이고,
// 수집 상태 행이 덮인 집합이다. 기대에 있는데 덮이지 않은 것이 하나라도
// 있으면 완전하지 않다. 그리고 **기대 집합 자체를 못 읽었으면** 완전하다고
// 말하지 않는다 — 빈 목록과 못 읽은 것은 다르다.

import { ledgerCovers } from './incomeIngest';

export interface IngestStateRow {
  connectionId: string;
  fromMs: number | null;
  toMs: number | null;
}

export type CoverageCode =
  /** 모든 활성 연결이 이 구간을 덮는다 */
  | 'COMPLETE'
  /** 활성 연결 목록을 못 읽었다. **연결이 없다는 뜻이 아니다** */
  | 'CONNECTIONS_UNKNOWN'
  /** 수집 상태를 못 읽었다 */
  | 'INGEST_UNKNOWN'
  /** 이 환경에 활성 연결이 없다 */
  | 'NO_CONNECTION'
  /** 수집 상태 행이 아예 없는 연결이 있다 — **예전 검사가 놓치던 것** */
  | 'MISSING_CONNECTIONS'
  /** 행은 있는데 구간을 다 못 덮는 연결이 있다 */
  | 'PARTIAL_PERIOD';

export interface CoverageVerdict {
  complete: boolean;
  code: CoverageCode;
  /** 기대 집합에 있는데 수집 상태 행이 없는 연결 */
  missing: string[];
  /** 행은 있는데 구간을 못 덮는 연결 */
  partial: string[];
  /** 수집 상태는 있는데 지금은 활성이 아닌 연결 — 완전성 판정에서 뺀다 */
  stale: string[];
  reason: string;
}

const idsOf = (v: any): string[] =>
  (Array.isArray(v) ? v : []).map(x => String(x ?? '')).filter(Boolean);

/**
 * 이 구간이 완전히 수집되었는가.
 *
 * **`expected`가 null이면 완전하다고 말하지 않는다.** 연결 목록 조회가
 * 실패한 것을 "연결 0개"로 읽으면, 대조할 것이 없으니 언제나 통과한다.
 * 그건 `/api/ledger/sync`가 없는 칸 이름 하나 때문에 한 건도 수집하지
 * 않으면서 조용히 성공하던 것과 정확히 같은 고장이다.
 */
export function ledgerCompleteness(i: {
  /** 이 환경의 활성 연결 id. **못 읽었으면 null** */
  expected: string[] | null | undefined;
  /** 수집 상태 행. **못 읽었으면 null** */
  states: IngestStateRow[] | null | undefined;
  periodFromMs: number;
  periodToMs: number;
}): CoverageVerdict {
  const base = { missing: [] as string[], partial: [] as string[], stale: [] as string[] };

  if (i?.expected == null) {
    return { ...base, complete: false, code: 'CONNECTIONS_UNKNOWN',
      reason: '거래소 연결 목록을 읽지 못했습니다 — 무엇을 수집해야 하는지 모르므로 '
        + '완전하다고 말하지 않습니다' };
  }
  const expected = idsOf(i.expected);

  if (i?.states == null) {
    return { ...base, complete: false, code: 'INGEST_UNKNOWN',
      reason: '수집 상태를 읽지 못했습니다 — 완전하다는 뜻이 아닙니다' };
  }
  const states = Array.isArray(i.states) ? i.states : [];

  if (expected.length === 0) {
    // **여기서 complete: true로 두면 안 된다.** 대조할 것이 없다는 이유로
    // 통과시키면, 연결이 사라진 상태에서 매매손익이 확정된다.
    return { ...base, complete: false, code: 'NO_CONNECTION',
      reason: '이 환경에 활성 거래소 연결이 없습니다 — 대조할 원장이 없습니다' };
  }

  const byId = new Map<string, IngestStateRow>();
  for (const s of states) {
    const id = String(s?.connectionId ?? '');
    if (id) byId.set(id, s);
  }

  const missing: string[] = [];
  const partial: string[] = [];
  const reasons: string[] = [];

  for (const id of expected) {
    const row = byId.get(id);
    if (!row) { missing.push(id); continue; }
    const c = ledgerCovers({
      coverage: { fromMs: row.fromMs ?? null, toMs: row.toMs ?? null },
      periodFromMs: i.periodFromMs, periodToMs: i.periodToMs,
    });
    if (!c.complete) { partial.push(id); reasons.push(c.reason); }
  }

  // 비활성이 된 옛 연결. **완전성 판정에 넣지 않는다** — 이미 안 쓰는
  // 연결이 옛 구간에 머물러 있다고 오늘 손익을 막을 이유는 없다.
  const stale = Array.from(byId.keys()).filter(id => !expected.includes(id));

  if (missing.length > 0) {
    return { complete: false, code: 'MISSING_CONNECTIONS', missing, partial, stale,
      reason: `연결 ${missing.length}개는 거래소 원장을 한 번도 읽지 않았습니다 `
        + `(활성 ${expected.length}개 중) — 그 연결의 수수료·펀딩이 빠지면 `
        + '그만큼이 전부 수익으로 보입니다' };
  }
  if (partial.length > 0) {
    return { complete: false, code: 'PARTIAL_PERIOD', missing, partial, stale,
      reason: reasons[0] ?? '일부 구간이 덮이지 않았습니다' };
  }
  return { complete: true, code: 'COMPLETE', missing, partial, stale,
    reason: `활성 연결 ${expected.length}개 모두 이 구간을 덮고 있습니다` };
}
