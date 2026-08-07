// src/lib/risk/tradingHistory.test.ts
//
// 막으려는 것:
//  1. **청산을 진입으로 세는 것.** 그러면 손절을 걸 때마다 하루 상한이
//     줄어들고, 정리하려 할수록 못 정리하게 된다
//  2. 못 읽은 이력을 '진입 0회'로 채워, 조회가 흔들릴 때마다 상한이
//     통째로 열리는 것
//  3. 아무도 정하지 않은 규율을 기본값으로 켜서, 어느 날 갑자기
//     "오늘 진입 5/5회를 다 썼습니다"로 막는 것
//  4. 손익을 모르면서 연패 0회로 단정하는 것
import { test, assert, eq } from '../../test/harness';
import {
  historyFromOrders, overtradingPolicyOf, utcDayStart, timeOf,
} from './tradingHistory';
import { overtradingGate } from './conviction';

const DAY = 86_400_000;
/** 2026-08-07 12:00 UTC */
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

const order = (over: any = {}) => ({
  symbol: 'BTCUSDT', side: 'BUY', reduce_only: false, status: 'FILLED',
  created_at: new Date(NOW - 60_000).toISOString(),
  ...over,
});

export function runTradingHistoryTests() {
  console.log('[진입 이력 — 무엇을 세는가]');

  test('오늘 나간 진입만 센다', () => {
    const h = historyFromOrders([
      order(),
      order({ created_at: new Date(NOW - 2 * 60_000).toISOString() }),
      // 어제 것은 안 센다
      order({ created_at: new Date(NOW - DAY).toISOString() }),
    ], { nowMs: NOW });
    eq(h.entriesToday, 2);
  });

  test('청산은 진입이 아니다', () => {
    // 세면 손절을 걸 때마다 상한이 줄어든다 — 정리하려 할수록 못 정리한다.
    const h = historyFromOrders([
      order(), order({ reduce_only: true }), order({ reduce_only: true }),
    ], { nowMs: NOW });
    eq(h.entriesToday, 1);
  });

  test('안 나간 주문과 거부된 주문은 안 센다', () => {
    // 거부는 거래소가 이미 막은 것이다. 여기서 또 세면 두 번 벌한다.
    const h = historyFromOrders([
      order({ status: 'INTENT' }),
      order({ status: 'REJECTED' }),
      order({ status: 'FAILED' }),
      order({ status: 'SENT' }),
    ], { nowMs: NOW });
    eq(h.entriesToday, 1);
  });

  test('결과를 모르는 주문(UNKNOWN)은 센다', () => {
    // 나가긴 나갔다. 안 세면 응답을 못 받을 때마다 상한이 늘어난다.
    eq(historyFromOrders([order({ status: 'UNKNOWN' })], { nowMs: NOW }).entriesToday, 1);
  });

  test('시각을 못 읽은 행은 건너뛴다', () => {
    // 0으로 두면 1970년이 되어 쿨다운이 늘 지나 있다.
    const h = historyFromOrders([
      order({ created_at: null }), order({ created_at: '어제' }), order(),
    ], { nowMs: NOW });
    eq(h.entriesToday, 1);
    eq(timeOf(null), null);
    eq(timeOf('아무거나'), null);
  });

  test('미래 시각은 오늘로 안 센다', () => {
    eq(historyFromOrders([
      order({ created_at: new Date(NOW + 60_000).toISOString() }),
    ], { nowMs: NOW }).entriesToday, 0);
  });

  console.log('[진입 이력 — 종목 쿨다운]');

  test('같은 종목의 마지막 진입 시각을 찾는다', () => {
    const h = historyFromOrders([
      order({ created_at: new Date(NOW - 10 * 60_000).toISOString() }),
      order({ created_at: new Date(NOW - 3 * 60_000).toISOString() }),
      order({ symbol: 'ETHUSDT', created_at: new Date(NOW - 60_000).toISOString() }),
    ], { nowMs: NOW, symbol: 'BTCUSDT' });
    eq(h.lastEntryOnSymbolMs, NOW - 3 * 60_000, '가장 최근 것');
  });

  test('심볼을 안 주면 종목 쿨다운을 재지 않는다', () => {
    eq(historyFromOrders([order()], { nowMs: NOW }).lastEntryOnSymbolMs, null);
  });

  test('대소문자는 가리지 않는다', () => {
    const h = historyFromOrders([order({ symbol: 'btcusdt' })], { nowMs: NOW, symbol: 'BTCUSDT' });
    assert(h.lastEntryOnSymbolMs != null, '같은 종목인데 못 찾았다');
  });

  console.log('[진입 이력 — 모르는 것은 모른다고 한다]');

  test('연패는 여기서 안 만든다', () => {
    // live_orders에는 손익이 없다. 0으로 두면 '연패 없음'이 되는데
    // 그건 확인한 사실이 아니다. 연패는 lossStreakCheck가 본다.
    const h = historyFromOrders([order()], { nowMs: NOW });
    eq(h.consecutiveLosses, null);
    eq(h.lastLossMs, null);
  });

  test('빈 목록에도 터지지 않는다', () => {
    eq(historyFromOrders(null, { nowMs: NOW }).entriesToday, 0);
    eq(historyFromOrders([], { nowMs: NOW }).entriesToday, 0);
  });

  test('하루 경계는 UTC다 — 손실 한도와 같은 기준', () => {
    // 날짜 경계가 둘이면 "오늘 손실 한도는 안 걸렸는데 진입 상한은 걸린"
    // 설명할 수 없는 상태가 생긴다.
    eq(utcDayStart(NOW), Date.UTC(2026, 7, 7));
  });

  console.log('[진입 이력 — 정책은 켜야 돈다]');

  test('아무것도 안 정했으면 정책이 없다', () => {
    // 기본값으로 상한을 넣으면, 아무 설정도 안 한 사용자가 어느 날 갑자기
    // 막힌다. 아직 아무도 정하지 않은 규율은 규율이 아니다.
    eq(overtradingPolicyOf(() => undefined), null);
    eq(overtradingPolicyOf(() => ''), null);
  });

  test('하나만 정해도 켜진다', () => {
    const p = overtradingPolicyOf(k => (k === 'OVERTRADE_MAX_ENTRIES_PER_DAY' ? '5' : undefined));
    assert(p != null, '켜져야 한다');
    eq(p!.maxEntriesPerDay, 5);
    eq(p!.sameSymbolCooldownMin, null, '안 정한 것은 null이다');
  });

  test('0과 음수는 안 정한 것으로 본다', () => {
    // 0을 '상한 0회'로 읽으면 모든 진입이 막힌다.
    eq(overtradingPolicyOf(k => (k === 'OVERTRADE_MAX_ENTRIES_PER_DAY' ? '0' : undefined)), null);
    eq(overtradingPolicyOf(k => (k === 'OVERTRADE_SYMBOL_COOLDOWN_MIN' ? '-5' : undefined)), null);
  });

  test('연패 상한은 여기서 안 읽는다', () => {
    // lossStreakCheck가 이미 본다. 두 곳에서 같은 판정을 하면 언젠가
    // 서로 다른 답을 낸다.
    const p = overtradingPolicyOf(k => (k === 'OVERTRADE_SYMBOL_COOLDOWN_MIN' ? '30' : undefined));
    eq(p!.maxConsecutiveLosses, null);
  });

  console.log('[진입 이력 — 게이트와 맞물린다]');

  test('상한을 다 쓰면 막힌다', () => {
    const hist = historyFromOrders(
      [order(), order(), order()], { nowMs: NOW });
    const v = overtradingGate({ maxEntriesPerDay: 3 }, hist);
    eq(v.allowed, false);
    eq(v.blocked, 'DAILY_CAP');
    assert(v.reason.includes('3/3'), v.reason);
  });

  test('종목 쿨다운이 남아 있으면 막고, 언제 풀리는지 적는다', () => {
    const hist = historyFromOrders(
      [order({ created_at: new Date(NOW - 5 * 60_000).toISOString() })],
      { nowMs: NOW, symbol: 'BTCUSDT' });
    const v = overtradingGate({ sameSymbolCooldownMin: 30 }, hist);
    eq(v.allowed, false);
    eq(v.blocked, 'SYMBOL_COOLDOWN');
    eq(v.retryAtMs, NOW - 5 * 60_000 + 30 * 60_000);
  });

  test('정책이 없으면 아무것도 안 막는다', () => {
    const hist = historyFromOrders([order(), order(), order()], { nowMs: NOW });
    eq(overtradingGate(null, hist).allowed, true);
    eq(overtradingGate({}, hist).allowed, true);
  });
}
