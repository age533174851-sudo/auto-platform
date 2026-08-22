// src/lib/markets/venueBars.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **아직 안 끝난 봉을 종가로 읽는 것.**
//
// 거래소 klines의 마지막 원소는 진행 중인 봉이다. 그걸 그대로 쓰면
// '마지막 종가'가 종가가 아니라 지금 가격이고, 그래서:
//
//   · 돌파가 생겼다 사라진다 (같은 봉 안에서 판정이 계속 바뀐다)
//   · 사다리 전략이 그 값으로 손절가를 만든다
//   · 백테스트와 실거래가 서로 다른 숫자를 본다
//
// 그리고 **간격을 모르면 자르지 않는다.** 추측해서 자르면 멀쩡한 봉을
// 하나 잃고, 그건 지표를 한 칸씩 밀어 놓는다 — 조용히 틀리는 쪽이다.

import { test, eq, assert } from '../../test/harness';
import { intervalMs, dropIncompleteBar, barsRequestPlan } from './venueBars';

const H = 3_600_000;
const D = 86_400_000;

export function runVenueBarsTests() {
  console.log('[봉 간격]');

  test('분·시간·일·주를 읽는다', () => {
    eq(intervalMs('1m'), 60_000);
    eq(intervalMs('15m'), 900_000);
    eq(intervalMs('1h'), H);
    eq(intervalMs('4h'), 4 * H);
    eq(intervalMs('1d'), D);
    eq(intervalMs('1w'), 7 * D);
  });

  // **모르는 간격을 지어내지 않는다.** 가까운 값으로 대신 읽으면
  // 다른 시간축의 봉을 자르게 된다.
  test('모르는 간격은 null이다', () => {
    for (const v of ['', '1x', 'abc', '0m', '-1h', null, undefined, '3mo']) {
      eq(intervalMs(v as string), null, `${String(v)}가 값으로 읽혔다`);
    }
  });

  console.log('[미완성 봉을 잘라 낸다]');

  const bar = (openTime: number) => ({ openTime });

  test('진행 중인 마지막 봉을 버린다', () => {
    // 마지막 봉이 1시간 전에 열렸고 지금은 30분밖에 안 지났다
    const now = 10 * H;
    const rows = [bar(7 * H), bar(8 * H), bar(9 * H + 1800_000)];
    const r = dropIncompleteBar(rows, '1h', now);
    eq(r.dropped, true);
    eq(r.rows.length, 2);
  });

  test('다 끝난 봉은 그대로 둔다', () => {
    // 마지막 봉이 9시에 열렸고 지금은 10시 — 정확히 닫혔다
    const rows = [bar(8 * H), bar(9 * H)];
    const r = dropIncompleteBar(rows, '1h', 10 * H);
    eq(r.dropped, false);
    eq(r.rows.length, 2);
  });

  // 경계에서 한 칸 더 자르면 **멀쩡한 마지막 종가를 버린다.**
  // 그건 전략을 한 봉 늦게 만든다.
  test('경계에 정확히 걸린 봉은 방금 닫힌 것이다 — 자르지 않는다', () => {
    eq(dropIncompleteBar([bar(0)], '1d', D).dropped, false);
    eq(dropIncompleteBar([bar(0)], '1d', D - 1).dropped, true);
  });

  test('간격을 모르면 자르지 않는다 — 추측해서 봉을 잃지 않는다', () => {
    const rows = [bar(0), bar(H)];
    const r = dropIncompleteBar(rows, '???', 999 * H);
    eq(r.dropped, false);
    eq(r.rows.length, 2);
  });

  test('빈 배열·잘못된 시각에도 터지지 않는다', () => {
    eq(dropIncompleteBar([], '1h', 0).rows.length, 0);
    eq(dropIncompleteBar(null as any, '1h', 0).rows.length, 0);
    eq(dropIncompleteBar([{ openTime: NaN }], '1h', 0).dropped, false);
  });

  // 일봉에서 이게 특히 중요하다. 사다리 전략은 마지막 종가로 손절가를
  // 만드는데, 그 값이 '오늘 지금 가격'이면 손절가가 하루 종일 움직인다.
  test('일봉: 오늘 봉을 버리고 어제 종가를 마지막으로 쓴다', () => {
    const today = 100 * D;
    const rows = [bar(98 * D), bar(99 * D), bar(today)];
    const r = dropIncompleteBar(rows, '1d', today + 3 * H);   // 오늘 오전 3시
    eq(r.dropped, true);
    eq(r.rows[r.rows.length - 1].openTime, 99 * D, '어제 봉이 마지막이어야 한다');
  });

  test('한 개짜리 배열도 진행 중이면 비운다 — 없는 것을 만들어 주지 않는다', () => {
    const r = dropIncompleteBar([bar(0)], '1h', 1800_000);
    eq(r.dropped, true);
    eq(r.rows.length, 0);
  });

  // ── 진행 중인 봉을 남겨야 하는 자리 ──
  //
  // 기본은 자른다. 신호 판정에서 미완성 봉을 쓰면 '마지막 종가'가 종가가
  // 아니라 지금 가격이라, 돌파가 생겼다 사라지고 같은 봉 안에서 판정이
  // 계속 바뀐다.
  //
  // **그런데 최고 도달가(high-water)는 다르다.** 지금 봉에서 찍은 고가도
  // 실제로 도달한 가격이고, 버리면 트레일링이 최대 한 봉만큼 늦어진다 —
  // 15분봉이면 15분이다. 그 사이에 되돌아오면 이익을 그냥 반납한다.
  console.log('[봉 요청 계획 — 자를 것인가, 몇 개를 받을 것인가]');

  test('기본은 자른다', () => {
    const p = barsRequestPlan({ limit: 100 });
    eq(p.dropIncomplete, true);
    eq(p.want, 101, '자를 건데 하나를 더 안 받으면 지표 길이가 모자란다');
  });

  test('켜면 안 자르고, 하나를 더 받지도 않는다', () => {
    const p = barsRequestPlan({ limit: 100, includeIncomplete: true });
    eq(p.dropIncomplete, false);
    eq(p.want, 100);
  });

  test('거래소 상한(1000)을 넘기지 않는다', () => {
    eq(barsRequestPlan({ limit: 1000 }).want, 1000);
    eq(barsRequestPlan({ limit: 5000, includeIncomplete: true }).want, 1000);
  });

  test('0이나 이상한 값을 받아도 최소 1개는 받는다', () => {
    eq(barsRequestPlan({ limit: 0, includeIncomplete: true }).want, 1);
    eq(barsRequestPlan({ limit: NaN as any, includeIncomplete: true }).want, 1);
    eq(barsRequestPlan({ limit: -5, includeIncomplete: true }).want, 1);
  });

  test('켜는 것은 명시적일 때만이다 — undefined는 자른다', () => {
    // 기본값이 뒤집히면 모든 신호 경로가 조용히 흔들린다.
    eq(barsRequestPlan({ limit: 10, includeIncomplete: undefined }).dropIncomplete, true);
    eq(barsRequestPlan({ limit: 10, includeIncomplete: false }).dropIncomplete, true);
  });
}
