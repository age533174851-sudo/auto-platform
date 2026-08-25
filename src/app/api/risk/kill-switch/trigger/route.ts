// POST /api/risk/kill-switch/trigger
// { connectionId, reason? } — 수동 발동 (즉시 active=true)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { loadKillSwitch, saveKillSwitch, logKillEvent, executeKillActions, reconcile } from '@/lib/risk/killSwitch';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { isTestnetConn, intentOf, leftoverVerdict, retriggerPlan, killCompletion, discoveryVerdict } from '@/lib/risk/killSwitchTruth';
import { levelOf, actionModeOf } from '@/lib/risk/emergencyLevel';

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

  // ── 이번에 실제로 하기로 한 조합을 **저장 전에** 정한다 ──
  //
  // 예전에는 저장이 먼저였고 저장되는 값은 설정의 `actionMode`였다.
  // 그래서 이런 일이 가능했다:
  //
  //   설정 BC → 수동 CLOSE_ALL(ABCD) 실행 → 포지션 일부 남음 → reset
  //   → reset은 저장된 BC로 읽어 expectedClosed = false
  //   → 잔여 판정이 포지션을 안 세고 CLEAR → **남은 포지션 위에서 잠금 해제**
  //
  // 설정값은 그대로 두고(사용자 설정이다) 이번 발동의 조합을 따로 남긴다.
  const levelSpec = levelOf(body?.level);
  const modeForCheck = levelSpec ? actionModeOf(levelSpec) : s.actionMode;

  s.active = true;
  s.triggeredAt = Date.now();
  s.triggerReason = reason || '수동 발동';
  s.effectiveActionMode = modeForCheck;

  const ok = await saveKillSwitch(sb, uid, connectionId, s);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 500 });

  // 저장소 전체 규칙: `is_testnet === false`만 실전이다.
  const testnet = isTestnetConn(conn);
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
  const creds = await loadFuturesCreds(sb, uid, connectionId);

  // ── 이미 발동 중인데 다시 눌렀다 ──
  //
  // **예전에는 무조건 건너뛰고 `ok: true`를 줬다.** 그런데 사용자가 다시
  // 누르는 순간은 대부분 **첫 실행이 절반만 됐을 때**다. 그때 아무것도
  // 안 하고 성공이라고 답하면 남은 포지션을 아무도 안 본다.
  //
  // 그래서 먼저 거래소에 물어본다. 남은 것이 없다고 **확인됐을 때만**
  // 건너뛴다 — 모르면 다시 한다.
  // **이번에 실제로 하기로 한 조합.** 저장된 actionMode와 다를 수 있다
  // (단계를 골라 보내면 그 단계가 이긴다). 완료 문구는 반드시 이 값을
  // 기준으로 적어야 한다 — 저장값으로 적으면 안 한 일을 말하게 된다.
  let preLeftover: any = null;
  /** 줄일 대상을 실제로 확인했는가. **빈 배열과 못 찾음을 가른다** */
  let discovery: any = null;
  let positionsRead = false;
  let ledgerRead = false;
  if (wasActive && creds.ok && creds.exchange) {
    try {
      const r = await reconcile(sb, uid, connectionId, {
        key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
        exchange: creds.exchange, expectClosed: intentOf(modeForCheck).close,
      });
      preLeftover = leftoverVerdict({ leftover: r, expectedClosed: intentOf(modeForCheck).close });
    } catch { preLeftover = null; }
  }
  const rerun = retriggerPlan({ wasActive, leftover: preLeftover });

  let exec: any = null;
  if (rerun.execute) {
    try {
      if (!creds.ok) {
        // 실행하지 못했다는 사실을 숨기지 않는다. active=true는 이미 저장됐으므로
        // 신규 주문은 막힌 상태다 — 그 절반만 됐다는 것을 응답에 적는다.
        exec = { ran: false, error: creds.error, message: creds.message
          || 'API 키를 읽지 못해 취소·종료를 실행하지 못했습니다' };
      } else {
        // ── 단계를 받는다 ──
        //
        // 예전에는 저장된 actionMode 하나뿐이라, 버튼이 실질적으로
        // 하나였다. 그리고 그 하나가 **손매매 포지션까지** 닫았다 —
        // 봇이 이상해서 눌렀는데 어제부터 들고 있던 것도 같이 나간다.
        // 한 번 겪으면 다음부터 그 버튼을 못 누른다.
        //
        // 단계를 안 주면 예전 동작 그대로다(저장된 actionMode).
        const { automatedSymbols, closeTargets } = await import('@/lib/risk/emergencyLevel');
        const spec = levelSpec;

        // ── 심볼별로 닫는 단계 ──
        //
        // executeKillActions의 'D'는 **계좌의 모든 포지션**을 닫는다.
        // "자동매매가 연 것만" 또는 "절반만"은 그걸로 못 한다 —
        // 손매매까지 나가면 이 단계를 만든 이유의 정반대다.
        let autoNote = '';
        let closed: Array<{
          symbol: string; ok: boolean; message: string;
          before?: number | null; after?: number | null; closePct?: number;
        }> = [];
        if (spec && spec.closePct > 0 && (spec.automatedOnly || spec.closePct < 100)) {
          const { futuresPositionRisk, futuresClosePosition } =
            await import('@/lib/exchanges/futuresAdapter');
          const { futuresListPositions } = await import('@/lib/exchanges/futuresExec');
          const { strategyOf } = await import('@/lib/strategies/ledger');

          // ── 열린 포지션은 거래소에 물어본다 ──
          //
          // **예전에는 `live_orders`의 심볼만 후보로 만들었다.**
          // REDUCE_RISK는 정의상 "모든 열린 포지션을 절반으로"인데,
          // 그 표에 줄이 없으면 후보가 0이 되어 **거래소에 포지션이
          // 둘 있어도 아무것도 줄이지 않고** `targeted: []`로 끝났다.
          // 그리고 완료 판정은 빈 배열에 아무것도 요구하지 않았다.
          //
          // 장부는 "어느 것이 봇의 것인가"를 가릴 때만 쓴다. 무엇이
          // 열려 있는지는 거래소가 답할 일이다.
          const posList = await futuresListPositions({
            exchange: creds.exchange as any, key: creds.key!, secret: creds.secret!,
            testnet: creds.testnet!,
          });
          positionsRead = posList.ok;
          const live: Array<{ symbol: string; qty: number }> = (posList.positions || [])
            .map((p: any) => ({
              symbol: String(p.symbol || '').toUpperCase(),
              qty: Math.abs(Number(p.qty ?? p.positionAmt ?? 0)),
            }))
            .filter(p => p.symbol && Number.isFinite(p.qty) && p.qty > 0);

          // 어느 심볼이 봇이 연 것인가. **automatedOnly일 때만 필요하다.**
          // 그리고 조회 실패와 "봇이 연 것이 없음"을 가른다 — 예전에는
          // `rows`가 null이라 둘이 구분되지 않았다.
          const led = await (sb as any).from('live_orders')
            .select('symbol, signal_id, status')
            .eq('connection_id', connectionId).eq('status', 'FILLED')
            .order('created_at', { ascending: false }).limit(200);
          ledgerRead = !led?.error && Array.isArray(led?.data);
          const auto = automatedSymbols(ledgerRead ? led.data : [], strategyOf);

          const plan = closeTargets(spec, live, auto);
          discovery = discoveryVerdict({
            spec, positionsRead, ledgerRead, targetCount: plan.targets.length,
          });
          autoNote = plan.note;
          for (const t of plan.targets) {
            const before = live.find(l => l.symbol === t.symbol)?.qty ?? null;
            const r = await futuresClosePosition(
              creds.exchange!, creds.key!, creds.secret!, creds.testnet!,
              t.symbol, spec.closePct);

            // ── 접수는 체결이 아니다 ──
            //
            // **예전에는 `r.success`만 모았다.** 그런데 그건 주문이
            // 접수됐다는 뜻이고, 실제로 줄었는지는 **포지션을 다시
            // 읽어야** 안다. 이 저장소가 `closeEvidence`에서 이미 정한
            // 규칙인데 이 경로만 안 따르고 있었다.
            //
            // 못 읽으면 null이다 — 0으로 적으면 "닫혔다"가 사실이 된다.
            let after: number | null = null;
            if (r.success) {
              try {
                const rr2 = await futuresPositionRisk(
                  creds.exchange!, creds.key!, creds.secret!, t.symbol, creds.testnet!);
                const amt2 = rr2.risk?.positionAmt;
                after = amt2 == null ? null : Math.abs(Number(amt2));
                if (!Number.isFinite(after as number)) after = null;
              } catch { after = null; }
            }
            closed.push({
              symbol: t.symbol, ok: !!r.success, message: r.message,
              before, after, closePct: spec.closePct,
            });
          }
        }

        const r = await executeKillActions(sb, uid, connectionId, {
          key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
          exchange: creds.exchange,
          // 단계가 있으면 그 조합, 없으면 저장된 값.
          actionMode: spec ? actionModeOf(spec) : s.actionMode,
        });
        exec = {
          ran: true, ...r,
          level: spec?.level ?? null,
          levelLabel: spec?.label ?? null,
          // **무엇을 안 했는지도 적는다.** 자동매매 것만 닫는 단계인데
          // 대상이 없으면 "정리됨"으로 보이면 안 된다.
          note: autoNote || null,
          // **닫으려다 실패한 것을 숨기지 않는다.** 하나라도 실패했으면
          // "정리됨"으로 그리면 안 된다.
          closed: closed.length ? closed : null,
          closeFailed: closed.filter(c => !c.ok).length,
          // **완료 판정이 보는 것.** `D`가 없는 단계(CLOSE_AUTOMATED ·
          // REDUCE_RISK)도 여기로 검사된다 — 주문 응답이 아니라 재조회 결과로.
          targeted: closed.length ? closed : null,
        };
      }
    } catch (e: any) {
      exec = { ran: false, error: 'execute_failed', message: e?.message || '취소·종료 실행 실패' };
    }
  }

  // **KILL은 반드시 기록에 남는다.** 급할 때 누른 버튼이라 나중에
  // "누가 언제 왜 눌렀나"를 가장 많이 묻게 된다. 그리고 실행이 절반만
  // 됐을 때 그 사실도 같이 남아야 한다.

  // 취소·종료가 실패하면 ok:true로 돌려주지 않는다. 화면이 "정리됨"으로 그리면
  // 사용자는 거래소를 확인하지 않는다.
  // ── 무엇을 했다고 말해도 되는가 ──
  //
  // **예전 판정은 `close?.success !== false`였다.** 기본 actionMode는
  // 'BC'라 D가 없고, 그러면 `exec.close`가 `null`이다.
  // `undefined !== false` → 참. **한 적 없는 일이 성공으로 셌고**,
  // 응답은 "미체결 취소·포지션 종료 완료"라고 적었다. 급할 때 그 문구를
  // 읽은 사람은 거래소를 확인하지 않는다.
  //
  // 이제 하기로 한 것만 말하고, 그중 **거래소가 확인해 준 것만** 완료라고 적는다.
  let postLeftover: any = null;
  if (creds.ok && creds.exchange) {
    try {
      const r = await reconcile(sb, uid, connectionId, {
        key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
        exchange: creds.exchange, expectClosed: intentOf(modeForCheck).close,
      });
      postLeftover = leftoverVerdict({ leftover: r, expectedClosed: intentOf(modeForCheck).close });
    } catch { postLeftover = null; }
  }

  // **건너뛴 것과 못 한 것을 구분해서 넘긴다.** 안 그러면
  // "이미 깨끗해서 재실행 생략"이 곧바로 502가 된다.
  const done = killCompletion({
    actionMode: modeForCheck, exec, leftover: postLeftover, discovery,
    skipped: rerun.execute ? null : { reason: rerun.reason },
  });

  // **KILL은 반드시 기록에 남는다.** 급할 때 누른 버튼이라 나중에
  // "누가 언제 왜 눌렀나"를 가장 많이 묻게 된다.
  //
  // ── result는 실행 여부가 아니라 완료 여부다 ──
  //
  // 예전에는 `exec.ran === false`만 실패로 적었다. 그러면 **실행은
  // 했는데 절반만 된 경우가 success로 남는다** — 나중에 감사 기록을
  // 보고 "그때는 정리됐었다"고 읽게 된다. 화면에는 502를 주면서
  // 기록에는 성공이라고 적는 것은 그 자체로 모순이다.
  //
  // 그리고 **이번에 실제로 실행한 조합**을 남긴다. 설정값을 적으면
  // 안 한 일을 한 것처럼 읽힌다.
  {
    const { recordAudit } = await import('@/lib/safety/auditStore');
    recordAudit(sb, {
      userId: uid, action: 'KILL_SWITCH', resource: connectionId,
      result: done.complete ? 'success' : 'failed',
      connectionId,
      detail: {
        level: exec?.level ?? null,
        // 실제로 실행한 조합 · 설정값 둘 다 남긴다.
        actionMode: modeForCheck,
        configuredActionMode: s.actionMode,
        reason: s.triggerReason,
        wasActive,
        reran: rerun.execute,
        cancelled: exec?.cancel?.count ?? null,
        closeFailed: exec?.closeFailed ?? null,
        discovery: discovery?.code ?? null,
        complete: done.complete,
        missing: done.missing,
      },
    });
  }

  return NextResponse.json({
    ok: done.complete,
    active: true,
    queued: false,
    triggerReason: s.triggerReason,
    exec,
    // 줄일 대상을 실제로 확인했는가. **빈 배열과 못 찾음은 다른 사실이다.**
    discovery,
    // 다시 눌렀을 때 무엇을 했는지 숨기지 않는다.
    reran: rerun.execute, reranReason: rerun.reason,
    leftover: postLeftover,
    missing: done.missing,
    intendedClose: done.intendedClose,
    message: done.message,
  }, { status: done.complete ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
