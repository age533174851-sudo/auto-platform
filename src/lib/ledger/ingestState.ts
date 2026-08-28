// src/lib/ledger/ingestState.ts
//
// **어디까지 읽었다고 적을 것인가.**
//
// 이 파일이 지키는 것 셋
// ──────────────────────
//   ① 성공했는데 새 이벤트가 0건인 것과, 한 번도 읽지 않은 것은 다르다
//      → 0건이어도 **"이 구간을 확인했고 새 이벤트가 없음"**을 남긴다.
//        안 남기면 그 연결은 영원히 '한 번도 읽지 않음'으로 보이고,
//        오늘 손익은 영원히 확인 불가다.
//
//   ② 읽기가 실패했으면 **덮인 지점을 전진시키지 않는다**
//      → 전진시키면 읽지 않은 구간을 읽었다고 말하는 것이 되고,
//        그 구간의 수수료·펀딩이 영원히 빠진다.
//
//   ③ 한 건이라도 적지 못했으면 그 회차도 전진시키지 않는다
//      → 다음 회차가 겹쳐서 다시 읽는다. 중복은 idempotency_key가 막는다.

export interface IngestStateInput {
  userId: string;
  connectionId: string;
  env: 'LIVE' | 'TESTNET';
  /** 지금까지 덮인 구간. 처음이면 null */
  coverage: { fromMs: number | null; toMs: number | null } | null | undefined;
  /** 이번 회차에 읽으려던 시작 지점 */
  planFromMs: number;
  /** 거래소를 읽었는가. **false면 전진하지 않는다** */
  readOk: boolean;
  /** 실패 사유. **키·값은 절대 담지 않는다** */
  readError?: string | null;
  /** 이번에 받은 이벤트의 시각 범위. 0건이면 둘 다 null */
  eventsFromMs?: number | null;
  eventsToMs?: number | null;
  written?: number;
  /** 적지 못한 건수. **하나라도 있으면 전진하지 않는다** */
  failed?: number;
  /** 알아보지 못한 종류 — 조용히 버리지 않는다 */
  skipped?: Array<{ type: string; count: number }> | null;
  nowMs: number;
}

export interface IngestStatePatch {
  /** upsert할 줄 */
  row: Record<string, any>;
  /** 덮인 지점이 전진했는가 */
  advanced: boolean;
  reason: string;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/**
 * 이번 회차의 결과 → `ledger_ingest_state`에 적을 줄.
 *
 * **언제나 줄을 만든다.** 실패했어도 "시도했고 실패했다"가 남아야
 * 운영 화면이 "한 번도 안 돌았다"와 구별할 수 있다.
 */
export function ingestStatePatchOf(i: IngestStateInput): IngestStatePatch {
  const key = {
    user_id: i.userId, connection_id: i.connectionId, env: i.env,
    last_run_at: iso(i.nowMs),
  };

  if (!i.readOk) {
    // **거래소를 못 읽었다.** 덮인 구간을 손대지 않는다 — 줄이는 것도 아니고
    // 늘리는 것도 아니다. 그대로 둔다.
    return {
      row: { ...key, last_error: (i.readError || '거래소 원장을 읽지 못했습니다').slice(0, 300) },
      advanced: false,
      reason: '읽기 실패 — 덮인 지점을 전진시키지 않습니다',
    };
  }

  const failed = Number(i.failed ?? 0);
  const written = Number(i.written ?? 0);
  const prevFrom = i.coverage?.fromMs ?? null;
  const prevTo = i.coverage?.toMs ?? null;

  // 시작 지점은 **앞으로만 넓힌다.** 뒤로 당기면 이미 읽은 옛 구간이
  // 안 읽은 것이 된다.
  const candidateFrom = i.eventsFromMs ?? i.planFromMs;
  const newFrom = prevFrom != null ? Math.min(prevFrom, candidateFrom) : candidateFrom;

  if (failed > 0) {
    // 적지 못한 사건이 있다. **그 구간을 '읽었다'고 하지 않는다.**
    return {
      row: {
        ...key,
        covered_from: iso(newFrom),
        covered_to: iso(prevTo),
        last_written: written,
        last_skipped: i.skipped?.length ? i.skipped : null,
        last_error: `${failed}건을 장부에 적지 못했습니다`,
      },
      advanced: false,
      reason: '기록 실패가 있어 덮인 지점을 전진시키지 않습니다 — 다음 회차가 겹쳐서 다시 읽습니다',
    };
  }

  // ── 성공 ──
  //
  // **이벤트가 0건이어도 전진한다.** "이 구간을 확인했고 새 이벤트가
  // 없음"이 곧 coverage 증거다. 여기서 안 적으면 거래가 없던 날은
  // 영원히 '수집된 적 없음'이 된다.
  const newTo = Math.max(prevTo ?? 0, i.eventsToMs ?? 0, i.nowMs);
  return {
    row: {
      ...key,
      covered_from: iso(newFrom),
      covered_to: iso(newTo),
      last_written: written,
      last_skipped: i.skipped?.length ? i.skipped : null,
      last_error: null,
    },
    advanced: true,
    reason: written === 0
      ? '이 구간을 확인했고 새 이벤트가 없습니다'
      : `${written}건을 적고 덮인 지점을 옮겼습니다`,
  };
}
