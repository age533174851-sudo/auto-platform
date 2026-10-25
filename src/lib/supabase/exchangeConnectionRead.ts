// src/lib/supabase/exchangeConnectionRead.ts
//
// **연결을 읽는 두 자리가 서로 다른 칸을 읽던 문제를 한 곳으로 모은다.**
//
// 무엇이 있었나
// ─────────────
// 워커가 `exchange_connections`를 `select('*')`로 읽던 것을 전송량 때문에
// "쓰는 칸만"으로 좁혔다. 그런데 좁히는 자리가 **둘**이었다:
//
//   · `getConnection()`      — 여덟 칸 (`encrypted_secret` 포함)
//   · `monitorConnections()` — 일곱 칸 (`encrypted_secret` **빠짐**)
//
// 자격증명을 푸는 코드는 이렇게 생겼다:
//
//   secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '')
//
// `encrypted_secret`에만 비밀이 든 **구 버전 연결**(`api_secret_enc`는
// 004의 기본값 `''`)은 monitorConnections에서 `secret === ''`가 되고,
// 바로 다음 줄 `if (!key || !secret) continue;`에 걸려 **조용히 빠진다.**
//
// 그래서 그 연결만 잃는 것
// ────────────────────────
//   · Ghost Sync — 거래소에서 사라진 포지션 경고
//   · **킬스위치 자가복구** — Vercel이 job 생성에 실패했을 때 워커가
//     KILL_SWITCH_EXECUTE를 만들어 주는 자리
//
// 보호 경로다. 전송량을 아끼려다 보호를 끈 셈이고, 이건 #388이 스스로
// 적어 둔 원칙("포지션 보호는 끊지 않는다")에 정면으로 어긋난다.
//
// 그래서 칸 목록을 **값 하나**로 둔다. 읽는 자리가 셋이 되어도 갈라질 수
// 없다 — 이 저장소가 반복해서 당한 "경로가 둘인데 한쪽만 고침"이다.

/**
 * 워커가 `exchange_connections`에서 **실제로 읽는 칸 전부.**
 *
 * `select('*')`로 돌아가지 않는다 — 3초 주기 조회에서 쓰지 않는 칸과
 * 암호문까지 전송량이 된다. 대신 칸이 빠지는 쪽도 막아야 한다:
 * 빠진 칸은 오류가 아니라 **`undefined`**로 와서 조용히 틀린다.
 *
 * 칸을 더 읽게 되면 여기에만 적는다.
 *
 * **한 줄 문자열이어야 한다** — 이어 붙이면 supabase-js의 타입 추론이
 * 끊겨 행 타입이 `GenericStringError`로 무너진다(jobs 조회에서 겪었다).
 */
export const EXCHANGE_CONNECTION_COLUMNS =
  'id, user_id, exchange_id, api_key, api_secret_enc, encrypted_secret, is_testnet, has_withdrawal';

/**
 * 자격증명을 푸는 데 반드시 있어야 하는 칸.
 *
 * `api_secret_enc`는 004의 기본값이 `''`라 **비어 있는 것이 정상**이다.
 * 그럴 때 비밀은 `encrypted_secret`에 있다(063). 둘 중 하나라도 빠지면
 * 구 버전 연결이 자격증명 없는 연결로 보인다.
 */
export const CREDENTIAL_COLUMNS = ['api_key', 'api_secret_enc', 'encrypted_secret'] as const;

export type ConnectionReadCode = 'FOUND' | 'NOT_FOUND' | 'READ_FAILED';

export type ConnectionRead = {
  code: ConnectionReadCode;
  /** `FOUND`일 때만 채운다. 나머지는 null이다. */
  conn: any | null;
  reason: string;
};

/**
 * 연결 한 건 조회의 결과를 판정한다.
 *
 * **못 읽은 것을 "연결 없음"으로 적지 않는다.**
 *
 * 예전 워커는 이렇게 썼다:
 *
 *   const conn = await getConnection(job.connection_id);
 *   if (!conn) { await finalize(job, false, null, '연결 없음'); continue; }
 *
 * `finalize(..., false, ...)`는 잡을 **FAILED로 영구 종료**한다. 그래서
 * 조회가 한 번 실패하면 — RLS 일시 오류든, 마이그레이션 063이 아직 안 간
 * 환경에서 `encrypted_secret` 칸이 없든 — **청산·킬스위치 잡이 "연결 없음"
 * 이라는 틀린 사유로 죽는다.** 연결은 멀쩡히 있는데.
 *
 * 세 가지는 서로 다른 사실이다:
 *   · FOUND       — 읽었고, 있다
 *   · NOT_FOUND   — 읽었고, 없다 (잡을 끝내도 되는 유일한 경우)
 *   · READ_FAILED — **못 읽었다.** 있는지 없는지 모른다
 */
export function connectionReadVerdict(res: { data?: any; error?: any } | null | undefined): ConnectionRead {
  if (!res) {
    return { code: 'READ_FAILED', conn: null, reason: '연결 조회가 아무 응답도 돌려주지 않았습니다' };
  }
  if (res.error) {
    const msg = String(res.error?.message ?? res.error ?? '알 수 없는 오류');
    return { code: 'READ_FAILED', conn: null, reason: `연결 조회 실패 — ${msg}` };
  }
  if (res.data == null) {
    return { code: 'NOT_FOUND', conn: null, reason: '연결이 존재하지 않습니다' };
  }
  return { code: 'FOUND', conn: res.data, reason: '연결을 읽었습니다' };
}

/**
 * 조회해 온 연결 행에 자격증명 칸이 **모두 실려 왔는지** 본다.
 *
 * 값이 비어 있는 것과 **칸 자체가 안 실려 온 것**은 다르다. 전자는 "이
 * 연결에는 비밀이 없다"이고, 후자는 "우리가 안 읽었다"다. 후자를 전자로
 * 읽으면 멀쩡한 연결이 조용히 건너뛰어진다.
 */
export function credentialColumnsPresent(conn: any): { ok: boolean; missing: string[] } {
  if (conn == null || typeof conn !== 'object') return { ok: false, missing: [...CREDENTIAL_COLUMNS] };
  const missing = CREDENTIAL_COLUMNS.filter((c) => !(c in conn));
  return { ok: missing.length === 0, missing };
}

// ─────────────────────────────────────────────────────────────────────
// 못 읽었을 때 **얼마나 자주, 몇 번까지** 다시 볼 것인가
// ─────────────────────────────────────────────────────────────────────
//
// 조회 실패로 잡을 끝내지 않는 것까지는 맞다. 그런데 그냥 PENDING으로
// 되돌리기만 하면 **3초마다 claim → 되돌림이 반복된다.**
//
//   · `max_attempts` 비교는 `runAction` 실패 경로에만 있다. 조회 실패는
//     그 앞에서 빠져나가므로 **상한이 걸리지 않는다**
//   · claim 한 번 · 되돌림 한 번 = 틱마다 쓰기 2회. 한도(402) 때문에 난
//     실패라면 **아끼려던 전송량을 오히려 늘린다**
//   · 063이 안 간 환경처럼 **지속되는 원인**이면 영원히 돈다
//
// 그래서 되돌리되 간격을 벌리고, 상한을 건다. 사다리는 한도 차단기와
// **같은 것을 쓴다** — 재시도 간격을 두 군데에 적지 않는다.

import { BACKOFF_STEPS_MS } from './quotaBreaker';

export type ConnectionReadRetry =
  | { action: 'GIVE_UP'; waitMs: 0; reason: string }
  | { action: 'RETRY_LATER'; waitMs: number; reason: string };

/**
 * 연결을 못 읽은 잡을 어떻게 할 것인가.
 *
 * **GIVE_UP도 "연결 없음"이 아니다.** 사유에 못 읽었다는 사실을 남긴다 —
 * 포기한 이유가 "연결이 없어서"로 적히면 다음 사람이 엉뚱한 데를 본다.
 */
export function connectionReadRetryPlan(i: {
  attempts: number;
  maxAttempts?: number | null;
  reason: string;
}): ConnectionReadRetry {
  const max = Number.isFinite(Number(i.maxAttempts)) && Number(i.maxAttempts) > 0
    ? Number(i.maxAttempts) : 5;
  const attempts = Number.isFinite(Number(i.attempts)) ? Number(i.attempts) : 0;
  if (attempts >= max) {
    return {
      action: 'GIVE_UP', waitMs: 0,
      reason: `연결을 ${attempts}회 읽지 못했습니다 (상한 ${max}) — ${i.reason}`,
    };
  }
  // 1회차 실패 뒤 1분, 그다음 2·4·8·16분, 30분 상한.
  const step = BACKOFF_STEPS_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_STEPS_MS.length - 1)];
  return {
    action: 'RETRY_LATER', waitMs: step,
    reason: `연결을 읽지 못해 ${Math.round(step / 1000)}초 뒤 다시 봅니다 (${attempts}/${max}) — ${i.reason}`,
  };
}
