// src/test/integration/tpslReplaceIntegration.test.ts
//
// **보호주문을 바꿀 때 바꾸지 않기로 한 쪽을 지우지 않는가.**
//
// 실제로 도는 것: `futuresSetTpsl` → `cancelOpenTPSL` /
//   `getPriceOrdersGateFutures` → `gateProtectiveKind` →
//   `placeFuturesTPSL` / `placeStopGateFutures` → 서명 생성 · 질의 조립.
//   가짜는 `fetch` 한 겹뿐이다.
//
// 무엇이 걸려 있나
// ────────────────
// `SET_TPSL`은 같은 포지션에 여러 번 온다(손절 이동·본전 이동). 그래서
// `replaceExisting`이 있다. 그런데 그 구현이 **바꾸려는 쪽만이 아니라
// 전부**를 지웠다:
//
//   바이낸스  cancelOpenTPSL(key, secret, symbol, testnet)   ← only 안 넘김
//   Gate      DELETE /price_orders?contract=X                 ← 계약 단위
//
// 익절만 옮기는 회차에 **손절이 함께 사라진다.** 그리고 지운 뒤 새로
// 거는 데 실패하면 그 포지션은 무방비가 된다.
//
// 지우는 것과 거는 것 사이에 창이 있다
// ────────────────────────────────────
// DELETE가 2xx라고 **실제로 취소된 것은 아니다.** 그래서 지운 뒤
// 다시 읽어 확인하고, 확인하지 못하면 새로 걸지 않는다 — 옛 보호가
// 남아 있는 편이 보호가 없는 것보다 낫다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import { futuresSetTpsl } from '../../lib/exchanges/futuresExec';
import { placeStopGateFutures } from '../../lib/exchanges/gateFutures';

const OPEN = '/fapi/v1/openOrders';
const ORDER = '/fapi/v1/order';
const EXINFO = '/fapi/v1/exchangeInfo';
const BN_POS = '/fapi/v2/positionRisk';
const GPRICE = '/api/v4/futures/usdt/price_orders';

const KEY = 'K'.repeat(64);
const SECRET = 'S'.repeat(64);
const SYM = 'BTCUSDT';
const BN = { exchange: 'binance' as const, key: KEY, secret: SECRET, testnet: true };

/** 전량 청산용 보호주문 한 줄 (바이낸스 모양) */
const prot = (orderId: number, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET') => ({
  orderId, symbol: SYM, type, side: 'SELL', stopPrice: '99000',
  closePosition: true, reduceOnly: false, origQty: '0', price: '0',
  workingType: 'MARK_PRICE', status: 'NEW',
});

function bnVenue(opts: {
  before?: any[];           // 교체 전 미체결
  after?: any[];            // 취소 뒤 재조회 결과 (없으면 before와 같다)
  deleteFails?: boolean;
  readFails?: boolean;
  postReply?: any;
} = {}): FakeVenue {
  const v = new FakeVenue();
  let deleted = false;
  v.on(EXINFO, { json: { symbols: [{ symbol: SYM, filters: [
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
    { filterType: 'PRICE_FILTER', tickSize: '0.10' },
  ] }] } });
  v.on(BN_POS, { json: [{ symbol: SYM, positionAmt: '0.010', entryPrice: '100000',
    markPrice: '100000', unRealizedProfit: '0', liquidationPrice: '90000',
    leverage: '10', marginType: 'isolated' }] });
  v.on(ORDER, { status: 400, json: { code: -2011, msg: 'Unknown order sent.' } }, 'DELETE');
  if (!opts.deleteFails) {
    v.on(ORDER, { json: { orderId: 1, status: 'CANCELED' } }, 'DELETE');
  }
  v.on(OPEN, opts.readFails
    ? { status: 500, json: { code: -1000, msg: 'down' } }
    : { json: () => (deleted ? (opts.after ?? opts.before ?? []) : (opts.before ?? [])) });
  v.on(ORDER, opts.postReply ?? { json: { orderId: 777, status: 'NEW' } }, 'POST');
  // DELETE가 한 번이라도 나가면 '취소됨' 상태로 넘어간다
  (v as any).rules.unshift({
    label: 'mark-deleted',
    match: (c: any) => c.method === 'DELETE' && c.path.includes(ORDER) && !(deleted = true),
    reply: { json: {} },
  });
  return v;
}

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}
/** 취소 요청이 나간 주문 번호들 */
const cancelledIds = (v: FakeVenue) => v.calls
  .filter(c => c.method === 'DELETE' && c.path.includes(ORDER))
  .map(c => String(c.params?.orderId ?? ''));
const postCount = (v: FakeVenue) => v.calls
  .filter(c => c.method === 'POST' && c.path.includes(ORDER)).length;

export async function runTpslReplaceTests() {
  console.log('[통합 — 보호주문 교체]');

  // ══════════ ① 익절만 바꾸면 손절은 남는다 ══════════
  {
    const v = bnVenue({ before: [prot(11, 'STOP_MARKET'), prot(12, 'TAKE_PROFIT_MARKET')],
      after: [prot(11, 'STOP_MARKET')] });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', tpPrice: 101000, replaceExisting: true,
    }));

    test('★ ① 익절만 바꾸면 기존 손절을 지우지 않는다', () => {
      const ids = cancelledIds(v);
      assert(!ids.includes('11'), `손절(11)이 취소됐다: ${ids.join(',')}`);
      assert(ids.includes('12'), `익절(12)은 취소돼야 한다: ${ids.join(',')}`);
      eq(r.ok, true, String(r.message));
    });
  }

  // ══════════ ② 손절만 바꾸면 익절은 남는다 ══════════
  {
    const v = bnVenue({ before: [prot(21, 'STOP_MARKET'), prot(22, 'TAKE_PROFIT_MARKET')],
      after: [prot(22, 'TAKE_PROFIT_MARKET')] });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', slPrice: 98000, replaceExisting: true,
    }));

    test('★ ② 손절만 바꾸면 기존 익절을 지우지 않는다', () => {
      const ids = cancelledIds(v);
      assert(!ids.includes('22'), `익절(22)이 취소됐다: ${ids.join(',')}`);
      assert(ids.includes('21'), `손절(21)은 취소돼야 한다: ${ids.join(',')}`);
      eq(r.ok, true, String(r.message));
    });
  }

  // ══════════ ③ 둘 다 바꾸면 둘 다 교체된다 ══════════
  {
    const v = bnVenue({ before: [prot(31, 'STOP_MARKET'), prot(32, 'TAKE_PROFIT_MARKET')],
      after: [] });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', tpPrice: 101000, slPrice: 98000,
      replaceExisting: true,
    }));

    test('★ ③ 둘 다 주면 둘 다 지우고 둘 다 건다', () => {
      const ids = cancelledIds(v);
      assert(ids.includes('31') && ids.includes('32'), `취소 ${ids.join(',')}`);
      eq(r.ok, true, String(r.message));
      eq(postCount(v), 2);
    });
  }

  // ══════════ ④ 취소가 실패하면 새로 걸지 않는다 ══════════
  //
  // 옛 보호가 남아 있는 편이, 지우다 말고 새로 걸지도 못한 상태보다 낫다.
  {
    const v = bnVenue({ before: [prot(41, 'STOP_MARKET')],
      after: [prot(41, 'STOP_MARKET')], deleteFails: true });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', slPrice: 98000, replaceExisting: true,
    }));

    test('★ ④ 기존 보호주문 취소 실패 시 새 주문을 보내지 않는다', () => {
      eq(r.ok, false, '못 지웠는데 성공으로 적혔다');
      eq(postCount(v), 0, '취소 실패 뒤에 새 주문이 나갔다');
    });
  }

  // ══════════ ⑤ 취소 성공 뒤 새 주문이 거부되면 실패다 ══════════
  {
    const v = bnVenue({ before: [prot(51, 'STOP_MARKET')], after: [],
      postReply: { status: 400, json: { code: -2021, msg: 'Order would immediately trigger.' } } });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', slPrice: 98000, replaceExisting: true,
    }));

    test('★ ⑤ 새 손절이 거부되면 ok:false다', () => {
      eq(r.ok, false);
    });
  }

  // ══════════ ⑥ 새 주문 응답이 모호하면 성공이 아니다 ══════════
  //
  // 200인데 번호가 없다. **다시 보내지 않는다** — 재POST는 중복 보호
  // 주문을 만든다.
  {
    const v = bnVenue({ before: [], after: [], postReply: { json: { msg: 'accepted' } } });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', slPrice: 98000, replaceExisting: true,
    }));

    test('★ ⑥ 번호 없는 200 응답을 손절 설정 성공으로 적지 않는다', () => {
      eq(r.ok, false, '취소·확인이 불가능한 주문을 "설정됨"으로 적었다');
      eq(postCount(v), 1, '모호하다고 다시 보내면 중복 보호주문이 된다');
    });
  }

  // ══════════ ⑦ 기존 보호주문을 못 읽으면 UNKNOWN이고 걸지 않는다 ══════════
  {
    const v = bnVenue({ readFails: true });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', slPrice: 98000, replaceExisting: true,
    }));

    test('★ ⑦ 기존 보호주문 조회 실패는 "없음"이 아니다', () => {
      eq(r.ok, false, '무엇이 걸려 있는지 모르는 채로 교체를 진행했다');
      eq(postCount(v), 0);
    });
  }

  // ══════════ ⑧ Gate: 번호 없는 응답은 성공이 아니고 재전송도 없다 ══════════
  //
  // #364가 이 자리를 `success:false`로 바꿨다. **그 뒤에 자동 재POST가
  // 생기지 않았는지**를 여기서 고정한다. 실제로 주문이 생성됐는데 번호만
  // 안 온 경우, 다시 보내면 **중복 보호주문**이 된다.
  {
    const v = new FakeVenue().on(GPRICE, { json: { detail: 'accepted' } }, 'POST');
    const r: any = await on(v, () => placeStopGateFutures(KEY, SECRET, {
      contract: 'BTC_USDT',
      spec: { rule: 1, autoSize: 'close_long', triggerPrice: 99000 },
    }, true));

    test('★ ⑧ Gate 손절 응답에 번호가 없어도 다시 보내지 않는다', () => {
      eq(r.success, false);
      eq(v.calls.filter(c => c.method === 'POST').length, 1,
        '재전송하면 고아 주문 위에 중복 보호주문이 쌓인다');
      assert(/주문 번호|생성됐을 수|확인/.test(String(r.message)),
        `사람이 고아를 찾아볼 단서가 없다: ${r.message}`);
    });
  }

  // ══════════ ⑨ 취소가 부분 성공이면 완료가 아니다 ══════════
  //
  // 둘을 지우려 했는데 하나가 남았다. 재조회가 그것을 본다.
  {
    const v = bnVenue({ before: [prot(91, 'STOP_MARKET'), prot(92, 'TAKE_PROFIT_MARKET')],
      after: [prot(91, 'STOP_MARKET')] });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', tpPrice: 101000, slPrice: 98000,
      replaceExisting: true,
    }));

    test('★ ⑨ 지우려던 것이 남아 있으면 새로 걸지 않는다', () => {
      eq(r.ok, false, '남은 보호주문 위에 새 주문을 얹으면 중복이 된다');
      eq(postCount(v), 0);
    });
  }

  // ══════════ ⑩ 교체가 아닌 정상 신규 생성은 그대로 된다 ══════════
  {
    const v = bnVenue({ before: [] });
    const r: any = await on(v, () => futuresSetTpsl(BN, {
      symbol: SYM, positionSide: 'LONG', tpPrice: 101000, slPrice: 98000,
    }));

    test('★ ⑩ replaceExisting 없이 거는 기존 기능은 그대로다', () => {
      eq(r.ok, true, String(r.message));
      eq(postCount(v), 2);
      eq(cancelledIds(v).length, 0, '교체가 아닌데 기존 주문을 지웠다');
    });
  }
}
