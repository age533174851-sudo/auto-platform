// src/lib/risk/killClosePlan.test.ts
//
// **이 파일이 증명하려는 것은 하나다.**
//
//     닫을 수 없으면 보호주문도 취소하지 않는다.
//
// 그 외에 범위(대상 심볼만)·식별(번호를 읽은 것만)·순서(모드가 먼저)를
// 함께 못박는다. 성능이나 수익과는 무관하다.
import { test, eq, assert } from '../../test/harness';
import {
  planKillClose, planKillCancelOnly, killProtectionVerdict, KILL_CLOSE_SEQUENCE,
  type KillClosePlanInput, type KillModeVerdictLike,
} from './killClosePlan';

const OK_MODE: KillModeVerdictLike = {
  ok: true, code: 'ONE_WAY', mode: 'ONE_WAY', message: '포지션 모드 단방향 확인',
};
const HEDGE: KillModeVerdictLike = {
  ok: false, code: 'HEDGE_UNVERIFIED', mode: 'HEDGE',
  message: '양방향(헤지) 계좌의 청산 규격을 아직 확정하지 못해 보내지 않았습니다',
};
const UNKNOWN_MODE: KillModeVerdictLike = {
  ok: false, code: 'UNKNOWN', mode: null,
  message: '계좌의 포지션 모드(단방향/양방향)를 읽지 못해 청산 주문을 보내지 않았습니다',
};
const NO_DIR: KillModeVerdictLike = {
  ok: false, code: 'NO_DIRECTION', mode: 'ONE_WAY',
  message: '닫을 포지션의 방향을 읽지 못해 청산 주문을 보내지 않았습니다',
};

const IN = (over: Partial<KillClosePlanInput> = {}): KillClosePlanInput => ({
  modeVerdict: OK_MODE,
  positions: { ok: true, rows: [
    { symbol: 'BTCUSDT', amount: 0.01 },
    { symbol: 'ETHUSDT', amount: -0.5 },
  ] },
  openOrders: { ok: true, rows: [
    { id: '111', symbol: 'BTCUSDT' },
    { id: '222', symbol: 'ETHUSDT' },
    // 다른 전략의 자리
    { id: '999', symbol: 'SOLUSDT' },
  ] },
  ...over,
});

export function runKillClosePlanTests() {
  // ══════════════════════════════════════════════════════════
  // 대조군 — 정상 경로가 실제로 통과한다
  // ══════════════════════════════════════════════════════════
  test('단방향 확인 + 포지션·주문을 읽었으면 취소 후 종료를 진행한다', () => {
    const p = planKillClose(IN());
    eq(p.code, 'PROCEED');
    eq(p.mayClose, true);
    eq(p.mayCancel, true);
    eq(p.closes.length, 2);
    eq(p.closes[0].symbol, 'BTCUSDT');
    eq(p.closes[0].side, 'LONG');
    eq(p.closes[0].qty, 0.01);
    eq(p.closes[1].side, 'SHORT', '음수 수량은 SHORT다');
    eq(p.closes[1].qty, 0.5, '부호를 벗긴 수량이다');
  });

  // ══════════════════════════════════════════════════════════
  // ★ 핵심 안전 조건 — 닫을 수 없으면 취소하지 않는다
  // ══════════════════════════════════════════════════════════
  test('★ 양방향 계좌: 종료 0건 · 취소 0건 · 보호주문 유지', () => {
    const p = planKillClose(IN({ modeVerdict: HEDGE }));
    eq(p.code, 'BLOCKED_HEDGE');
    eq(p.mayClose, false);
    eq(p.mayCancel, false, '★ 닫지도 못하면서 보호만 벗기지 않는다');
    eq(p.cancelIds.length, 0);
    eq(p.protectionRetained, true);
    eq(p.manualInterventionRequired, true);
  });

  test('★ 모드 UNKNOWN: 종료 0건 · 취소 0건 · 보호주문 유지', () => {
    const p = planKillClose(IN({ modeVerdict: UNKNOWN_MODE }));
    eq(p.code, 'BLOCKED_MODE_UNKNOWN');
    eq(p.mayCancel, false);
    eq(p.cancelIds.length, 0);
    eq(p.protectionRetained, true);
  });

  test('★ 방향 미확인: 종료 0건 · 취소 0건 · 보호주문 유지', () => {
    const p = planKillClose(IN({ modeVerdict: NO_DIR }));
    eq(p.code, 'BLOCKED_NO_DIRECTION');
    eq(p.mayCancel, false);
    eq(p.protectionRetained, true);
  });

  test('★ 관문을 아예 지나지 않으면 막는다 (modeVerdict 없음)', () => {
    for (const v of [null, undefined]) {
      const p = planKillClose(IN({ modeVerdict: v }));
      eq(p.code, 'BLOCKED_NO_GATE', `modeVerdict=${String(v)}`);
      eq(p.mayCancel, false);
      eq(p.mayClose, false);
      eq(p.protectionRetained, true);
    }
  });

  test('★ 포지션을 못 읽으면 flat이 아니다 — 취소도 종료도 하지 않는다', () => {
    const p = planKillClose(IN({ positions: { ok: false, rows: null } }));
    eq(p.code, 'BLOCKED_POSITIONS_UNREAD');
    eq(p.mayClose, false);
    eq(p.mayCancel, false);
    eq(p.protectionRetained, true);
  });

  test('★★ 어떤 입력으로도 mayCancel이 mayClose보다 넓어지지 않는다', () => {
    const cases: Array<Partial<KillClosePlanInput>> = [
      {}, { modeVerdict: HEDGE }, { modeVerdict: UNKNOWN_MODE },
      { modeVerdict: NO_DIR }, { modeVerdict: null },
      { positions: { ok: false } }, { positions: { ok: true, rows: [] } },
      { positions: { ok: true, rows: [{ symbol: 'BTCUSDT', amount: null }] } },
      { openOrders: { ok: false } }, { openOrders: { ok: true, rows: [] } },
      { targetSymbols: [] }, { targetSymbols: ['NOPEUSDT'] },
      { positions: { ok: true, rows: [{ symbol: null, amount: 1 }] } },
    ];
    for (const c of cases) {
      const p = planKillClose(IN(c));
      if (p.mayCancel) {
        assert(p.mayClose, `${JSON.stringify(c)}: 닫지 못하는데 취소가 열렸다`);
      }
      if (!p.mayClose) {
        eq(p.cancelIds.length, 0, `${JSON.stringify(c)}: 취소 목록이 비어야 한다`);
        eq(p.protectionRetained, true, `${JSON.stringify(c)}: 보호주문을 남겨야 한다`);
      }
    }
  });

  test('★ 입력이 통째로 없어도 막는다', () => {
    for (const v of [null, undefined, {} as any]) {
      const p = planKillClose(v);
      eq(p.mayClose, false);
      eq(p.mayCancel, false);
      eq(p.protectionRetained, true);
    }
  });

  // ══════════════════════════════════════════════════════════
  // ★ 취소 범위 — 다른 전략의 보호주문을 건드리지 않는다
  // ══════════════════════════════════════════════════════════
  test('★ 대상 심볼의 주문만 취소한다 (다른 심볼은 남긴다)', () => {
    const p = planKillClose(IN());
    eq(p.cancelIds.length, 2);
    assert(p.cancelIds.includes('111') && p.cancelIds.includes('222'));
    assert(!p.cancelIds.includes('999'),
      '★ SOLUSDT는 닫을 대상이 아니다 — 다른 전략의 보호주문일 수 있다');
  });

  test('★ 표적 종료: 범위를 준 심볼만 닫고 그 심볼의 주문만 취소한다', () => {
    const p = planKillClose(IN({ targetSymbols: ['BTCUSDT'] }));
    eq(p.code, 'PROCEED');
    eq(p.closes.length, 1);
    eq(p.closes[0].symbol, 'BTCUSDT');
    eq(p.cancelIds.length, 1);
    eq(p.cancelIds[0], '111');
  });

  test('★ 범위에 없는 심볼만 주면 닫을 것이 없다 — 취소도 하지 않는다', () => {
    const p = planKillClose(IN({ targetSymbols: ['SOLUSDT'] }));
    eq(p.code, 'NOTHING_TO_DO');
    eq(p.mayCancel, false, '★ 고아 주문 정리는 긴급 버튼의 일이 아니다');
    eq(p.cancelIds.length, 0);
    eq(p.manualInterventionRequired, false, '닫을 것이 없으면 사람이 할 일도 없다');
  });

  test('★ 주문 번호를 못 읽으면 지우지 않고 수를 적는다', () => {
    const p = planKillClose(IN({ openOrders: { ok: true, rows: [
      { id: '111', symbol: 'BTCUSDT' },
      { id: null, symbol: 'BTCUSDT' },
      { id: '   ', symbol: 'ETHUSDT' },
    ] } }));
    eq(p.cancelIds.length, 1);
    eq(p.unidentifiedOrders, 2, '★ 모르는 것을 "내 것"으로 치지 않는다');
  });

  test('★ 미체결 주문을 못 읽으면 전체 취소로 대신하지 않는다', () => {
    const p = planKillClose(IN({ openOrders: { ok: false, rows: null } }));
    eq(p.code, 'BLOCKED_ORDERS_UNREAD');
    eq(p.mayCancel, false, '★ 식별 못 하면 취소하지 않는다');
    eq(p.cancelIds.length, 0);
    eq(p.mayClose, true, '종료는 위험을 줄이는 방향이므로 계속한다');
    eq(p.protectionRetained, true);
    eq(p.manualInterventionRequired, true);
  });

  test('닫을 노출이 없으면 주문 0건이다', () => {
    for (const rows of [[], [{ symbol: 'BTCUSDT', amount: 0 }]]) {
      const p = planKillClose(IN({ positions: { ok: true, rows } }));
      eq(p.code, 'NOTHING_TO_DO', JSON.stringify(rows));
      eq(p.closes.length, 0);
      eq(p.mayCancel, false);
    }
    // ★ `amount: null`은 플랫이 **아니다** — 못 읽은 것이다
    const unread = planKillClose(IN({
      positions: { ok: true, rows: [{ symbol: 'BTCUSDT', amount: null }] } }));
    eq(unread.code, 'BLOCKED_TARGET_UNUSABLE');
    eq(unread.mayClose, false);
  });

  test('★ 수량을 못 읽은 줄이 섞이면 읽은 것은 닫되 "정리 완료"가 아니다', () => {
    const p = planKillClose(IN({ positions: { ok: true, rows: [
      { symbol: 'BTCUSDT', amount: 0.01 },
      { symbol: 'ETHUSDT', amount: 'x' as any },
    ] } }));
    eq(p.code, 'PROCEED_PARTIAL');
    eq(p.closes.length, 1, '읽은 것은 닫는다 — 한 줄 때문에 긴급 버튼이 멈추지 않는다');
    eq(p.unusableTargets, 1);
    eq(p.manualInterventionRequired, true, '★ 못 읽은 줄이 있으면 사람이 봐야 한다');
    eq(p.cancelIds.length, 1, '취소는 닫는 심볼의 것만');
    eq(p.cancelIds[0], '111');
  });

  test('★ 닫을 수 있는 것이 하나도 없는데 플랫도 아니면 막는다', () => {
    const p = planKillClose(IN({ positions: { ok: true, rows: [
      { symbol: 'BTCUSDT', amount: 'x' as any },
      { symbol: null, amount: 5 },
    ] } }));
    eq(p.code, 'BLOCKED_TARGET_UNUSABLE');
    eq(p.mayClose, false);
    eq(p.mayCancel, false);
    eq(p.protectionRetained, true);
    eq(p.unusableTargets, 2);
  });

  test('심볼 대소문자와 공백을 같은 것으로 본다', () => {
    const p = planKillClose(IN({
      positions: { ok: true, rows: [{ symbol: ' btcusdt ', amount: 1 }] },
      openOrders: { ok: true, rows: [{ id: '1', symbol: 'BTCUSDT' }] },
      targetSymbols: ['btcusdt'],
    }));
    eq(p.code, 'PROCEED');
    eq(p.closes[0].symbol, 'BTCUSDT');
    eq(p.cancelIds.length, 1);
  });

  // ══════════════════════════════════════════════════════════
  // 순서가 계약이다
  // ══════════════════════════════════════════════════════════
  test('★ 순서 정본: 모드 → 식별 → 취소 → 종료 → 확인', () => {
    eq(KILL_CLOSE_SEQUENCE.join('→'), 'GATE→DISCOVER→CANCEL→CLOSE→VERIFY');
    eq(KILL_CLOSE_SEQUENCE.indexOf('GATE') < KILL_CLOSE_SEQUENCE.indexOf('CANCEL'), true,
      '★ 모드 확인이 취소보다 앞이어야 한다');
    eq(KILL_CLOSE_SEQUENCE.indexOf('CANCEL') < KILL_CLOSE_SEQUENCE.indexOf('CLOSE'), true);
    eq(KILL_CLOSE_SEQUENCE.indexOf('CLOSE') < KILL_CLOSE_SEQUENCE.indexOf('VERIFY'), true);
  });

  // ══════════════════════════════════════════════════════════
  // 취소했는데 종료가 실패했다 — 별도의 위험
  // ══════════════════════════════════════════════════════════
  const PLAN_PROCEED = { mayCancel: true, mayClose: true,
    cancelIds: ['111'], protectionRetained: false };
  const PLAN_BLOCKED = { mayCancel: false, mayClose: false,
    cancelIds: [] as string[], protectionRetained: true };

  test('★ 보호주문을 취소한 뒤 포지션이 남으면 무방비 노출이다', () => {
    const v = killProtectionVerdict({
      plan: PLAN_PROCEED, cancelAttempted: true, leftoverPositions: 1 });
    eq(v.code, 'UNPROTECTED_EXPOSURE');
    eq(v.unprotected, true);
    eq(v.manualInterventionRequired, true);
    assert(v.reason.includes('무방비'), v.reason);
  });

  test('취소하지 않았고 포지션이 남았으면 보호는 그대로다', () => {
    const v = killProtectionVerdict({
      plan: PLAN_BLOCKED, cancelAttempted: false, leftoverPositions: 2 });
    eq(v.code, 'PROTECTION_INTACT');
    eq(v.unprotected, false);
    eq(v.manualInterventionRequired, true, '남은 포지션은 사람이 봐야 한다');
  });

  test('잔여 0을 확인했으면 닫힌 것이다', () => {
    const v = killProtectionVerdict({
      plan: PLAN_PROCEED, cancelAttempted: true, leftoverPositions: 0 });
    eq(v.code, 'CLOSED');
    eq(v.unprotected, false);
    eq(v.manualInterventionRequired, false);
  });

  test('★ 잔여를 못 읽으면 0으로 적지 않는다', () => {
    const v = killProtectionVerdict({
      plan: PLAN_PROCEED, cancelAttempted: true, leftoverPositions: null });
    eq(v.code, 'UNKNOWN');
    eq(v.unprotected, true, '★ 취소했는데 모르면 무방비일 수 있다');
    eq(v.manualInterventionRequired, true);
  });

  test('취소를 보내지 않았으면 잔여를 몰라도 무방비는 아니다', () => {
    const v = killProtectionVerdict({
      plan: PLAN_BLOCKED, cancelAttempted: false, leftoverPositions: null });
    eq(v.code, 'UNKNOWN');
    eq(v.unprotected, false);
  });

  test('★ 취소 목록이 비어 있으면 보호를 벗긴 것이 아니다', () => {
    const v = killProtectionVerdict({
      plan: { ...PLAN_PROCEED, cancelIds: [] },
      cancelAttempted: true, leftoverPositions: 1 });
    eq(v.code, 'PROTECTION_INTACT');
    eq(v.unprotected, false);
  });

  // ══════════════════════════════════════════════════════════
  // ★ "주문만 중지" 단계 — 보호주문을 벗기지 않는다
  // ══════════════════════════════════════════════════════════
  const CANCEL_IN = {
    positions: { ok: true, rows: [{ symbol: 'BTCUSDT', amount: 0.01 }] },
    openOrders: { ok: true, rows: [
      { id: '111', symbol: 'BTCUSDT' },     // 포지션 있음 → 보호일 수 있다
      { id: '222', symbol: 'ETHUSDT' },     // 포지션 없음 → 대기 주문
    ] },
  };

  test('★ 포지션이 있는 심볼의 주문은 취소하지 않는다 (보호일 수 있다)', () => {
    const p = planKillCancelOnly(CANCEL_IN);
    eq(p.code, 'CANCEL_PENDING_ONLY');
    eq(p.cancelIds.join(','), '222', '★ BTCUSDT 주문을 지우면 포지션이 무방비가 된다');
    eq(p.retainedProtective, 1);
  });

  test('★ 수량을 못 읽은 심볼도 점유로 본다 (비어 있다고 치지 않는다)', () => {
    const p = planKillCancelOnly({
      positions: { ok: true, rows: [{ symbol: 'ETHUSDT', amount: null }] },
      openOrders: { ok: true, rows: [{ id: '222', symbol: 'ETHUSDT' }] },
    });
    eq(p.cancelIds.length, 0);
    eq(p.retainedProtective, 1);
  });

  test('★ 포지션을 못 읽으면 아무것도 취소하지 않는다', () => {
    const p = planKillCancelOnly({
      positions: { ok: false }, openOrders: CANCEL_IN.openOrders });
    eq(p.code, 'BLOCKED_POSITIONS_UNREAD');
    eq(p.cancelIds.length, 0);
  });

  test('★ 주문을 못 읽으면 계좌 전체 취소로 대신하지 않는다', () => {
    const p = planKillCancelOnly({
      positions: CANCEL_IN.positions, openOrders: { ok: false } });
    eq(p.code, 'BLOCKED_ORDERS_UNREAD');
    eq(p.cancelIds.length, 0);
  });

  test('★ 입력이 없으면 취소하지 않는다', () => {
    for (const v of [null, undefined, {} as any]) {
      eq(planKillCancelOnly(v).cancelIds.length, 0);
    }
  });

  test('취소할 대기 주문이 없으면 그대로 적는다', () => {
    const p = planKillCancelOnly({
      positions: CANCEL_IN.positions,
      openOrders: { ok: true, rows: [{ id: '111', symbol: 'BTCUSDT' }] } });
    eq(p.code, 'NOTHING_TO_CANCEL');
    eq(p.cancelIds.length, 0);
    eq(p.retainedProtective, 1);
  });
}