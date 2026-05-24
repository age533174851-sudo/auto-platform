// /api/strategies  GET=list  POST=save|update|toggle|delete
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MEM: any[] = [];

// ── GET /api/strategies ──────────────────────────────────────
export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ strategies: [], source: 'anon' });

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from('trading_strategies')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ strategies: data ?? [], source: 'supabase' });
  }

  return NextResponse.json({ strategies: MEM.filter(s => s.user_id === uid), source: 'memory' });
}

// ── POST /api/strategies ─────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  const sb = getSupabaseAdmin();

  if (action === 'save') {
    const record = {
      user_id: uid,
      name: body.name ?? '새 전략',
      type: body.type ?? 'ema_cross',
      asset: body.asset ?? 'BTC',
      asset_name_kr: body.assetNameKr ?? body.asset_name_kr ?? '비트코인',
      timeframe: body.timeframe ?? '4h',
      leverage: body.leverage ?? 1,
      max_leverage: body.maxLeverage ?? body.max_leverage ?? 10,
      risk_level: body.riskLevel ?? body.risk_level ?? 'medium',
      tp: body.tp ?? 5,
      sl: body.sl ?? 2.5,
      enabled: false,
      status: 'stopped',
      win_rate: 0, total_pnl: 0, trades: 0,
      max_daily_loss: body.maxDailyLoss ?? body.max_daily_loss ?? 500000,
      max_position_size: body.maxPositionSize ?? body.max_position_size ?? 3000000,
      cooldown_min: body.cooldownMin ?? body.cooldown_min ?? 60,
      params: body.params ?? {},
      description: body.description ?? '',
      exec_mode: 'paper',
    };

    if (sb) {
      const { data, error } = await sb.from('trading_strategies').insert(record).select().single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ strategy: data, source: 'supabase' });
    }

    const saved = { ...record, id: 'mem-' + Date.now().toString(36), created_at: new Date().toISOString() };
    MEM.unshift(saved);
    return NextResponse.json({ strategy: saved, source: 'memory' });
  }

  if (action === 'update') {
    const { id } = body;
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });
    const allowed: Record<string, unknown> = {};
    for (const f of ['name','type','asset','asset_name_kr','timeframe','leverage',
                     'max_leverage','risk_level','tp','sl','enabled','status',
                     'max_daily_loss','max_position_size','cooldown_min','params','description','exec_mode']) {
      if (body[f] !== undefined) allowed[f] = body[f];
    }
    if (sb) {
      const { data, error } = await sb.from('trading_strategies')
        .update(allowed).eq('id', id).eq('user_id', uid).select().single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ strategy: data, source: 'supabase' });
    }
    const idx = MEM.findIndex(s => s.id === id && s.user_id === uid);
    if (idx >= 0) MEM[idx] = { ...MEM[idx], ...allowed };
    return NextResponse.json({ strategy: MEM[idx] ?? null, source: 'memory' });
  }

  if (action === 'toggle') {
    const { id, enabled, status } = body;
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });
    const updates = { enabled: !!enabled, status: status ?? (enabled ? 'running' : 'stopped') };
    if (sb) {
      const { data, error } = await sb.from('trading_strategies')
        .update(updates).eq('id', id).eq('user_id', uid).select().single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ strategy: data, source: 'supabase' });
    }
    const idx = MEM.findIndex(s => s.id === id && s.user_id === uid);
    if (idx >= 0) MEM[idx] = { ...MEM[idx], ...updates };
    return NextResponse.json({ strategy: MEM[idx] ?? null, source: 'memory' });
  }

  if (action === 'delete') {
    const { id } = body;
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });
    if (sb) {
      const { error } = await sb.from('trading_strategies').delete().eq('id', id).eq('user_id', uid);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, source: 'supabase' });
    }
    const idx = MEM.findIndex(s => s.id === id && s.user_id === uid);
    if (idx >= 0) MEM.splice(idx, 1);
    return NextResponse.json({ success: true, source: 'memory' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
