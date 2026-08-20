// worker/src/supabase.ts — service role 클라이언트 + lock + heartbeat
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
    + ` target=${supabaseFingerprint()}`);
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

export async function heartbeat(workerId: string, status: string, task: string, errorCount: number): Promise<void> {
  const base: Record<string, any> = {
    worker_id: workerId, last_seen: new Date().toISOString(), status,
    current_task: task, error_count: errorCount, updated_at: new Date().toISOString(),
  };
  const sha = String(process.env.GIT_SHA || '').trim();
  try {
    const { error } = await sb().from('worker_heartbeat')
      .upsert(sha ? { ...base, version: sha } : base, { onConflict: 'worker_id' });
    if (!error) {
      noteHeartbeatRecovered();
      noteHeartbeatOk(workerId, sha, base.last_seen);
      return;
    }
    // 054가 아직 안 적용된 배포에서는 `version` 칸이 없다. 그때 생존
    // 신호까지 같이 잃으면 **살아 있는 워커가 죽은 것으로 보인다** —
    // 버전을 빼고 다시 적는다.
    if (sha && /column|schema cache/i.test(String(error.message))) {
      const retry = await sb().from('worker_heartbeat').upsert(base, { onConflict: 'worker_id' });
      if (!retry.error) {
        noteHeartbeatRecovered();
        noteHeartbeatOk(workerId, '', base.last_seen);
        // **이건 조용히 넘어가면 안 되는 성공이다.** 생존 신호는 적혔지만
        // 버전은 못 적었고, 그러면 배포 대조가 영원히 '모름'이 된다.
        noteMissingVersionColumn();
        return;
      }
      noteHeartbeatFailure(String(retry.error.message || retry.error));
      return;
    }
    noteHeartbeatFailure(String(error.message || error));
  } catch (e: any) {
    // 예외도 실패다. 예전에는 이 자리가 비어 있었다.
    noteHeartbeatFailure(String(e?.message || e));
  }
}

// 054 미적용은 배포 대조를 통째로 무력화한다. 자주 찍을 필요는 없지만
// **한 번은 반드시 보여야 한다.**
let missingVersionWarned = false;
function noteMissingVersionColumn(): void {
  if (missingVersionWarned) return;
  missingVersionWarned = true;
  console.warn(
    '[heartbeat] worker_heartbeat.version 칸이 없습니다 — 마이그레이션 054를 적용하세요.'
    + ' 그때까지 /api/system/deployment의 Fly SHA는 "모름"입니다(같음이 아닙니다).');
}

export async function logKill(connectionId: string, ev: { reason: string; action: string; mode: string; equity?: number }): Promise<void> {
  try {
    await sb().from('kill_switch_log').insert({ connection_id: connectionId, at: new Date().toISOString(), reason: ev.reason, equity: ev.equity ?? 0, drawdown_pct: 0, action: ev.action, mode: ev.mode });
  } catch {}
}
