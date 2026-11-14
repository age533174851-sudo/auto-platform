// src/lib/exchanges/binanceTpSlFallback.test.ts
//
// **대체 시도를 못 했을 때, 판단까지 같이 사라졌다.**
//
// 2026-11-14 스모크에서 사용자가 본 문장은 이것이었다:
//
//   진입 실패: 손절 부착 실패([-4120] Order type not supported for this
//   endpoint. Please use the Algo Order API endpoints instead.)
//
// 영어 원문뿐이다. 그래서 사용자는 API 키 권한과 IP 설정을 뒤졌다.
// 둘 다 원인이 아니었다.
//
// 바로 윗줄 코드는 이 상황을 **판단할 줄 안다** — `closePosition`과
// `수량` 두 모양을 바꿔 시도하고, 둘 다 -4120이면 "이 환경이 그 주문
// 유형을 받지 않습니다. 키·권한·수량 문제가 아닙니다"라고 적는다.
//
// 그 길로 못 간 이유는 **수량을 몰라 대체 시도를 건너뛰었기** 때문이다.
// 건너뛴 순간 원문만 남았다. 못 한 것을 적지 않으면, 사람은 안 해도 될
// 곳을 뒤진다.
//
// 그렇다고 한 모양만 보고 "환경이 안 받는다"로 단정하지도 않는다 —
// 그건 아직 모르는 일이다. **시도한 것과 못 한 것을 그대로 적는다.**
import { test, assert, eq } from '../../test/harness';
import { netTest, withFetch } from '../../test/netStub';
import { tpslFailureVerdict, placeFuturesTPSL } from './binanceFutures';

const E4120 = '[-4120] Order type not supported for this endpoint. '
  + 'Please use the Algo Order API endpoints instead.';

export function runBinanceTpSlFallbackTests() {
  console.log('[바이낸스 보호주문 — 대체 시도를 못 했으면 그렇게 적는다]');

  test('★★ 대체를 못 했으면 그 이유가 남는다 — 원문만 던지지 않는다', () => {
    const v = tpslFailureVerdict({
      label: '손절', type: 'STOP_MARKET', testnet: true,
      firstError: E4120, secondError: null,
      retrySkippedReason: '수량을 몰라',
    });
    assert(/-4120/.test(v.message), `원문이 사라졌다: ${v.message}`);
    assert(/수량/.test(v.message), `못 한 이유가 없다: ${v.message}`);
    eq(v.envUnsupported, false, '한 모양만 보고 환경 탓으로 단정했다');
  });

  test('★★ 두 모양 다 막혔을 때만 환경 탓이라고 적는다', () => {
    const v = tpslFailureVerdict({
      label: '손절', type: 'STOP_MARKET', testnet: true,
      firstError: E4120, secondError: E4120, retrySkippedReason: null,
    });
    eq(v.envUnsupported, true);
    assert(/받지 않습니다/.test(v.message), v.message);
    assert(/키·권한·수량 문제가 아닙니다/.test(v.message), v.message);
  });

  test('★ 둘 다 시도했는데 다른 이유로 막히면 환경 탓을 하지 않는다', () => {
    const v = tpslFailureVerdict({
      label: '익절', type: 'TAKE_PROFIT_MARKET', testnet: true,
      firstError: E4120, secondError: '[-2019] Margin is insufficient.',
      retrySkippedReason: null,
    });
    eq(v.envUnsupported, false);
    assert(/-2019/.test(v.message), v.message);
  });

  test('★ -4120이 아닌 실패는 원문 그대로 — 없는 설명을 붙이지 않는다', () => {
    const v = tpslFailureVerdict({
      label: '손절', type: 'STOP_MARKET', testnet: true,
      firstError: '[-2019] Margin is insufficient.', secondError: null,
      retrySkippedReason: '수량을 몰라',
    });
    eq(v.envUnsupported, false);
    assert(/-2019/.test(v.message), v.message);
    assert(!/대체/.test(v.message), `관계없는 설명을 붙였다: ${v.message}`);
  });

  test('★ 왜 못 했는지도 모르면 지어내지 않는다 — 원문만 남긴다', () => {
    // -4120이지만 '대체를 못 한 이유'가 없는 경우. 이유 칸을 빈 채로
    // 문장을 만들면 "대체 방식은 null 시도하지 못했습니다"가 된다.
    // 모르는 것은 적지 않는다.
    const v = tpslFailureVerdict({
      label: '손절', type: 'STOP_MARKET', testnet: true,
      firstError: E4120, secondError: null, retrySkippedReason: null,
    });
    eq(v.envUnsupported, false);
    assert(/-4120/.test(v.message), v.message);
    assert(!/시도하지 못했습니다/.test(v.message), `없는 이유를 지어냈다: ${v.message}`);
  });

  test('실계좌면 환경 이름을 데모라고 적지 않는다', () => {
    const v = tpslFailureVerdict({
      label: '손절', type: 'STOP_MARKET', testnet: false,
      firstError: E4120, secondError: E4120, retrySkippedReason: null,
    });
    assert(!/데모/.test(v.message), v.message);
  });

  // ── 판정기만 맞고 배선이 틀린 경우 ──
  //
  // 위 시험들은 `tpslFailureVerdict`가 옳은 문장을 만드는지 본다. 그런데
  // `placeFuturesTPSL`이 그 함수를 **안 부르거나**, 부르면서 '못 한 이유'를
  // 빼고 넘기면 위 시험들은 전부 초록인 채로 사용자는 다시 영어 원문을
  // 본다. 이 저장소에서 반복된 고장이 정확히 그것이다 —
  // 만들어 놓고 배선을 안 함.
  //
  // 그래서 여기서는 **실제로 함수를 부른다.** 거래소로는 나가지 않는다.
  const DEMO = 'demo-fapi.binance.com';
  const M4120 = 'Order type not supported for this endpoint. '
    + 'Please use the Algo Order API endpoints instead.';

  /** demo-fapi로 가는 것만 답한다. 모르는 주소는 원래 fetch로 넘어간다. */
  const demo = (url: string) => {
    if (!url.includes(DEMO)) return null;
    if (url.includes('/fapi/v1/time')) return { body: { serverTime: Date.now() } };
    if (url.includes('/fapi/v1/order')) return { status: 400, body: { code: -4120, msg: M4120 } };
    return { body: {} };
  };

  netTest('★★ 배선 — 수량을 모르면 한 번만 시도하고, 그 사실이 사유에 남는다', async () => {
    let r: any = null;
    const urls = await withFetch(demo, async () => {
      r = await placeFuturesTPSL('k', 's', {
        symbol: 'BTCUSDT', side: 'SELL', stopPrice: 100, type: 'STOP_MARKET',
      }, true);
    });
    const orders = urls.filter(u => u.includes('/fapi/v1/order'));
    eq(orders.length, 1, `대체를 못 하는데 두 번 나갔다: ${orders.length}`);
    eq(r.success, false);
    assert(/-4120/.test(r.message), `원문이 사라졌다: ${r.message}`);
    assert(/수량/.test(r.message), `못 한 이유가 사유에 없다: ${r.message}`);
    eq(r.envUnsupported, false, '한 모양만 보고 환경 탓으로 단정했다');
    // 한 번만 나갔는데 "둘 다 해 봤다"고 적으면 그건 거짓말이다.
    // 가드를 빼면 2차 시도가 fetch 전에 스스로 던지므로 주문 수는 그대로
    // 1인데 문장만 "두 가지 방식을 다 시도했습니다"로 바뀐다.
    assert(!/두 가지 방식을 다 시도/.test(r.message),
      `하지 않은 일을 했다고 적었다: ${r.message}`);
  });

  netTest('★★ 배선 — 수량을 알면 두 모양을 다 시도하고 환경 탓이라고 적는다', async () => {
    let r: any = null;
    const urls = await withFetch(demo, async () => {
      r = await placeFuturesTPSL('k', 's', {
        symbol: 'BTCUSDT', side: 'SELL', stopPrice: 100, type: 'STOP_MARKET',
        fallbackQuantity: 0.5,
      }, true);
    });
    const orders = urls.filter(u => u.includes('/fapi/v1/order'));
    eq(orders.length, 2, `대체를 시도하지 않았다: ${orders.length}`);
    eq(r.success, false);
    eq(r.envUnsupported, true);
    assert(/받지 않습니다/.test(r.message), r.message);
  });
}
