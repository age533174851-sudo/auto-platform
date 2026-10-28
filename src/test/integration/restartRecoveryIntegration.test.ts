// src/test/integration/restartRecoveryIntegration.test.ts
//
// **프로세스가 주문 직후 죽었다. 다시 떴을 때 무엇을 해야 하는가.**
//
// 왜 더 필요한가
// ──────────────
// `resolveUnknown`·`resolveAcked`는 유닛 시험이 있다. 그런데 **거래소
// 조회를 실제로 돌려서** 그 판정에 넣어 본 적이 없다 — 통합 시험
// 어디에서도 부르지 않는다. 입력을 손으로 지어내면 "조회가 실제로 무엇을
// 돌려주는가"가 빠지고, 그 틈에서 이 저장소가 반복해서 당했다:
//
//   `findOrderByClientId`는 -2013을 **found:false**로 바꾼다.
//   그 false를 "주문이 안 나갔다"로 읽으면 **중복 주문**이 된다.
//
// 그래서 여기서는 FakeVenue를 통해 **진짜 HTTP 조회**를 돌리고, 그
// 결과를 그대로 `resolveUnknown`에 넣는다.
//
// 막으려는 것:
//  1. 재시작 뒤 "안 보인다"를 "안 들어갔다"로 읽어 두 번 주문하는 것
//  2. 조회 **실패**(5xx)를 "주문 없음"으로 읽는 것
//  3. 멱등 키가 없는데 자동으로 확정해 버리는 것
//  4. 유예 시간 안의 "아직 안 보임"을 실패로 확정하는 것
//  5. 모르는 상태 문자열을 임의로 매핑하는 것
//
// **실주문은 없다.** HTTP 경계만 가짜다.
import { test, eq, assert } from '../harness';
import { FakeVenue, withCryptoEnv } from './venueHarness';
import { findOrderByClientId } from '../../lib/exchanges/binanceFutures';
import { resolveUnknown, REFLECT_GRACE_MS } from '../../lib/engine/unknownResolver';

const BN_ORDER = '/fapi/v1/order';
const SYM = 'BTCUSDT';
const COID = 'RESTART-1';
const KEY = 'K'.repeat(64);
const SEC = 'S'.repeat(64);

type QueryReply =
  | { kind: 'FOUND'; status: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'DOWN' }
  | { kind: 'WEIRD'; status: string };

function venueFor(q: QueryReply): FakeVenue {
  const v = new FakeVenue();
  if (q.kind === 'DOWN') {
    v.on(BN_ORDER, { status: 503, json: { code: -1001, msg: 'Internal error' } }, 'GET');
  } else if (q.kind === 'NOT_FOUND') {
    v.on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET');
  } else {
    v.on(BN_ORDER, { json: {
      orderId: 9001, symbol: SYM, clientOrderId: COID,
      status: q.kind === 'WEIRD' ? q.status : q.status,
      executedQty: q.kind === 'FOUND' && q.status === 'FILLED' ? '0.01' : '0',
      origQty: '0.01', avgPrice: '100000',
    } }, 'GET');
  }
  return v;
}

/** 재시작 뒤 한 번 하는 일: 거래소에 **실제로** 물어보고 판정에 넣는다 */
async function restartAndResolve(q: QueryReply, i: {
  elapsedMs: number;
  clientOrderId?: string | null;
  qtyBefore?: number;
  qtyNow?: number | null;
}) {
  const venue = venueFor(q);
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try {
    const coid = i.clientOrderId === undefined ? COID : i.clientOrderId;
    // **진짜 조회.** 서명·질의 조립·응답 파싱·-2013 처리가 전부 돈다.
    // **조회가 던질 수 있다.** `findOrderByClientId`는 -2013(없음)과
    // -2015(이 엔드포인트만 막힘)만 흡수하고, 그 밖의 오류는 **그대로
    // 던진다** — 거래소 장애를 "주문 없음"으로 접지 않기 위해서다.
    // 부르는 쪽은 반드시 잡아야 한다. 그 사실을 여기서 값으로 남긴다.
    let look: { found: boolean; order?: any } = { found: false, order: undefined };
    let threw: string | null = null;
    if (coid) {
      try { look = await findOrderByClientId(KEY, SEC, SYM, coid, true); }
      catch (e: any) { threw = String(e?.message || e); }
    }
    const verdict = resolveUnknown({
      clientOrderId: coid,
      elapsedMs: i.elapsedMs,
      query: q.kind === 'DOWN'
        // 조회가 실패했다는 사실을 그대로 넘긴다 — found:false로 접지 않는다.
        ? { ok: false, order: null, error: 'HTTP 503' }
        : { ok: true, order: look.found ? look.order : null },
      ...(i.qtyNow !== undefined
        ? { position: { qtyBefore: i.qtyBefore ?? 0, qtyNow: i.qtyNow } } : {}),
    } as any);
    return { verdict, venue, look, threw };
  } finally { restore(); unenv(); }
}

export async function runRestartRecoveryTests() {
  console.log('[통합 — 주문 직후 죽었다가 다시 떴을 때 (실제 조회로 판정)]');

  // ── 거래소에 주문이 있다 ──
  {
    const { verdict, venue, look } = await restartAndResolve(
      { kind: 'FOUND', status: 'FILLED' }, { elapsedMs: 60_000 });

    test('★★★ 재시작 조회가 주문을 찾으면 체결로 확정한다', () => {
      eq(look.found, true, '조회가 주문을 못 찾았다');
      eq(verdict.resolved, true);
      eq(verdict.state, 'FILLED');
      eq(verdict.action, 'NONE');
    });

    test('★★★ 그리고 주문을 다시 보내지 않는다', () => {
      eq(venue.orderSends().length, 0, '재시작이 주문을 또 보냈다');
    });

    test('★ 조회는 멱등 키로 한다 (origClientOrderId)', () => {
      const c = venue.calls.find((x) => x.method === 'GET' && x.path.includes(BN_ORDER));
      assert(!!c, '조회 호출이 없다');
      eq(c!.params.origClientOrderId, COID);
      eq(c!.params.symbol, SYM);
    });
  }

  // ── 거래소가 접수만 했다 ──
  {
    const { verdict } = await restartAndResolve(
      { kind: 'FOUND', status: 'NEW' }, { elapsedMs: 60_000 });

    test('★★ 접수 상태는 접수로 확정한다 — 체결로 올리지 않는다', () => {
      eq(verdict.resolved, true);
      assert(verdict.state !== 'FILLED', `접수인데 ${verdict.state}다`);
    });
  }

  // ── 조회 자체가 실패했다 ──
  {
    const { verdict, venue, threw, look } = await restartAndResolve(
      { kind: 'DOWN' }, { elapsedMs: 60_000 });

    test('★★★ 거래소 5xx는 found:false로 접히지 않고 던진다 (fail-closed)', () => {
      assert(threw != null, '5xx를 삼켰다 — 장애가 "주문 없음"이 된다');
      eq(look.found, false);
      assert(/-1001|Internal error/.test(threw!), `예상 밖 오류: ${threw}`);
    });

    test('★★★ 조회 실패를 "주문 없음"으로 읽지 않는다', () => {
      eq(verdict.resolved, false);
      eq(verdict.state, 'UNKNOWN');
      eq(verdict.action, 'RETRY_QUERY');
    });

    test('★★★ 조회 실패 상태에서 주문을 다시 보내지 않는다', () => {
      eq(venue.orderSends().length, 0);
    });
  }

  // ── 조회는 됐는데 주문이 안 보인다 ──
  {
    const { verdict } = await restartAndResolve(
      { kind: 'NOT_FOUND' }, { elapsedMs: REFLECT_GRACE_MS - 1 });

    test('★★★ 유예 안의 "안 보임"은 실패로 확정하지 않는다', () => {
      eq(verdict.resolved, false,
        `유예(${REFLECT_GRACE_MS}ms) 안인데 확정했다: ${verdict.reason}`);
      assert(verdict.action !== 'NONE', `더 할 일 없음으로 끝냈다: ${verdict.action}`);
    });
  }

  {
    const { verdict } = await restartAndResolve(
      { kind: 'NOT_FOUND' }, { elapsedMs: 60_000, qtyBefore: 0, qtyNow: null });

    test('★★★ 포지션도 못 읽었으면 자동으로 확정하지 않는다', () => {
      eq(verdict.resolved, false, `증거가 없는데 확정했다: ${verdict.reason}`);
    });
  }

  {
    const { verdict } = await restartAndResolve(
      { kind: 'NOT_FOUND' }, { elapsedMs: 60_000, qtyBefore: 0, qtyNow: 0.01 });

    test('★★ 주문은 안 보이는데 포지션이 늘었으면 들어간 것으로 읽는다', () => {
      // "안 보인다 → 실패 → 재시도"가 중복의 주 경로다. 포지션이 증거다.
      assert(verdict.state !== 'FAILED',
        `포지션이 늘었는데 실패로 적었다: ${verdict.state} — ${verdict.reason}`);
    });
  }

  // ── 멱등 키가 없다 ──
  {
    const { verdict } = await restartAndResolve(
      { kind: 'NOT_FOUND' }, { elapsedMs: 60_000, clientOrderId: null });

    test('★★★ 멱등 키가 없으면 절대 자동 확정하지 않는다', () => {
      eq(verdict.resolved, false);
      assert(verdict.action === 'ESCALATE' || verdict.action === 'RETRY_QUERY',
        `자동으로 끝냈다: ${verdict.action}`);
    });
  }

  // ── 모르는 상태 문자열 ──
  {
    const { verdict } = await restartAndResolve(
      { kind: 'WEIRD', status: 'SOMETHING_NEW' }, { elapsedMs: 60_000 });

    test('★★★ 해석할 수 없는 상태를 임의로 매핑하지 않는다', () => {
      eq(verdict.resolved, false);
      eq(verdict.action, 'ESCALATE');
    });
  }
}
