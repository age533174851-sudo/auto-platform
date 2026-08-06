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
        // ── 단계를 받는다 ──
        //
        // 예전에는 저장된 actionMode 하나뿐이라, 버튼이 실질적으로
        // 하나였다. 그리고 그 하나가 **손매매 포지션까지** 닫았다 —
        // 봇이 이상해서 눌렀는데 어제부터 들고 있던 것도 같이 나간다.
        // 한 번 겪으면 다음부터 그 버튼을 못 누른다.
        //
        // 단계를 안 주면 예전 동작 그대로다(저장된 actionMode).
        const { levelOf, actionModeOf, automatedSymbols, closeTargets } =
          await import('@/lib/risk/emergencyLevel');
        const spec = levelOf(body?.level);

        // ── 심볼별로 닫는 단계 ──
        //
        // executeKillActions의 'D'는 **계좌의 모든 포지션**을 닫는다.
        // "자동매매가 연 것만" 또는 "절반만"은 그걸로 못 한다 —
        // 손매매까지 나가면 이 단계를 만든 이유의 정반대다.
        let autoNote = '';
        let closed: Array<{ symbol: string; ok: boolean; message: string }> = [];
        if (spec && spec.closePct > 0 && (spec.automatedOnly || spec.closePct < 100)) {
          const { futuresPositionRisk, futuresClosePosition } =
            await import('@/lib/exchanges/futuresAdapter');
          const { strategyOf } = await import('@/lib/strategies/ledger');

          // 어느 심볼이 봇이 연 것인가. **못 가리면 빈 집합이고,
          // 그러면 CLOSE_AUTOMATED는 아무것도 안 닫는다.**
          const { data: rows } = await (sb as any).from('live_orders')
            .select('symbol, signal_id, status')
            .eq('connection_id', connectionId).eq('status', 'FILLED')
            .order('created_at', { ascending: false }).limit(200);
          const auto = automatedSymbols(rows || [], strategyOf);

          // 지금 들고 있는 포지션. 후보는 봇이 손댄 심볼과 지금 열려
          // 있는 것의 교집합이다.
          const candidates: string[] = spec.automatedOnly
            ? Array.from(auto)
            : Array.from(new Set<string>(
                (rows || []).map((r: any) => String(r.symbol || '').toUpperCase()).filter(Boolean)));

          const live: Array<{ symbol: string; qty: number }> = [];
          for (const sym of candidates) {
            const rr = await futuresPositionRisk(
              creds.exchange!, creds.key!, creds.secret!, sym, creds.testnet!);
            const amt = rr.risk?.positionAmt;
            if (amt != null && Math.abs(Number(amt)) > 0) live.push({ symbol: sym, qty: Math.abs(Number(amt)) });
          }

          const plan = closeTargets(spec, live, auto);
          autoNote = plan.note;
          for (const t of plan.targets) {
            const r = await futuresClosePosition(
              creds.exchange!, creds.key!, creds.secret!, creds.testnet!,
              t.symbol, spec.closePct);
            closed.push({ symbol: t.symbol, ok: !!r.success, message: r.message });
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
        };
      }
    } catch (e: any) {
      exec = { ran: false, error: 'execute_failed', message: e?.message || '취소·종료 실행 실패' };
    }
  }

  // **KILL은 반드시 기록에 남는다.** 급할 때 누른 버튼이라 나중에
  // "누가 언제 왜 눌렀나"를 가장 많이 묻게 된다. 그리고 실행이 절반만
  // 됐을 때 그 사실도 같이 남아야 한다.
  {
    const { recordAudit } = await import('@/lib/safety/auditStore');
    recordAudit(sb, {
      userId: uid, action: 'KILL_SWITCH', resource: connectionId,
      result: exec?.ran === false ? 'failed' : 'success',
      connectionId,
      detail: {
        level: exec?.level ?? null,
        actionMode: s.actionMode,
        reason: s.triggerReason,
        wasActive,
        cancelled: exec?.cancel?.count ?? null,
        closeFailed: exec?.closeFailed ?? null,
      },
    });
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
