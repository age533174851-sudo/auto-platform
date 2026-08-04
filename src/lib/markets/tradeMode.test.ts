// src/lib/markets/tradeMode.test.ts
//
// 막으려는 사고: **모의라고 믿고 실계좌에 주문이 나가는 것.**
//
// 화면에서는 둘이 똑같이 생겼다 — 같은 주문판, 같은 버튼, 같은 체결 문구.
// 그래서 판정을 눈으로 확인할 방법이 없고, 사고가 난 뒤에야 안다.

import { test, eq, assert } from '../../test/harness';
import {
  isLiveConnection, connectionsFor, resolveTradeMode, orderEndpointFor,
  switchWarning, MODE_INFO, type ConnLike,
} from './tradeMode';

const testnetConn: ConnLike = { id: 't1', is_testnet: true };
const liveConn: ConnLike = { id: 'l1', is_testnet: false };
const unknownConn: ConnLike = { id: 'u1' };                       // is_testnet 없음
const withdrawConn: ConnLike = { id: 'w1', is_testnet: false, has_withdrawal: true };

export function runTradeModeTests() {
  console.log('[매매 모드 — 실전 판정]');

  test('is_testnet이 false일 때만 실전이다', () => {
    eq(isLiveConnection(liveConn), true);
    eq(isLiveConnection(testnetConn), false);
  });

  test('모르는 값은 실전이 아니다 — 설정이 덜 된 계정이 실계좌가 되면 안 된다', () => {
    eq(isLiveConnection(unknownConn), false);
    eq(isLiveConnection({ id: 'x', is_testnet: null }), false);
    eq(isLiveConnection(null), false);
    eq(isLiveConnection(undefined), false);
  });

  console.log('[매매 모드 — 연결 분류]');

  test('실전 목록에는 실전만', () => {
    const r = connectionsFor('LIVE', [testnetConn, liveConn, unknownConn]);
    eq(r.length, 1);
    eq(r[0].id, 'l1');
  });

  test('테스트넷 목록에는 실전이 없다 — 있으면 "테스트넷이니까"라고 누른다', () => {
    const r = connectionsFor('TESTNET', [testnetConn, liveConn, unknownConn]);
    eq(r.length, 2);
    assert(!r.some(c => c.id === 'l1'), '실전 연결이 테스트넷 목록에 들어갔다');
  });

  test('출금 권한 키는 어느 모드에서도 빠진다', () => {
    eq(connectionsFor('LIVE', [withdrawConn]).length, 0);
    eq(connectionsFor('TESTNET', [withdrawConn]).length, 0);
  });

  test('이 함수들은 스네이크 케이스만 읽는다 — 카멜 케이스만 준 객체는 전부 테스트넷이 된다', () => {
    // 실제로 났던 사고를 그대로 적어 둔다.
    //
    // `/api/exchange?action=list`가 `isTestnet`·`permissions.withdrawal`만
    // 내보내고 `is_testnet`·`has_withdrawal`은 안 내보냈다. 그래서 화면에서:
    //   · 실전 연결이 **하나도** 안 잡혀 실전 탭이 언제나 "연결 없음"
    //   · 실전 키가 **테스트넷 목록에 들어가** '테스트넷 계좌'라고 적힌 채
    //     실계좌로 주문
    //   · 출금 권한 키가 안 걸러짐
    //
    // 함수는 멀쩡했고 입력이 틀렸다. 그래서 아무 테스트도 안 깨졌다.
    const camelOnly: any = { id: 'c1', isTestnet: false, permissions: { withdrawal: true } };
    eq(isLiveConnection(camelOnly), false);
    eq(connectionsFor('LIVE', [camelOnly]).length, 0);
    eq(connectionsFor('TESTNET', [camelOnly]).length, 1);
    // 서버 응답에 이 두 이름이 반드시 있어야 한다는 뜻이다 (route.ts safeConn).
  });

  test('모의는 연결을 쓰지 않는다', () => {
    eq(connectionsFor('PAPER', [testnetConn, liveConn]).length, 0);
  });

  console.log('[매매 모드 — 해결]');

  test('모의는 연결이 하나도 없어도 된다', () => {
    const r = resolveTradeMode('PAPER', []);
    eq(r.ok, true);
    eq(r.connId, null);
    eq(r.realMoney, false);
  });

  test('실전은 실제 자금 표시가 붙는다', () => {
    eq(resolveTradeMode('LIVE', [liveConn]).realMoney, true);
    eq(resolveTradeMode('TESTNET', [testnetConn]).realMoney, false);
  });

  test('고른 연결을 그대로 쓴다', () => {
    const r = resolveTradeMode('TESTNET', [testnetConn, unknownConn], 'u1');
    eq(r.connId, 'u1');
    eq(r.reason, '');
  });

  test('고른 연결이 모드에 안 맞으면 바꾸되 그 사실을 말한다', () => {
    // 실전 연결을 고른 채 테스트넷 탭을 눌렀다. 조용히 바꾸면 사용자는
    // 자기가 고른 계정으로 주문이 나간다고 믿는다.
    const r = resolveTradeMode('TESTNET', [testnetConn, liveConn], 'l1');
    eq(r.ok, true);
    eq(r.connId, 't1');
    assert(r.reason.length > 0, '바뀐 사실을 말해야 한다');
  });

  test('쓸 연결이 없으면 막고 이유를 적는다', () => {
    const r = resolveTradeMode('LIVE', [testnetConn]);
    eq(r.ok, false);
    eq(r.connId, null);
    assert(r.reason.includes('실전 연결이 없습니다'), `이유: ${r.reason}`);
  });

  test('연결이 아예 없을 때와 종류가 없을 때를 구분한다', () => {
    assert(resolveTradeMode('LIVE', []).reason.includes('거래소 연결이 없습니다'),
      '연결 자체가 없는 것과 실전이 없는 것은 다른 문제다');
    assert(resolveTradeMode('LIVE', [testnetConn]).reason.includes('전부 테스트넷'),
      '무엇을 고쳐야 하는지 말해야 한다');
  });

  console.log('[매매 모드 — 주문 경로]');

  test('모의는 어느 시장이든 가상 라우트로 간다', () => {
    for (const m of ['SPOT', 'USDM', 'COINM'] as const) {
      eq(orderEndpointFor('PAPER', m), '/api/paper/order', `${m}이 실계좌로 갔다`);
    }
  });

  test('테스트넷과 실전은 같은 라우트를 쓴다 — 구분은 연결이 한다', () => {
    eq(orderEndpointFor('TESTNET', 'USDM'), '/api/binance/futures/order');
    eq(orderEndpointFor('LIVE', 'USDM'), '/api/binance/futures/order');
  });

  test('시장마다 라우트가 다르다', () => {
    eq(orderEndpointFor('LIVE', 'SPOT'), '/api/binance/spot/order');
    eq(orderEndpointFor('LIVE', 'COINM'), '/api/binance/coinm/order');
  });

  console.log('[매매 모드 — 전환 경고]');

  test('실전으로 갈 때만 확인을 받는다', () => {
    assert(switchWarning('PAPER', 'LIVE')!.includes('실제 자금'), '경고가 없다');
    eq(switchWarning('LIVE', 'PAPER'), null);
    eq(switchWarning('PAPER', 'TESTNET'), null);
  });

  test('모의만 실제 자금이 아니라고 적혀 있다', () => {
    eq(MODE_INFO.PAPER.realMoney, false);
    eq(MODE_INFO.TESTNET.realMoney, false);
    eq(MODE_INFO.LIVE.realMoney, true);
    assert(MODE_INFO.PAPER.desc.includes('나가지 않습니다'), '모의 설명이 약하다');
  });

  // ── **연결이 둘 이상일 때 조용히 고르지 않는다** ──
  //
  // 실제로 있었던 일: 바이낸스 연결이 둘(실전·데모)인데 하나가
  // is_testnet=true로 잘못 저장돼 있었다. 테스트넷 탭에서는 둘 다
  // '쓸 수 있는 연결'이라 첫 번째가 뽑혔고, 그게 데모 서버가 모르는
  // 키였다. 화면에는 다른 연결의 잔고가 떠 있었고 주문만 -2015로 막혔다.
  //
  // is_testnet은 사용자가 적은 값이지 거래소가 확인해 준 값이 아니다.
  console.log('[매매 모드 — 어느 연결로 나가는지 말한다]');

  const C = (id: string, label: string, testnet: boolean | null) =>
    ({ id, label, exchange_id: 'binance', is_testnet: testnet } as any);

  test('쓸 수 있는 연결이 하나면 조용히 쓴다', () => {
    const r = resolveTradeMode('TESTNET', [C('a', '데모', true)], null);
    eq(r.connId, 'a');
    eq(r.reason, '', '하나뿐인데 설명을 붙였다');
    eq(r.choices, 1);
  });

  test('둘 이상이면 어느 것을 골랐는지 말한다', () => {
    const r = resolveTradeMode('TESTNET', [C('a', '데모', true), C('b', '실전키오등록', true)], null);
    eq(r.connId, 'a');
    eq(r.choices, 2);
    assert(r.reason.includes('2개'), '몇 개인지 안 적었다: ' + r.reason);
    assert(r.reason.includes('데모'), '고른 연결 이름이 없다: ' + r.reason);
  });

  test('사용자가 고른 연결이 있으면 그것을 쓰고 조용하다', () => {
    const r = resolveTradeMode('TESTNET', [C('a', '데모', true), C('b', '둘째', true)], 'b');
    eq(r.connId, 'b');
    eq(r.reason, '');
    eq(r.chosenLabel, '둘째');
  });

  test('고른 연결이 이 모드에 안 맞으면 바꾼 사실과 대상 이름을 적는다', () => {
    const r = resolveTradeMode('TESTNET', [C('a', '데모', true)], 'live-1');
    eq(r.connId, 'a');
    assert(r.reason.includes('데모'), '어디로 나가는지 안 적었다: ' + r.reason);
  });

  // 이름이 없어도 문장이 깨지면 안 된다 — "(으)로 주문합니다"만 남으면
  // 사용자는 무엇으로 나가는지 알 수 없다.
  // 이름이 없어도 **사람이 읽을 수 있어야** 하고, 동시에 **어느 것인지
  // 구분되어야** 한다. 둘 중 하나만 만족하면 안 된다:
  //  · id만 쓰면 "cd7fd4be(으)로 주문합니다" — 무슨 계좌인지 모른다
  //  · 거래소 이름만 쓰면 같은 거래소 둘일 때 구분이 안 된다
  test('이름이 없으면 거래소·망과 id 앞자리를 함께 적는다', () => {
    const r = resolveTradeMode('TESTNET', [
      { id: 'abcdef1234', exchange_id: 'binance', is_testnet: true } as any,
      { id: 'zzz', exchange_id: 'binance', is_testnet: true } as any,
    ], null);
    assert((r.chosenLabel || '').length > 0, '이름이 비었다');
    assert(r.reason.includes('바이낸스'), '거래소 이름이 없다: ' + r.reason);
    assert(r.reason.includes('테스트넷'), '실전/테스트넷 구분이 없다: ' + r.reason);
    assert(r.reason.includes('abcdef12'), '어느 연결인지 구분할 수 없다: ' + r.reason);
  });

  // **원시 UUID가 통째로 이름이 되면 안 된다.**
  // 매매 화면에 "cd7fd4be(으)로 주문합니다"가 실제로 떴다.
  test('벌거벗은 UUID를 이름으로 쓰지 않는다', () => {
    const r = resolveTradeMode('TESTNET', [
      { id: 'cd7fd4be-1111-2222-3333-444444444444', is_testnet: true } as any,
    ], 'other-id');
    const label = r.chosenLabel || '';
    assert(label !== 'cd7fd4be', 'UUID 앞자리만 이름으로 썼다: ' + label);
    assert(/연결|테스트넷/.test(label), '무엇인지 알 수 없는 이름이다: ' + label);
  });

  test('거래소를 알면 한글 이름으로 부른다', () => {
    const r = resolveTradeMode('LIVE', [
      { id: 'aaaaaaaa11', exchange_id: 'gate', is_testnet: false } as any,
    ], null);
    assert((r.chosenLabel || '').includes('게이트아이오'), r.chosenLabel);
    assert((r.chosenLabel || '').includes('실전'), r.chosenLabel);
  });

  // ── 응답의 이름이 바뀌어도 버틴다 ──
  //
  // **이게 실제로 화면을 망가뜨렸다.** `/api/exchange?action=list`가
  // exchange_id를 `exchange`로, label을 `nickname`으로 바꿔 내보내고 있었다.
  // 그래서 여기 있는 위 테스트들은 전부 통과하는데 화면에는
  //   "테스트넷 연결 cd7fd4be(으)로 주문합니다"
  // 가 떴다. 응답 쪽을 고쳤지만, 이름이 어긋나면 **조용히** 틀리는 종류라
  // 여기서도 받아 준다.
  test('exchange·nickname으로 와도 알아본다 — 응답 필드 이름이 갈린 적이 있다', () => {
    const r = resolveTradeMode('LIVE', [
      { id: 'cd7fd4be-1111', exchange: 'gate', is_testnet: false } as any,
    ], null);
    assert((r.chosenLabel || '').includes('게이트아이오'),
      '거래소를 못 알아봤다: ' + r.chosenLabel);

    const r2 = resolveTradeMode('LIVE', [
      { id: 'cd7fd4be-1111', nickname: '내 게이트', is_testnet: false } as any,
    ], null);
    eq(r2.chosenLabel, '내 게이트');
  });

  // 사용자가 붙인 이름이 있으면 그게 최우선이다.
  test('사용자 이름이 있으면 그대로 쓴다', () => {
    const r = resolveTradeMode('LIVE', [
      { id: 'x1', label: '내 실계좌', exchange_id: 'binance', is_testnet: false } as any,
    ], null);
    eq(r.chosenLabel, '내 실계좌');
  });

  test('실전 모드에서도 여러 개면 말한다', () => {
    const r = resolveTradeMode('LIVE', [C('a', '실전1', false), C('b', '실전2', false)], null);
    eq(r.choices, 2);
    assert(r.reason.includes('2개'), r.reason);
  });
}
