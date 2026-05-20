// /api/strategies — save and list trading strategies
// POST body: { action: 'save'|'update'|'delete'|'toggle', ...payload }
// GET ?action=list
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, getUserIdFromRequest } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// In-memory fallback
const MEM: any[] = [];

function memId() { return 'mem-' + Date.now().toString(36); }

// ─────────────────────────────────────────────────────────────
// GET /api/strategies?action=list
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  const fallbackId = req.headers.get('x-user-id') || 'demo-user';
  const uid = userId || fallbackId;

  const sb = getSupabaseAdmin();

  if (sb && userId) {
    const { data, error } = await sb
      .from('trading_strategies')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ strategies: data || [], source: 'supabase' });
  }

  // Fallback: in-memory
  return NextResponse.json({
    strategies: MEM.filter(s => s.user_id === uid),
    source: 'memory',
  });
}

// ─────────────────────────────────────────────────────────────
// POST /api/strategies
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  const fallbackId = req.headers.get('x-user-id') || 'demo-user';
  const uid = userId || fallbackId;

  const sb = getSupabaseAdmin();

  // ── SAVE (insert new) ───────────────────────────────────────
  if (action === 'save') {
    const record = {
      user_id:           uid,
      name:              body.name || '새 전략',
      type:              body.type || 'ema_cross',
      asset:             body.asset || 'BTC',
      asset_name_kr:     body.assetNameKr || '비트코인',
      timeframe:         body.timeframe || '4h',
      leverage:          body.leverage ?? 1,
      max_leverage:      body.maxLeverage ?? 10,
      risk_level:        body.riskLevel || 'medium',
      tp:                body.tp ?? 5,
      sl:                body.sl ?? 2.5,
      enabled:           false,
      status:            'stopped',
      win_rate:          body.winRate ?? 0,
      total_pnl:         body.totalPnl ?? 0,
      trades:            body.trades ?? 0,
      max_daily_loss:    body.maxDailyLoss ?? 500000,
      max_position_size: body.maxPositionSize ?? 3000000,
      cooldown_min:      body.cooldownMin ?? 60,
      params:            body.params ?? {},
      description:       body.description || '',
      exec_mode:         'paper',
    };

    if (sb && userId) {
      const { data, error } = await sb
        .from('trading_strategies')
        .insert(record)
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ strategy: data, source: 'supabase' });
    }

    const saved = { ...record, id: memId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    MEM.push(saved);
    return NextResponse.json({ strategy: saved, source: 'memory' });
  }

  // ── UPDATE ──────────────────────────────────────────────────
  if (action === 'update') {
    const { id, ...updates } = body;
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });

    // Whitelist safe update fields
    const allowed: Record<string, unknown> = {};
    const fields = ['name','type','asset','asset_name_kr','timeframe','leverage',
                    'max_leverage','risk_level','tp','sl','enabled','status',
                    'max_daily_loss','max_position_size','cooldown_min','params','description','exec_mode'];
    for (const f of fields) {
      if (updates[f] !== undefined) allowed[f] = updates[f];
    }

    if (sb && userId) {
      const { data, error } = await sb
        .from('trading_strategies')
        .update(allowed)
        .eq('id', id)
        .eq('user_id', uid)
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ strategy: data, source: 'supabase' });
    }

    const idx = MEM.findIndex(s => s.id === id && s.user_id === uid);
    if (idx < 0) return NextResponse.json({ error: '전략을 찾을 수 없습니다' }, { status: 404 });
    MEM[idx] = { ...MEM[idx], ...allowed };
    return NextResponse.json({ strategy: MEM[idx], source: 'memory' });
  }

  // ── TOGGLE (enable/disable) ─────────────────────────────────
  if (action === 'toggle') {
    const { id, enabled, status } = body;
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });

    if (sb && userId) {
      const { data, error } = await sb
        .from('trading_strategies')
        .update({ enabled: !!enabled, status: status || (enabled ? 'running' : 'stopped') })
        .eq('id', id)
        .eq('user_id', uid)
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ strategy: data, source: 'supabase' });
    }

    const idx = MEM.findIndex(s => s.id === id && s.user_id === uid);
    if (idx >= 0) { MEM[idx].enabled = !!enabled; MEM[idx].status = status || (enabled ? 'running' : 'stopped'); }
    return NextResponse.json({ strategy: MEM[idx] || null, source: 'memory' });
  }

  // ── DELETE ──────────────────────────────────────────────────
  if (action === 'delete') {
    const { id } = body;
    if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });

    if (sb && userId) {
      const { error } = await sb
        .from('trading_strategies')
        .delete()
        .eq('id', id)
        .eq('user_id', uid);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, source: 'supabase' });
    }

    const idx = MEM.findIndex(s => s.id === id && s.user_id === uid);
    if (idx >= 0) MEM.splice(idx, 1);
    return NextResponse.json({ success: true, source: 'memory' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
