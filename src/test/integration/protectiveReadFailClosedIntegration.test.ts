// src/test/integration/protectiveReadFailClosedIntegration.test.ts
//
// **보호주문 조회가 깨진 회차를 "보호주문 없음"으로 읽지 않는다.**
//
// 실제로 도는 것: `futuresProtectiveOrders` · `futuresCancelProtection`
//   → `getFuturesOpenOrders` → 서명 생성 · 질의 조립 · 응답 파싱.
//   가짜는 `fetch` 한 겹뿐이다.
//
// 왜 이 묶음이 필요한가
// ─────────────────────
// `getFuturesOpenOrders`는 실패할 때 `{ success: false, orders: [] }`를
// 돌려준다 — **빈 배열이지 null이 아니다.** 그래서
//
//   if (!Array.isArray(orders)) return fail(...)   ← 한 번도 발동 못 함
//   const targets = (orders || []).filter(...)     ← 언제나 0건
//
// 두 형제 함수가 조회 실패를 **"없다"**로 읽고 있었다.
//
// 같은 파일의 `futuresOpenOrdersAll`은 이미 그 교훈을 적어 두었다:
// "★ **`success`를 반드시 본다.** 이 함수는 실패할 때 `orders: []`를
//  돌려준다 — 배열 길이만 보면 조회 실패가 '미체결 없음'으로 읽힌다."
// 한 파일 안에서 한쪽만 고쳐져 있었던 것이다.
//
// 남은 결함 하나 — 이 PR에서 고치지 않았다
// ────────────────────────────────────────
// `getFuturesOpenOrders` 자체가 **배열이 아닌 응답을 `[]`로 바꾸고
// `success: true`를 돌려준다**(`(Array.isArray(data) ? data : [])`).
// 그 경우 어댑터는 "읽었고 0건"과 "못 읽었다"를 구분할 방법이 없다.
// 고칠 자리는 `binanceFutures.ts`인데 지금 열린 PR 다섯이 그 파일을
// 잡고 있어(#186 #327 #343 #346 #351) 건드리지 않았다. 별도 회차 몫이다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import {
  futuresProtectiveOrders, futuresCancelProtection,
} from '../../lib/exchanges/futuresAdapter';

const OPEN = '/fapi/v1/openOrders';
const ORDER = '/fapi/v1/order';

const KEY = 'K'.repeat(64);
const SECRET = 'S'.repeat(64);

/** 전량 청산용 손절 한 건 — 실제 응답 모양 */
const STOP = {
  orderId: 8801, symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'SELL',
  stopPrice: '99000', closePosition: true, reduceOnly: false,
  origQty: '0', price: '0', workingType: 'MARK_PRICE', status: 'NEW',
};

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

export async function runProtectiveReadFailClosedTests() {
  console.log('[통합 — 보호주문 조회 실패를 "없음"으로 적지 않는다]');

  // ══════════ ① 읽히면 그대로 센다 (관문이 공허하지 않다) ══════════
  {
    const v = new FakeVenue().on(OPEN, { json: [STOP] });
    const r: any = await on(v, () => futuresProtectiveOrders(
      'binance', KEY, SECRET, true, 'BTCUSDT', 'LONG'));

    test('★ ① 손절이 걸려 있으면 ok이고 1건으로 센다', () => {
      eq(r.ok, true, String(r.error));
      eq(r.stopCount, 1);
    });
  }

  // ══════════ ② 조회가 깨지면 "손절 0건"이 아니다 ══════════
  //
  // 0건은 **단정**이다. 점검 화면이 "거래소에 손절이 하나도 없습니다"로
  // 적고, 그걸 본 사람이 이미 있는 손절 위에 또 하나를 건다.
  {
    const v = new FakeVenue()
      .on(OPEN, { status: 500, json: { code: -1003, msg: 'Too many requests' } });
    const r: any = await on(v, () => futuresProtectiveOrders(
      'binance', KEY, SECRET, true, 'BTCUSDT', 'LONG'));

    test('★ ② 미체결 조회가 깨지면 ok:false이고 수는 null이다', () => {
      eq(r.ok, false, '못 읽은 회차가 "확인됨"으로 나갔다');
      eq(r.stopCount, null, '0은 "손절이 없다"는 단정이다 — 확인한 적이 없다');
      eq(r.count, null);
      assert(typeof r.error === 'string' && r.error.length > 0,
        '왜 못 읽었는지가 남아야 한다');
    });
  }

  // ══════════ ④ 정리 경로 — 못 읽었으면 "지울 것 없음"이 아니다 ══════════
  //
  // `orderExecutor`가 **전량 청산을 확인한 직후** 이것을 부른다. 남은
  // 손절이 무장된 채로 남으면 트리거에 닿는 순간 반대 포지션이 열린다.
  {
    const v = new FakeVenue()
      .on(OPEN, { status: 500, json: { code: -1003, msg: 'Too many requests' } })
      .on(ORDER, { json: { code: 200 } }, 'DELETE');
    const r: any = await on(v, () => futuresCancelProtection(
      'binance', KEY, SECRET, true, 'BTCUSDT'));

    test('★ ④ 정리 전 조회가 깨지면 "0건 정리"로 조용히 끝내지 않는다', () => {
      assert(r.cancelled !== 0,
        '못 읽은 회차를 "지울 것이 0건"으로 적으면 남은 손절을 아무도 못 본다');
      eq(r.cancelled, null);
      assert(typeof r.note === 'string' && r.note.includes('확인하지 못했습니다'),
        `호출부가 사람에게 알릴 문구가 비어 있다: ${JSON.stringify(r.note)}`);
      eq(v.countOf(ORDER, 'DELETE'), 0, '무엇을 지우는지 모르는 채로 취소가 나갔다');
    });
  }

  // ══════════ ⑤ 읽혔으면 실제로 지운다 (④가 공허하지 않다) ══════════
  {
    const v = new FakeVenue()
      .on(OPEN, { json: [STOP] })
      .on(ORDER, { json: { orderId: 8801, status: 'CANCELED' } }, 'DELETE');
    const r: any = await on(v, () => futuresCancelProtection(
      'binance', KEY, SECRET, true, 'BTCUSDT'));

    test('★ ⑤ 읽힌 보호주문은 실제로 취소된다', () => {
      eq(r.cancelled, 1);
      eq(v.countOf(ORDER, 'DELETE'), 1);
    });
  }
}
