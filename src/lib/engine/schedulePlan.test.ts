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
import { tierAllowedIn, withinTier } from './leverageLadder';
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
}
