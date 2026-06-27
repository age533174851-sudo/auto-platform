// POST /api/risk/kill-switch/trigger
// { connectionId, reason? } — 수동 발동 (즉시 active=true)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { loadKillSwitch, saveKillSwitch, logKillEvent, executeKillActions } from '@/lib/risk/killSwitch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId, reason } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  const s = await loadKillSwitch(sb, uid, connectionId);
  if (s.noTable) return NextResponse.json({ error: 'table_missing', message: 'kill_switch_state 테이블이 없습니다.' }, { status: 503 });

  const wasActive = s.active;
  s.active = true;
  s.triggeredAt = Date.now();
  s.triggerReason = reason || '수동 발동';

  const ok = await saveKillSwitch(sb, uid, connectionId, s);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 500 });

  const testnet = conn.is_testnet === true;
  await logKillEvent(sb, uid, connectionId, { reason: s.triggerReason, equity: 0, drawdownPct: 0, action: 'MANUAL_TRIGGER', mode: testnet ? 'TESTNET' : 'LIVE' });

  // 발동 순간 KILL_SWITCH_EXECUTE job 적재 (Worker가 실행)
  let exec: any = null;
  if (!wasActive) {
    try {
      const { enqueueJob } = await import('@/lib/jobs');
      const q = await enqueueJob(sb, { userId: uid, connectionId, action: 'KILL_SWITCH_EXECUTE', mode: testnet ? 'TESTNET' : 'LIVE', payload: { actionMode: s.actionMode, reason: s.triggerReason }, priority: 0, maxAttempts: 10 });
      exec = { queued: true, jobId: q.jobId };
    } catch { exec = { error: true }; }
  }

  return NextResponse.json({ ok: true, active: true, triggerReason: s.triggerReason, exec });
}
