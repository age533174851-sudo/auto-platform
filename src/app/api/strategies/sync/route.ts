// /api/strategies/sync
// 사용자 전략 클라우드 동기화 (로그인 유저 전용)
//
// GET  ?action=pull       — Supabase에서 전체 전략 조회 → 클라이언트 병합
// POST { action:'push', strategies: [...] } — 클라이언트의 변경사항 업로드
// POST { action:'delete', id } — 단일 삭제
//
// 로그인 안 한 유저는 동기화 안 함 (localStorage만 사용).

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import type { UserStrategy } from '@/lib/strategies/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function rowToStrategy(row: any): UserStrategy {
  return {
    id:         row.id,
    name:       row.name || '',
    asset:      row.asset || '',
    market:     row.market || 'crypto',
    timeframe:  row.timeframe || '1h',
    mode:       row.mode || 'paper',
    action:     row.action || 'buy',
    conditions: Array.isArray(row.conditions) ? row.conditions : [],
    order:      row.order_spec || { type: 'market', amount: 0, currency: 'KRW' },
    risk:       row.risk || { takeProfitPct: 0, stopLossPct: 0 },
    enabled:    !!row.enabled,
    source:     row.source || 'manual',
    prompt:     row.prompt || undefined,
    createdAt:  row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt:  row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

function strategyToRow(s: UserStrategy, uid: string) {
  return {
    id:         s.id,
    user_id:    uid,
    name:       s.name,
    asset:      s.asset,
    market:     s.market,
    timeframe:  s.timeframe,
    mode:       s.mode,
    action:     s.action,
    conditions: s.conditions,
    order_spec: s.order,
    risk:       s.risk,
    enabled:    !!s.enabled,
    source:     s.source || 'manual',
    prompt:     s.prompt || null,
    created_at: new Date(s.createdAt).toISOString(),
    updated_at: new Date(s.updatedAt).toISOString(),
  };
}

// ── GET (pull) ────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ strategies: [], synced: false });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ strategies: [], synced: false, reason: 'supabase_not_configured' });

  const { data, error } = await (sb.from('user_strategies') as any)
    .select('*').eq('user_id', uid).order('updated_at', { ascending: false });

  if (error) return NextResponse.json({ strategies: [], synced: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    strategies: (data || []).map(rowToStrategy),
    synced: true,
    count: (data || []).length,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

// ── POST (push / delete) ──────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ error: 'auth_required', synced: false }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured', synced: false }, { status: 503 });

  const action = body.action;

  if (action === 'push') {
    const strategies: UserStrategy[] = Array.isArray(body.strategies) ? body.strategies : [];
    if (strategies.length === 0) return NextResponse.json({ ok: true, count: 0 });
    if (strategies.length > 50) {
      return NextResponse.json({ error: 'too_many_strategies (max 50)' }, { status: 400 });
    }

    // upsert 한 번에
    const rows = strategies.map(s => strategyToRow(s, uid));
    const { error } = await (sb.from('user_strategies') as any)
      .upsert(rows, { onConflict: 'id' });

    if (error) return NextResponse.json({ error: error.message, synced: false }, { status: 500 });
    return NextResponse.json({ ok: true, count: rows.length, synced: true });
  }

  if (action === 'delete') {
    const id = body.id;
    if (!id || typeof id !== 'string') return NextResponse.json({ error: 'missing_id' }, { status: 400 });
    const { error } = await (sb.from('user_strategies') as any)
      .delete().eq('id', id).eq('user_id', uid);
    if (error) return NextResponse.json({ error: error.message, synced: false }, { status: 500 });
    return NextResponse.json({ ok: true, synced: true });
  }

  return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
}
