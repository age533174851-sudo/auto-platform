// src/lib/runtime/heartbeatVerify.ts
//
// **"요청이 성공했다"와 "행이 갱신됐다"는 다른 사실이다.**
//
// 워커의 heartbeat는 이랬다:
//
//     const { error } = await sb().from('worker_heartbeat').upsert(full, ...);
//     if (!error) { noteHeartbeatOk(...); return; }
//
// `error`가 없으면 `[heartbeat] ok`를 찍는다. **방금 쓴 줄을 다시 읽어
// 보지는 않는다.**
//
// 그래서 이런 상태가 만들어진다 — 실제로 만들어졌다:
//
//   Fly 로그        8/23 현재 `[heartbeat] ok ... target=1351b7` 반복
//   같은 DB의 표    최신 줄이 8/21 · version 0a3a5cf · alive=false
//
// 둘 다 참일 수 있다. PostgREST에서 **RLS가 UPDATE를 막으면 오류가 아니라
// 0행**이다. upsert는 충돌 시 UPDATE 경로로 가므로, 행이 이미 있고 그
// 행이 정책상 보이지 않으면 **아무 일도 안 일어나고 200이 돌아온다.**
//
// 022는 네 표에 RLS를 켜면서 `TO service_role` 정책만 만들었다. 워커의
// `SUPABASE_SERVICE_ROLE_KEY`가 진짜 service_role이면 RLS를 우회하므로
// 문제가 없다. **anon/publishable 키가 들어가 있으면 정확히 위 모양이
// 된다** — 키가 틀렸다는 신호가 어디에도 안 뜬 채로.
//
// 그래서 쓰고 나서 읽는다
// ───────────────────────
//   1. upsert에 `.select()`를 붙여 **몇 행이 돌아왔는지** 본다
//   2. 같은 client로 그 worker_id를 **다시 읽어** last_seen·version을 대조한다
//
// 둘 다 통과해야 `ok`다. 하나라도 어긋나면 그 사실을 이름 붙여 말한다.
//
// 판정은 여기 있고 테스트가 붙는다. 워커는 사실만 모아서 넘긴다.

export type HeartbeatCode =
  | 'RECORDED'          // 썼고, 돌아왔고, 다시 읽어도 같다
  | 'WRITE_FAILED'      // upsert가 오류를 돌려줬다
  | 'WRITE_NOT_VISIBLE' // 오류는 없는데 **0행이다** — RLS/권한이 조용히 막았다
  | 'READBACK_FAILED'   // 다시 읽지 못했다. **못 읽은 것은 틀린 것이 아니다**
  | 'READBACK_MISSING'  // 다시 읽었는데 그 worker_id가 없다
  | 'READBACK_STALE';   // 있는데 방금 쓴 값이 아니다

export interface HeartbeatVerifyInput {
  /** 이번에 쓰려 한 값 */
  expected: { workerId: string; lastSeen: string; version: string | null };
  /** upsert가 돌려준 오류 (없으면 null) */
  writeError: string | null;
  /**
   * upsert가 `.select()`로 돌려준 행 수.
   *
   * **null은 "세지 못했다"이지 0이 아니다.** `.select()`를 못 붙이는
   * 경로(칸 없음 재시도 등)에서는 null이 온다.
   */
  returnedRows: number | null;
  /** 다시 읽기가 실패했으면 사유 */
  readError: string | null;
  /** 다시 읽은 행. 없으면 null */
  readRow: { worker_id?: string; last_seen?: string | null; version?: string | null } | null;
}

export interface HeartbeatVerdict {
  code: HeartbeatCode;
  ok: boolean;
  /** 로그 한 줄 */
  message: string;
  /**
   * 서비스 키가 진짜 쓰기 권한인지에 대한 의심.
   * **단정하지 않는다** — 0행은 여러 이유로 나올 수 있다.
   */
  suspectKey: boolean;
}

/** 시각 문자열을 비교 가능한 수로. 못 읽으면 null */
function ms(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * 판정. **순수 함수.**
 *
 * 통과는 `RECORDED` 하나뿐이다. 나머지는 전부 "썼다고 말하면 안 되는"
 * 상태다 — 확인하지 못한 것도 포함한다.
 */
export function heartbeatVerdict(i: HeartbeatVerifyInput): HeartbeatVerdict {
  if (i.writeError) {
    return {
      code: 'WRITE_FAILED', ok: false, suspectKey: false,
      message: `heartbeat 쓰기 실패: ${String(i.writeError).slice(0, 200)}`,
    };
  }

  // **오류 없이 0행.** PostgREST에서 RLS가 UPDATE를 막으면 이 모양이다.
  if (i.returnedRows === 0) {
    return {
      code: 'WRITE_NOT_VISIBLE', ok: false, suspectKey: true,
      message: 'heartbeat upsert가 오류 없이 0행을 돌려줬습니다 — 요청은 성공했지만 행이 갱신되지 않았습니다.'
        + ' RLS가 UPDATE를 막았을 때 나오는 모양입니다 (SUPABASE_SERVICE_ROLE_KEY가 service_role이 아닐 수 있습니다).',
    };
  }

  if (i.readError) {
    return {
      code: 'READBACK_FAILED', ok: false, suspectKey: false,
      message: `heartbeat를 다시 읽지 못했습니다: ${String(i.readError).slice(0, 200)}`
        + ' — 못 읽은 것은 안 써진 것과 다릅니다. 다음 주기에 다시 봅니다.',
    };
  }

  if (!i.readRow) {
    return {
      code: 'READBACK_MISSING', ok: false, suspectKey: true,
      message: `방금 쓴 worker_id(${i.expected.workerId})를 다시 읽었는데 행이 없습니다`
        + ' — 쓰기가 성공했다고 보고됐지만 실제로는 남지 않았습니다.',
    };
  }

  const wroteAt = ms(i.expected.lastSeen);
  const sawAt = ms(i.readRow.last_seen ?? null);
  // **읽은 값이 우리가 쓴 값보다 오래됐으면** 다른 쓰기가 이겼거나
  // 우리 쓰기가 반영되지 않은 것이다. 같거나 더 최신이면 통과다
  // (워커가 여럿이면 더 최신일 수 있다 — 그건 정상이다).
  if (wroteAt != null && sawAt != null && sawAt < wroteAt) {
    return {
      code: 'READBACK_STALE', ok: false, suspectKey: true,
      message: `다시 읽은 last_seen이 방금 쓴 값보다 오래됐습니다`
        + ` (쓴 값 ${i.expected.lastSeen}, 읽은 값 ${i.readRow.last_seen}) — 쓰기가 반영되지 않았습니다.`,
    };
  }
  if (wroteAt != null && sawAt == null) {
    return {
      code: 'READBACK_STALE', ok: false, suspectKey: true,
      message: '다시 읽은 행에 last_seen이 없습니다 — 쓰기가 반영되지 않았습니다.',
    };
  }

  // 버전은 **있을 때만** 본다. 054 이전 배포에는 칸 자체가 없다.
  if (i.expected.version && i.readRow.version !== undefined && i.readRow.version !== null
      && i.readRow.version !== i.expected.version) {
    return {
      code: 'READBACK_STALE', ok: false, suspectKey: false,
      message: `다시 읽은 version이 다릅니다 (쓴 값 ${i.expected.version.slice(0, 7)},`
        + ` 읽은 값 ${String(i.readRow.version).slice(0, 7)}) — 다른 워커가 같은 worker_id로 쓰고 있거나 쓰기가 반영되지 않았습니다.`,
    };
  }

  return {
    code: 'RECORDED', ok: true, suspectKey: false,
    message: '기록 확인됨 (다시 읽어 대조했습니다)',
  };
}

/**
 * `https://<ref>.supabase.co` → `<ref>`
 *
 * **6자 지문이 같다는 것만으로 같은 DB라고 단정하지 않기 위해** 같이
 * 남긴다. 공개 URL의 일부라 비밀이 아니다. 모르는 모양이면 null —
 * 지어내지 않는다.
 */
export function projectRefOf(url: string | null | undefined): string | null {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) return null;
  try {
    const host = new URL(u).hostname;
    const m = /^([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * 접속 문자열(`postgresql://…`)에서 Supabase project ref를 뽑는다.
 *
 * **비밀번호도 호스트도 내보내지 않는다.** ref만 돌려준다.
 * 두 가지 모양을 받는다:
 *
 *   직접   `db.<ref>.supabase.co`
 *   풀러   사용자 이름이 `postgres.<ref>` (호스트는 aws-0-…pooler.supabase.com)
 */
export function projectRefFromPostgresUrl(dbUrl: string | null | undefined): string | null {
  const raw = String(dbUrl ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname || '';
    const direct = /^db\.([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host);
    if (direct) return direct[1];
    const user = decodeURIComponent(u.username || '');
    const pooled = /^postgres\.([a-z0-9-]+)$/i.exec(user);
    if (pooled) return pooled[1];
    const anyHost = /^([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host);
    if (anyHost && anyHost[1] !== 'db') return anyHost[1];
    return null;
  } catch { return null; }
}

/**
 * 두 곳이 같은 프로젝트를 보고 있는가.
 *
 * **모르면 null이다.** 한쪽이라도 ref를 모르면 "같다"고 적지 않는다.
 */
export function sameProject(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  return a === b;
}
