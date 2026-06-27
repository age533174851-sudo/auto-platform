// POST /api/risk/kill-switch/update
// { connectionId, enabled?, dailyLimitPct?, weeklyLimitPct?, monthlyLimitPct?, absLimitUsdt?, actionMode? }

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadKillSwitch, saveKillSwitch } from '@/lib/risk/killSwitch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  const s = await loadKillSwitch(sb, uid, connectionId);
  if (s.noTable) return NextResponse.json({ error: 'table_missing', message: 'kill_switch_state 테이블이 없습니다. SQL 마이그레이션을 먼저 실행하세요.' }, { status: 503 });

  if (typeof body.enabled === 'boolean') s.enabled = body.enabled;
  if (body.dailyLimitPct != null)   s.dailyLimitPct   = Math.max(0.1, Number(body.dailyLimitPct));
  if (body.weeklyLimitPct != null)  s.weeklyLimitPct  = Math.max(0.1, Number(body.weeklyLimitPct));
  if (body.monthlyLimitPct != null) s.monthlyLimitPct = Math.max(0.1, Number(body.monthlyLimitPct));
  if (body.absLimitUsdt != null)    s.absLimitUsdt    = Math.max(0, Number(body.absLimitUsdt));
  if (typeof body.actionMode === 'string') s.actionMode = body.actionMode.toUpperCase().replace(/[^ABCD]/g, '') || 'BC';

  const ok = await saveKillSwitch(sb, uid, connectionId, s);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  return NextResponse.json({ ok: true, config: { enabled: s.enabled, dailyLimitPct: s.dailyLimitPct, weeklyLimitPct: s.weeklyLimitPct, monthlyLimitPct: s.monthlyLimitPct, absLimitUsdt: s.absLimitUsdt, actionMode: s.actionMode } });
}
