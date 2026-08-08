// src/lib/portfolio/walletAccounts.test.ts
//
// 실제로 난 일:
//
//   지갑 > 테스트넷   "이 환경에 연결된 계좌가 없습니다"
//   매매 화면          같은 순간 Gate 테스트넷으로 주문이 나감
//
// 계좌가 없는 게 아니라 **지갑이 안 물어본 것**이었다. 이 저장소에서
// 반복되는 고장 그대로다 — 기능은 있는데 서로 배선이 안 됨.
//
// 막으려는 것:
//  1. 지갑이 주문과 **다른 판정**으로 환경을 가르는 것. 여기서만
//     `is_testnet === true`로 읽으면, 값이 빈 연결이 지갑에서는 실전으로
//     보이고 주문은 테스트넷으로 나간다
//  2. 조회 실패를 "계좌 없음"으로 그리는 것 — 사용자는 연결이 풀린 줄
//     알고 키를 다시 등록한다
//  3. 아직 안 물어봤는데 "계좌 없음"을 먼저 띄우는 것
//  4. 두 계좌 중 하나만 더해 '총 평가자산'이라고 적는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  envOfConnection, accountsFromConnections, accountsInEnv, accountsVerdict,
  futuresStateOf, spotStateOf, equitySumOf, totalEquityFromTree,
  type WalletAccount, type WalletFetchResult,
} from './walletAccounts';
import { isLiveConnection } from '../markets/tradeMode';

const C = (id: string, over: any = {}) =>
  ({ id, exchange_id: 'gate', is_testnet: true, ...over });

export function runWalletAccountsTests() {
  console.log('[지갑 계좌 — 주문과 같은 판정을 쓴다]');

  test('환경 판정이 주문 경로와 글자 그대로 같다', () => {
    // 여기서만 다르게 읽으면 화면이 말하는 계좌와 주문이 깎는 계좌가 갈린다.
    for (const v of [true, false, null, undefined, 'true' as any, 0 as any]) {
      const c = C('x', { is_testnet: v });
      const expected = isLiveConnection(c) ? 'LIVE' : 'TESTNET';
      eq(envOfConnection(c), expected, String(v));
    }
  });

  test('is_testnet이 비어 있으면 테스트넷이다 — 실전으로 올리지 않는다', () => {
    eq(envOfConnection(C('a', { is_testnet: null })), 'TESTNET');
    eq(envOfConnection(C('a', { is_testnet: undefined })), 'TESTNET');
    eq(envOfConnection(C('a', { is_testnet: false })), 'LIVE');
  });

  test('테스트넷 연결을 목록에서 빠뜨리지 않는다', () => {
    // 이게 지금 화면에 뜬 그 문구의 원인이다.
    const accts = accountsFromConnections([C('gate-test', { is_testnet: true })]);
    eq(accountsInEnv('TESTNET', accts).length, 1);
    eq(accountsInEnv('LIVE', accts).length, 0);
  });

  test('실전 연결은 테스트넷 탭에 안 나온다', () => {
    const accts = accountsFromConnections([C('gate-live', { is_testnet: false })]);
    eq(accountsInEnv('LIVE', accts).length, 1);
    eq(accountsInEnv('TESTNET', accts).length, 0);
  });

  test('connectionId를 그대로 들고 다닌다', () => {
    // 주문이 쓰는 id와 지갑이 보여 주는 id가 다르면 배선 실패다.
    const a = accountsFromConnections([C('conn-abc')])[0];
    eq(a.connectionId, 'conn-abc');
  });

  console.log('[지갑 계좌 — 못 읽는 계좌도 숨기지 않는다]');

  test('출금 권한 키는 목록에 남기고 이유를 적는다', () => {
    // 빼 버리면 계좌가 있는데 "계좌 없음"이 뜨고, 사용자는 연결이
    // 풀렸다고 믿고 키를 다시 등록한다.
    const a = accountsFromConnections([C('w', { has_withdrawal: true })])[0];
    eq(a.queryable, false);
    assert(a.blockedReason.includes('거래 전용 키'), a.blockedReason);
  });

  test('미지원 거래소도 남기고 이유를 적는다', () => {
    const a = accountsFromConnections([C('u', { exchange_id: 'upbit' })])[0];
    eq(a.queryable, false);
    assert(a.blockedReason.includes('지원하지 않습니다'), a.blockedReason);
  });

  test('id가 없는 줄은 계좌가 아니다', () => {
    eq(accountsFromConnections([{ exchange_id: 'gate' }]).length, 0);
    eq(accountsFromConnections(null).length, 0);
  });

  console.log('[지갑 계좌 — 읽는 중 · 없음 · 못 읽음을 섞지 않는다]');

  test('아직 안 물어봤으면 계좌 없음이라고 하지 않는다', () => {
    const v = accountsVerdict('TESTNET', 'LOADING', []);
    eq(v.trulyEmpty, false);
    assert(v.message.includes('불러오는 중'), v.message);
  });

  test('못 읽었으면 연결이 없다는 뜻이 아니라고 적는다', () => {
    const v = accountsVerdict('TESTNET', 'FAILED', [], 'HTTP 500');
    eq(v.trulyEmpty, false);
    assert(v.message.includes('연결이 없다는 뜻이 아닙니다'), v.message);
  });

  test('읽었는데 없으면 다른 환경에 있는지까지 말한다', () => {
    // "테스트넷엔 없지만 실전엔 2개 있다"를 알면 탭을 잘못 봤다는 걸 안다.
    const accts = accountsFromConnections([
      C('a', { is_testnet: false }), C('b', { is_testnet: false }),
    ]);
    const v = accountsVerdict('TESTNET', 'READY', accts);
    eq(v.trulyEmpty, true);
    assert(v.message.includes('다른 환경에 2개'), v.message);
  });

  test('모의는 연결이 없는 것이 정상이라고 적는다', () => {
    const v = accountsVerdict('MOCK', 'READY', []);
    assert(v.message.includes('정상입니다'), v.message);
  });

  test('계좌가 있으면 군말이 없다', () => {
    const v = accountsVerdict('TESTNET', 'READY', accountsFromConnections([C('a')]));
    eq(v.accounts.length, 1);
    eq(v.message, '');
  });

  console.log('[지갑 계좌 — 한쪽이 실패해도 0으로 안 그린다]');

  const R = (over: any = {}): WalletFetchResult =>
    ({ connectionId: 'a', ok: true, tree: { spot: { ok: true }, futures: { ok: true }, totalUsdt: 569.09 }, error: '', ...over });

  test('라우트가 ok여도 선물이 실패했을 수 있다', () => {
    // /api/wallets는 현물·선물을 따로 부르고 하나가 죽어도 나머지를
    // 돌려준다. tree.futures.ok를 안 읽으면 실패를 잔고 0으로 그린다.
    eq(futuresStateOf(R({ tree: { futures: { ok: false } } })), 'FAILED');
    eq(futuresStateOf(R()), 'OK');
    eq(spotStateOf(R({ tree: { spot: { ok: false } } })), 'FAILED');
  });

  test('아직 안 받았으면 동기화 중이다', () => {
    eq(futuresStateOf(null), 'SYNCING');
    eq(spotStateOf(undefined), 'SYNCING');
  });

  test('총자산을 못 읽으면 null이다', () => {
    eq(totalEquityFromTree(R({ ok: false })), null);
    eq(totalEquityFromTree(R({ tree: { totalUsdt: null } })), null);
    eq(totalEquityFromTree(null), null);
    close(totalEquityFromTree(R())!, 569.09, 1e-9);
  });

  test('진짜 0은 0이다', () => {
    eq(totalEquityFromTree(R({ tree: { totalUsdt: 0 } })), 0);
  });

  console.log('[지갑 계좌 — 부분 합계를 총자산이라 적지 않는다]');

  const acct = (id: string, over: any = {}): WalletAccount => ({
    connectionId: id, label: id, exchange: 'gate', env: 'TESTNET',
    queryable: true, blockedReason: '', connection: 'OK', ...over,
  });

  test('한 계좌라도 못 읽으면 합계를 내지 않는다', () => {
    const m = new Map<string, WalletFetchResult>([
      ['a', R({ connectionId: 'a', tree: { totalUsdt: 500 } })],
      ['b', R({ connectionId: 'b', ok: false })],
    ]);
    const s = equitySumOf([acct('a'), acct('b')], m);
    eq(s.total, null);
    eq(s.complete, false);
    assert(s.missing.includes('b'), s.missing.join(','));
    assert(s.note.includes('사라진 것처럼'), s.note);
  });

  test('전부 읽었으면 합계를 낸다', () => {
    const m = new Map<string, WalletFetchResult>([
      ['a', R({ tree: { totalUsdt: 500 } })],
      ['b', R({ tree: { totalUsdt: 69.09 } })],
    ]);
    close(equitySumOf([acct('a'), acct('b')], m).total!, 569.09, 1e-9);
    eq(equitySumOf([acct('a'), acct('b')], m).complete, true);
  });

  test('조회 성공한 잔고 0은 합계에 들어간다', () => {
    // 조회 성공 + 잔고 0과, 조회 실패는 다르다.
    const m = new Map<string, WalletFetchResult>([['a', R({ tree: { totalUsdt: 0 } })]]);
    eq(equitySumOf([acct('a')], m).total, 0);
    eq(equitySumOf([acct('a')], m).complete, true);
  });

  test('못 물어보는 계좌가 있으면 합계를 막는다', () => {
    const s = equitySumOf([acct('w', { queryable: false })], new Map());
    eq(s.total, null);
    assert(s.missing.includes('w'), s.missing.join(','));
  });

  test('계좌가 없으면 합계도 없다', () => {
    eq(equitySumOf([], new Map()).total, null);
  });
}
