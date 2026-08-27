// src/lib/engine/tradeVenue.test.ts
//
// **청산 감시가 거래를 안 보고 계좌를 골랐다.**
//
//   .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle()
//
// 바이낸스 테스트넷과 Gate 테스트넷을 둘 다 연결해 두면 Gate 포지션의
// 트레일링을 바이낸스 봉으로 계산하고 청산 주문도 바이낸스로 나간다.
//
// 여기서 지키는 것은 하나다: **틀릴 수 있으면 고르지 않는다.**
import { test, assert, eq } from '../../test/harness';
import { tradeVenueOf } from './tradeVenue';

const BN = { id: 'conn-bn', exchange: 'binance' as const, testnet: true };
const GT = { id: 'conn-gt', exchange: 'gate' as const, testnet: true };

export function runTradeVenueTests() {
  console.log('\n🏦 거래가 열린 계좌 고르기 (틀릴 수 있으면 고르지 않는다)');

  // ══ 이번 고장 그대로 ══
  test('연결이 둘인데 거래에 안 적혀 있으면 고르지 않는다 — 예전에는 첫 줄을 썼다', () => {
    const v = tradeVenueOf({ tradeConnectionId: null, connections: [BN, GT] });
    eq(v.code, 'AMBIGUOUS', '어느 계좌인지 모른다');
    eq(v.connection, null, '**아무거나 고르지 않는다**');
    assert(!v.actionable, '손대지 않는다');
    assert(v.reason.includes('2개'), '몇 개인지 적는다');
  });

  test('거래에 적혀 있으면 그 연결이다 — 첫 줄이 아니라', () => {
    const v = tradeVenueOf({ tradeConnectionId: 'conn-gt', connections: [BN, GT] });
    eq(v.code, 'OWNED', '거래가 답을 갖고 있다');
    eq(v.connection?.id, 'conn-gt', 'Gate 거래는 Gate로');
    eq(v.connection?.exchange, 'gate', '거래소도 함께');
    assert(v.actionable, '다뤄도 된다');
  });

  test('순서가 바뀌어도 같은 답이다 — 목록 순서에 기대지 않는다', () => {
    const a = tradeVenueOf({ tradeConnectionId: 'conn-bn', connections: [BN, GT] });
    const b = tradeVenueOf({ tradeConnectionId: 'conn-bn', connections: [GT, BN] });
    eq(a.connection?.id, b.connection?.id, '같은 연결');
    eq(b.connection?.id, 'conn-bn', '적힌 그것');
  });

  // ══ 옛 줄이 보호를 잃지 않게 ══
  test('연결이 하나뿐이면 안 적혀 있어도 그 하나다 — 틀릴 여지가 없다', () => {
    const v = tradeVenueOf({ tradeConnectionId: null, connections: [BN] });
    eq(v.code, 'SOLE', '후보가 하나');
    eq(v.connection?.id, 'conn-bn', '그 하나');
    assert(v.actionable, '지금 열려 있는 포지션의 보호를 끊지 않는다');
  });

  test('빈 문자열도 "안 적힘"으로 다룬다', () => {
    eq(tradeVenueOf({ tradeConnectionId: '', connections: [BN] }).code, 'SOLE', '빈 문자열');
    eq(tradeVenueOf({ tradeConnectionId: '   ', connections: [BN] }).code, 'SOLE', '공백');
  });

  // ══ 남의 계좌로 보내지 않는다 ══
  test('적힌 연결이 지금 없으면 다른 연결로 대체하지 않는다', () => {
    const v = tradeVenueOf({ tradeConnectionId: 'conn-deleted', connections: [BN, GT] });
    eq(v.code, 'GONE', '그 계좌가 목록에 없다');
    eq(v.connection, null, '대체하지 않는다');
    assert(!v.actionable, '포지션이 없는 계좌에 청산을 보내지 않는다');
  });

  test('연결이 하나뿐이어도, 적힌 것이 그게 아니면 대체하지 않는다', () => {
    const v = tradeVenueOf({ tradeConnectionId: 'conn-gt', connections: [BN] });
    eq(v.code, 'GONE', 'Gate 거래인데 남은 것은 바이낸스뿐');
    assert(!v.actionable, '**여기서 바이낸스를 고르면 남의 계좌다**');
  });

  test('연결이 아예 없으면 NONE이다', () => {
    eq(tradeVenueOf({ tradeConnectionId: null, connections: [] }).code, 'NONE', '빈 목록');
    eq(tradeVenueOf({ tradeConnectionId: 'x', connections: null }).code, 'NONE', 'null');
    assert(!tradeVenueOf({ tradeConnectionId: null, connections: [] }).actionable, '손대지 않는다');
  });

  test('id가 없는 줄은 후보로 세지 않는다 — 그것 때문에 AMBIGUOUS가 되면 안 된다', () => {
    const v = tradeVenueOf({ tradeConnectionId: null, connections: [BN, { id: '', exchange: 'gate', testnet: true }] });
    eq(v.code, 'SOLE', '쓸 수 있는 것은 하나뿐이다');
    eq(v.connection?.id, 'conn-bn', '그 하나');
  });
}
