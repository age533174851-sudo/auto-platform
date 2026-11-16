// src/lib/exchanges/losslessJson.test.ts
//
// **2026-08-16: 취소가 실패한 게 아니라 취소할 번호가 깨져 있었다.**
//
// Gate가 준 실제 주문 번호:
//   2089209928026685400   ← 끝이 400
//   2089209928399978500   ← 끝이 500
//
// 둘 다 Number.MAX_SAFE_INTEGER(9007199254740991)를 300배 넘게 벗어난다.
// `JSON.parse`가 만든 순간 마지막 자릿수가 반올림됐고, 그 번호로 보낸
// 취소는 Gate에서 "No order found with the given ID"로 돌아왔다.
//
// 이 파일의 숫자는 **실제 크기 그대로** 쓴다. 작은 id로 테스트하면
// 이 고장은 절대 재현되지 않는다.

import { test, eq, assert } from '../../test/harness';
import {
  parseLossless, quoteUnsafeIntegers, isUnsafeIntegerLiteral,
  venueIdOf, isLostPrecisionId, parseErrorBody,
} from './losslessJson';
import {
  setCoinMMarginType, findCoinMOrderByClientId,
} from './binanceCoinFutures';
import { testGate } from './gate';
import { testUpbit } from './upbit';

// Gate TESTNET에서 실제로 받은 크기의 번호(끝자리만 바꿔 둘을 구분한다)
const SL_ID = '2089209928026685417';
const TP_ID = '2089209928399978533';
// **마지막 한 자리만 다른 두 번호.** number로 읽으면 같은 값이 된다.
const NEAR_A = '2089209928026685411';
const NEAR_B = '2089209928026685412';

export function runLosslessJsonTests() {
  console.log('[int64 주문번호 — 숫자로 읽으면 값이 바뀐다]');

  test('실제 Gate 주문번호는 Number로 담을 수 없다', () => {
    // 전제 자체를 못 박는다. 이게 false면 나머지 테스트가 무의미하다.
    for (const id of [SL_ID, TP_ID, NEAR_A, NEAR_B]) {
      eq(Number.isSafeInteger(Number(id)), false, id);
    }
    eq(Number.MAX_SAFE_INTEGER, 9007199254740991);
  });

  test('마지막 한 자리만 다른 두 번호가 number에서는 같아진다', () => {
    // **이래서 소유 판정이 "내 주문 맞음"으로 통과했다.**
    eq(Number(NEAR_A) === Number(NEAR_B), true, 'number 경로에서는 구분되지 않는다');
    // 문자열로 읽으면 절대 합쳐지지 않는다.
    const a = parseLossless<any>(`{"id":${NEAR_A}}`).id;
    const b = parseLossless<any>(`{"id":${NEAR_B}}`).id;
    assert(a !== b, `${a} 와 ${b} 가 같아졌다`);
    eq(a, NEAR_A); eq(b, NEAR_B);
  });

  console.log('[int64 주문번호 — 파싱 시점에 잡는다]');

  test('Gate 응답의 큰 정수는 정확한 문자열로 남는다', () => {
    const raw = `[{"id":${SL_ID},"user":123,"status":"open",`
      + `"initial":{"contract":"ETH_USDT","size":0,"price":"0","auto_size":"close_long",`
      + `"reduce_only":true,"text":"t-mo1-abc"},`
      + `"trigger":{"strategy_type":0,"price_type":1,"price":"1870.5","rule":2}}]`;
    const rows = parseLossless<any[]>(raw);
    eq(rows[0].id, SL_ID);
    eq(typeof rows[0].id, 'string');
    // **가격·수량은 그대로다.** 식별자만 문자열로 바꾼다.
    eq(rows[0].initial.size, 0);
    eq(rows[0].user, 123);
    eq(rows[0].trigger.rule, 2);
    eq(rows[0].trigger.price, '1870.5');
  });

  test('작은 정수와 소수는 숫자 그대로 둔다 — 계산 대상이다', () => {
    const o = parseLossless<any>('{"qty":0.05,"lev":100,"px":63912.5,"neg":-12,"exp":1.5e3}');
    eq(o.qty, 0.05); eq(o.lev, 100); eq(o.px, 63912.5); eq(o.neg, -12); eq(o.exp, 1500);
    eq(typeof o.lev, 'number');
  });

  test('문자열 안의 숫자는 건드리지 않는다', () => {
    // 소유 식별자에 숫자가 들어 있다. 여기를 바꾸면 소유권 파싱이 깨진다.
    const o = parseLossless<any>(`{"text":"t-mo1-${SL_ID}","id":${SL_ID}}`);
    eq(o.text, `t-mo1-${SL_ID}`);
    eq(o.id, SL_ID);
  });

  test('이스케이프된 따옴표를 문자열 끝으로 착각하지 않는다', () => {
    const o = parseLossless<any>(`{"note":"say \\"${SL_ID}\\" ok","id":${TP_ID}}`);
    eq(o.note, `say "${SL_ID}" ok`);
    eq(o.id, TP_ID);
  });

  test('음수 큰 정수도 보존한다', () => {
    eq(parseLossless<any>(`{"id":-${SL_ID}}`).id, `-${SL_ID}`);
  });

  test('깨진 JSON은 조용히 넘기지 않는다', () => {
    let threw = false;
    try { parseLossless('{'); } catch { threw = true; }
    assert(threw, '깨진 JSON을 빈 값으로 만들었다');
  });

  test('안전 범위 안의 정수는 문자열로 바꾸지 않는다', () => {
    eq(isUnsafeIntegerLiteral('9007199254740991'), false);
    eq(isUnsafeIntegerLiteral('9007199254740993'), true);
    eq(isUnsafeIntegerLiteral('123'), false);
    eq(isUnsafeIntegerLiteral('1.5'), false);
    eq(quoteUnsafeIntegers('{"a":123}'), '{"a":123}');
  });

  console.log('[int64 주문번호 — 이미 망가진 값을 복구했다고 하지 않는다]');

  test('안전 범위를 벗어난 number 식별자는 null이다 — String()으로 되살리지 않는다', () => {
    // **`String(2089209928026685400)`은 복구가 아니라 위조다.**
    // 그 번호로 취소를 보내면 거래소는 "그런 주문 없다"고 답한다.
    eq(venueIdOf(Number(SL_ID)), null);
    eq(isLostPrecisionId(Number(SL_ID)), true);
  });

  test('문자열 · bigint · 안전한 정수는 그대로 쓴다', () => {
    eq(venueIdOf(SL_ID), SL_ID);
    eq(venueIdOf(BigInt(SL_ID) as any), SL_ID);
    eq(venueIdOf(12345), '12345');
    eq(venueIdOf(' 7 '), '7');
    eq(venueIdOf(null), null);
    eq(venueIdOf('null'), null);
    eq(venueIdOf(NaN), null);
  });

  console.log('[int64 주문번호 — 취소 URL에 원래 자릿수가 그대로 간다]');

  test('취소 경로에 넣어도 자릿수가 하나도 안 바뀐다', () => {
    const id = parseLossless<any>(`{"id":${SL_ID}}`).id;
    const path = `/api/v4/futures/usdt/price_orders/${encodeURIComponent(id)}`;
    eq(path, `/api/v4/futures/usdt/price_orders/${SL_ID}`);
    assert(path.endsWith(SL_ID), path);
  });

  test('서버 → 브라우저 JSON 왕복에서도 자릿수가 유지된다', () => {
    // 화면은 이 값을 그대로 취소에 쓴다. 여기서 다시 number가 되면
    // 같은 사고가 브라우저 쪽에서 반복된다.
    const fromVenue = parseLossless<any>(`{"id":${TP_ID}}`).id;
    const wire = JSON.stringify({ orders: [{ id: fromVenue }] });
    assert(wire.includes(`"${TP_ID}"`), wire);
    eq(JSON.parse(wire).orders[0].id, TP_ID);
  });

  // ── 거절 본문이 거래소 사유 그대로 올라오는가 ──
  //
  // `parseLossless`를 들이면서 오류 경로 다섯 곳이
  // `parseLossless(await r.text()).catch(() => ({}))`가 됐다.
  // `parseLossless`는 **동기 함수**라 반환값에 `.catch`가 없다. 그래서
  // 거래소가 거절하면 그 사유 대신
  //   "parseLossless(...).catch is not a function"
  // 이라는 TypeError가 던져졌다. 사유(-4046 · -2013 · INVALID_KEY …)를
  // 보고 판단하는 코드가 전부 그 문장을 받았다:
  //
  //   · COIN-M `setCoinMMarginType` — 이미 ISOLATED(-4046)인 계좌에서
  //     "ISOLATED 설정 실패"로 주문을 멈췄다
  //   · COIN-M `findCoinMOrderByClientId` — 처음 내는 주문의 정상 답
  //     -2013("없음")이 판단 불가 예외가 되어, clientOrderId가 붙은
  //     **모든 COIN-M 주문이 전송 전에 실패했다**
  //   · Gate·Upbit — 401/403의 실제 사유(INVALID_KEY …)가 화면에 안 나왔다
  console.log('[거래소 거절 본문 — 사유를 TypeError로 바꾸지 않는다]');

  test('parseErrorBody: 거래소 JSON은 그대로, 못 읽으면 빈 객체', () => {
    eq(parseErrorBody('{"code":-4046,"msg":"No need to change margin type."}').code, -4046);
    eq(JSON.stringify(parseErrorBody('<html>502</html>')), '{}');
    eq(JSON.stringify(parseErrorBody('')), '{}');
    eq(JSON.stringify(parseErrorBody('null')), '{}');
    eq(JSON.stringify(parseErrorBody('"text"')), '{}');
  });

  // 하네스는 async 테스트를 동시에 돌린다. 전역 fetch를 오래 갈아 끼우면
  // 다른 파일의 스텁과 섞인다. 여기서는 **동기 구간 안에서만** 갈아
  // 끼운다 — 대상 함수들은 첫 `await` 전에 fetch를 부르므로, 호출 직후
  // 원래 fetch로 되돌려도 응답은 이미 이 스텁 것이다. 그 전제가 깨지면
  // (fetch가 동기 구간에 안 불리면) 시험이 그 사실로 실패한다.
  const rejectOnce = <T>(status: number, body: any, call: () => Promise<T>) => {
    const real = (globalThis as any).fetch;
    let hits = 0;
    (globalThis as any).fetch = async () => {
      hits++;
      const text = JSON.stringify(body);
      return { ok: false, status, text: async () => text, json: async () => body } as any;
    };
    let p: Promise<T>;
    try { p = call(); } finally { (globalThis as any).fetch = real; }
    eq(hits, 1, '대상 함수가 동기 구간에서 fetch를 부르지 않았다 — 시험 전제가 깨졌다');
    return p;
  };

  test('COIN-M: 이미 ISOLATED(-4046)는 성공이다 — 주문을 멈추지 않는다', async () => {
    const r = await rejectOnce(400,
      { code: -4046, msg: 'No need to change margin type.' },
      () => setCoinMMarginType('k', 's', 'BTCUSD_PERP', 'ISOLATED', true));
    eq(r.success, true, `받은 값: ${JSON.stringify(r)}`);
  });

  test('COIN-M: 다른 거절은 거래소 사유 그대로 실패한다', async () => {
    const r = await rejectOnce(400,
      { code: -4047, msg: 'Margin type cannot be changed if there exists open orders.' },
      () => setCoinMMarginType('k', 's', 'BTCUSD_PERP', 'ISOLATED', true));
    eq(r.success, false);
    assert(String(r.message).includes('open orders'), `사유가 사라졌다: ${r.message}`);
  });

  test('COIN-M: clientOrderId 사전 조회의 -2013은 "없음"이다 — 예외로 주문을 막지 않는다', async () => {
    const r = await rejectOnce(400,
      { code: -2013, msg: 'Order does not exist.' },
      () => findCoinMOrderByClientId('k', 's', 'BTCUSD_PERP', 'CMX', true));
    eq(r, null);
  });

  test('COIN-M: 사전 조회의 판단 불가 오류는 여전히 던진다 (재전송 금지 유지)', async () => {
    let thrown: any = null;
    try {
      await rejectOnce(400, { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' },
        () => findCoinMOrderByClientId('k', 's', 'BTCUSD_PERP', 'CMX', true));
    } catch (e) { thrown = e; }
    assert(thrown != null, '판단 불가인데 null(없음)로 읽었다');
    assert(String(thrown.message).includes('recvWindow'), `사유가 사라졌다: ${thrown?.message}`);
  });

  test('Gate: 401 본문의 사유(INVALID_KEY)가 메시지에 남는다', async () => {
    const r = await rejectOnce(401,
      { label: 'INVALID_KEY', message: 'Invalid key provided' },
      () => testGate('k', 's', true));
    eq(r.success, false);
    assert(String(r.message).startsWith('Invalid key provided'), `받은 값: ${r.message}`);
  });

  test('Upbit: 거절 본문의 사유가 메시지에 남는다', async () => {
    const r = await rejectOnce(401,
      { error: { name: 'invalid_access_key', message: '잘못된 엑세스 키입니다.' } },
      () => testUpbit('k', 's'));
    eq(r.success, false);
    assert(String(r.message).includes('잘못된 엑세스 키'), `받은 값: ${r.message}`);
  });
}
