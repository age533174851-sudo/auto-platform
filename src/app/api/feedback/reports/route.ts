// 문의 접수와 내 문의 목록.
//
// **비밀은 여기를 통과하지 못한다.** 본문도 컨텍스트도 저장 직전에
// `redact`/`pickContext`를 거친다. 저장한 뒤에 지우는 것은 지운 것이
// 아니다 — 한 번 들어간 값은 백업과 복제본에 남는다.
//
// 권한: service_role로 쓰고 `user_id`를 코드에서 박는다. 요청이 보낸
// user_id는 **읽지 않는다** — 읽으면 남의 이름으로 접수할 수 있다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  parseTicketInput, redactedOverflow, redactedOverflowMessage,
  ticketReportRow, TICKET_OPTIONAL_FIELDS, TICKET_REPORT_COLUMNS,
  type TicketOptionals,
} from '@/lib/feedback/ticket';
import { redact, redactionNotice } from '@/lib/feedback/redact';
import { pickContext } from '@/lib/feedback/context';

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

/** 내 문의 목록. **남의 것은 조건이 아니라 구조로 막는다** */
export async function GET(req: NextRequest) {
  const { uid, sb } = await ctx(req);
  if (!uid) return json({ ok: false, error: 'auth_required' }, 401);
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  const r = await sb.from('feedback_reports')
    .select(`${TICKET_REPORT_COLUMNS},updated_at`)
    .eq('user_id', uid).order('created_at', { ascending: false }).limit(100);
  // 못 읽은 것을 "없음"으로 적지 않는다.
  if (r.error || !Array.isArray(r.data)) {
    return json({ ok: false, error: 'tickets_unreadable', message: '문의 목록을 확인하지 못했습니다' }, 503);
  }
  return json({ ok: true, tickets: r.data });
}

/** 새 문의 접수 */
export async function POST(req: NextRequest) {
  const { uid, sb } = await ctx(req);
  if (!uid) return json({ ok: false, error: 'auth_required' }, 401);
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  let raw: any = null;
  try { raw = await req.json(); } catch { raw = null; }
  const parsed = parseTicketInput(raw);
  if (parsed == null) {
    return json({ ok: false, error: 'invalid_input',
      message: '분류·제목·내용을 확인해 주세요' }, 400);
  }

  // ── 비밀을 지운다. 제목과 본문 둘 다 ──
  const t = redact(parsed.title);
  const b = redact(parsed.body);
  // ── 가린 뒤의 길이를 **저장 전에** 본다 ──
  //
  // 가림은 글을 늘릴 수 있다. 늘어난 글은 DB의 CHECK에 막히고, 예전에는
  // 그것이 "다시 시도해 주세요"로 나갔다 — 같은 글은 다시 보내도 똑같이
  // 늘어나므로 영원히 실패하는 안내였다. 판정은 ticket.ts 한 곳에 있다.
  // ── 선택 칸도 같은 가림을 지난다 ──
  //
  // #618의 세 칸(재현 절차·기대·실제)은 **저장되지 않고 버려지고 있었다.**
  // 저장하기로 했으면 제목·본문과 **같은 가림**을 지나야 한다 — 사용자가
  // 재현 절차에 API 키를 붙여 넣는 일은 실제로 일어난다.
  const optionals: TicketOptionals = { steps: null, expected: null, actual: null };
  const optionalHits = [];
  for (const f of TICKET_OPTIONAL_FIELDS) {
    const v = parsed[f];
    if (v == null) continue;
    const r = redact(v);
    optionals[f] = r.text;
    optionalHits.push(...r.hits);
  }

  const over = redactedOverflow({ title: t.text, body: b.text, ...optionals });
  if (over) {
    // **글 내용은 담지 않는다 — 길이만 돌려준다.**
    return json({ ok: false, error: 'too_long_after_redaction',
      field: over.field, length: over.length, max: over.max, over: over.over,
      message: redactedOverflowMessage(over) }, 400);
  }

  const picked = pickContext(raw?.context);
  const hits = [...t.hits, ...b.hits, ...optionalHits];
  // 종류별로 합친다. **값은 어디에도 담지 않는다**
  const merged = new Map<string, number>();
  for (const h of hits) merged.set(h.kind, (merged.get(h.kind) ?? 0) + h.count);
  const redactions = [...merged].map(([kind, count]) => ({ kind, count }));

  // 줄을 손으로 적지 않는다 — 칸이 빠진 것을 아무도 모르던 자리였다.
  const ins = await sb.from('feedback_reports').insert(ticketReportRow({
    userId: uid,                                  // 요청이 보낸 값은 쓰지 않는다
    parsed, title: t.text, optionals,
    context: picked.context, redactions,
  })).select(TICKET_REPORT_COLUMNS).maybeSingle();

  if (ins.error || !ins.data) {
    return json({ ok: false, error: 'ticket_write_failed',
      message: '문의를 저장하지 못했습니다 — 다시 시도해 주세요' }, 503);
  }

  // 본문은 첫 메시지로 쌓는다. 같은 문의 안에서 대화가 이어지려면
  // 본문도 메시지 줄 하나여야 한다 — 글에 칸으로 두면 첫 글만 모양이 다르다.
  const msg = await sb.from('feedback_comments').insert({
    report_id: ins.data.id, author: 'USER', internal: false,
    body: b.text, redactions,
  }).select('id').maybeSingle();

  if (msg.error || !msg.data) {
    // 글만 남고 내용이 없으면 관리자가 읽을 것이 없다. **조용히 넘기지 않는다.**
    return json({ ok: false, error: 'ticket_body_write_failed', ticketId: ins.data.id,
      message: '문의는 접수됐지만 내용을 저장하지 못했습니다 — 내 문의에서 다시 적어 주세요' }, 503);
  }

  return json({
    ok: true,
    ticket: ins.data,
    // 무엇이 지워졌는지 사용자에게 알린다. **값은 적지 않는다**
    redactionNotice: redactionNotice(hits),
    droppedContext: picked.dropped,
  }, 201);
}
