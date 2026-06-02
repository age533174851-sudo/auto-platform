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

  // ── stats — 통계 대시보드 ─────────────────────────────────
  if (action === 'stats') {
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7d  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString();

    // 병렬 카운트 (best-effort: 테이블 없으면 0)
    const safeCount = async (table: string, filter?: (q: any) => any): Promise<number> => {
      try {
        let q: any = (sb.from(table) as any).select('id', { count: 'exact', head: true });
        if (filter) q = filter(q);
        const { count, error } = await q;
        if (error) return 0;
        return count ?? 0;
      } catch { return 0; }
    };

    const [
      totalUsers,
      activeUsers24h,
      newUsers7d,
      bannedUsers,
      totalStrategies,
      activeStrategies,
      totalExchanges,
      activeBots24h,
      auditCount24h,
    ] = await Promise.all([
      safeCount('profiles'),
      safeCount('user_login_sessions', (q: any) => q.gte('last_seen_at', since24h)),
      safeCount('profiles',            (q: any) => q.gte('created_at',   since7d)),
      safeCount('profiles',            (q: any) => q.eq('status', 'banned')),
      safeCount('user_strategies'),
      safeCount('user_strategies',     (q: any) => q.eq('enabled', true)),
      safeCount('exchange_connections'),
      safeCount('audit_logs',          (q: any) => q.gte('created_at', since24h).in('action', ['BOT_START','BOT_STOP'])),
      safeCount('audit_logs',          (q: any) => q.gte('created_at', since24h)),
    ]);

    return NextResponse.json({
      stats: {
        users: {
          total:     totalUsers,
          active24h: activeUsers24h,
          new7d:     newUsers7d,
          banned:    bannedUsers,
        },
        strategies: {
          total:  totalStrategies,
          active: activeStrategies,
        },
        exchanges: {
          total: totalExchanges,
        },
        activity: {
          botEvents24h:   activeBots24h,
          auditEvents24h: auditCount24h,
        },
        generatedAt: now.toISOString(),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── notices_list — 공지 목록 ─────────────────────────────
  if (action === 'notices_list') {
    if (!sb) return NextResponse.json({ notices: [] });
    const { data, error } = await (sb.from('admin_notices') as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ notices: data ?? [] });
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

  // ── notice_create ────────────────────────────────────────
  if (action === 'notice_create') {
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });
    const title = String(body.title || '').trim();
    const noticeBody = String(body.body || '').trim();
    if (!title || !noticeBody) return NextResponse.json({ error: 'title, body 필수' }, { status: 400 });

    const row = {
      title,
      body:      noticeBody,
      level:     ['info','warning','critical'].includes(String(body.level)) ? body.level : 'info',
      active:    body.active !== false,
      show_to:   ['all','pro','admin'].includes(String(body.show_to)) ? body.show_to : 'all',
      starts_at: body.starts_at ? new Date(body.starts_at as string).toISOString() : new Date().toISOString(),
      ends_at:   body.ends_at   ? new Date(body.ends_at   as string).toISOString() : null,
      created_by: userId,
    };
    const { data, error } = await (sb.from('admin_notices') as any).insert(row).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await sb.from('audit_logs').insert({
      actor_id: userId,
      action:   'NOTICE_CREATE',
      details:  { notice_id: data?.id, title },
      result:   'success',
    });
    return NextResponse.json({ success: true, notice: data });
  }

  // ── notice_update (toggle / edit) ────────────────────────
  if (action === 'notice_update') {
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });
    const id = String(body.id || '');
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.title === 'string')  patch.title  = body.title;
    if (typeof body.body  === 'string')  patch.body   = body.body;
    if (typeof body.level === 'string' && ['info','warning','critical'].includes(body.level)) patch.level = body.level;
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (typeof body.show_to === 'string' && ['all','pro','admin'].includes(body.show_to)) patch.show_to = body.show_to;
    if (body.ends_at !== undefined) patch.ends_at = body.ends_at ? new Date(body.ends_at as string).toISOString() : null;

    const { error } = await (sb.from('admin_notices') as any).update(patch).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // ── notice_delete ────────────────────────────────────────
  if (action === 'notice_delete') {
    if (!sb) return NextResponse.json({ error: 'Supabase 미연결' }, { status: 503 });
    const id = String(body.id || '');
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });

    const { error } = await (sb.from('admin_notices') as any).delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await sb.from('audit_logs').insert({
      actor_id: userId,
      action:   'NOTICE_DELETE',
      details:  { notice_id: id },
      result:   'success',
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
