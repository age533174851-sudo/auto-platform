// GET /api/risk/kill-switch/status?connectionId=xxx
// 현재 equity 기준 일/주/월 drawdown 계산 + 스냅샷 롤오버 + active 판정(영속)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadKillSwitch, saveKillSwitch, evaluate, logKillEvent, reconcile } from '@/lib/risk/killSwitch';
import { isTestnetConn, leftoverVerdict , effectiveModeOf } from '@/lib/risk/killSwitchTruth';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { futuresEquityUsd } from '@/lib/exchanges/futuresAdapter';

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

  // **저장소 전체 규칙: `is_testnet === false`만 실전이다.**
  // 예전에는 `=== true`였다 — 칸이 비어 있으면(NULL) 실전으로 읽혀서
  // 테스트넷 키로 실전 호스트에 물어보고, 실패하고, 그 실패가 아래에서
  // `equity = 0`이 되어 킬스위치 발동으로 이어졌다.
  const testnet = isTestnetConn(conn);

  // **거래소를 가리지 않는다.** 예전에는 바이낸스 잔고 함수를 직접
  // 불렀다 — Gate 연결이면 언제나 실패했고, 그 실패가 equity 0이었다.
  const creds = await loadFuturesCreds(sb, uid, connectionId);
  const bal = creds.ok && creds.exchange
    ? await futuresEquityUsd(creds.exchange, creds.key!, creds.secret!, creds.testnet!)
    : { equity: null as number | null, error: creds.message || creds.error || '연결을 읽지 못했습니다' };

  const prev = await loadKillSwitch(sb, uid, connectionId);

  // ── 총자산을 못 읽으면 평가하지 않는다 ──
  //
  // **예전에는 실패를 `equity = 0`으로 만들어 evaluate에 넘겼다.**
  // 그러면 낙폭이 -100%가 되어 한도를 무조건 넘고, 멀쩡한 계좌에서
  // 킬스위치가 발동한다. `actionMode`에 D가 있으면 **실제 포지션이
  // 전부 청산된다.** 조회 한 번 실패한 값으로 할 일이 아니다.
  //
  // 켜져 있던 상태를 끄지도 않는다 — 모르는 것은 해제 사유가 아니다.
  if (bal.equity == null) {
    // **평가하지 않는다고 해놓고 evaluate를 부르지 않는다.**
    //
    // 예전 초안은 표시값을 만들려고 `evaluate(prev, prev.dailyStartEquity ?? 0, ...)`을
    // 다시 불렀다. 그러면 기준선 조합에 따라 낙폭이 0%로도 -100%로도
    // 나온다 — DB에 저장되지는 않지만 **화면이 거짓을 말한다.**
    // 모르는 것은 계산하지 않고 모른다고 적는다.
    return NextResponse.json({
      config: {
        enabled: prev.enabled, dailyLimitPct: prev.dailyLimitPct,
        weeklyLimitPct: prev.weeklyLimitPct, monthlyLimitPct: prev.monthlyLimitPct,
        absLimitUsdt: prev.absLimitUsdt, actionMode: prev.actionMode,
      },
      // 켜져 있던 상태는 그대로 보여 준다 — 모르는 것은 해제 사유가 아니다.
      active: prev.active,
      level: prev.active ? 'active' : 'unknown',
      triggeredAt: prev.triggeredAt, triggerReason: prev.triggerReason,
      // **0으로 채우지 않는다.** 0은 "손실 100%"로 읽힌다.
      equity: null,
      daily: { startEquity: prev.dailyStartEquity, drawdownPct: null, remainingPct: null },
      weekly: { startEquity: prev.weeklyStartEquity, drawdownPct: null, remainingPct: null },
      monthly: { startEquity: prev.monthlyStartEquity, drawdownPct: null, remainingPct: null },
      absLoss: null,
      noTable: prev.noTable,
      testnet, equityOk: false, equityError: bal.error,
      evaluated: false,
      message: '총자산을 읽지 못해 손실 한도를 평가하지 않았습니다 — '
        + '0으로 계산하면 멀쩡한 계좌에서 킬스위치가 발동합니다',
      exec: null, recon: null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const equity = bal.equity;
  const wasActive = prev.active;
  const { state, status } = evaluate(prev, equity, Date.now());

  // 롤오버/active 변화 영속
  let exec: any = null, recon: any = null;
  if (!prev.noTable) {
    // ── 자동 발동에도 반드시 true/false를 남긴다 ──
    //
    // 이 경로(손실 한도 자동 발동)는 targeted 청산(REDUCE_RISK·
    // CLOSE_AUTOMATED)을 타지 않는다. 마무리할 targeted 작업이 없으므로
    // **false**다.
    //
    // 여기서 안 남기면 null로 남고, 읽는 쪽은 null을 legacy·기록 실패로
    // 보고 리셋을 막는다 — **줄일 것이 애초에 없던 발동이 영원히
    // 안 풀린다.**
    if (!wasActive && state.active) state.targetedPending = false;
    await saveKillSwitch(sb, uid, connectionId, state);
    if (state.active) {
      // **이번 발동을 만든 조합**으로 본다. 설정값으로 보면 수동으로
      // 더 강한 단계를 실행한 경우를 놓친다.
      const effNow = effectiveModeOf({
        effective: state.effectiveActionMode, config: state.actionMode, active: state.active,
      });
      const hasD = effNow.expectedClosed;
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
          // **거래소를 가리지 않는다.** executeKillActions는 이미 Gate를
          // 받는데(opts.exchange), 이 라우트가 loadBinanceCreds라 Gate
          // 연결이면 시작도 못 했다 — 만들어 놓고 배선을 안 한 자리다.
          //
          // 킬스위치는 "문을 잠그고 안에 있는 것을 꺼내는" 동작이다.
          // 꺼내는 쪽이 안 돌면 잠그기만 하고 끝나는데, 급할 때 누른
          // 사람은 정리됐다고 믿고 손을 뗀다.
          const { executeKillActions } = await import('@/lib/risk/killSwitch');
          if (!creds.ok) {
            exec = { ran: false, error: creds.error,
              message: creds.message || 'API 키를 읽지 못해 취소·종료를 실행하지 못했습니다' };
          } else {
            const r = await executeKillActions(sb, uid, connectionId, {
              key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
              exchange: creds.exchange!,
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
        // **거래소를 가리지 않는다.** 예전에는 바이낸스 `countOpen`을
        // 직접 불렀다 — 실행은 Gate를 받는데 마지막 확인만 바이낸스라,
        // Gate 연결에서는 잔여 확인이 인증 오류로 끝나고 조용히 넘어갔다.
        recon = creds.ok && creds.exchange
          ? await reconcile(sb, uid, connectionId, {
              key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
              exchange: creds.exchange, expectClosed: hasD,
            })
          : { positions: null, orders: null, clean: false,
              error: creds.message || '연결을 읽지 못해 잔여를 확인하지 못했습니다' };
        if (recon && !recon.clean) {
          const { sendTelegramAlert } = await import('@/lib/notify/telegram');
          await sendTelegramAlert({
            level: 'warning', eventType: 'reconcile_fail', exchange: 'Binance', mode: testnet ? 'TESTNET' : 'LIVE',
            title: '거래소 직접 확인 필요',
            message: '킬스위치 후 잔여 포지션/주문이 남아있습니다.',
            // **못 읽은 것을 0으로 적지 않는다.**
            fields: {
              Positions: recon.positions ?? '확인 못 함',
              Orders: recon.orders ?? '확인 못 함',
            },
          }, sb);
        }
      } catch {}
    }
  }

  return NextResponse.json({
    ...status, testnet, equityOk: true, evaluated: true, exec, recon,
    // 잔여를 '정리됨'으로 단정하지 않는다 — 못 읽었으면 그 사실을 싣는다.
    leftover: recon
      ? leftoverVerdict({
          leftover: recon,
          expectedClosed: effectiveModeOf({
            effective: state.effectiveActionMode, config: state.actionMode, active: state.active,
          }).expectedClosed,
        })
      : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
