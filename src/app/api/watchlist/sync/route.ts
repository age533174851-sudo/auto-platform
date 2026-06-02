// /api/watchlist/sync  GET=load  POST=add|remove|bulk_sync
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MEM = new Map<string, any[]>(); // fallback when Supabase unavailable

// ── GET ──────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ items: [], source: 'anon' });

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from('watchlists')
      .select('id,symbol,name_kr,symbol_ticker,color,category,exchange,tv_symbol,added_at')
      .eq('user_id', uid)
      .order('added_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ items: data ?? [], source: 'supabase' });
  }

  return NextResponse.json({ items: MEM.get(uid) ?? [], source: 'memory' });
}

// ── POST ─────────────────────────────────────────────────────
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

  if (action === 'add') {
    const record = {
      user_id: uid,
      symbol: body.symbol,
      name_kr: body.nameKr ?? body.symbol,
      symbol_ticker: body.symbolTicker ?? body.symbol,
      color: body.color ?? '#3B82F6',
      category: body.category ?? 'coin',
      exchange: body.exchange ?? 'BINANCE',
      tv_symbol: body.tvSymbol ?? null,
    };
    if (!record.symbol) return NextResponse.json({ error: 'symbol 필수' }, { status: 400 });

    if (sb) {
      const { data, error } = await sb
        .from('watchlists')
        .upsert(record, { onConflict: 'user_id,symbol' })
        .select('id,symbol,name_kr,symbol_ticker,color,category,exchange,tv_symbol,added_at')
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ item: data, source: 'supabase' });
    }

    const mem = MEM.get(uid) ?? [];
    const existing = mem.findIndex(i => i.symbol === record.symbol);
    if (existing >= 0) mem[existing] = { ...mem[existing], ...record };
    else mem.unshift({ ...record, id: 'mem-' + Date.now(), added_at: new Date().toISOString() });
    MEM.set(uid, mem);
    return NextResponse.json({ item: mem[0], source: 'memory' });
  }

  if (action === 'remove') {
    const { symbol } = body;
    if (!symbol) return NextResponse.json({ error: 'symbol 필수' }, { status: 400 });
    if (sb) {
      const { error } = await sb.from('watchlists').delete().eq('user_id', uid).eq('symbol', symbol);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, source: 'supabase' });
    }
    MEM.set(uid, (MEM.get(uid) ?? []).filter(i => i.symbol !== symbol));
    return NextResponse.json({ success: true, source: 'memory' });
  }

  if (action === 'bulk_sync') {
    const { items } = body as { items: any[] };
    if (!Array.isArray(items) || !items.length) return NextResponse.json({ synced: 0 });
    const records = items.map(i => ({
      user_id: uid,
      symbol: i.id ?? i.symbol,
      name_kr: i.nameKr ?? i.name_kr ?? i.symbol,
      symbol_ticker: i.sym ?? i.symbol_ticker ?? i.symbol,
      color: i.clr ?? i.color ?? '#3B82F6',
      category: i.cat ?? i.category ?? 'coin',
      exchange: i.exchange ?? 'BINANCE',
      tv_symbol: i.tv ?? i.tv_symbol ?? null,
    }));
    if (sb) {
      const { error } = await sb.from('watchlists').upsert(records, { onConflict: 'user_id,symbol' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ synced: records.length, source: 'supabase' });
    }
    MEM.set(uid, records.map(r => ({ ...r, id: 'mem-' + r.symbol, added_at: new Date().toISOString() })));
    return NextResponse.json({ synced: records.length, source: 'memory' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
