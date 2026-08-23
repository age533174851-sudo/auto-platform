// src/lib/portfolio/tradeStats.test.ts
//
// **틀리는 방향이 정해져 있는 값 둘.**
//
//   체결 수  → 못 읽으면 0건으로 보인다 → "오늘 한 번도 안 했다"
//   승률     → 표본이 0인데 0%로 보인다 → "전부 졌다"
//
// 둘 다 사실이 아니고, 둘 다 사용자가 다음에 할 행동을 바꾼다.
// 그리고 홈에서 **큰 글씨로** 나온다.
import { test, eq, assert } from '../../test/harness';
import { tradeStatsOf } from './tradeStats';

const R = (kind: string, amount?: number) => ({ kind, amount });

export function runTradeStatsTests() {
  console.log('[오늘 체결·승률 — 못 읽은 것을 0으로 적지 않는다]');

  test('장부를 못 읽으면 0건이 아니다', () => {
    const s = tradeStatsOf({ rows: null, ledgerComplete: true });
    eq(s.fills.known, false, '못 읽었는데 0건이라고 적었다');
    eq(s.fills.value, null);
    eq(s.winRate.known, false);
    assert((s.fills.note || '').includes('읽지 못했습니다'), s.fills.note || '');
  });

  test('읽었는데 없는 것은 0건이 맞다', () => {
    // 못 읽은 것과 없는 것은 다르다.
    const s = tradeStatsOf({ rows: [], ledgerComplete: true });
    eq(s.fills.known, true);
    eq(s.fills.value, 0);
  });

  test('체결만 센다 — 수수료·펀딩은 거래가 아니다', () => {
    const s = tradeStatsOf({
      rows: [R('FILL'), R('FEE', -1), R('FILL'), R('FUNDING', -0.5), R('ORDER_ACK')],
      ledgerComplete: true,
    });
    eq(s.fills.value, 2);
  });

  console.log('[승률 — 표본이 없으면 0%가 아니다]');

  test('닫힌 거래가 없으면 승률이 0%가 아니다', () => {
    // 0%는 '전부 졌다'는 뜻이다.
    const s = tradeStatsOf({ rows: [R('FILL')], ledgerComplete: true });
    eq(s.winRate.known, false, '표본이 없는데 승률을 적었다');
    eq(s.winRate.value, null);
    eq(s.closed.value, 0, '닫힌 거래 수는 0이 맞다');
    assert((s.winRate.note || '').includes('아직 닫힌 거래가 없습니다'), s.winRate.note || '');
  });

  test('이긴 것과 진 것을 센다', () => {
    const s = tradeStatsOf({
      rows: [R('REALIZED_PNL', 10), R('REALIZED_PNL', -5), R('REALIZED_PNL', 3), R('REALIZED_PNL', -1)],
      ledgerComplete: true,
    });
    eq(s.closed.value, 4);
    eq(s.winRate.value, 0.5);
  });

  test('0원으로 끝난 거래는 이긴 것이 아니다', () => {
    const s = tradeStatsOf({ rows: [R('REALIZED_PNL', 0), R('REALIZED_PNL', 10)], ledgerComplete: true });
    eq(s.closed.value, 2);
    eq(s.winRate.value, 0.5);
  });

  test('금액을 못 읽은 거래는 분모에도 안 넣는다', () => {
    // 0으로 읽으면 그 거래가 '무승부'가 되고 분모만 늘어난다.
    const s = tradeStatsOf({
      rows: [R('REALIZED_PNL', 10), { kind: 'REALIZED_PNL', amount: 'abc' } as any],
      ledgerComplete: true,
    });
    eq(s.closed.value, 1);
    eq(s.winRate.value, 1);
  });

  // ── 장부가 완전하지 않으면 승률을 내지 않는다 ──
  //
  // 실현손익 기록이 일부만 들어와 있으면 이긴 것만 들어왔는지 진 것만
  // 들어왔는지 알 수 없다. 그 상태의 승률은 **틀린 숫자가 아니라
  // 의미 없는 숫자다.**
  test('장부가 불완전하면 승률을 내지 않는다', () => {
    const s = tradeStatsOf({
      rows: [R('REALIZED_PNL', 10), R('REALIZED_PNL', 5)],
      ledgerComplete: false, reason: '수수료를 못 읽었습니다',
    });
    eq(s.winRate.known, false, '불완전한 장부로 승률 100%를 적었다');
    eq(s.winRate.note, '수수료를 못 읽었습니다', '지갑 계층이 적어 둔 이유를 안 썼다');
    eq(s.closed.known, false);
  });

  test('완전한지 모를 때도 승률을 내지 않는다', () => {
    eq(tradeStatsOf({ rows: [R('REALIZED_PNL', 10)], ledgerComplete: null }).winRate.known, false);
    eq(tradeStatsOf({ rows: [R('REALIZED_PNL', 10)], ledgerComplete: undefined }).winRate.known, false);
  });

  test('장부가 불완전해도 센 체결 수는 준다', () => {
    // 센 만큼은 사실이다. 다만 그것이 전부라고 말하지는 않는다.
    const s = tradeStatsOf({ rows: [R('FILL'), R('FILL')], ledgerComplete: false, reason: 'x' });
    eq(s.fills.known, true);
    eq(s.fills.value, 2);
  });

  test('승률은 0~1이다', () => {
    const all = tradeStatsOf({ rows: [R('REALIZED_PNL', 1)], ledgerComplete: true });
    eq(all.winRate.value, 1);
    const none = tradeStatsOf({ rows: [R('REALIZED_PNL', -1)], ledgerComplete: true });
    eq(none.winRate.value, 0, '전부 졌으면 0이 맞다 — 표본이 없는 것과 다르다');
    eq(none.winRate.known, true);
  });
}
