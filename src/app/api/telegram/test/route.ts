// POST /api/telegram/test
// body: { channel?: 'money'|'system', severity?: 'critical'|'warning'|'info', test?: 'basic'|'throttle'|'escalation' }
// Redis 연결 상태도 반환

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { dispatchAlert } from '@/lib/notify/alerts';
import { redisAvailable } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const channel = body.channel === 'system' ? 'system' : 'money';
  const severity = ['critical', 'warning', 'info'].includes(body.severity) ? body.severity : 'info';
  const test = body.test || 'basic';
  const sb = getSupabaseAdmin();

  const redis = redisAvailable();

  // throttle 테스트: 동일 critical 3연발 → 1건 발송 + 2건 throttled
  if (test === 'throttle') {
    const results = [];
    for (let i = 1; i <= 3; i++) {
      results.push(await dispatchAlert({ severity: 'critical', channel, eventType: 'test_throttle', exchange: 'binance', symbol: 'BTCUSDT', title: `Throttle 테스트 #${i}`, message: '동일 키 연속 발송 — 1건만 발송되어야 정상' }, sb));
    }
    return NextResponse.json({ ok: true, redis, test, results });
  }

  // escalation 테스트: 동일 warning 10연발 → 10번째 critical 격상
  if (test === 'escalation') {
    const results = [];
    for (let i = 1; i <= 10; i++) {
      results.push(await dispatchAlert({ severity: 'warning', channel: 'system', eventType: 'test_escalation', exchange: 'binance', symbol: 'ALL', title: `Escalation 테스트 #${i}`, message: '1시간 내 10회 → Critical 격상 확인' }, sb));
    }
    return NextResponse.json({ ok: true, redis, test, escalated: results.some((r: any) => r.escalated), results });
  }

  // basic: 단일 발송
  const res = await dispatchAlert({
    severity: severity as any, channel,
    eventType: 'test', exchange: 'binance', mode: 'TESTNET',
    title: `${channel.toUpperCase()} Bot 테스트 (${severity})`,
    message: '✅ TRAIGO 알림 연결 확인',
    fields: { Time: new Date().toLocaleString('ko-KR'), Redis: redis ? '연결됨' : '미연결(fail-open)' },
  }, sb);

  return NextResponse.json({ ok: res.ok, redis, sent: res.sent, throttled: res.throttled, buffered: res.buffered, error: res.error, message: res.error ? `발송 실패: ${res.error}` : (res.buffered ? '버퍼링됨(5분 후 묶음 발송)' : res.sent === false ? 'info는 로그만 저장' : '발송 완료') });
}
