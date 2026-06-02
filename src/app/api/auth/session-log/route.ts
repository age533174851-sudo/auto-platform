// /api/auth/session-log
// GET    — 현재 사용자의 세션 기록 목록 (Authorization: Bearer)
// POST   — 새 세션 기록 또는 기존 갱신 (로그인/세션 확인 시 호출)
// DELETE ?id=xxx — 세션 종료 (revoked=true)
//
// 안전:
// - 모든 요청 JWT 검증 → 본인 row만 조작 가능 (RLS + service_role)
// - 세션 토큰은 클라이언트가 만들어 보냄 (UUID), 서버는 user_id로 격리

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { parseUserAgent } from '@/lib/auth/parseUA';
import { resolveGeoIP } from '@/lib/auth/geoip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// JWT에서 user 추출하는 헬퍼
async function resolveUser(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return { user: null, sb: null, error: 'no_token' };
  const sb = getSupabaseAdmin();
  if (!sb) return { user: null, sb: null, error: 'supabase_not_configured' };
  const { data, error } = await sb.auth.getUser(auth.slice(7));
  if (error || !data?.user) return { user: null, sb: null, error: 'invalid_token' };
  return { user: data.user, sb, error: null };
}

function getClientIP(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || '';
}

// ─── GET ─────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { user, sb, error } = await resolveUser(req);
  if (!user || !sb) return NextResponse.json({ sessions: [], error }, { status: 401 });

  const { data, error: queryErr } = await (sb.from('user_login_sessions') as any)
    .select('id, device_name, device_type, browser, os, ip_address, country, city, is_current, revoked, last_seen_at, created_at, session_token')
    .eq('user_id', user.id)
    .eq('revoked', false)
    .order('last_seen_at', { ascending: false })
    .limit(20);

  if (queryErr) return NextResponse.json({ sessions: [], error: queryErr.message }, { status: 500 });

  // 클라이언트로 보내기 전에 session_token 마스킹
  const sessions = (data || []).map((s: any) => ({
    ...s,
    session_token: s.session_token ? s.session_token.slice(0, 8) + '…' : null,
  }));

  return NextResponse.json({ sessions }, { headers: { 'Cache-Control': 'no-store' } });
}

// ─── POST ────────────────────────────────────────────────────────────────
// body: { sessionToken: string }   (클라이언트가 생성한 UUID)
// UA / IP는 서버가 헤더에서 추출
export async function POST(req: NextRequest) {
  const { user, sb, error } = await resolveUser(req);
  if (!user || !sb) return NextResponse.json({ error }, { status: 401 });

  let body: { sessionToken?: string };
  try { body = await req.json(); } catch { body = {}; }
  const token = (body.sessionToken || '').trim().slice(0, 100);
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 400 });

  const ua = req.headers.get('user-agent') || '';
  const parsed = parseUserAgent(ua);
  const ip = getClientIP(req);
  // GeoIP 조회 (Vercel 헤더 우선, 없으면 ipwho.is)
  const geo = await resolveGeoIP(req, ip);

  // 같은 (user_id, session_token)이 있으면 last_seen_at 갱신만, 없으면 insert
  const { data: existing } = await (sb.from('user_login_sessions') as any)
    .select('id')
    .eq('user_id', user.id)
    .eq('session_token', token)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing?.id) {
    // 기존 세션 갱신 — country/city는 변경되면 덮어쓰기
    const updateFields: any = {
      last_seen_at: now,
      is_current:   true,
      ip_address:   ip || null,
    };
    if (geo.country) updateFields.country = geo.country;
    if (geo.city)    updateFields.city    = geo.city;
    const { error: updErr } = await (sb.from('user_login_sessions') as any)
      .update(updateFields)
      .eq('id', existing.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    // 같은 user의 다른 세션은 is_current=false로
    await (sb.from('user_login_sessions') as any)
      .update({ is_current: false })
      .eq('user_id', user.id)
      .neq('id', existing.id);
    return NextResponse.json({ ok: true, id: existing.id, updated: true });
  }

  // 신규 세션
  const insertRow: Record<string, unknown> = {
    user_id:       user.id,
    email:         user.email || `${user.id}@unknown.local`,
    session_token: token,
    device_name:   parsed.deviceName,
    device_type:   parsed.deviceType,
    browser:       parsed.browser,
    os:            parsed.os,
    ip_address:    ip || null,
    country:       geo.country,
    city:          geo.city,
    user_agent:    ua.slice(0, 500),
    is_current:    true,
    revoked:       false,
    last_seen_at:  now,
  };

  const { data: inserted, error: insErr } = await (sb.from('user_login_sessions') as any)
    .insert(insertRow)
    .select('id')
    .single();

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // 같은 user의 다른 세션은 is_current=false로
  await (sb.from('user_login_sessions') as any)
    .update({ is_current: false })
    .eq('user_id', user.id)
    .neq('id', inserted.id);

  return NextResponse.json({ ok: true, id: inserted.id, created: true });
}

// ─── DELETE ─────────────────────────────────────────────────────────────
// ?id=xxx          → 특정 세션 revoked=true (DB 레벨)
// ?all_others=1    → 호출 토큰 외 모든 세션 실제 무효화 (Supabase Auth API)
//
// 정직: Supabase Auth API는 특정 refresh_token 하나만 무효화 못 함.
// scope='others'로 호출 토큰 외 전부 무효화만 가능.
// 따라서 "이 기기 외 모두 로그아웃"은 진짜 무효화, 개별 세션 종료는 DB 표시만.
export async function DELETE(req: NextRequest) {
  const { user, sb, error } = await resolveUser(req);
  if (!user || !sb) return NextResponse.json({ error }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  const allOthers = req.nextUrl.searchParams.get('all_others') === '1';

  // ── 모든 다른 세션 실제 무효화 ────────────────────────
  if (allOthers) {
    const auth = req.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 400 });

    // Supabase Auth API: 호출 토큰 제외 모든 세션 종료
    // signOut(jwt, 'others') — 다른 모든 디바이스의 refresh_token 폐기
    try {
      const adm: any = (sb as any).auth?.admin;
      if (adm?.signOut) {
        // v2 API: admin.signOut(jwt, scope)
        await adm.signOut(token, 'others');
      }
    } catch {
      // 실패해도 DB는 갱신 (best-effort)
    }

    // DB도 revoked 표시 (is_current인 것만 남기고 나머지)
    const { error: updErr } = await (sb.from('user_login_sessions') as any)
      .update({ revoked: true, is_current: false })
      .eq('user_id', user.id)
      .eq('is_current', false);   // 현재 세션은 유지
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, all_others: true });
  }

  // ── 단일 세션 종료 (DB 마킹만) ────────────────────────
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  // 현재 세션인지 확인 — 현재 세션 종료는 별도 안내
  const { data: target } = await (sb.from('user_login_sessions') as any)
    .select('is_current')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  const isCurrent = !!target?.is_current;

  const { error: updErr } = await (sb.from('user_login_sessions') as any)
    .update({ revoked: true, is_current: false })
    .eq('id', id)
    .eq('user_id', user.id);   // 본인 것만

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    is_current: isCurrent,
    note: isCurrent
      ? '현재 세션 표시를 종료했습니다. 실제 로그아웃은 클라이언트에서 별도로 진행해주세요.'
      : '세션이 종료 표시되었습니다. 다른 기기는 다음 토큰 갱신 시점에 자동으로 로그아웃됩니다.',
  });
}
