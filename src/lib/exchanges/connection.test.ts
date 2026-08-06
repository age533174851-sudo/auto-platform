// src/lib/exchanges/connection.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **없는 칸을 고르는 것**, 그리고 **그 실패를 조용히 삼키는 것.**
//
// 주문·잔고·대사 경로 여덟 곳이 각자 이렇게 읽고 있었다:
//
//   .select('exchange, api_key, api_secret_enc, encrypted_secret, ...')
//
// exchange_connections에는 `exchange`도 `encrypted_secret`도 없다. 실제
// 이름은 exchange_id와 api_secret_enc다. PostgREST는 없는 칸을 고르면
// 질의 **전체**를 실패시키고, supabase-js는 던지지 않고 error를 돌려준다.
// 여덟 곳 전부 error를 안 보고 `if (conn)`으로만 갈라서, 연결이 멀쩡히
// 저장돼 있어도 언제나 '연결 없음'이었다. 경고도 로그도 없었다.
//
// 그래서 여기서 두 가지를 고정한다:
//  1. select 목록에 실존하는 칸만 들어간다
//  2. 실패는 반드시 이유가 붙어서 나온다 — null + 빈 이유는 없다

import { test, eq, assert } from '../../test/harness';
import { loadConnection, normalizeExchange, CONN_SELECT } from './connection';
import { futuresExchangeOf } from './futuresAdapter';

/** 004/028 마이그레이션에 실제로 있는 칸 */
const REAL_COLUMNS = new Set([
  'id', 'user_id', 'exchange_id', 'label', 'api_key', 'api_key_masked',
  'api_secret_enc', 'api_passphrase_enc', 'has_withdrawal', 'is_active',
  'last_tested_at', 'test_status', 'created_at', 'perm_read', 'perm_trading',
  'auto_trading_enabled', 'is_paper', 'is_testnet', 'account_no',
  'kis_access_token', 'kis_token_expires_at',
]);

/** supabase 흉내. 체인 끝에서 { data, error }를 준다 */
function fakeSb(res: { data?: any; error?: any }, spy?: { select?: string }) {
  const chain: any = {
    select(cols: string) { if (spy) spy.select = cols; return chain; },
    eq() { return chain; },
    async maybeSingle() { return { data: res.data ?? null, error: res.error ?? null }; },
  };
  return { from: () => chain };
}

const ROW = {
  id: 'c1', user_id: 'u1', exchange_id: 'binance', label: '내 계정',
  api_key: 'KEY', api_secret_enc: '', api_passphrase_enc: null,
  account_no: null, has_withdrawal: false, is_active: true, is_testnet: true,
};

export function runConnectionTests() {
  console.log('[거래소 연결 — 없는 칸을 고르면 질의가 통째로 죽는다]');

  // ── **이 파일의 이유** ────────────────────────────────
  test('select 목록에 실존하지 않는 칸이 없다', () => {
    for (const raw of CONN_SELECT.split(',')) {
      const c = raw.trim();
      if (!c) continue;
      assert(REAL_COLUMNS.has(c), `없는 칸을 고르고 있다: ${c}`);
    }
  });

  test('없어진 칸 이름 두 개는 절대 들어가지 않는다', () => {
    assert(!CONN_SELECT.includes('encrypted_secret'), 'encrypted_secret은 없는 칸이다');
    assert(!/\bexchange\b(?!_id)/.test(CONN_SELECT), 'exchange는 없는 칸이다 (exchange_id다)');
  });

  // ── 실패에는 언제나 이유가 붙는다 ─────────────────────
  test('supabase가 없으면 이유가 나온다', async () => {
    const r = await loadConnection(null, 'c1');
    eq(r.conn, null);
    assert(r.error.length > 0, '조용히 null이 됐다');
  });

  test('연결 id가 없으면 이유가 나온다', async () => {
    const r = await loadConnection(fakeSb({ data: ROW }), '');
    eq(r.conn, null);
    assert(r.error.includes('connectionId'), r.error);
  });

  // 이 한 줄이 없어서 여덟 곳이 전부 조용히 죽었다.
  test('질의가 실패하면 그 사실이 그대로 나온다', async () => {
    const r = await loadConnection(fakeSb({ error: { message: 'column "exchange" does not exist' } }), 'c1');
    eq(r.conn, null);
    assert(r.error.includes('does not exist'), '오류 메시지를 삼켰다: ' + r.error);
  });

  test('행이 없으면 못 찾았다고 말한다 — 질의 실패와 다른 문구다', async () => {
    const notFound = await loadConnection(fakeSb({ data: null }), 'c1', 'u1');
    const queryFail = await loadConnection(fakeSb({ error: { message: 'boom' } }), 'c1', 'u1');
    eq(notFound.conn, null);
    eq(queryFail.conn, null);
    assert(notFound.error !== queryFail.error, '두 실패가 같은 문구다 — 원인을 구분할 수 없다');
  });

  test('conn이 null이면 이유는 반드시 비어 있지 않다', async () => {
    const cases = await Promise.all([
      loadConnection(null, 'c1'),
      loadConnection(fakeSb({ data: null }), 'c1'),
      loadConnection(fakeSb({ error: { message: 'x' } }), 'c1'),
      loadConnection(fakeSb({ data: { ...ROW, exchange_id: '' } }), 'c1'),
      loadConnection(fakeSb({ data: { ...ROW, api_key: '' } }), 'c1'),
    ]);
    for (const r of cases) {
      eq(r.conn, null);
      assert(r.error.trim().length > 0, '이유 없는 실패가 있다');
    }
  });

  // ── 차단 조건 ─────────────────────────────────────────
  test('출금 권한 키는 차단한다 — 경고가 아니라 차단이다', async () => {
    const r = await loadConnection(fakeSb({ data: { ...ROW, has_withdrawal: true } }), 'c1');
    eq(r.conn, null);
    assert(r.error.includes('출금'), r.error);
  });

  test('꺼진 연결은 쓰지 않는다', async () => {
    const r = await loadConnection(fakeSb({ data: { ...ROW, is_active: false } }), 'c1');
    eq(r.conn, null);
  });

  // 빈 시크릿으로 서명하면 거래소는 -2015를 준다. 그 메시지로는
  // '키가 틀렸다'와 '키를 못 읽었다'를 구분할 수 없다.
  test('시크릿을 복호화 못 하면 여기서 멈춘다 — 빈 키로 서명하지 않는다', async () => {
    const r = await loadConnection(fakeSb({ data: ROW }), 'c1');
    eq(r.conn, null);
    assert(r.error.includes('EXCHANGE_ENCRYPTION_KEY'), '어느 환경변수인지 안 적었다: ' + r.error);
  });

  // ── 정상 경로 ─────────────────────────────────────────
  test('정상 연결은 바로 쓸 수 있는 모양으로 나온다', async () => {
    process.env.EXCHANGE_ENCRYPTION_KEY = 'a'.repeat(64);
    const { encryptSecret } = await import('./crypto');
    const spy: { select?: string } = {};
    const sb = fakeSb({ data: { ...ROW, api_secret_enc: encryptSecret('SECRET') } }, spy);
    const r = await loadConnection(sb, 'c1', 'u1');
    assert(r.conn != null, r.error);
    eq(r.error, '');
    eq(r.conn!.exchange, 'binance');
    eq(r.conn!.apiKey, 'KEY');
    eq(r.conn!.apiSecret, 'SECRET');
    // 실제로 그 목록으로 질의했는지까지 본다 — 상수만 맞고 안 쓰면 소용없다
    eq(spy.select, CONN_SELECT);
  });

  // **is_testnet === false일 때만 실전이다.** 모르면 테스트넷으로 본다 —
  // 실전 여부를 추측해서 틀리면 실제 돈이 나간다.
  test('실전은 is_testnet === false일 때뿐이다', async () => {
    process.env.EXCHANGE_ENCRYPTION_KEY = 'a'.repeat(64);
    const { encryptSecret } = await import('./crypto');
    const enc = encryptSecret('S');
    const mk = (v: any) => fakeSb({ data: { ...ROW, api_secret_enc: enc, is_testnet: v } });
    eq((await loadConnection(mk(false), 'c1')).conn!.isTestnet, false, 'false만 실전이다');
    eq((await loadConnection(mk(true), 'c1')).conn!.isTestnet, true);
    eq((await loadConnection(mk(null), 'c1')).conn!.isTestnet, true, 'null을 실전으로 읽었다');
    eq((await loadConnection(mk(undefined), 'c1')).conn!.isTestnet, true, 'undefined를 실전으로 읽었다');
  });

  // ── 거래소 태그 ───────────────────────────────────────
  test('거래소 이름을 정규화한다', () => {
    eq(normalizeExchange('binance'), 'binance');
    eq(normalizeExchange('BINANCE_FUTURES'), 'binance');
    eq(normalizeExchange('gate'), 'gate');
    eq(normalizeExchange('gateio'), 'gate');
    eq(normalizeExchange('kis'), 'kis');
  });

  // 모르는 거래소를 binance로 추측하면 엉뚱한 곳에 주문이 나간다.
  test('모르는 거래소는 추측하지 않는다', () => {
    eq(normalizeExchange('upbit'), 'upbit', '모르는 값을 바꿔치기했다');
    eq(normalizeExchange(''), '');
    eq(normalizeExchange(null), '');
    eq(normalizeExchange(undefined), '');
  });

  console.log('[거래소 해석 — 모르는 것을 바이낸스로 떨어뜨리지 않는다]');

  test('두 해석기가 같은 문자열을 같게 읽는다', () => {
    // 예전에는 futuresExchangeOf가 정확히 'gate'|'gateio'|'gate.io'만 봤고
    // normalizeExchange는 `.includes('gate')`였다. 두 해석기가 갈리면
    // 한쪽이 통과시킨 연결을 다른 쪽이 막고, 그때 화면에는 이유가 안 남는다.
    for (const raw of ['gate', 'gateio', 'Gate.io', 'GATE_FUTURES', 'gate futures']) {
      eq(normalizeExchange(raw), 'gate', raw);
      eq(futuresExchangeOf(raw), 'gate', raw);
    }
    for (const raw of ['binance', 'BINANCE_FUTURES', 'binance-usdm']) {
      eq(normalizeExchange(raw), 'binance', raw);
      eq(futuresExchangeOf(raw), 'binance', raw);
    }
  });

  test('선물을 안 하는 거래소는 null이다 — binance가 아니다', () => {
    // 아홉 곳이 손으로 이렇게 적고 있었다:
    //   .includes('gate') ? 'gate' : 'binance'
    // 그러면 exchange_id가 비었거나 오타이거나 새 거래소일 때
    // **바이낸스 코드가 남의 키로 돈다.**
    for (const raw of ['upbit', 'bithumb', 'kis', '한국투자', 'okx', '', null, undefined, 'ㅁㄴㅇㄹ']) {
      eq(futuresExchangeOf(raw), null, String(raw));
    }
  });

  test('모르는 값을 정규화가 지어내지 않는다', () => {
    // normalizeExchange는 원문을 그대로 둔다. 그래야 위쪽에서
    // "이 거래소는 못 다룬다"고 말할 수 있다.
    eq(normalizeExchange('okx'), 'okx');
    eq(futuresExchangeOf('okx'), null);
  });

  test('공백과 대소문자에 흔들리지 않는다', () => {
    eq(futuresExchangeOf('  GATE  '), 'gate');
    eq(futuresExchangeOf('  Binance '), 'binance');
  });
}
