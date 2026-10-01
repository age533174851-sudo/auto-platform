// src/lib/exchanges/bracketCache.test.ts
//
// **브래킷은 계정별 값이고, 캐시는 그 사실을 알아야 한다.**
//
// `/fapi/v1/leverageBracket`은 USER_DATA다. 응답의 `notionalCoef`는 계정별
// 조정 배수이고, 조정이 걸린 계정과 안 걸린 계정은 **같은 심볼에서도 다른
// 구간**을 받는다.
//
// 그래서 캐시 키가 `테스트넷여부 + 심볼`뿐이면, 계정 A가 먼저 BTCUSDT를
// 읽은 뒤 계정 B가 같은 심볼을 물으면 **A의 브래킷을 받는다.** 100배
// 청산거리 입력에서 그건 허용할 수 없다.
//
// 그리고 TTL이 지난 뒤 다시 읽기에 실패하면 옛 값을 조용히 돌려주고
// 있었다 — 6시간이 아니라 **사실상 무기한** 낡은 구간이다.
import { test, eq, assert } from '../../test/harness';
import { readBracket, readPremiumIndex } from './binanceFutures';

/** 주입할 가짜 조회기. 전역 `fetch`를 건드리지 않는다 */
const tiersFor = (coef: number | null) => {
  const t: Array<[number, number, number, number?]> = [
    [50_000, 0.004, 0, coef ?? undefined],
    [500_000, 0.005, 50, coef ?? undefined],
  ];
  return t;
};
const feeder = (get: () => number | null, fails: () => boolean = () => false) =>
  async (_k: string, _s: string, _tn: boolean, sym: string) => {
    if (fails()) return { brackets: {}, message: '조회 실패' };
    return { brackets: { [sym]: tiersFor(get()) } };
  };

export function runBracketCacheTests() {
  console.log('\n🔐 leverageBracket 캐시 — 계정별이고, 낡으면 낡았다고 말한다');

  test('계정이 다르면 캐시를 나눠 쓰지 않는다', async () => {
    // A는 조정 없음, B는 조정 1.5. 같은 심볼·같은 망이다.
    let who = 'A';
    const feed = feeder(() => (who === 'A' ? null : 1.5));

    const a = await readBracket('BTCUSDT', 'KEY-A', 'SEC-A', true, feed);
    eq(a.freshness, 'FRESH');
    eq(a.tiers![0][3], undefined, 'A는 조정이 없어야 한다');

    who = 'B';
    const b = await readBracket('BTCUSDT', 'KEY-B', 'SEC-B', true, feed);
    eq(b.freshness, 'FRESH');
    eq(b.tiers![0][3], 1.5,
      '★ 계정 B가 계정 A의 캐시된 브래킷을 받았다 — 100배 청산거리 입력이 섞인다');

    // 네트워크가 B를 돌려주더라도 A는 **자기 캐시**에서 와야 한다.
    const a2 = await readBracket('BTCUSDT', 'KEY-A', 'SEC-A', true, feed);
    eq(a2.tiers![0][3], undefined, '★ A의 캐시가 B 값으로 덮였다');
  });

  test('비밀값을 캐시 키에 넣지 않는다 — 지문만 쓴다', async () => {
    let n = 0;
    const feed = feeder(() => { n += 1; return n; });
    const x = await readBracket('ETHUSDT', 'k1', 's1', true, feed);
    const y = await readBracket('ETHUSDT', 'k2', 's2', true, feed);
    assert(x.tiers![0][3] !== y.tiers![0][3], '★ 다른 키인데 같은 캐시를 썼다');
  });

  test('같은 망·다른 계정이어도 심볼이 같으면 섞이지 않는다 (테스트넷/실계좌도 분리)', async () => {
    const feed = feeder(() => 2.5);
    const t = await readBracket('ADAUSDT', 'KEY-E', 'SEC-E', true, feed);
    const l = await readBracket('ADAUSDT', 'KEY-E', 'SEC-E', false, feeder(() => 3.5));
    eq(t.tiers![0][3], 2.5);
    eq(l.tiers![0][3], 3.5, '★ 테스트넷 캐시가 실계좌로 샜다');
  });

  test('TTL이 지난 뒤 다시 읽기에 실패하면 FRESH라고 하지 않는다', async () => {
    // **전역 `Date.now`를 바꾸지 않는다** — 비동기 시험이 겹치면 그 패치가
    // 다른 시험으로 샌다(실제로 샜다). 시각도 주입한다.
    let broken = false;
    const feed = feeder(() => null, () => broken);
    const T0 = 1_000_000_000_000;
    const first = await readBracket('SOLUSDT', 'KEY-C', 'SEC-C', true, feed, () => T0);
    eq(first.freshness, 'FRESH');
    eq(first.observedAtMs, T0);

    broken = true;
    const T1 = T0 + 6 * 60 * 60 * 1000 + 60_000;   // 6시간 + 1분 뒤
    const second = await readBracket('SOLUSDT', 'KEY-C', 'SEC-C', true, feed, () => T1);
    eq(second.freshness, 'STALE_CACHE',
      '★ 만료된 캐시를 FRESH로 돌려준다 — 사실상 무기한 낡은 구간을 쓰게 된다');
    // 값은 남기되 **언제 읽은 것인지**를 그대로 들고 간다.
    eq(second.observedAtMs, T0, '★ 낡은 값에 새 시각을 붙였다');
    assert(second.error != null, '왜 다시 못 읽었는지 적어야 한다');
  });

  test('캐시가 아예 없고 조회도 실패하면 NONE이다', async () => {
    const r = await readBracket('XRPUSDT', 'KEY-D', 'SEC-D', true, feeder(() => null, () => true));
    eq(r.freshness, 'NONE');
    eq(r.tiers, null);
  });

  test('조회기가 던져도 NONE이지 터지지 않는다', async () => {
    const boom = async () => { throw new Error('network'); };
    const r = await readBracket('DOTUSDT', 'KEY-F', 'SEC-F', true, boom as any);
    eq(r.freshness, 'NONE');
    assert(r.error != null);
  });

  // ── premiumIndex의 **관측 시각** (BLOCKER 6) ──
  //
  // 45초 TTL이 지난 뒤 조회에 실패하면 캐시의 옛 값이 남는데, 부르는 쪽이
  // 거기에 `observedAtMs: Date.now()`를 새로 붙이고 있었다. 그러면 며칠 된
  // 캐시도 "방금 읽은 데이터"로 보인다 — ④(신선도 보호)가 설 기반이
  // 통째로 오염된다.

  const PREM = {
    symbol: 'BTCUSDT', markPrice: 50_000, indexPrice: 50_000,
    lastFundingRate: 0.0001, nextFundingTime: 1_000_000_100_000,
  };

  test('낡은 premium 캐시는 **원래 읽은 시각**을 그대로 들고 간다', async () => {
    let broken = false;
    const fetchOne = async () => {
      if (broken) throw new Error('network');
      return PREM;
    };
    const T0 = 1_000_000_000_000;
    const first = await readPremiumIndex('BTCUSDT', true, fetchOne, () => T0);
    eq(first.freshness, 'FRESH');
    eq(first.observedAtMs, T0);

    broken = true;
    const T1 = T0 + 10 * 24 * 60 * 60 * 1000;   // 열흘 뒤
    const second = await readPremiumIndex('BTCUSDT', true, fetchOne, () => T1);
    eq(second.freshness, 'STALE_CACHE',
      '★ 열흘 된 캐시를 FRESH로 돌려준다');
    eq(second.observedAtMs, T0,
      '★ 낡은 값에 새 시각을 붙였다 — ④가 볼 때 "방금 읽은 데이터"가 된다');
    assert(second.error != null, '왜 다시 못 읽었는지 적어야 한다');
  });

  test('캐시도 없고 조회도 실패하면 NONE이다', async () => {
    const boom = async () => { throw new Error('network'); };
    const r = await readPremiumIndex('LTCUSDT', true, boom, () => 1);
    eq(r.freshness, 'NONE');
    eq(r.data, null);
    eq(r.observedAtMs, null);
  });

  test('TTL 안이면 캐시지만 FRESH이고, 시각은 읽은 그때다', async () => {
    const T0 = 2_000_000_000_000;
    const fetchOne = async () => PREM;
    const a = await readPremiumIndex('BNBUSDT', true, fetchOne, () => T0);
    const b = await readPremiumIndex('BNBUSDT', true, fetchOne, () => T0 + 10_000);
    eq(b.freshness, 'FRESH');
    eq(b.observedAtMs, T0, '★ 캐시 적중인데 시각을 지금으로 바꿨다');
  });
}
