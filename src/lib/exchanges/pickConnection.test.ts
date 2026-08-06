// src/lib/exchanges/pickConnection.test.ts
//
// 막으려는 것:
//  1. 같은 계정 같은 순간에 **두 화면이 서로 다른 계좌를 고른 채로** 열리는 것
//     — 매매 화면은 `usable[0]`, 자동매매 화면은 테스트넷 우선이었다
//  2. 새로 연 화면이 **실전 계좌에 서 있는 것.** 모르고 누른 첫 주문이
//     실제 돈이 되는 것이 이 화면의 최악이다
//  3. 목록에 없는 id가 남아, 화면은 계좌가 선택된 것처럼 그리는데
//     그 계좌는 없는 상태
//  4. 저장해 둔 계좌가 지워졌을 때 **말없이** 다른 계좌로 옮기는 것
//  5. 출금 권한 키가 자동 경로에 들어오는 것
import { test, assert, eq } from '../../test/harness';
import {
  pickConnection, connectionStillValid, usableConnections, isLiveConn, labelOf,
} from './pickConnection';

const live = (id: string, label = 'Binance') => ({ id, label, exchange_id: 'binance', is_testnet: false });
const testnet = (id: string, label = 'Gate') => ({ id, label, exchange_id: 'gate', is_testnet: true });

export function runPickConnectionTests() {
  console.log('[계좌 자동 선택 — 기본은 테스트넷]');

  test('실전이 먼저 등록돼 있어도 테스트넷을 고른다', () => {
    // 이게 두 화면이 갈리던 자리다. 매매 화면은 usable[0]이라 실전을
    // 골랐고, 자동매매 화면은 테스트넷을 골랐다.
    const r = pickConnection([live('L1'), testnet('T1')]);
    eq(r.id, 'T1');
    eq(r.source, 'PREFERRED_TESTNET');
    eq(r.isLive, false);
  });

  test('is_testnet === false 일 때만 실전이다', () => {
    eq(isLiveConn({ id: 'a', is_testnet: false }), true);
    eq(isLiveConn({ id: 'a', is_testnet: true }), false);
    eq(isLiveConn({ id: 'a' }), false, '모르면 실전이 아니다');
    eq(isLiveConn({ id: 'a', is_testnet: null }), false);
    eq(isLiveConn(null), false);
  });

  test('테스트넷이 없으면 실전을 고르되 그렇다고 말한다', () => {
    const r = pickConnection([live('L1'), live('L2')]);
    eq(r.id, 'L1');
    eq(r.source, 'FIRST');
    eq(r.isLive, true);
    assert(r.reason.includes('테스트넷 연결이 없어'), r.reason);
  });

  test('실전 하나뿐이면 그것을 고르고 진짜 돈이라고 적는다', () => {
    const r = pickConnection([live('L1')]);
    eq(r.id, 'L1');
    eq(r.source, 'ONLY_ONE');
    assert(r.reason.includes('진짜 돈'), r.reason);
  });

  test('테스트넷 하나뿐이면 조용히 고른다 — 늘 경고하면 아무도 안 읽는다', () => {
    const r = pickConnection([testnet('T1')]);
    eq(r.id, 'T1');
    eq(r.reason, '');
  });

  console.log('[계좌 자동 선택 — 저장된 계좌]');

  test('지난번에 고른 계좌가 아직 있으면 그것을 쓴다', () => {
    const r = pickConnection([testnet('T1'), live('L1')], { saved: 'L1' });
    eq(r.id, 'L1', '사용자가 고른 것을 자동 규칙이 덮으면 안 된다');
    eq(r.source, 'SAVED');
    eq(r.reason, '', '사용자가 고른 것에는 설명이 필요 없다');
    eq(r.savedGone, false);
  });

  test('저장된 계좌가 지워졌으면 옮기되 **말한다**', () => {
    // 말없이 옮기면 다음 주문이 사용자가 모르는 계좌로 나간다.
    const r = pickConnection([testnet('T1')], { saved: '없어진id' });
    eq(r.id, 'T1');
    eq(r.savedGone, true);
    assert(r.reason.includes('전에 쓰던 계좌가 목록에 없습니다'), r.reason);
    assert(r.reason.includes('바꿨습니다'), r.reason);
  });

  test('저장값이 비어 있는 것은 지워진 것과 다르다', () => {
    const r = pickConnection([testnet('T1')], { saved: '' });
    eq(r.savedGone, false);
    eq(r.reason, '', '처음 여는 사람에게 "전에 쓰던 계좌"를 말하면 안 된다');
  });

  console.log('[계좌 자동 선택 — 쓸 수 없는 연결]');

  test('출금 권한 키는 고르지 않는다', () => {
    const withdraw = { id: 'W1', label: 'Binance', is_testnet: true, has_withdrawal: true };
    const r = pickConnection([withdraw, testnet('T1')]);
    eq(r.id, 'T1');
    eq(usableConnections([withdraw]).length, 0);
  });

  test('출금 권한 키뿐이면 아무것도 못 고른다 — 이유를 적는다', () => {
    const r = pickConnection([{ id: 'W1', has_withdrawal: true }]);
    eq(r.id, null, '빈 문자열이 아니라 null이어야 한다');
    eq(r.source, 'NONE');
    assert(r.reason.includes('출금 권한'), r.reason);
  });

  test('연결이 아예 없으면 그렇게 적는다', () => {
    const r = pickConnection([]);
    eq(r.id, null);
    assert(r.reason.includes('거래소 연결이 없습니다'), r.reason);
    eq(pickConnection(null).id, null);
    eq(pickConnection(undefined).source, 'NONE');
  });

  test('id가 없는 줄은 셈에 넣지 않는다', () => {
    const r = pickConnection([{ id: '', is_testnet: true }, { id: '  ' }, testnet('T1')]);
    eq(r.id, 'T1');
  });

  console.log('[계좌 자동 선택 — 목록에 없는 id를 들고 있으면 안 된다]');

  test('들고 있던 id가 아직 유효한지 판정한다', () => {
    const conns = [testnet('T1'), live('L1')];
    eq(connectionStillValid(conns, 'T1'), true);
    eq(connectionStillValid(conns, '없어진id'), false);
    eq(connectionStillValid(conns, ''), false);
    eq(connectionStillValid(conns, null), false);
    eq(connectionStillValid([], 'T1'), false);
    eq(connectionStillValid([{ id: 'W1', has_withdrawal: true }], 'W1'), false,
      '출금 권한 키를 유효하다고 하면 안 된다');
  });

  console.log('[계좌 자동 선택 — 표시]');

  test('이름에 실전인지 테스트넷인지 적는다', () => {
    assert(labelOf(live('L1', 'Binance')).includes('실전'), labelOf(live('L1')));
    assert(labelOf(testnet('T1', 'Gate')).includes('테스트넷'), labelOf(testnet('T1')));
    assert(labelOf(null).includes('알 수 없는'), labelOf(null));
  });

  test('이름이 없으면 거래소 id를 쓴다 — 빈 칸을 만들지 않는다', () => {
    const s = labelOf({ id: 'x', exchange_id: 'gate', is_testnet: true });
    assert(s.startsWith('gate'), s);
  });

  console.log('[계좌 자동 선택 — 두 화면이 같은 답을 낸다]');

  test('같은 목록에는 언제나 같은 답이다', () => {
    // 규칙이 두 벌이던 것이 이 파일이 있는 이유다.
    const conns = [live('L1'), testnet('T1'), testnet('T2')];
    const a = pickConnection(conns);
    const b = pickConnection(conns);
    eq(a.id, b.id);
    eq(a.id, 'T1');
  });

  test('자동매매 화면의 옛 규칙과 결과가 같다', () => {
    // 옛 규칙: list.find(c => c.is_testnet !== false) || list[0]
    const cases = [
      [live('L1'), testnet('T1')],
      [testnet('T1'), live('L1')],
      [live('L1'), live('L2')],
      [testnet('T1')],
    ];
    for (const conns of cases) {
      const oldWay = conns.find((c: any) => c.is_testnet !== false) || conns[0];
      eq(pickConnection(conns).id, String(oldWay.id), JSON.stringify(conns.map((c: any) => c.id)));
    }
  });
}
