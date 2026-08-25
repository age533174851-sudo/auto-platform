// POST /api/risk/kill-switch/reset
// { connectionId } — 스냅샷 baseline을 현재 equity로 재설정 + active 해제

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadKillSwitch, saveKillSwitch, logKillEvent, reconcile } from '@/lib/risk/killSwitch';
import { isTestnetConn, leftoverVerdict, resetVerdict, effectiveModeOf, targetedStateOf } from '@/lib/risk/killSwitchTruth';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { futuresEquityUsd } from '@/lib/exchanges/futuresAdapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  const s = await loadKillSwitch(sb, uid, connectionId);
  if (s.noTable) return NextResponse.json({ error: 'table_missing', message: 'kill_switch_state 테이블이 없습니다.' }, { status: 503 });

  // 저장소 전체 규칙: `is_testnet === false`만 실전이다.
  const testnet = isTestnetConn(conn);

  // ── 리셋은 신규 진입 잠금을 여는 동작이다 ──
  //
  // **예전에는 잔여를 확인하지 않고 `active = false`를 저장했다.**
  // 청산이 실패한 직후 사용자가 리셋을 누르면, 남은 포지션 위에서
  // 신규 진입 잠금이 풀린다.
  //
  // 그리고 기준선을 다시 잡는 동작이기도 하다. 예전에는 잔고 조회가
  // 실패하면 `equity = 0`으로 세 기준선을 전부 0으로 저장했다 —
  // 그러면 다음 평가의 낙폭이 전부 틀린다.
  //
  // **둘 다 확인된 뒤에만 연다. 못 읽은 것은 통과가 아니다.**
  const creds = await loadFuturesCreds(sb, uid, connectionId);
  const bal = creds.ok && creds.exchange
    ? await futuresEquityUsd(creds.exchange, creds.key!, creds.secret!, creds.testnet!)
    : { equity: null as number | null, error: creds.message || creds.error || '연결을 읽지 못했습니다' };

  // ── 이번 발동을 만든 조합으로 판단한다 ──
  //
  // **설정값으로 판단하면 잠금이 잘못 풀린다.**
  //
  //   설정 BC → 수동 CLOSE_ALL(ABCD) 실행 → 포지션 일부 남음 → reset
  //   → BC로 읽으면 expectedClosed = false → 잔여가 포지션을 안 셈
  //   → CLEAR → **남은 포지션 위에서 신규 진입 잠금 해제**
  //
  // 기록이 없으면(067 미적용 등) 가장 강한 쪽으로 본다 —
  // 무엇으로 켜졌는지 모르는 채 느슨하게 풀지 않는다.
  const eff = effectiveModeOf({
    effective: s.effectiveActionMode, config: s.actionMode, active: s.active,
  });
  const expectClosed = eff.expectedClosed;
  let leftover: any = null;
  if (creds.ok && creds.exchange) {
    try {
      const r = await reconcile(sb, uid, connectionId, {
        key: creds.key!, secret: creds.secret!, testnet: creds.testnet!,
        exchange: creds.exchange, expectClosed,
      });
      leftover = leftoverVerdict({ leftover: r, expectedClosed: expectClosed });
    } catch (e: any) {
      leftover = leftoverVerdict({ leftover: null, expectedClosed: expectClosed });
    }
  }

  // ── 끝나지 않은 targeted 작업 위에서 열지 않는다 ──
  //
  // REDUCE_RISK(AB)·CLOSE_AUTOMATED(ABC)는 D가 없어 잔여 판정이
  // 포지션을 세지 않는다. **절반 축소가 실패한 채로도 미체결 0이면
  // CLEAR다.** 그래서 그 단계가 끝났는지를 따로 본다.
  const targeted = targetedStateOf({
    pending: s.targetedPending, effective: s.effectiveActionMode, active: s.active,
  });
  const gate = resetVerdict({ equity: bal.equity, leftover, targeted });
  if (!gate.allowed) {
    return NextResponse.json({
      ok: false, reset: false, code: gate.code, message: gate.reason,
      equityOk: bal.equity != null, equityError: bal.error,
      leftover,
      // 무엇을 기준으로 판단했는지 숨기지 않는다.
      judgedBy: { mode: eff.mode, expectedClosed: eff.expectedClosed, source: eff.source, reason: eff.reason, targeted },
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  const equity = bal.equity!;
  const now = Date.now();
  s.active = false; s.triggeredAt = null; s.triggerReason = null;
  // 발동이 끝났으므로 이번 발동의 조합도 비운다 — 다음 판단에서
  // 지난 발동의 값을 쓰면 안 된다.
  s.effectiveActionMode = null;
  s.targetedPending = null;
  s.dailyStartEquity = equity;   s.dailyStartAt = now;
  s.weeklyStartEquity = equity;  s.weeklyStartAt = now;
  s.monthlyStartEquity = equity; s.monthlyStartAt = now;

  const ok = await saveKillSwitch(sb, uid, connectionId, s);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  await logKillEvent(sb, uid, connectionId, { reason: '사용자 리셋', equity, drawdownPct: 0, action: 'RESET', mode: testnet ? 'TESTNET' : 'LIVE' });
  return NextResponse.json({
    ok: true, reset: true, equity, resetAt: now, leftover,
    message: `기준선을 현재 총자산으로 다시 잡고 잠금을 풀었습니다 — ${gate.reason}`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
