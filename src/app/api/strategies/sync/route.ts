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
    req.headers.get('x-user-id'),
    req.headers.get('x-dev-token')
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
    req.headers.get('x-user-id'),
    req.headers.get('x-dev-token')
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

    const rows = strategies.map(s => strategyToRow(s, uid));

    // ── 남의 줄을 덮어쓰지 못하게 막는다 ──
    //
    // **여기가 위험했다.** 이 라우트는 service role로 돈다 — RLS를
    // 지나간다. 그런데 upsert의 열쇠가 `id` 하나뿐이라, 다른 사람의
    // 전략 id를 그대로 실어 보내면 그 줄이 덮어써지고 `user_id`까지
    // 내 것으로 바뀐다. 주인이 통째로 넘어간다.
    //
    // 노려서 하기는 어렵다(id에 난수가 붙는다). 하지만 우연히도 난다 —
    // `duplicateStrategy`가 만드는 id에는 난수가 없어서
    // 'str-' + 밀리초뿐이고, 두 사용자가 같은 밀리초에 복제하면 충돌한다.
    // 그때 한쪽 전략이 소리 없이 사라지고, 그걸 알아챌 방법이 없다.
    //
    // 그래서 **먼저 주인을 확인한다.** 남의 것이면 조용히 건너뛰지 않고
    // 거절한다 — 조용히 빼면 사용자는 저장된 줄 안다.
    const ids = rows.map(r => r.id);
    const { data: owners, error: ownerErr } = await (sb.from('user_strategies') as any)
      .select('id, user_id').in('id', ids);

    if (ownerErr) {
      // **주인을 확인 못 했으면 쓰지 않는다.** 확인하지 못한 것은 통과가 아니다.
      return NextResponse.json({
        error: ownerErr.message, synced: false,
        reason: '기존 전략의 주인을 확인하지 못해 저장하지 않았습니다',
      }, { status: 500 });
    }

    const foreign = (owners || []).filter((o: any) => o.user_id && o.user_id !== uid).map((o: any) => o.id);
    if (foreign.length > 0) {
      return NextResponse.json({
        error: 'id_owned_by_another_user', synced: false, ids: foreign,
        reason: '다른 계정의 전략과 id가 겹칩니다 — 덮어쓰면 그쪽 전략이 사라지므로 저장하지 않았습니다',
      }, { status: 409 });
    }

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
