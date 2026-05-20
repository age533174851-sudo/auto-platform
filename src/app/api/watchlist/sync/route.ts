// /api/watchlist/sync — sync watchlist between client and Supabase
// GET  : fetch user's watchlist from Supabase
// POST : { action: 'add'|'remove'|'bulk_sync', ...payload }
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, getUserIdFromRequest } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// In-memory fallback
const MEM_WL: Map<string, any[]> = new Map();

// ─────────────────────────────────────────────────────────────
// GET /api/watchlist/sync
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  const fallbackId = req.headers.get('x-user-id') || 'demo-user';
  const uid = userId || fallbackId;

  const sb = getSupabaseAdmin();

  if (sb && userId) {
    const { data, error } = await sb
      .from('watchlists')
      .select('*')
      .eq('user_id', uid)
      .order('added_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ items: data || [], source: 'supabase' });
  }

  return NextResponse.json({ items: MEM_WL.get(uid) || [], source: 'memory' });
}

// ─────────────────────────────────────────────────────────────
// POST /api/watchlist/sync
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  const fallbackId = req.headers.get('x-user-id') || 'demo-user';
  const uid = userId || fallbackId;

  const sb = getSupabaseAdmin();

  // ── ADD single item ─────────────────────────────────────────
  if (action === 'add') {
    const { symbol, nameKr, symbolTicker, color, category, exchange, tvSymbol } = body;
    if (!symbol) return NextResponse.json({ error: 'symbol 필수' }, { status: 400 });

    const record = {
      user_id:       uid,
      symbol,
      name_kr:       nameKr || symbol,
      symbol_ticker: symbolTicker || symbol,
      color:         color || '#3B82F6',
      category:      category || 'coin',
      exchange:      exchange || 'BINANCE',
      tv_symbol:     tvSymbol || null,
    };

    if (sb && userId) {
      const { data, error } = await sb
        .from('watchlists')
        .upsert(record, { onConflict: 'user_id,symbol' })
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ item: data, source: 'supabase' });
    }

    const mem = MEM_WL.get(uid) || [];
    const existing = mem.findIndex(i => i.symbol === symbol);
    if (existing >= 0) mem[existing] = { ...mem[existing], ...record };
    else mem.unshift({ ...record, id: 'mem-' + Date.now(), added_at: new Date().toISOString() });
    MEM_WL.set(uid, mem);
    return NextResponse.json({ item: mem[0], source: 'memory' });
  }

  // ── REMOVE ──────────────────────────────────────────────────
  if (action === 'remove') {
    const { symbol } = body;
    if (!symbol) return NextResponse.json({ error: 'symbol 필수' }, { status: 400 });

    if (sb && userId) {
      const { error } = await sb
        .from('watchlists')
        .delete()
        .eq('user_id', uid)
        .eq('symbol', symbol);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, source: 'supabase' });
    }

    const mem = (MEM_WL.get(uid) || []).filter(i => i.symbol !== symbol);
    MEM_WL.set(uid, mem);
    return NextResponse.json({ success: true, source: 'memory' });
  }

  // ── BULK SYNC (push localStorage → Supabase on login) ───────
  if (action === 'bulk_sync') {
    const { items } = body as { items: any[] };
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ synced: 0, source: 'supabase' });
    }

    const records = items.map(i => ({
      user_id:       uid,
      symbol:        i.id || i.symbol,
      name_kr:       i.nameKr || i.name_kr || i.symbol,
      symbol_ticker: i.sym || i.symbol_ticker || i.symbol,
      color:         i.clr || i.color || '#3B82F6',
      category:      i.cat || i.category || 'coin',
      exchange:      i.exchange || 'BINANCE',
      tv_symbol:     i.tv || i.tv_symbol || null,
    }));

    if (sb && userId) {
      const { error } = await sb
        .from('watchlists')
        .upsert(records, { onConflict: 'user_id,symbol' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ synced: records.length, source: 'supabase' });
    }

    MEM_WL.set(uid, records.map(r => ({ ...r, id: 'mem-' + r.symbol, added_at: new Date().toISOString() })));
    return NextResponse.json({ synced: records.length, source: 'memory' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
