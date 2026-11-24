// src/test/integration/gateOrderReadIntegration.test.ts
//
// **Gate 미체결·조건부 주문 조회가 "못 읽음"을 "없음"으로 적지 않는가.**
//
// 실제로 도는 것: `getOpenOrdersGateFutures` ·
//   `getPriceOrdersGateFutures` · `getAllPriceOrdersGateFutures` ·
//   `cancelAllOpenOrdersGateFutures` · `placeStopGateFutures`
//   → `gateReq`(서명 생성 · 질의 조립 · 응답 파싱).
//   가짜는 `fetch` 한 겹뿐이다.
//
// Gate 문서가 말하는 것 (`/orders`, `/price_orders` 둘 다):
//   · `limit` 기본 **100** — "Maximum number of records returned in a single list"
//   · `offset` — "List offset, starting from 0"
//   · **정렬 순서는 적혀 있지 않다**
// 그래서 첫 100건에 없다고 없는 것이 아니다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import {
  getOpenOrdersGateFutures, getPriceOrdersGateFutures, getAllPriceOrdersGateFutures,
  cancelAllOpenOrdersGateFutures, placeStopGateFutures,
} from '../../lib/exchanges/gateFutures';

const ORDERS = '/api/v4/futures/usdt/orders';
const PRICE = '/api/v4/futures/usdt/price_orders';
const POSITIONS = '/api/v4/futures/usdt/positions';
const KEY = 'K'.repeat(32);
const SECRET = 'S'.repeat(64);
const C = 'BTC_USDT';

const ord = (i: number, over: Record<string, unknown> = {}) =>
  ({ id: 1000 + i, contract: C, size: 1, price: '0', status: 'open', ...over });
const full = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ord(i, over));

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}
async function threwOn<T>(v: FakeVenue, fn: () => Promise<T>): Promise<boolean> {
  try { await on(v, fn); return false; } catch { return true; }
}
/** offset을 보고 쪽마다 다른 응답을 준다 */
function paged(v: FakeVenue, path: string, byOffset: (offset: number) => any) {
  v.on(path, { json: () => {
    const c = v.calls[v.calls.length - 1];
    return byOffset(Number(c?.params?.offset ?? 0));
  } });
  return v;
}

export async function runGateOrderReadTests() {
  console.log('[통합 — Gate 주문 조회]');

  // ══════════ ① 미체결: 비배열 200을 빈 목록으로 접지 않는다 ══════════
  //
  // `cancelAllOpenOrdersGateFutures`는 이 함수의 **던짐**을 받아
  // `success:false`를 돌려주도록 이미 만들어져 있다. 빈 배열로 접으면
  // 그 보호가 그냥 지나간다.
  {
    const v = new FakeVenue().on(ORDERS, { json: { label: 'OK' } });
    const threw = await threwOn(v, () => getOpenOrdersGateFutures(KEY, SECRET, true));

    test('★ ① 미체결 응답이 배열이 아니면 빈 목록이 아니다', () => {
      assert(threw, '빈 배열로 접으면 상위의 try/catch 보호가 지나간다');
    });
  }

  // ══════════ ② 미체결: 101번째 주문을 놓치지 않는다 ══════════
  {
    const v = paged(new FakeVenue(), ORDERS, (o) =>
      (o === 0 ? full(100) : o === 100 ? [ord(999, { id: 7777 })] : []));
    const r: any = await on(v, () => getOpenOrdersGateFutures(KEY, SECRET, true));

    test('★ ② 첫 쪽이 가득 차면 다음 쪽을 읽는다', () => {
      eq(r.length, 101, '첫 쪽만 읽으면 101번째 미체결이 없는 것이 된다');
    });
  }

  // ══════════ ③ 미체결: 짧은 쪽이면 한 번으로 끝난다 ══════════
  {
    const v = new FakeVenue().on(ORDERS, { json: [ord(1)] });
    const r: any = await on(v, () => getOpenOrdersGateFutures(KEY, SECRET, true));

    test('★ ③ 흔한 계정은 요청 한 번이다', () => {
      eq(r.length, 1);
      eq(v.countOf(ORDERS), 1);
    });
  }

  // ══════════ ④ 조건부: 자기 문서대로 null을 돌려준다 ══════════
  //
  // 그 함수의 주석이 그대로 적고 있다:
  //   "걸려 있는 조건부 주문(손절·익절). **못 읽으면 null** — 빈 배열과 구분한다"
  // 그런데 코드는 비배열 200에 `[]`를 돌려줬다. 문서와 코드가 달랐다.
  {
    const v = new FakeVenue().on(PRICE, { json: { label: 'OK' } });
    const r: any = await on(v, () => getPriceOrdersGateFutures(KEY, SECRET, C, true));

    test('★ ④ 조건부 주문을 못 읽으면 null이다 (빈 배열이 아니다)', () => {
      eq(r, null, '[]로 돌려주면 "보호주문 없음"이 사실이 된다');
    });
  }

  // ══════════ ⑤ 조건부: 101번째 손절을 놓치지 않는다 ══════════
  {
    const v = paged(new FakeVenue(), PRICE, (o) =>
      (o === 0 ? full(100) : o === 100 ? [ord(999, { id: 5555 })] : []));
    const r: any = await on(v, () => getPriceOrdersGateFutures(KEY, SECRET, C, true));

    test('★ ⑤ 조건부 주문도 쪽을 넘긴다', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 101);
    });
  }

  // ══════════ ⑥ 전체 조건부 조회도 쪽을 넘긴다 ══════════
  {
    const v = paged(new FakeVenue(), PRICE, (o) =>
      (o === 0 ? full(100) : o === 100 ? [ord(999, { id: 4444 })] : []));
    const r: any = await on(v, () => getAllPriceOrdersGateFutures(KEY, SECRET, true));

    test('★ ⑥ 계약 없는 전체 조회도 101번째를 읽는다', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 101);
    });
  }

  // ══════════ ⑦ 정상적인 빈 목록은 허용한다 ══════════
  {
    const v = new FakeVenue().on(PRICE, { json: [] });
    const r: any = await on(v, () => getPriceOrdersGateFutures(KEY, SECRET, C, true));

    test('★ ⑦ 진짜 빈 목록은 빈 배열이다 (막지 않는다)', () => {
      assert(Array.isArray(r) && r.length === 0, '정상적인 0건을 null로 막으면 안 된다');
    });
  }

  // ══════════ ⑧ 전체 취소: 일부를 못 읽었으면 성공이 아니다 ══════════
  //
  // 이 함수의 주석이 그대로 적고 있다:
  //   "조회에 실패하면 성공이라고 말하지 않는다. 여기서 '0건 취소 완료'를
  //    돌려주면 사용자는 정리됐다고 믿고 손을 뗀다."
  //
  // 그런데 그 보호는 **계약을 하나도 못 찾았을 때만** 걸렸다. 미체결에서
  // 계약이 하나라도 나오면, 조건부 전체 조회가 실패해도(null) 그대로
  // 진행하고 `success: true`로 끝났다 — **다른 계약에 남은 손절은 보지도
  // 않은 채**다.
  {
    const v = new FakeVenue()
      .on(ORDERS, { json: [ord(1)] }, 'GET')
      .on(POSITIONS, { json: [] })
      // ★ GET만 실패시킨다. DELETE까지 막으면 "취소가 실패해서" 성공이
      //   아니게 되고, 그건 이 시험이 보려는 것이 아니다 (공허한 통과).
      .on(PRICE, { status: 500, json: { label: 'SERVER_ERROR' } }, 'GET')
      .on(PRICE, { json: [] }, 'DELETE')
      .on(ORDERS, { json: [] }, 'DELETE');
    const r: any = await on(v, () => cancelAllOpenOrdersGateFutures(KEY, SECRET, true));

    test('★ ⑧ 조건부 전체 조회가 실패하면 "전부 취소"라고 하지 않는다', () => {
      eq(r.success, false, '보지 않은 계약이 있는데 전부 취소로 적혔다');
    });
  }

  // ══════════ ⑨ 전부 읽혔으면 성공이 맞다 (⑧이 공허하지 않다) ══════════
  {
    const v = new FakeVenue()
      .on(ORDERS, { json: [ord(1)] }, 'GET')
      .on(POSITIONS, { json: [] })
      .on(PRICE, { json: [] }, 'GET')
      .on(PRICE, { json: [] }, 'DELETE')
      .on(ORDERS, { json: [] }, 'DELETE');
    const r: any = await on(v, () => cancelAllOpenOrdersGateFutures(KEY, SECRET, true));

    test('★ ⑨ 세 조회가 다 읽히면 성공으로 적는다', () => {
      eq(r.success, true, String(r.message));
    });
  }

  // ══════════ ⑩ 손절: 번호를 못 읽으면 "설정됨"이 아니다 ══════════
  //
  // 번호를 못 읽은 손절은 **나중에 취소할 수도, 확인할 수도 없다.**
  // 그 코드의 주석도 이미 적고 있다: "숫자로 읽힌 int64는 이미 망가진
  // 값이라 `venueIdOf`가 null을 준다 — 그 번호로는 취소가 안 된다."
  // 그래 놓고 `success: true`였다.
  {
    const v = new FakeVenue().on(PRICE, { json: { detail: 'accepted' } }, 'POST');
    const r: any = await on(v, () => placeStopGateFutures(KEY, SECRET, {
      contract: C, spec: { rule: 1, autoSize: 'close_long', triggerPrice: 99000 },
    }, true));

    test('★ ⑩ 주문 번호가 없으면 손절 설정 성공이 아니다', () => {
      eq(r.success, false, '취소도 확인도 못 하는 손절을 "설정됨"으로 적었다');
    });
  }

  // ══════════ ⑪ 번호가 오면 성공이 맞다 (⑩이 공허하지 않다) ══════════
  {
    const v = new FakeVenue().on(PRICE, { json: { id: 123456789 } }, 'POST');
    const r: any = await on(v, () => placeStopGateFutures(KEY, SECRET, {
      contract: C, spec: { rule: 1, autoSize: 'close_long', triggerPrice: 99000 },
    }, true));

    test('★ ⑪ 번호가 읽히면 손절 설정 성공이다', () => {
      eq(r.success, true, String(r.message));
      eq(r.orderId, '123456789');
    });
  }
}
