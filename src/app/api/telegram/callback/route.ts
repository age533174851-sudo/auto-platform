// src/app/api/telegram/callback/route.ts
// 텔레그램 인라인 버튼 클릭 처리 (일시정지 / 전량청산).
// 텔레그램 봇 webhook으로 등록: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<APP_URL>/api/telegram/callback
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function tgApi(method: string, body: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
}

async function answer(cbId: string, text: string) {
  await tgApi('answerCallbackQuery', { callback_query_id: cbId, text, show_alert: false });
}

export async function POST(req: NextRequest) {
  const { log } = await import('@/lib/log/logger');

  // ── 보안 ①: 텔레그램 secret token 헤더 검증 ──
  // setWebhook 시 secret_token으로 등록하면 텔레그램이 이 헤더를 실어보냄. 위조 요청 차단.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (secret) {
    const got = req.headers.get('x-telegram-bot-api-secret-token') || '';
    if (got !== secret) {
      log.warn('telegram', '콜백 secret 불일치 — 위조 요청 차단');
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  let update: any;
  try { update = await req.json(); } catch { return NextResponse.json({ ok: true }); }

  const cb = update?.callback_query;
  if (!cb) return NextResponse.json({ ok: true });   // 메시지 등 다른 업데이트는 무시

  // ── 보안 ②: 소유자 검증 — 등록된 chat_id에서 온 클릭만 허용 ──
  const allowedChat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  const fromChat = String(cb.message?.chat?.id ?? cb.from?.id ?? '');
  if (allowedChat && fromChat && fromChat !== allowedChat) {
    log.warn('telegram', '허용되지 않은 사용자의 버튼 클릭 차단', { fromChat });
    await answer(cb.id, '권한이 없습니다');
    return NextResponse.json({ ok: true });
  }

  const cbId = cb.id;
  const data: string = cb.data || '';
  const [action, connectionId] = data.split(':');

  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();
    if (!sb) { await answer(cbId, '서버 설정 오류'); return NextResponse.json({ ok: true }); }

    if (action === 'pause') {
      // 신규 진입 차단 (킬스위치 active=true) — 보유 포지션은 유지
      if (!connectionId) { await answer(cbId, '연결 정보 없음'); return NextResponse.json({ ok: true }); }
      await sb.from('kill_switch_state').upsert(
        { connection_id: connectionId, active: true, trigger_reason: '텔레그램 일시정지', updated_at: new Date().toISOString() },
        { onConflict: 'connection_id' }
      );
      log.warn('telegram', '일시정지 실행', { connectionId });
      await answer(cbId, '⏸ 일시정지됨 — 신규 진입이 차단됩니다');
      await tgApi('sendMessage', { chat_id: cb.message?.chat?.id, text: '⏸ <b>일시정지</b>\n신규 진입이 차단되었습니다. 보유 포지션은 유지됩니다.', parse_mode: 'HTML' });
    } else if (action === 'closeall') {
      // 1단계: 확인 버튼 재요청 (실수 방지)
      if (!connectionId) { await answer(cbId, '연결 정보 없음'); return NextResponse.json({ ok: true }); }
      await answer(cbId, '전량청산 확인이 필요합니다');
      await tgApi('sendMessage', {
        chat_id: cb.message?.chat?.id,
        text: '⚠️ <b>전량청산 확인</b>\n모든 포지션을 시장가로 청산합니다. 되돌릴 수 없어요.',
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ 청산 확정', callback_data: `closeconfirm:${connectionId}` },
          { text: '취소', callback_data: `cancel:${connectionId}` },
        ]] },
      });
    } else if (action === 'closeconfirm') {
      // 2단계: 실제 전량청산 job 적재 (Worker가 실행)
      if (!connectionId) { await answer(cbId, '연결 정보 없음'); return NextResponse.json({ ok: true }); }
      const { data: conn } = await sb.from('exchange_connections').select('user_id').eq('id', connectionId).maybeSingle();
      const { enqueueJob } = await import('@/lib/jobs');
      const q = await enqueueJob(sb, { action: 'CLOSE_ALL_POSITIONS', connectionId, userId: conn?.user_id, payload: { source: 'telegram' } } as any);
      log.fatal('telegram', '전량청산 요청', { connectionId, jobId: q.jobId });
      await answer(cbId, q.ok ? '🔴 전량청산 요청됨' : '청산 실패');
      await tgApi('sendMessage', { chat_id: cb.message?.chat?.id, text: q.ok ? '🔴 <b>전량청산</b> 요청이 접수되었습니다. 잠시 후 체결됩니다.' : '⚠️ 전량청산 실패 — 다시 시도하세요.', parse_mode: 'HTML' });
    } else if (action === 'cancel') {
      await answer(cbId, '취소되었습니다');
    } else {
      await answer(cbId, '알 수 없는 동작');
    }
  } catch (e: any) {
    log.error('telegram', `콜백 처리 실패: ${e?.message}`, { data });
    await answer(cbId, '처리 중 오류가 발생했습니다');
  }
  return NextResponse.json({ ok: true });
}
