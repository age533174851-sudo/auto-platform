// 문의 하나 — 읽기와 **답장**.
//
// 답장이 핵심이다. "다른 방식으로 고쳐 주세요"가 새 문의가 아니라 같은
// 글의 다음 줄이어야 앞선 맥락이 이어진다.
//
// 내부 메모는 여기로 나가지 않는다. 두 겹으로 막는다:
//   ① 이 조회가 `internal=false`만 고른다
//   ② DB 정책(106)이 소유자에게 internal 줄을 주지 않는다
// 한 겹이 뚫려도 다른 겹이 남는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { canUserReply, BODY_MAX } from '@/lib/feedback/ticket';
import { redact, redactionNotice } from '@/lib/feedback/redact';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function ctx(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  const sb: any = uid ? getSupabaseAdmin() : null;
  return { uid, sb };
}

/** 소유자 확인. **못 읽은 것과 남의 것을 구분한다** */
async function own(sb: any, uid: string, id: string) {
  const r = await sb.from('feedback_reports')
    .select('id,ref,category,title,status,severity,visibility,context,created_at,updated_at')
    .eq('id', id).eq('user_id', uid).maybeSingle();
  if (r.error) return { ticket: null, unreadable: true as const };
  return { ticket: r.data ?? null, unreadable: false as const };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { uid, sb } = await ctx(req);
  if (!uid) return json({ ok: false, error: 'auth_required' }, 401);
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  const { ticket, unreadable } = await own(sb, uid, params.id);
  if (unreadable) return json({ ok: false, error: 'ticket_unreadable',
    message: '문의를 확인하지 못했습니다' }, 503);
  if (!ticket) return json({ ok: false, error: 'not_found' }, 404);

  const m = await sb.from('feedback_comments')
    .select('id,author,body,created_at')
    .eq('report_id', params.id).eq('internal', false)   // ① 내부 메모는 고르지 않는다
    .order('created_at', { ascending: true }).limit(200);
  if (m.error || !Array.isArray(m.data)) {
    return json({ ok: false, error: 'messages_unreadable',
      message: '대화 내용을 확인하지 못했습니다' }, 503);
  }
  return json({ ok: true, ticket, messages: m.data });
}

/** 같은 문의에 한 줄 더. 새 문의를 만들지 않는다 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { uid, sb } = await ctx(req);
  if (!uid) return json({ ok: false, error: 'auth_required' }, 401);
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  let raw: any = null;
  try { raw = await req.json(); } catch { raw = null; }
  const text = typeof raw?.body === 'string' ? raw.body.trim() : '';
  if (text === '' || text.length > BODY_MAX) {
    return json({ ok: false, error: 'invalid_input', message: '내용을 확인해 주세요' }, 400);
  }

  const { ticket, unreadable } = await own(sb, uid, params.id);
  if (unreadable) return json({ ok: false, error: 'ticket_unreadable',
    message: '문의를 확인하지 못했습니다' }, 503);
  if (!ticket) return json({ ok: false, error: 'not_found' }, 404);
  if (!canUserReply(ticket.status)) {
    return json({ ok: false, error: 'ticket_closed',
      message: '종료된 문의입니다 — 새 문의를 남겨 주세요' }, 409);
  }

  const b = redact(text);
  const merged = new Map<string, number>();
  for (const h of b.hits) merged.set(h.kind, (merged.get(h.kind) ?? 0) + h.count);
  const redactions = [...merged].map(([kind, count]) => ({ kind, count }));

  const ins = await sb.from('feedback_comments').insert({
    report_id: ticket.id, author: 'USER', internal: false, body: b.text, redactions,
  }).select('id,author,body,created_at').maybeSingle();
  if (ins.error || !ins.data) {
    return json({ ok: false, error: 'message_write_failed',
      message: '답장을 저장하지 못했습니다' }, 503);
  }

  // 사용자가 답장했으면 "추가 정보 요청" 상태는 더 이상 맞지 않다.
  // **상태를 되돌리지는 않는다** — 진행 중인 수정을 접수로 내리면 안 된다.
  if (ticket.status === 'NEEDS_INFO') {
    await sb.from('feedback_reports')
      .update({ status: 'REVIEWING', updated_at: new Date().toISOString() })
      .eq('id', ticket.id).eq('user_id', uid);
  } else {
    await sb.from('feedback_reports')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', ticket.id).eq('user_id', uid);
  }

  return json({ ok: true, message: ins.data, redactionNotice: redactionNotice(b.hits) }, 201);
}
