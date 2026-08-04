// POST /api/risk/kill-switch/trigger
// { connectionId, reason? } — 수동 발동 (즉시 active=true)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { loadKillSwitch, saveKillSwitch, logKillEvent, executeKillActions } from '@/lib/risk/killSwitch';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId, reason } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  const s = await loadKillSwitch(sb, uid, connectionId);
  if (s.noTable) return NextResponse.json({ error: 'table_missing', message: 'kill_switch_state 테이블이 없습니다.' }, { status: 503 });

  const wasActive = s.active;
  s.active = true;
  s.triggeredAt = Date.now();
  s.triggerReason = reason || '수동 발동';

  const ok = await saveKillSwitch(sb, uid, connectionId, s);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 500 });

  const testnet = conn.is_testnet === true;
  await logKillEvent(sb, uid, connectionId, { reason: s.triggerReason, equity: 0, drawdownPct: 0, action: 'MANUAL_TRIGGER', mode: testnet ? 'TESTNET' : 'LIVE' });

  // ── 발동 순간 실제로 실행한다 ──
  //
  // 예전에는 KILL_SWITCH_EXECUTE job을 적재하고 Worker가 실행하게 했다. 그
  // 워커는 Binance IP 지역 차단으로 쓰지 않고 있어서(PROGRESS 인프라 표)
  // **미체결 취소와 포지션 종료가 일어나지 않았다.**
  //
  // 즉 킬스위치를 누르면 DB의 active=true는 켜져서 신규 주문은 막혔지만,
  // 이미 열린 포지션은 그대로 남았다. 문을 잠그고 안에 있는 것을 꺼내지 않은
  // 것이다. 급할 때 누른 사람은 정리됐다고 믿고 손을 뗀다 — 이 앱에서 가장
  // 위험한 실패였다.
  //
  // executeKillActions는 이 파일이 이미 import하고 있었다. 부르지 않았을 뿐이다.
  let exec: any = null;
  if (!wasActive) {
    try {
      const creds = await loadFuturesCreds(sb, uid, connectionId);
      if (!creds.ok) {
        // 실행하지 못했다는 사실을 숨기지 않는다. active=true는 이미 저장됐으므로
        // 신규 주문은 막힌 상태다 — 그 절반만 됐다는 것을 응답에 적는다.
        exec = { ran: false, error: creds.error, message: creds.message
          || 'API 키를 읽지 못해 취소·종료를 실행하지 못했습니다' };
      } else {
        const r = await executeKillActions(sb, uid, connectionId, {
          key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
          exchange: creds.exchange, actionMode: s.actionMode,
        });
        exec = { ran: true, ...r };
      }
    } catch (e: any) {
      exec = { ran: false, error: 'execute_failed', message: e?.message || '취소·종료 실행 실패' };
    }
  }

  // 취소·종료가 실패하면 ok:true로 돌려주지 않는다. 화면이 "정리됨"으로 그리면
  // 사용자는 거래소를 확인하지 않는다.
  const execOk = !wasActive
    ? !!(exec?.ran && (exec.cancel?.success !== false) && (exec.close?.success !== false))
    : true;

  return NextResponse.json({
    ok: execOk,
    active: true,
    queued: false,
    triggerReason: s.triggerReason,
    exec,
    message: execOk
      ? '킬스위치 발동 — 신규 주문 차단, 미체결 취소·포지션 종료 완료'
      : '킬스위치는 켜졌지만(신규 주문 차단) 취소·종료가 완료되지 않았습니다 — 거래소에서 직접 확인하세요',
  }, { status: execOk ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
