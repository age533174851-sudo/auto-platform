// GET /api/risk/kill-switch/status?connectionId=xxx
// 현재 equity 기준 일/주/월 drawdown 계산 + 스냅샷 롤오버 + active 판정(영속)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { getFuturesBalance } from '@/lib/exchanges/binanceFutures';
import { loadKillSwitch, saveKillSwitch, evaluate, computeUsdtEquity, logKillEvent, executeKillActions, reconcile, acquireLock, releaseLock } from '@/lib/risk/killSwitch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  let secret = '';
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); } catch {}
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;

  const bal = await getFuturesBalance(apiKey, secret, testnet);
  const equity = bal.success ? computeUsdtEquity(bal.balances as any) : 0;

  const prev = await loadKillSwitch(sb, uid, connectionId);
  const wasActive = prev.active;
  const { state, status } = evaluate(prev, equity, Date.now());

  // 롤오버/active 변화 영속
  let exec: any = null, recon: any = null;
  if (!prev.noTable) {
    await saveKillSwitch(sb, uid, connectionId, state);
    if (state.active) {
      const hasD = (state.actionMode || '').includes('D');
      // 발동 순간(전이): KILL_SWITCH_EXECUTE job 적재 (Worker가 유일 실행자)
      if (!wasActive) {
        await logKillEvent(sb, uid, connectionId, {
          reason: state.triggerReason || '한도 초과', equity, drawdownPct: status.daily.drawdownPct,
          action: state.actionMode, mode: testnet ? 'TESTNET' : 'LIVE',
        });
        // 자동 발동도 여기서 실제로 실행한다. 예전에는 job을 적재하고 Worker가
        // 실행했는데, 그 워커를 쓰지 않게 된 뒤로 한도를 넘겨 자동 발동해도
        // 포지션이 그대로 남았다. 수동 발동(trigger)과 같은 문제였다.
        try {
          const { loadBinanceCreds } = await import('@/lib/exchanges/loadCreds');
          const { executeKillActions } = await import('@/lib/risk/killSwitch');
          const creds = await loadBinanceCreds(sb, uid, connectionId);
          if (!creds.ok) {
            exec = { ran: false, error: creds.error,
              message: creds.message || 'API 키를 읽지 못해 취소·종료를 실행하지 못했습니다' };
          } else {
            const r = await executeKillActions(sb, uid, connectionId, {
              key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
              actionMode: state.actionMode,
            });
            exec = { ran: true, ...r };
          }
        } catch (e: any) {
          exec = { ran: false, error: 'execute_failed', message: e?.message || '취소·종료 실행 실패' };
        }

        // 🚨 즉시 텔레그램 알림 (실행 결과는 위 exec에 담겨 응답으로 나간다)
        try {
          const { sendTelegramAlert } = await import('@/lib/notify/telegram');
          await sendTelegramAlert({
            level: 'critical', eventType: 'kill_switch', exchange: 'Binance', mode: testnet ? 'TESTNET' : 'LIVE',
            title: 'Kill Switch Active',
            message: 'Worker가 Cancel All → Close All 실행 예정. 처리 결과는 추가 알림됩니다.',
            fields: { Reason: state.triggerReason || '한도 초과', Equity: `${equity.toFixed(2)} USDT`, Action: state.actionMode },
          }, sb);
        } catch {}
      }
      // 발동 중이면 잔여 재확인(읽기 전용) — 실제 종료는 Worker가 수행
      try {
        recon = await reconcile(sb, uid, connectionId, { key: apiKey, secret, testnet, expectClosed: hasD });
        if (recon && !recon.clean) {
          const { sendTelegramAlert } = await import('@/lib/notify/telegram');
          await sendTelegramAlert({
            level: 'warning', eventType: 'reconcile_fail', exchange: 'Binance', mode: testnet ? 'TESTNET' : 'LIVE',
            title: '거래소 직접 확인 필요',
            message: '킬스위치 후 잔여 포지션/주문이 남아있습니다.',
            fields: { Positions: recon.positions, Orders: recon.orders },
          }, sb);
        }
      } catch {}
    }
  }

  return NextResponse.json({ ...status, testnet, equityOk: bal.success, exec, recon }, { headers: { 'Cache-Control': 'no-store' } });
}
