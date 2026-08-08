// src/lib/exchanges/futuresExec.test.ts
//
// **Gate 잡이 Gate로 나가는가.** 그리고 모르는 거래소가 바이낸스로
// 떨어지지 않는가.
//
// 이 파일이 못 박는 것은 화면에서 안 보이는 것들이다. 거래소를 잘못
// 고르면 대개 서명이 실패해서 "키가 틀렸다"로 보이고, 실패하지 않는
// 조합이 하나라도 있으면 **남의 계좌에 주문이 나간다.**
//
// 마지막 묶음은 네트워크를 가로채서 **실제로 어느 호스트로 나가는지**
// 확인한다. 판정 함수만 맞고 배선이 틀린 경우가 이 저장소에서 반복됐다 —
// 만들어 놓고 배선을 안 함.

import { test, eq, assert } from '../../test/harness';
import {
  resolveExecExchange, jobExchangeCheck, leverageVerdict, unknownResultVerdict,
  reconcileDecision, futuresPlaceOrder, futuresFindOrderByClientId,
  positionModeVerdict, __clearPositionModeCache,
  UNSUPPORTED_EXCHANGE, EXCHANGE_MISMATCH, type ExecTarget,
} from './futuresExec';
import { __clearGateSpecCache } from './gateFutures';

const GATE_TESTNET = 'api-testnet.gateapi.io';
const GATE_LIVE = 'api.gateio.ws';
const BINANCE_TESTNET = 'demo-fapi.binance.com';

export function runFuturesExecTests() {
  console.log('[실행기 — 거래소 판정]');

  test('binance와 gate만 실행한다', () => {
    eq(resolveExecExchange('binance').exchange, 'binance');
    eq(resolveExecExchange('gate').exchange, 'gate');
    eq(resolveExecExchange('gateio').exchange, 'gate');
    eq(resolveExecExchange('gate.io').exchange, 'gate');
  });

  test('모르는 거래소는 binance로 떨어지지 않는다', () => {
    for (const raw of ['bybit', 'okx', 'upbit', 'kis', 'bithumb', 'coinbase']) {
      const r = resolveExecExchange(raw);
      eq(r.exchange, null, `${raw}가 실행 가능으로 판정됐다`);
      eq(r.code, UNSUPPORTED_EXCHANGE);
      assert(r.message.includes(raw), '어느 거래소였는지 메시지에 남아야 한다');
    }
  });

  test('빈 값·null도 막는다 — 기본값이 없다', () => {
    for (const raw of [null, undefined, '', '   ']) {
      eq(resolveExecExchange(raw as any).exchange, null, `${JSON.stringify(raw)}가 통과했다`);
    }
  });

  console.log('[실행기 — 잡과 연결의 거래소가 같은가]');

  test('같으면 통과', () => {
    eq(jobExchangeCheck('binance', 'binance').ok, true);
    eq(jobExchangeCheck('gate', 'gateio').ok, true);   // 이름만 다르고 같은 거래소
  });

  test('다르면 실행하지 않는다 — 어느 쪽이 맞는지 고를 수 없다', () => {
    const r = jobExchangeCheck('binance', 'gate');
    eq(r.ok, false);
    eq(r.code, EXCHANGE_MISMATCH);
  });

  test('잡에 거래소가 없으면 연결을 따른다 (옛 행)', () => {
    const r = jobExchangeCheck(null, 'gate');
    eq(r.ok, true);
    eq(r.code, 'JOB_EXCHANGE_MISSING');
  });

  test('연결이 지원 밖이면 잡이 뭐라 적었든 막는다', () => {
    eq(jobExchangeCheck('binance', 'bybit').ok, false);
    eq(jobExchangeCheck('binance', 'bybit').code, UNSUPPORTED_EXCHANGE);
  });

  console.log('[실행기 — 배율 되읽기]');

  test('요청과 실제가 같으면 통과', () => {
    const r = leverageVerdict(100, 100, 100);
    eq(r.ok, true); eq(r.code, 'MATCH'); eq(r.observed, 100);
  });

  test('실제가 더 높으면 막는다 — 청산가가 계산보다 가깝다', () => {
    const r = leverageVerdict(50, 50, 100);
    eq(r.ok, false); eq(r.code, 'HIGHER_THAN_REQUESTED'); eq(r.observed, 100);
  });

  test('거래소가 낮게 잡아도 막는다 — 100배 전략이 75배로 도는 것은 다른 전략이다', () => {
    const r = leverageVerdict(100, 75, 75);
    eq(r.ok, false, '75배로 통과시켰다');
    eq(r.code, 'VENUE_CAPPED'); eq(r.observed, 75);
    assert(r.message.includes('100'), '요청한 100배가 메시지에 남아야 한다');
    assert(r.message.includes('75'), '실제 75배가 메시지에 남아야 한다');
    assert(r.message.includes('그대로'), '전략 설정을 건드리지 않았다고 적어야 한다');
  });

  test('1배라도 다르면 막는다 — 안전한 방향이라는 이유로 통과시키지 않는다', () => {
    eq(leverageVerdict(100, 99, 99).ok, false);
    eq(leverageVerdict(10, 9, 9).ok, false);
    eq(leverageVerdict(3, 2, 2).ok, false);
  });

  test('되읽기가 실패하면 설정 응답으로 판정하지 않는다 — 그건 "받았다"이지 "됐다"가 아니다', () => {
    const r = leverageVerdict(75, 75, null);
    eq(r.ok, false, '설정 응답만 보고 통과시켰다');
    eq(r.code, 'UNVERIFIED'); eq(r.observed, null);
    assert(r.message.includes('75배'), '설정 응답 값은 참고로 남아야 한다');
  });

  test('설정 응답이 무엇이든 판정은 되읽은 값만 쓴다', () => {
    // 설정 응답 100 · 되읽음 50 → 되읽은 50이 요청과 다르므로 막힌다
    eq(leverageVerdict(100, 100, 50).code, 'VENUE_CAPPED');
    // 설정 응답 50 · 되읽음 100 → 되읽은 100이 요청보다 높으므로 막힌다
    eq(leverageVerdict(50, 50, 100).code, 'HIGHER_THAN_REQUESTED');
    // 설정 응답이 요청과 같아도, 되읽지 못했으면 통과가 아니다
    eq(leverageVerdict(100, 100, null).code, 'UNVERIFIED');
  });

  test('둘 다 못 읽으면 주문하지 않는다 — 확인하지 못한 것은 통과가 아니다', () => {
    const r = leverageVerdict(100, null, null);
    eq(r.ok, false); eq(r.code, 'UNVERIFIED'); eq(r.observed, null);
  });

  test('0과 null은 배율이 아니다 — 되읽은 0을 100배로 읽지 않는다', () => {
    // Gate는 leverage 0이 교차 마진이다. 0을 배율로 쓰면 안 된다.
    const r = leverageVerdict(100, 0, 0);
    eq(r.ok, false); eq(r.code, 'UNVERIFIED');
  });

  test('요청과 실제가 같을 때만 통과한다 — 통과 경로는 이것 하나다', () => {
    eq(leverageVerdict(100, 100, 100).ok, true);
    eq(leverageVerdict(100, 100, 100).code, 'MATCH');
  });

  test('배율을 지정하지 않았으면 검사하지 않는다', () => {
    eq(leverageVerdict(null, null, null).code, 'NOT_REQUESTED');
    eq(leverageVerdict(0, null, null).code, 'NOT_REQUESTED');
  });

  console.log('[실행기 — 포지션 모드]');

  test('헤지 모드는 막는다 — 단방향 주문은 거래소가 거부한다', () => {
    const r = positionModeVerdict('HEDGE');
    eq(r.ok, false); eq(r.code, 'HEDGE_BLOCKED');
    assert(r.message.includes('단방향'), '무엇으로 바꿔야 하는지 적혀야 한다');
    assert(r.message.includes('키·수량·잔고 문제가 아닙니다'),
      '엉뚱한 곳을 뒤지지 않게 하는 문장이 있어야 한다');
  });

  test('단방향이면 통과', () => {
    const r = positionModeVerdict('ONE_WAY');
    eq(r.ok, true); eq(r.code, 'ONE_WAY');
  });

  test('못 읽으면 신규 진입을 막는다 — 헤지였다면 반대 포지션이 열릴 수 있다', () => {
    const r = positionModeVerdict(null, '타임아웃');
    eq(r.ok, false, '못 읽었는데 진입을 허용했다');
    eq(r.code, 'UNKNOWN'); eq(r.mode, null);
    assert(r.message.includes('타임아웃'), '왜 못 읽었는지 남아야 한다');
    assert(r.message.includes('청산은 이 검사를 받지 않습니다'),
      '닫는 길이 막히지 않는다는 것을 명시해야 한다');
  });

  console.log('[실행기 — UNKNOWN 판정]');

  test('타임아웃·연결 끊김은 UNKNOWN이다', () => {
    for (const s of [
      '거래소 응답 없음', 'Request timed out', 'ETIMEDOUT', 'ECONNRESET',
      'socket hang up', 'fetch failed', 'The operation was aborted',
      '응답을 받지 못했습니다',
    ]) {
      assert(unknownResultVerdict(s).unknown, `UNKNOWN으로 안 읽힘: ${s}`);
    }
  });

  test('거래소가 명시적으로 거절한 것은 UNKNOWN이 아니다', () => {
    for (const s of [
      '[-2019] Margin is insufficient', '[-1111] Precision is over the maximum',
      'Gate 400: invalid argument', '최소 수량 미달',
    ]) {
      eq(unknownResultVerdict(s).unknown, false, `거절인데 UNKNOWN으로 읽힘: ${s}`);
    }
  });

  test('빈 문구는 UNKNOWN이 아니다', () => {
    eq(unknownResultVerdict('').unknown, false);
    eq(unknownResultVerdict(null).unknown, false);
  });

  console.log('[실행기 — UNKNOWN 뒤 대조]');

  test('이미 나갔으면 다시 보내지 않는다', () => {
    const d = reconcileDecision({ ok: true, found: true });
    eq(d.action, 'ALREADY_PLACED'); eq(d.mayResend, false);
  });

  test('안 나간 것이 확인되면 다시 보낼 수 있다', () => {
    const d = reconcileDecision({ ok: true, found: false });
    eq(d.action, 'NOT_PLACED'); eq(d.mayResend, true);
  });

  test('조회 실패는 "없음"이 아니다 — 여기서 헷갈리면 중복 체결이다', () => {
    for (const l of [{ ok: false, found: false }, null, undefined]) {
      const d = reconcileDecision(l as any);
      eq(d.action, 'STILL_UNKNOWN', '조회 실패를 없음으로 읽었다');
      eq(d.mayResend, false);
    }
  });

  console.log('[실행기 — 실제로 어디로 나가는가]');

  // ── 여기서부터는 fetch를 가로챈다 ──
  //
  // 하네스는 async 테스트를 **동시에** 시작한다(fn()을 바로 부르고 프라미스만
  // 모은다). 그래서 전역 fetch를 갈아 끼우는 테스트를 그냥 쓰면 서로의 스텁을
  // 덮어쓴다 — 처음에 실제로 그렇게 깨졌다. 두 가지로 막는다:
  //
  //   1. `netTest`로 이 파일의 네트워크 테스트를 **한 줄로 세운다**
  //   2. 스텁이 모르는 URL은 **원래 fetch로 넘긴다** — 같이 도는 다른 파일의
  //      테스트를 이 스텁이 가로채지 않게
  let chain: Promise<void> = Promise.resolve();
  const netTest = (name: string, fn: () => Promise<void>) => {
    test(name, () => {
      const p = chain.then(fn, () => fn());
      chain = p.then(() => undefined, () => undefined);
      return p;
    });
  };

  const withFetch = async (
    handler: (url: string, init: any) => { status?: number; body?: any } | null,
    fn: () => Promise<void>,
  ): Promise<string[]> => {
    const urls: string[] = [];
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (u: any, init: any) => {
      const url = String(u);
      const r = handler(url, init);
      // 이 테스트가 모르는 주소는 원래 fetch가 처리한다.
      if (!r) return real(u, init);
      urls.push(url);
      const text = JSON.stringify(r.body ?? {});
      return {
        ok: (r.status ?? 200) < 400, status: r.status ?? 200,
        text: async () => text, json: async () => JSON.parse(text),
      } as any;
    };
    try { await fn(); } finally { (globalThis as any).fetch = real; }
    return urls;
  };

  // **거래 경로만** 가로챈다. 같이 도는 다른 파일의 시세 테스트(klines 등)가
  // 같은 호스트를 쓰는데, 그것까지 잡으면 남의 테스트를 깨뜨리고 이 테스트의
  // 기록도 더럽힌다. 여기서 확인하려는 것은 "주문이 어느 거래소로 나가는가"다.
  const TRADING_PATH =
    /\/fapi\/v[12]\/(order|batchOrders|openOrders|allOrders|positionRisk|leverage|exchangeInfo|positionSide)|\/api\/v4\/futures\//;

  /** 이 테스트가 다루는 주소인가. 아니면 null을 돌려 원래 fetch로 넘긴다 */
  const mine = (url: string) =>
    (url.includes(GATE_TESTNET) || url.includes(GATE_LIVE)
      || url.includes(BINANCE_TESTNET) || url.includes('fapi.binance.com'))
    && TRADING_PATH.test(url);

  netTest('Gate TESTNET 주문은 Gate 테스트넷 호스트로만 나간다', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'gate', key: 'k', secret: 's', testnet: true };
    let placed: any = null;
    const urls = await withFetch((url, init) => {
      if (!mine(url)) return null;
      // 단방향 계좌 — 이게 없으면 신규 진입이 막힌다(그게 맞는 동작이다)
      if (url.includes('/futures/usdt/accounts')) return { body: { in_dual_mode: false, total: '1000', available: '1000' } };
      if (url.includes('/futures/usdt/contracts/')) {
        // 1계약 = 0.0001 BTC
        return { body: { name: 'BTC_USDT', quanto_multiplier: '0.0001', order_size_min: 1, order_price_round: '0.1' } };
      }
      if (url.includes('/futures/usdt/orders') && init?.method === 'POST') {
        placed = JSON.parse(init.body);
        return { body: { id: 987, contract: 'BTC_USDT', size: placed.size, price: '0', status: 'finished', left: 0, fill_price: '63000' } };
      }
      return { body: {} };
    }, async () => {
      const r = await futuresPlaceOrder(t, {
        symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05,
        clientOrderId: 'job-abc',
      });
      eq(r.ok, true, `주문이 실패했다: ${r.error}`);
      eq(r.status, 'FILLED');
      eq(r.orderId, '987');
    });

    assert(urls.length > 0, '아무 호출도 안 나갔다');
    for (const u of urls) {
      assert(u.includes(GATE_TESTNET), `Gate 테스트넷이 아닌 곳으로 나갔다: ${u}`);
      assert(!u.includes('binance'), `바이낸스로 나갔다: ${u}`);
      assert(!u.includes(GATE_LIVE), `실전 Gate로 나갔다: ${u}`);
    }
    // 0.05 BTC ÷ 0.0001 = 500계약. 매수라 양수.
    eq(placed.size, 500, 'Gate 계약 수가 틀렸다');
    eq(placed.contract, 'BTC_USDT');
    eq(placed.tif, 'ioc');
    assert(String(placed.text).startsWith('t-'), 'Gate 주문 이름 규격(t- 접두사)이 안 붙었다');
  });

  netTest('Gate 매도는 계약 수가 음수다 — 부호가 곧 방향이다', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'gate', key: 'k', secret: 's', testnet: true };
    let placed: any = null;
    await withFetch((url, init) => {
      if (!mine(url)) return null;
      if (url.includes('/futures/usdt/accounts')) return { body: { in_dual_mode: false, total: '1000', available: '1000' } };
      if (url.includes('/futures/usdt/contracts/')) {
        return { body: { name: 'BTC_USDT', quanto_multiplier: '0.0001', order_size_min: 1, order_price_round: '0.1' } };
      }
      if (url.includes('/futures/usdt/orders') && init?.method === 'POST') {
        placed = JSON.parse(init.body);
        return { body: { id: 1, size: placed.size, status: 'finished', left: 0, fill_price: '63000' } };
      }
      return { body: {} };
    }, async () => {
      await futuresPlaceOrder(t, { symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.05 });
    });
    eq(placed.size, -500);
  });

  netTest('계약 규격을 못 읽으면 Gate 주문을 보내지 않는다 — 10,000배가 나갈 수 있다', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'gate', key: 'k', secret: 's', testnet: true };
    let posted = 0;
    await withFetch((url, init) => {
      if (!mine(url)) return null;
      if (init?.method === 'POST') posted++;
      if (url.includes('/futures/usdt/accounts')) return { body: { in_dual_mode: false } };
      if (url.includes('/futures/usdt/contracts/')) return { status: 500, body: { message: 'down' } };
      return { body: {} };
    }, async () => {
      const r = await futuresPlaceOrder(t, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05 });
      eq(r.ok, false);
      eq(r.status, 'REJECTED');
      assert(String(r.error).includes('규격'), `이유가 규격 미확인이어야 한다: ${r.error}`);
    });
    eq(posted, 0, '규격을 모르는데 주문이 나갔다');
  });

  netTest('바이낸스 TESTNET 주문은 바이낸스 데모 호스트로 나간다', async () => {
    const t: ExecTarget = { exchange: 'binance', key: 'k', secret: 's', testnet: true };
    const urls = await withFetch((url) => {
      if (!mine(url)) return null;
      if (url.includes('/fapi/v1/positionSide/dual')) return { body: { dualSidePosition: false } };
      if (url.includes('/fapi/v1/exchangeInfo')) {
        return { body: { symbols: [{ symbol: 'BTCUSDT', filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
          { filterType: 'PRICE_FILTER', tickSize: '0.1' },
        ] }] } };
      }
      return { body: { orderId: 5, symbol: 'BTCUSDT', side: 'BUY', origQty: '0.05', executedQty: '0.05', avgPrice: '63000' } };
    }, async () => {
      const r = await futuresPlaceOrder(t, {
        symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05, clientOrderId: 'job-xyz',
      });
      eq(r.ok, true, `주문이 실패했다: ${r.error}`);
      eq(r.orderId, '5');
    });
    for (const u of urls) {
      assert(u.includes(BINANCE_TESTNET), `바이낸스 데모가 아닌 곳으로 나갔다: ${u}`);
      assert(!u.includes('gate'), `Gate로 나갔다: ${u}`);
    }
  });

  // ── 판정이 실제로 주문을 막는가 ──
  //
  // 판정 함수만 고치고 배선을 안 하는 것이 이 저장소의 1번 고장이다.
  // 아래 셋은 **POST가 한 번도 안 나갔는지**를 센다.

  netTest('포지션 모드를 못 읽으면 신규 진입 주문이 나가지 않는다', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'gate', key: 'k1', secret: 's', testnet: true };
    let posted = 0;
    await withFetch((url, init) => {
      if (!mine(url)) return null;
      if (init?.method === 'POST') posted++;
      // 계좌 조회만 실패한다 — 나머지는 정상
      if (url.includes('/futures/usdt/accounts')) return { status: 500, body: { message: 'rate limit' } };
      if (url.includes('/futures/usdt/contracts/')) {
        return { body: { name: 'BTC_USDT', quanto_multiplier: '0.0001', order_size_min: 1, order_price_round: '0.1' } };
      }
      return { body: { id: 1, size: 500, left: 0, status: 'finished' } };
    }, async () => {
      const r = await futuresPlaceOrder(t, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05 });
      eq(r.ok, false, '모드를 못 읽었는데 주문이 성공으로 끝났다');
      eq(r.status, 'REJECTED');
    });
    eq(posted, 0, '포지션 모드를 모르는데 주문이 나갔다');
  });

  netTest('청산(reduceOnly)은 포지션 모드를 못 읽어도 나간다 — 못 닫게 만들지 않는다', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'gate', key: 'k2', secret: 's', testnet: true };
    let orderPosts = 0;
    await withFetch((url, init) => {
      if (!mine(url)) return null;
      if (url.includes('/futures/usdt/accounts')) return { status: 500, body: { message: 'rate limit' } };
      if (url.includes('/futures/usdt/contracts/')) {
        return { body: { name: 'BTC_USDT', quanto_multiplier: '0.0001', order_size_min: 1, order_price_round: '0.1' } };
      }
      if (url.includes('/futures/usdt/orders') && init?.method === 'POST') {
        orderPosts++;
        return { body: { id: 7, size: -500, left: 0, status: 'finished', fill_price: '63000' } };
      }
      return { body: {} };
    }, async () => {
      const r = await futuresPlaceOrder(t, {
        symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.05, reduceOnly: true,
      });
      eq(r.ok, true, `청산이 막혔다: ${r.error}`);
    });
    eq(orderPosts, 1, '청산 주문이 안 나갔다');
  });

  netTest('배율이 요청과 다르면 주문이 나가지 않는다 — 100배 요청에 거래소 75배', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'binance', key: 'k3', secret: 's', testnet: true };
    let orderPosts = 0;
    await withFetch((url, init) => {
      if (!mine(url)) return null;
      if (url.includes('/fapi/v1/positionSide/dual')) return { body: { dualSidePosition: false } };
      // 설정 응답은 100배라고 답한다 — 그런데 되읽으면 75배다.
      if (url.includes('/fapi/v1/leverage')) return { body: { leverage: 100, symbol: 'BTCUSDT' } };
      if (url.includes('/fapi/v2/positionRisk')) {
        return { body: [{ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0', markPrice: '63000',
          leverage: '75', marginType: 'isolated', liquidationPrice: '0', unRealizedProfit: '0' }] };
      }
      if (url.includes('/fapi/v1/order')) { orderPosts++; return { body: { orderId: 9 } }; }
      return { body: {} };
    }, async () => {
      const r = await futuresPlaceOrder(t, {
        symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05, leverage: 100,
      });
      eq(r.ok, false, '배율이 75배인데 100배 주문이 나갔다');
      eq(r.status, 'REJECTED');
      assert(String(r.error).includes('75'), `실제 배율이 사유에 남아야 한다: ${r.error}`);
    });
    eq(orderPosts, 0, '배율이 요청과 다른데 주문이 나갔다');
  });

  netTest('Gate 조회 실패는 "주문 없음"이 아니다', async () => {
    const t: ExecTarget = { exchange: 'gate', key: 'k', secret: 's', testnet: true };
    await withFetch((url) => (mine(url) ? { status: 500, body: { message: 'rate limit' } } : null), async () => {
      const r = await futuresFindOrderByClientId(t, 'BTCUSDT', 'job-abc');
      eq(r.ok, false, '조회 실패인데 ok로 읽혔다');
      eq(reconcileDecision(r).mayResend, false);
    });
  });

  netTest('Gate ioc가 한 계약도 못 붙이면 체결로 적지 않는다', async () => {
    __clearGateSpecCache(); __clearPositionModeCache();
    const t: ExecTarget = { exchange: 'gate', key: 'k', secret: 's', testnet: true };
    await withFetch((url, init) => {
      if (!mine(url)) return null;
      if (url.includes('/futures/usdt/accounts')) return { body: { in_dual_mode: false, total: '1000', available: '1000' } };
      if (url.includes('/futures/usdt/contracts/')) {
        return { body: { name: 'BTC_USDT', quanto_multiplier: '0.0001', order_size_min: 1, order_price_round: '0.1' } };
      }
      if (url.includes('/futures/usdt/orders') && init?.method === 'POST') {
        // 200 + finished 인데 left가 그대로다 = 하나도 안 붙었다
        return { body: { id: 3, size: 500, left: 500, status: 'finished' } };
      }
      return { body: {} };
    }, async () => {
      const r = await futuresPlaceOrder(t, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05 });
      eq(r.ok, false, '체결 0인데 성공으로 읽혔다');
      eq(r.status, 'UNFILLED');
      eq(r.filledQty, 0);
    });
  });
}
