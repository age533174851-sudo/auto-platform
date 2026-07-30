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
}
