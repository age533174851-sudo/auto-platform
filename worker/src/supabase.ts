// worker/src/supabase.ts — service role 클라이언트 + lock + heartbeat
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { workerIdentityOf } from '../../src/lib/runtime/workerIdentity';
// **판정은 웹과 같은 파일을 쓴다.** 워커용 사본을 두면 한쪽만 고쳐진다.
import { heartbeatVerdict, projectRefOf } from '../../src/lib/runtime/heartbeatVerify';

let _sb: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

// ── 분산 lock (Vercel killSwitch.ts와 동일 로직/테이블) ──────────
export async function acquireLock(name: string, holder: string, ttlSec = 60): Promise<boolean> {
  const now = Date.now();
  const expires = new Date(now + ttlSec * 1000).toISOString();
  try {
    const { data: cur } = await sb().from('worker_lock').select('*').eq('name', name).maybeSingle();
    if (!cur) {
      const { error } = await sb().from('worker_lock').insert({ name, holder, expires_at: expires, acquired_at: new Date(now).toISOString() });
      return !error;
    }
    const expired = new Date(cur.expires_at).getTime() < now;
    if (cur.holder === holder || expired) {
      const { data: upd } = await sb().from('worker_lock')
        .update({ holder, expires_at: expires, acquired_at: new Date(now).toISOString() })
        .eq('name', name).eq('expires_at', cur.expires_at).select();
      return Array.isArray(upd) && upd.length > 0;
    }
    return false;
  } catch { return false; }
}

export async function releaseLock(name: string, holder: string): Promise<void> {
  try { await sb().from('worker_lock').update({ holder: null, expires_at: new Date(0).toISOString() }).eq('name', name).eq('holder', holder); } catch {}
}

// ── Heartbeat ──────────────────────────────────────────────────
//
// **이 워커가 어느 커밋인지 같이 적는다.**
//
// 두 번 사고가 났다. 8/13에는 fly-deploy가 안 돌아 워커가 8/9 코드로
// 돌았고, 8/15에는 #128(고아주문 정리)·#129(반복 스모크)가 워커에 없는
// 채로 스모크를 돌렸다. 두 번 다 **"Fly에 무엇이 떠 있나"에 답할
// 방법이 없어서** 원인을 찾는 데 시간을 다 썼다.
//
// `GIT_SHA`는 Dockerfile의 ARG로 들어온다(fly-deploy가 --build-arg로
// 넘긴다). 없으면 빈 문자열이고, 그건 **"모름"이지 "같음"이 아니다** —
// 읽는 쪽(`/api/system/deployment`)이 그렇게 처리한다.
// **그리고 이 기록이 실패하면 그 사실을 말한다.**
//
// 2026-08-19에 이것 때문에 사흘을 잃었다. `/api/system/deployment`는
// Fly 워커를 `alive: false`, 버전은 8/16 커밋이라고 했다. 그 사이 배포는
// 네 번 전부 success로 끝났고, Fly는 머신이 `started`라고 했다.
//
// 그런데 **어느 쪽이 사실인지 알 방법이 없었다.** 워커가 죽은 것인지,
// 살아서 돌고 있는데 heartbeat 쓰기만 실패하는 것인지 — 둘은 완전히
// 다른 고장이고 고치는 방법도 다른데, 아래 `catch {}`가 그 구분을
// 통째로 삼키고 있었다. 054 관련 오류만 다시 시도하고 나머지는 조용히
// 사라졌다.
//
// **조용히 틀리는 쪽이 언제나 더 나쁘다.** 살아 있는 워커가 죽은 것으로
// 보이는 것도, 죽은 워커와 구분되지 않는 것도 같은 뿌리다.
//
// 다만 3초마다 도는 경로다. 매번 찍으면 로그가 그것만으로 덮이고,
// 그러면 진짜 원인 줄이 스크롤 밖으로 밀려난다. 그래서 **처음 한 번과
// 그 뒤 1분에 한 번만** 찍고, 복구되면 복구됐다고 한 줄 남긴다.
// 값은 절대 찍지 않는다 — 실패 메시지만 옮긴다.
let hbFailedSince: number | null = null;
let hbLastLogMs = 0;
const HB_LOG_EVERY_MS = 60_000;

// **성공했을 때도 말한다.**
//
// #144는 실패를 찍게 만들었다. 그런데 그것만으로는 부족했다 —
// 로그에 heartbeat 줄이 하나도 없을 때 그게 "잘 되고 있다"인지
// "코드가 그 자리에 없다"인지 구분할 수 없었고, 실제로 그 구분이 안 돼
// 하루를 더 썼다. **아무 말도 안 하는 성공은 침묵과 같다.**
//
// 그래서 첫 성공 한 번과 그 뒤 60초에 한 번, 무엇을 어디에 썼는지
// 남긴다. 값은 없다 — worker_id · 버전 · 시각 · Supabase 지문뿐이다.
let hbLastOkLogMs = 0;
let hbEverLoggedOk = false;

function noteHeartbeatOk(workerId: string, sha: string, lastSeen: string): void {
  const now = Date.now();
  if (hbEverLoggedOk && now - hbLastOkLogMs < HB_LOG_EVERY_MS) return;
  hbLastOkLogMs = now; hbEverLoggedOk = true;
  console.log(
    `[heartbeat] ok worker=${workerId} version=${sha || '(없음)'} last_seen=${lastSeen}`
    // **6자 지문이 같다는 것만으로 같은 DB라고 단정하지 않는다.**
    // project ref는 공개 URL의 일부라 비밀이 아니다.
    + ` target=${supabaseFingerprint()} project=${supabaseProjectRef() ?? '(모름)'}`
    // **판정 코드를 그대로 찍는다.** 로그를 읽는 사람이 문장을 해석해서
    // 어느 경우인지 짐작하게 만들지 않는다.
    + ' verdict=RECORDED (다시 읽어 대조함)');
}

/**
 * 지금 쓰고 있는 Supabase의 **지문 6자리**.
 *
 * 값은 절대 찍지 않는다. 웹(`/api/system/deployment`)도 같은 방식으로
 * 자기 지문을 알려 주므로, 둘을 비교하면 **같은 데이터베이스를 보고
 * 있는지**를 값 없이 확인할 수 있다. 이 저장소가 암호화 키를 다루는
 * 방식과 같다.
 */
let supabaseFp: string | null = null;
function supabaseFingerprint(): string {
  if (supabaseFp == null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createHash } = require('crypto');
      const raw = String(process.env.SUPABASE_URL || '').trim();
      supabaseFp = raw ? String(createHash('sha256').update(raw).digest('hex')).slice(0, 6) : '(없음)';
    } catch { supabaseFp = '(모름)'; }
  }
  return supabaseFp ?? '(모름)';
}

/** 지금 쓰고 있는 Supabase의 project ref. 값이 아니라 이름이다 */
let supabaseRef: string | null | undefined;
function supabaseProjectRef(): string | null {
  if (supabaseRef === undefined) supabaseRef = projectRefOf(process.env.SUPABASE_URL || '');
  return supabaseRef ?? null;
}

function noteHeartbeatFailure(why: string): void {
  const now = Date.now();
  if (hbFailedSince == null) hbFailedSince = now;
  if (hbLastLogMs !== 0 && now - hbLastLogMs < HB_LOG_EVERY_MS) return;
  hbLastLogMs = now;
  const forSec = Math.round((now - hbFailedSince) / 1000);
  console.error(
    `[heartbeat] ⚠ 기록 실패 (${forSec}초째): ${why}`
    + ` — 워커는 돌고 있지만 화면에는 죽은 것으로 보입니다. target=${supabaseFingerprint()}`
    + ' · worker_heartbeat 쓰기 권한·서비스 키·네트워크를 확인하세요.');
}

function noteHeartbeatRecovered(): void {
  if (hbFailedSince == null) return;
  const forSec = Math.round((Date.now() - hbFailedSince) / 1000);
  hbFailedSince = null; hbLastLogMs = 0;
  console.log(`[heartbeat] 기록 복구됨 (${forSec}초 동안 실패했습니다)`);
}

/**
 * 이 프로세스의 신원. **사람이 넣는 값이 아니라 플랫폼이 넣어 준 값에서 읽는다.**
 *
 * `WORKER_PROVIDER=Fly`를 사람이 넣어야만 화면에 이름이 나오는 구조였다.
 * 아무도 안 넣어서 화면은 계속 '실행기'라고만 적었다 — 그전엔 화면에
 * 'Railway'가 글자로 박혀 있었고. 두 번 다 **사실을 아는 쪽이 적지
 * 않아서** 생긴 일이다. 워커는 자기가 Fly 위에 있는 걸 안다.
 */
const IDENTITY = workerIdentityOf(process.env as any);
const STARTED_AT = new Date().toISOString();

/** 기동 점검 결과. index.ts의 startupChecks가 채운다 */
let startupOk: boolean | null = null;
let startupDetail: string | null = null;
export function noteStartupResult(ok: boolean, detail: string | null): void {
  startupOk = ok;
  startupDetail = detail ? String(detail).slice(0, 300) : null;
}

/** 값을 안 보여 주고 같은지만 말한다 */
function fp(raw: string): string | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto');
    return String(createHash('sha256').update(v).digest('hex')).slice(0, 6);
  } catch { return null; }
}

/**
 * 057이 적용되기 전 배포에서는 이 칸들이 없다. 그때 **생존 신호까지 같이
 * 잃으면 살아 있는 워커가 죽은 것으로 보인다** — 054에서 이미 겪었다.
 * 그래서 칸이 없다는 오류가 나면 부가 정보를 빼고 다시 적는다.
 */
function runtimeColumns(tickCount: number | null): Record<string, any> {
  return {
    provider: IDENTITY.provider,
    region: IDENTITY.region,
    machine_id: IDENTITY.machineId,
    started_at: STARTED_AT,
    tick_count: tickCount,
    supabase_fingerprint: fp(process.env.SUPABASE_URL || ''),
    // 지문만으로는 같은 DB인지 단정할 수 없다. ref는 비밀이 아니다.
    // 칸이 아직 없는 배포에서는 아래 재시도가 이 값을 빼고 다시 적는다.
    project_ref: supabaseProjectRef(),
    encryption_fingerprint: fp(process.env.EXCHANGE_ENCRYPTION_KEY || ''),
    startup_ok: startupOk,
    startup_detail: startupDetail,
  };
}

let runtimeColumnsMissing = false;

export async function heartbeat(
  workerId: string, status: string, task: string, errorCount: number, tickCount?: number,
): Promise<void> {
  const base: Record<string, any> = {
    worker_id: workerId, last_seen: new Date().toISOString(), status,
    current_task: task, error_count: errorCount, updated_at: new Date().toISOString(),
  };
  const sha = String(process.env.GIT_SHA || '').trim();
  const withSha = sha ? { ...base, version: sha } : base;
  const full = runtimeColumnsMissing
    ? withSha
    : { ...withSha, ...runtimeColumns(Number.isFinite(tickCount as number) ? (tickCount as number) : null) };
  try {
    // **`.select()`를 붙인다.** 붙이지 않으면 몇 행이 갱신됐는지 알 수 없고,
    // PostgREST에서 RLS가 UPDATE를 막으면 **오류가 아니라 0행**이다.
    // 그 상태에서 예전 코드는 `error == null`만 보고 ok를 찍었다.
    const first = await sb().from('worker_heartbeat')
      .upsert(full, { onConflict: 'worker_id' }).select('worker_id, last_seen, version');
    // 057이 아직인 배포. 부가 정보만 빼고 예전처럼 적는다.
    if (first.error && !runtimeColumnsMissing && /column|schema cache/i.test(String(first.error.message))) {
      runtimeColumnsMissing = true;
      noteMissingRuntimeColumns();
    }
    const res: any = runtimeColumnsMissing && first.error
      ? await sb().from('worker_heartbeat')
          .upsert(withSha, { onConflict: 'worker_id' }).select('worker_id, last_seen, version')
      : first;
    const { error } = res;
    if (!error) {
      // ── 썼다고 말하기 전에 다시 읽는다 ──
      //
      // "요청이 성공했다"와 "행이 갱신됐다"는 다른 사실이다. 실제로
      // 워커는 8/23에 ok를 찍고 있었고 표의 최신 줄은 8/21이었다.
      const verdict = await verifyHeartbeatWrite(workerId, base.last_seen, sha || null, res);
      if (verdict.ok) {
        noteHeartbeatRecovered();
        noteHeartbeatOk(workerId, sha, base.last_seen);
        return;
      }
      noteHeartbeatFailure(`[${verdict.code}] ${verdict.message}`);
      return;
    }
    // 054가 아직 안 적용된 배포에서는 `version` 칸이 없다. 그때 생존
    // 신호까지 같이 잃으면 **살아 있는 워커가 죽은 것으로 보인다** —
    // 버전을 빼고 다시 적는다.
    if (sha && /column|schema cache/i.test(String(error.message))) {
      const retry: any = await sb().from('worker_heartbeat')
        .upsert(base, { onConflict: 'worker_id' }).select('worker_id, last_seen, version');
      if (!retry.error) {
        // 버전을 못 적는 경로에서도 **행이 실제로 갱신됐는지는 확인한다.**
        const v = await verifyHeartbeatWrite(workerId, base.last_seen, null, retry);
        if (!v.ok) { noteHeartbeatFailure(`[${v.code}] ${v.message}`); return; }
        noteHeartbeatRecovered();
        noteHeartbeatOk(workerId, '', base.last_seen);
        // **이건 조용히 넘어가면 안 되는 성공이다.** 생존 신호는 적혔지만
        // 버전은 못 적었고, 그러면 배포 대조가 영원히 '모름'이 된다.
        noteMissingVersionColumn();
        return;
      }
      noteHeartbeatFailure(`[WRITE_FAILED] ${String(retry.error.message || retry.error)}`);
      return;
    }
    noteHeartbeatFailure(`[WRITE_FAILED] ${String(error.message || error)}`);
  } catch (e: any) {
    // 예외도 실패다. 예전에는 이 자리가 비어 있었다.
    noteHeartbeatFailure(`[WRITE_FAILED] ${String(e?.message || e)}`);
  }
}

/**
 * **쓰고 나서 다시 읽는다.**
 *
 * 두 가지를 본다:
 *   1. upsert가 `.select()`로 몇 행을 돌려줬나 — 0행이면 조용히 막힌 것이다
 *   2. 같은 client로 그 worker_id를 다시 읽어 last_seen·version이 맞나
 *
 * 판정은 `src/lib/runtime/heartbeatVerify.ts`에 있고 테스트가 붙어 있다.
 * 여기서는 사실만 모은다.
 *
 * **다시 읽기가 실패한 것은 안 써진 것과 다르다** — 그 구분도 판정기가 한다.
 */
async function verifyHeartbeatWrite(
  workerId: string, lastSeen: string, version: string | null, res: any,
): Promise<{ ok: boolean; code: string; message: string }> {
  const returnedRows = Array.isArray(res?.data) ? res.data.length : null;

  let readError: string | null = null;
  let readRow: any = null;
  try {
    const r: any = await sb().from('worker_heartbeat')
      .select('worker_id, last_seen, version').eq('worker_id', workerId).maybeSingle();
    if (r?.error) readError = String(r.error.message || r.error);
    else readRow = r?.data ?? null;
  } catch (e: any) {
    readError = String(e?.message || e);
  }

  const v = heartbeatVerdict({
    expected: { workerId, lastSeen, version },
    writeError: null,
    returnedRows,
    readError,
    readRow,
  });
  return { ok: v.ok, code: v.code, message: v.message };
}

// 054 미적용은 배포 대조를 통째로 무력화한다. 자주 찍을 필요는 없지만
// **한 번은 반드시 보여야 한다.**
let missingRuntimeWarned = false;
function noteMissingRuntimeColumns(): void {
  if (missingRuntimeWarned) return;
  missingRuntimeWarned = true;
  console.warn(
    '[heartbeat] worker_heartbeat에 실행 정보 칸이 없습니다 — 마이그레이션 057을 자동으로 적용하는 중입니다.'
    + ' 그때까지 공급자·지문·기동점검은 "모름"입니다(정상이 아니라 모름입니다).');
}

let missingVersionWarned = false;
function noteMissingVersionColumn(): void {
  if (missingVersionWarned) return;
  missingVersionWarned = true;
  console.warn(
    '[heartbeat] worker_heartbeat.version 칸이 없습니다 — 마이그레이션 054를 자동으로 적용하는 중입니다.'
    + ' 그때까지 /api/system/deployment의 Fly SHA는 "모름"입니다(같음이 아닙니다).');
}

export async function logKill(connectionId: string, ev: { reason: string; action: string; mode: string; equity?: number }): Promise<void> {
  try {
    await sb().from('kill_switch_log').insert({ connection_id: connectionId, at: new Date().toISOString(), reason: ev.reason, equity: ev.equity ?? 0, drawdown_pct: 0, action: ev.action, mode: ev.mode });
  } catch {}
}
