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
export async function heartbeat(workerId: string, status: string, task: string, errorCount: number): Promise<void> {
  const base: Record<string, any> = {
    worker_id: workerId, last_seen: new Date().toISOString(), status,
    current_task: task, error_count: errorCount, updated_at: new Date().toISOString(),
  };
  const sha = String(process.env.GIT_SHA || '').trim();
  try {
    const { error } = await sb().from('worker_heartbeat')
      .upsert(sha ? { ...base, version: sha } : base, { onConflict: 'worker_id' });
    if (!error) return;
    // 054가 아직 안 적용된 배포에서는 `version` 칸이 없다. 그때 생존
    // 신호까지 같이 잃으면 **살아 있는 워커가 죽은 것으로 보인다** —
    // 버전을 빼고 다시 적는다.
    if (sha && /column|schema cache/i.test(String(error.message))) {
      await sb().from('worker_heartbeat').upsert(base, { onConflict: 'worker_id' });
    }
  } catch {}
}

export async function logKill(connectionId: string, ev: { reason: string; action: string; mode: string; equity?: number }): Promise<void> {
  try {
    await sb().from('kill_switch_log').insert({ connection_id: connectionId, at: new Date().toISOString(), reason: ev.reason, equity: ev.equity ?? 0, drawdown_pct: 0, action: ev.action, mode: ev.mode });
  } catch {}
}
