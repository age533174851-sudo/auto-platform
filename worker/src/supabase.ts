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
export async function heartbeat(workerId: string, status: string, task: string, errorCount: number): Promise<void> {
  try {
    await sb().from('worker_heartbeat').upsert({
      worker_id: workerId, last_seen: new Date().toISOString(), status, current_task: task, error_count: errorCount, updated_at: new Date().toISOString(),
    }, { onConflict: 'worker_id' });
  } catch {}
}

export async function logKill(connectionId: string, ev: { reason: string; action: string; mode: string; equity?: number }): Promise<void> {
  try {
    await sb().from('kill_switch_log').insert({ connection_id: connectionId, at: new Date().toISOString(), reason: ev.reason, equity: ev.equity ?? 0, drawdown_pct: 0, action: ev.action, mode: ev.mode });
  } catch {}
}
