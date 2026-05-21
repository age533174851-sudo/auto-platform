// /api/admin — admin-only API route
// ALL actions verified server-side: JWT → profiles.role → ADMIN_ROLES set
// Role promotion is only possible via Supabase SQL — never via this API
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/isAdmin';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── GET /api/admin?action=health|users|exchange_status|strategy_status|audit_logs
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req.headers.get('authorization'));
  if (guard instanceof Response) return guard;    // 403 for non-admins
  const { userId } = guard;

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') ?? 'health';
  const sb = getSupabaseAdmin();

  // ── health ──────────────────────────────────────────────
  if (action === 'health') {
    const envStatus = {
      NEXT_PUBLIC_SUPABASE_URL:      !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY:     !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    if (!sb) {
      return NextResponse.json(
        { status: 'error', connected: false, message: 'Supabase 클라이언트 초기화 실패', env: envStatus, latencyMs: null },
        { status: 503 }
      );
    }
    const t0 = Date.now();
    const { error } = await sb.from('profiles').select('id').limit(1);
    const latencyMs = Date.now() - t0;
    if (error && error.code !== 'PGRST116') {
      return NextResponse.json(
        { status: 'degraded', connected: false, message: `DB 오류: ${error.message}`, env: envStatus, latencyMs },
        { status: 503 }
      );
    }
    return NextResponse.json({ status: 'ok', connected: true, message: 'Supabase 연결 정상', env: envStatus, latencyMs });
  }

  // ── users ───────────────────────────────────────────────
  if (action === 'users') {
    if (!sb) return NextResponse.json({ users: [] });
    const search = searchParams.get('search') ?? '';
    let query = sb
      .from('profiles')
      .select('id,email,display_name,role,plan,status,badges,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (search) query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ users: data ?? [] });
  }

  // ── exchange_status ─────────────────────────────────────
  if (action === 'exchange_status') {
    if (!sb) return NextResponse.json({ connections: [] });
    const { data, error } = await sb
      .from('exchange_connections')
      .select('id,user_id,exchange_id,label,is_active,last_tested_at,test_status,created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ connections: data ?? [] });
  }

  // ── strategy_status ─────────────────────────────────────
  if (action === 'strategy_status') {
    if (!sb) return NextResponse.json({ strategies: [] });
    const { data, error } = await sb
      .from('trading_strategies')
      .select('id,user_id,name,asset,status,enabled,exec_mode,updated_at')
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ strategies: data ?? [] });
  }

  // ── audit_logs ──────────────────────────────────────────
  if (action === 'audit_logs') {
    if (!sb) return NextResponse.json({ logs: [] });
    const limit = Math.min(Number(searchParams.get('limit') ?? 100), 500);
    const { data, error } = await sb
      .from('audit_logs')
      .select('id,actor_id,action,target_id,resource,details,result,created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ logs: data ?? [] });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ── POST /api/admin
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req.headers.get('authorization'));
  if (guard instanceof Response) return guard;    // 403 for non-admins
  const { userId } = guard;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const { action } = body;
  const sb = getSupabaseAdmin();

  // ── emergency_stop: disable ALL running strategies globally
  if (action === 'emergency_stop') {
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });
    const { error, count } = await sb
      .from('trading_strategies')
      .update({ enabled: false, status: 'stopped' })
      .eq('enabled', true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await sb.from('audit_logs').insert({
      actor_id: userId,
      action:   'EMERGENCY_BOT_STOP',
      details:  { stopped_count: count ?? 'all', reason: body.reason ?? '관리자 긴급 정지' },
      result:   'success',
    });
    return NextResponse.json({ success: true, message: '모든 실행 중 전략이 중지되었습니다.', stoppedCount: count ?? 0 });
  }

  // ── ban_user / unban_user ───────────────────────────────
  if (action === 'ban_user' || action === 'unban_user') {
    const targetId = body.targetId as string | undefined;
    if (!targetId) return NextResponse.json({ error: 'targetId 필수' }, { status: 400 });
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });
    const newStatus = action === 'ban_user' ? 'banned' : 'active';
    const { error } = await sb
      .from('profiles')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', targetId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await sb.from('audit_logs').insert({
      actor_id:  userId,
      action:    action === 'ban_user' ? 'BAN_USER' : 'UNBAN_USER',
      target_id: targetId,
      details:   { reason: body.reason ?? '' },
      result:    'success',
    });
    return NextResponse.json({ success: true, status: newStatus });
  }

  // ── maintenance_mode: recorded in audit log (UI placeholder)
  if (action === 'maintenance_mode') {
    const enabled = !!body.enabled;
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });
    await sb.from('audit_logs').insert({
      actor_id: userId,
      action:   enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF',
      details:  { reason: body.reason ?? '' },
      result:   'success',
    });
    return NextResponse.json({ success: true, maintenanceMode: enabled });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
