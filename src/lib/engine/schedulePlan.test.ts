// src/lib/engine/schedulePlan.test.ts
//
// **켤 수도 끌 수도 없는 예약이 화면에 남았다.**
//
// Gate 테스트넷 연결을 다시 등록하면서 id가 새로 생겼는데, BTCUSDT 예약은
// 옛 id를 그대로 들고 있었다. 화면의 스위치는 **예약에 적힌 id**를 보내고,
// 서버는 그 id가 내 목록에 없으니 404로 거절한다. 화면에는 '연결 있음'이
// 적혀 있어서 무엇이 잘못됐는지 알 방법이 없었다.
//
// 이 파일이 못 박는 것은 둘이다:
//   · 낡은 연결을 낡았다고 말하는가 (그리고 '못 읽음'과 섞지 않는가)
//   · 바꿀 때 **사용자가 고른 것만** 쓰는가

import { test, eq, assert } from '../../test/harness';
import { scheduleConnState, rebindVerdict, type ConnRow } from './schedulePlan';
import { tierAllowedIn, withinTier, leverageLadder } from './leverageLadder';
import { runChecklist } from './preTradeChecklist';
import { leverageVerdict } from '../exchanges/futuresExec';

const gateTestnet: ConnRow = { id: 'conn-new', exchange_id: 'gate', label: 'Gate 테스트넷', is_testnet: true };
const gateLive: ConnRow = { id: 'conn-live', exchange_id: 'gate', label: 'Gate 실전', is_testnet: false };
const mine = [gateTestnet, gateLive];

export function runSchedulePlanTests() {
  console.log('[예약 — 연결이 아직 있는가]');

  test('목록에 있으면 OK', () => {
    const v = scheduleConnState('conn-new', mine);
    eq(v.state, 'OK'); eq(v.needsRebind, false);
  });

  test('목록에 없으면 STALE — 다시 고르라고 말한다', () => {
    const v = scheduleConnState('conn-old', mine);
    eq(v.state, 'STALE'); eq(v.needsRebind, true);
    assert(v.message.includes('연결 다시 선택 필요'), v.message);
  });

  test('연결 id 자체가 없으면 MISSING', () => {
    eq(scheduleConnState('', mine).state, 'MISSING');
    eq(scheduleConnState(null, mine).state, 'MISSING');
  });

  test('목록을 못 읽었으면 UNKNOWN — 멀쩡한 예약을 낡았다고 하지 않는다', () => {
    // 빈 배열로 치면 모든 예약이 한꺼번에 '낡음'이 되고, 사용자는
    // 멀쩡한 예약을 전부 다시 연결한다. 0과 모름은 다른 값이다.
    const v = scheduleConnState('conn-new', null);
    eq(v.state, 'UNKNOWN');
    eq(v.needsRebind, false, '못 읽었는데 다시 고르라고 시켰다');
  });

  console.log('[예약 — 재연결은 사용자가 고른 것만]');

  test('낡은 예약을 지금 고른 연결로 바꾼다', () => {
    const v = rebindVerdict({ currentConnectionId: 'conn-new', connections: mine, mode: 'TESTNET' });
    eq(v.ok, true); eq(v.code, 'OK'); eq(v.connectionId, 'conn-new');
  });

  test('고르지 않았으면 대신 골라 주지 않는다', () => {
    // 계좌가 둘 이상이면 어느 쪽으로 주문이 나가는지 모르는 채 바뀐다.
    for (const raw of ['', null, undefined, '   ']) {
      const v = rebindVerdict({ currentConnectionId: raw, connections: mine, mode: 'TESTNET' });
      eq(v.ok, false, `${JSON.stringify(raw)}가 통과했다`);
      eq(v.code, 'NO_CHOICE');
      eq(v.connectionId, null);
    }
  });

  test('다른 사용자의 연결로는 못 바꾼다', () => {
    // 목록은 호출자가 user_id로 걸러 넘긴다. 거기 없으면 내 것이 아니다.
    const v = rebindVerdict({ currentConnectionId: 'someone-elses', connections: mine, mode: 'TESTNET' });
    eq(v.ok, false); eq(v.code, 'NOT_YOURS'); eq(v.connectionId, null);
  });

  test('목록을 못 읽었으면 바꾸지 않는다 — 내 것인지 확인하지 못했다', () => {
    const v = rebindVerdict({ currentConnectionId: 'conn-new', connections: null, mode: 'TESTNET' });
    eq(v.ok, false); eq(v.code, 'CONNECTIONS_UNKNOWN');
  });

  test('테스트넷 예약을 실전 연결로 바꾸지 못한다 — 진짜 돈이 나간다', () => {
    const v = rebindVerdict({ currentConnectionId: 'conn-live', connections: mine, mode: 'TESTNET' });
    eq(v.ok, false); eq(v.code, 'ENV_MISMATCH');
    assert(v.message.includes('실전 연결'), v.message);
  });

  test('실전 예약을 테스트넷 연결로도 바꾸지 못한다', () => {
    for (const mode of ['LIVE_SMALL', 'LIVE_LIMITED', 'SHADOW_LIVE']) {
      const v = rebindVerdict({ currentConnectionId: 'conn-new', connections: mine, mode });
      eq(v.ok, false, `${mode}가 통과했다`);
      eq(v.code, 'ENV_MISMATCH');
    }
  });

  test('실전 예약은 실전 연결로 바꾼다', () => {
    const v = rebindVerdict({ currentConnectionId: 'conn-live', connections: mine, mode: 'LIVE_SMALL' });
    eq(v.ok, true); eq(v.connectionId, 'conn-live');
  });

  test('is_testnet이 false일 때만 실전이다 — 저장소 전체 규칙', () => {
    // undefined·null·true는 전부 테스트넷이다. 여기서 갈리면 모드 대조가
    // 통째로 뒤집힌다.
    const odd: ConnRow[] = [
      { id: 'a', is_testnet: undefined as any },
      { id: 'b', is_testnet: null as any },
      { id: 'c', is_testnet: true },
    ];
    for (const c of odd) {
      eq(rebindVerdict({ currentConnectionId: c.id, connections: odd, mode: 'TESTNET' }).ok, true,
        `${c.id}가 테스트넷으로 안 읽혔다`);
      eq(rebindVerdict({ currentConnectionId: c.id, connections: odd, mode: 'LIVE_SMALL' }).ok, false,
        `${c.id}가 실전으로 읽혔다`);
    }
  });

  console.log('[스트레스 등급 — 테스트넷은 열고 실전은 막는다]');

  test('TESTNET + STRESS(10% · 100배)는 허용한다', () => {
    eq(tierAllowedIn('STRESS', 'TESTNET').ok, true);
    eq(withinTier('STRESS', 10, 100).ok, true, '등급 안인데 막혔다');
  });

  test('LIVE + STRESS는 계속 막는다', () => {
    const v = tierAllowedIn('STRESS', 'LIVE');
    eq(v.ok, false, '실전에서 10% · 100배가 통과했다');
    // 실전에서 쓸 수 있는 것 중 가장 가까운 등급을 권한다.
    eq(v.suggested, 'AGGRESSIVE');
  });

  test('MOCK도 그대로 허용한다 — 열기만 하고 닫지 않았다', () => {
    eq(tierAllowedIn('STRESS', 'MOCK').ok, true);
  });

  console.log('[스트레스 등급 — 무결성 차단은 그대로다]');

  test('TESTNET이어도 거래소 실제 배율이 다르면 주문하지 않는다', () => {
    // 등급 관문은 열렸다. 그런데 100배를 요청했는데 거래소가 75배면
    // 계산한 청산가·증거금·기대값이 전부 달라진다 — 여기는 그대로 막힌다.
    const v = leverageVerdict(100, 100, 75);
    eq(v.ok, false, '등급을 열었더니 배율 대조까지 열렸다');
    eq(v.code, 'VENUE_CAPPED');
  });

  test('TESTNET이어도 배율을 되읽지 못하면 주문하지 않는다', () => {
    eq(leverageVerdict(100, 100, null).ok, false);
    eq(leverageVerdict(100, 100, null).code, 'UNVERIFIED');
  });

  test('TESTNET이어도 점검 목록의 UNKNOWN은 그대로 막는다', () => {
    // 아무것도 확인하지 않은 상태. 등급과 무관하게 막혀야 한다.
    const v = runChecklist({}, { market: 'USDM', intent: 'ENTRY' });
    eq(v.allowed, false, '빈 입력이 통과했다');
    assert(v.unknownCount > 0);
  });

  test('TESTNET이어도 배율이 의도와 다르면 점검 목록이 그 사실을 적는다', () => {
    // **차단은 점검 목록이 아니라 주문 실행기가 한다.**
    // 점검 목록의 LEVERAGE는 blocking:false — 사실 전달 항목이다. 실제로
    // 주문을 막는 것은 위 테스트의 futuresExec.leverageVerdict다.
    // 여기서 확인하는 것은 "등급을 열었다고 이 대조가 조용해지지 않는가"다.
    const base: any = {
      mode: { disposition: 'SEND', reason: '' },
      clock: { localMs: 1_700_000_000_000, serverMs: 1_700_000_000_100 },
      reconcile: { reachable: true, blockNewOrders: false, summary: '일치' },
      unresolvedOrderCount: 0,
      marginType: 'isolated',
      existingPositionQty: 0,
      stopPrice: 60000, liquidationPrice: 55000, side: 'LONG',
      margin: { required: 100, available: 1000 },
      todayEntry: { alreadyTraded: false },
      subAccount: { status: 'ok', reason: '' },
      dailyLoss: { status: 'ok', reason: '' },
      weeklyLoss: { status: 'ok', reason: '' },
      lossStreak: { status: 'ok', reason: '' },
    };
    const matched = runChecklist({ ...base, leverage: { actual: 100, intended: 100 } },
      { market: 'USDM', intent: 'ENTRY' });
    const mismatched = runChecklist({ ...base, leverage: { actual: 75, intended: 100 } },
      { market: 'USDM', intent: 'ENTRY' });

    const lev = (v: any) => v.results.find((r: any) => r.id === 'LEVERAGE');
    eq(lev(matched).status, 'pass', '같은 배율인데 문제로 적혔다');
    assert(lev(mismatched).status !== 'pass',
      `배율이 다른데 통과로 적혔다: ${JSON.stringify(lev(mismatched))}`);
    assert(String(lev(mismatched).detail).includes('75'),
      `실제 배율이 근거에 남아야 한다: ${lev(mismatched).detail}`);
  });

  console.log('[스트레스 배율 — 100배를 57배로 몰래 낮추지 않는다]');

  // 손절 0.5% · 유지증거금 0.4%면 청산안전 상한이 100배보다 한참 낮게 나온다.
  // 그게 지금 화면에 뜨던 '이번 주문 57배'의 정체다.
  const stressSrc = (over: any = {}) => ({
    userCap: 100, stopPct: 1.5, venueCap: 125, stressTestnet: true, ...over,
  });

  test('요청 100배 · 거래소 125배 · 청산안전이 더 낮아도 100배 그대로 간다', () => {
    const l = leverageLadder(stressSrc());
    eq(l.blocked, false, `막혔다: ${l.blockReason}`);
    eq(l.allowed, 100, '요청 배율이 깎였다');
    eq(l.requested, 100);
    // 청산안전 상한은 여전히 계산하고 여전히 보여 준다 — 깎지만 않는다.
    assert(l.liquidationSafeCap != null, '청산안전 상한을 계산하지 않았다');
    assert(l.liquidationSafeCap! < 100, '이 손절이면 청산안전이 100배보다 낮아야 한다');
    assert(l.warnings.some(w => w.includes('청산안전 권고')),
      `경고가 남아야 한다: ${l.warnings.join(' / ')}`);
  });

  test('요청 100배 · 거래소 75배 → 75배로 낮추지 않고 막는다', () => {
    const l = leverageLadder(stressSrc({ venueCap: 75 }));
    eq(l.blocked, true, '75배로 낮춰 통과시켰다');
    eq(l.blockCode, 'VENUE_CAPPED');
    eq(l.allowed, null, '막았는데 배율이 정해졌다');
    assert(l.blockReason.includes('75'), l.blockReason);
    assert(l.blockReason.includes('낮춰 보내지 않습니다'), l.blockReason);
  });

  test('요청 100배 · 거래소 상한 UNKNOWN → 막는다', () => {
    for (const v of [null, undefined, '', 0]) {
      const l = leverageLadder(stressSrc({ venueCap: v }));
      eq(l.blocked, true, `venueCap=${JSON.stringify(v)}가 통과했다`);
      eq(l.blockCode, 'VENUE_UNKNOWN');
    }
  });

  test('전략 상한이 요청보다 낮아도 낮추지 않고 막는다', () => {
    const l = leverageLadder(stressSrc({ strategyCap: 50 }));
    eq(l.blocked, true);
    eq(l.blockCode, 'CAP_BELOW_REQUEST');
  });

  test('청산안전 상한을 못 구하면 스트레스여도 막는다 — 실험에서도 알아야 하는 값이다', () => {
    const l = leverageLadder(stressSrc({ stopPct: null }));
    eq(l.blocked, true, '청산까지의 거리를 모르는데 통과했다');
    eq(l.blockCode, 'MISSING_REQUIRED');
  });

  test('LIVE(스트레스 아님)는 기존 정책 그대로 — 가장 낮은 상한이 이긴다', () => {
    const l = leverageLadder({ userCap: 100, stopPct: 1.5, venueCap: 125 });
    eq(l.blocked, false);
    assert(l.allowed! < 100, `실전에서 청산안전 상한이 안 걸렸다: ${l.allowed}`);
    eq(l.allowed, l.liquidationSafeCap, '청산안전 상한이 이겨야 한다');
    eq(l.boundBy, '청산안전 최대');
    // 요청은 그대로 남는다 — 화면이 요청과 실제를 구분해 보여줘야 한다.
    eq(l.requested, 100);
  });

  test('요청·권고·실제가 서로 다른 값으로 남는다', () => {
    const stress = leverageLadder(stressSrc());
    // 스트레스: 요청 100 · 권고 <100 · 실제 100
    eq(stress.requested, 100);
    eq(stress.allowed, 100);
    assert(stress.liquidationSafeCap! < 100);

    const live = leverageLadder({ userCap: 100, stopPct: 1.5, venueCap: 125 });
    // 실전: 요청 100 · 권고 <100 · 실제 = 권고
    eq(live.requested, 100);
    eq(live.allowed, live.liquidationSafeCap);
  });

  test('스트레스여도 배율 되읽기 불일치는 그대로 막는다', () => {
    // 사다리가 100배를 내줘도, 거래소에 실제로 걸린 값이 다르면 주문은 안 나간다.
    eq(leverageVerdict(100, 100, 57).ok, false, '되읽은 57배로 주문이 나갔다');
    eq(leverageVerdict(100, 100, 100).ok, true);
  });
}
