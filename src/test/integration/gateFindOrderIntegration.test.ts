// src/test/integration/gateFindOrderIntegration.test.ts
//
// **Gate 중복 확인이 "못 읽었다"를 "주문 없음"으로 적지 않는가.**
//
// 실제로 도는 것: `findOrderByClientIdGateFutures` → `toGateText` →
//   `gateReq`(서명 생성 · 질의 조립 · 응답 파싱). 가짜는 `fetch` 한 겹뿐이다.
//
// 이 판정의 뜻은 호출부가 정한다 (`orderExecutor`의 Gate 진입 경로):
//
//     if (!lookup.ok)      → FAILED · 주문 중단
//     if (lookup.order)    → RECONCILED (이미 있다)
//     그 외                 → **주문을 보낸다**
//
// 즉 `{ ok: true, order: null }`은 **"보내도 된다"**는 허가다. 못 읽은
// 회차가 그 모양으로 나가면 같은 주문이 한 번 더 나간다 — 이 함수의
// 주석이 막겠다고 적어 둔 바로 그 사고다:
// "레이트리밋이나 일시적 오류 한 번이 그대로 중복 체결이 될 수 있었다."

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import { findOrderByClientIdGateFutures } from '../../lib/exchanges/gateFutures';

const ORDERS = '/api/v4/futures/usdt/orders';
const KEY = 'K'.repeat(32);
const SECRET = 'S'.repeat(64);
const CID = 'LD-20261018-001';
const CONTRACT = 'BTC_USDT';
/** `toGateText`가 만드는 이름. 바뀌지 않는 키라 't-' 접두사만 붙는다 */
const TEXT = `t-${CID}`;

const ROW = {
  id: 2089209928026685400, contract: CONTRACT, size: 1, price: '0',
  status: 'finished', finish_as: 'filled', text: TEXT, left: 0, fill_price: '100000',
};

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

export async function runGateFindOrderTests() {
  console.log('[통합 — Gate 중복 확인]');

  // ══════════ ① 찾으면 찾았다고 한다 (아래가 공허하지 않다) ══════════
  {
    const v = new FakeVenue().on(ORDERS, { json: (i: number) => (i === 0 ? [] : [ROW]) });
    const r: any = await on(v, () => findOrderByClientIdGateFutures(
      KEY, SECRET, CONTRACT, CID, true));

    test('★ ① 같은 이름의 주문이 있으면 ok이고 그 줄을 싣는다', () => {
      eq(r.ok, true, String(r.error));
      assert(r.order != null, '있는 주문을 못 찾았다');
      eq(String(r.order.text), TEXT);
    });
  }

  // ══════════ ② 정말 없으면 "없음"이다 (재시도가 막히지 않는다) ══════════
  {
    const v = new FakeVenue().on(ORDERS, { json: [] });
    const r: any = await on(v, () => findOrderByClientIdGateFutures(
      KEY, SECRET, CONTRACT, CID, true));

    test('★ ② 두 목록이 비어 있으면 ok:true · order:null (보내도 된다)', () => {
      eq(r.ok, true);
      eq(r.order, null);
    });
  }

  // ══════════ ③ 200인데 배열이 아니면 "없음"이 아니다 ══════════
  //
  // `gateReq`는 **비2xx만** 던진다. 200으로 객체가 오면 그대로 돌려주고,
  // `Array.isArray(rows) ? … : null`이 그것을 `hit=null`로 접는다.
  // 두 상태를 다 돌고 나면 `{ ok: true, order: null }` — **보내도 된다**가
  // 된다. 못 읽은 회차가 허가로 바뀌는 자리다.
  {
    const v = new FakeVenue().on(ORDERS, { json: { label: 'OK', message: 'fine' } });
    const r: any = await on(v, () => findOrderByClientIdGateFutures(
      KEY, SECRET, CONTRACT, CID, true));

    test('★ ③ 배열이 아닌 200 응답을 "주문 없음"으로 적지 않는다', () => {
      eq(r.ok, false, '못 읽은 조회가 "보내도 된다"로 나갔다 — 중복 주문이 된다');
      eq(r.order, null);
      assert(typeof r.error === 'string' && r.error.length > 0, '이유가 남아야 한다');
    });
  }

  // ══════════ ④ 한쪽 목록만 깨져도 같다 ══════════
  //
  // `open`은 배열인데 `finished`가 아니면, 예전에는 그 사실이 사라지고
  // "없음"이 됐다. 둘 중 하나라도 못 읽으면 없다고 말할 수 없다.
  {
    const v = new FakeVenue().on(ORDERS, {
      json: (i: number) => (i === 0 ? [] : { label: 'OK' }),
    });
    const r: any = await on(v, () => findOrderByClientIdGateFutures(
      KEY, SECRET, CONTRACT, CID, true));

    test('★ ④ finished 목록만 깨져도 "없음"으로 적지 않는다', () => {
      eq(r.ok, false);
      eq(r.order, null);
    });
  }

  // ══════════ ⑤ 번호 없는 줄을 "찾았다"로 넘기지 않는다 ══════════
  //
  // 호출부는 찾은 줄을 `exchange_order_id: String(existing.id)`로 적는다.
  // `id`가 없으면 장부에 **문자열 "undefined"**가 남고, 나중 취소가 그
  // 번호로 나가 `No order found with the given ID`가 된다 — 이 저장소가
  // Gate 주문 번호로 이미 한 번 겪은 사고다(포지션 0인데 조건부 주문 2건).
  {
    const { id: _drop, ...noId } = ROW;
    const v = new FakeVenue().on(ORDERS, { json: (i: number) => (i === 0 ? [noId] : []) });
    const r: any = await on(v, () => findOrderByClientIdGateFutures(
      KEY, SECRET, CONTRACT, CID, true));

    test('★ ⑤ 번호를 못 읽은 줄은 확인된 주문이 아니다', () => {
      eq(r.ok, false, '번호 없는 줄을 넘기면 장부에 "undefined"가 적힌다');
      eq(r.order, null);
    });
  }
}
