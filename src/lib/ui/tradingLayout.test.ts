// src/lib/ui/tradingLayout.test.ts
//
// 이 테스트가 막는 것: **주문판과 중앙 차트가 조용히 눌리는 것.**
//
// 예전 배치는 퍼센트였다. 그래서 폭이 줄면 아무 경고 없이 주문판이
// 226px가 됐고, 그 안에서 라벨과 값이 겹쳤다. 겹침은 화면을 열어야
// 보이지만, 폭이 하한 아래로 내려간 것은 여기서 잡을 수 있다.

import { test, assert, eq } from '../../test/harness';
import {
  planTradingLayout, shouldCollapseNewsRail,
  ORDER_MIN, MARKET_MIN, SPLITTER, DESKTOP_MIN, TABLET_MIN,
} from './tradingLayout';
import { CENTER_MIN, SIDEBAR_COMPACT } from './panelPrefs';

/** 이 배치가 실제로 폭 안에 들어가는가 */
const fits = (w: number) => {
  const l = planTradingLayout(w);
  if (l.kind !== 'desktop') return true;
  const used = l.market.width + (l.market.width > 0 ? SPLITTER : 0)
             + l.center + SPLITTER + l.order.width;
  return used <= w;
};

export function runTradingLayoutTests() {
  console.log('[거래화면 배치 — 중앙과 주문을 픽셀로 지킨다]');

  // ── 하한 ───────────────────────────────────────────────────
  test('데스크톱에서는 주문판이 하한 아래로 내려가지 않는다', () => {
    // 실측 고장: 1664에서 301px, 1440에서 240px, 1366에서 226px였다.
    for (const w of [DESKTOP_MIN, 900, 1024, 1124, 1200, 1380, 1440, 1664, 1920, 2560]) {
      const l = planTradingLayout(w);
      if (l.kind !== 'desktop') continue;
      assert(l.order.width >= ORDER_MIN,
        `폭 ${w}: 주문판이 ${l.order.width}px (하한 ${ORDER_MIN})`);
    }
  });

  test('데스크톱에서는 중앙이 하한 아래로 내려가지 않는다', () => {
    for (const w of [DESKTOP_MIN, 900, 1024, 1124, 1200, 1380, 1440, 1664, 1920, 2560]) {
      const l = planTradingLayout(w);
      if (l.kind !== 'desktop') continue;
      assert(l.center >= CENTER_MIN, `폭 ${w}: 중앙이 ${l.center}px (하한 ${CENTER_MIN})`);
    }
  });

  test('배치가 실제로 주어진 폭 안에 들어간다', () => {
    // 합이 폭을 넘으면 화면에서는 가로 스크롤이나 겹침으로 나타난다.
    for (let w = 600; w <= 2600; w += 17) {
      assert(fits(w), `폭 ${w}에서 배치 합이 폭을 넘는다: ${JSON.stringify(planTradingLayout(w))}`);
    }
  });

  // ── 물러나는 순서 ──────────────────────────────────────────
  test('넓으면 종목을 펼친다', () => {
    const l = planTradingLayout(1600);
    eq(l.kind, 'desktop');
    eq(l.market.mode, 'expanded');
    assert(l.market.width >= MARKET_MIN, '펼친 종목이 최소폭보다 좁다');
  });

  test('폭이 줄면 종목이 먼저 물러난다 — 중앙·주문이 아니라', () => {
    // 우선순위: 중앙 > 주문 > 종목 > 시세·뉴스
    const wide = planTradingLayout(1600);
    const mid  = planTradingLayout(1000);
    eq(wide.market.mode, 'expanded');
    assert(mid.market.mode !== 'expanded', '좁아졌는데 종목이 그대로 펼쳐져 있다');
    assert(mid.order.width >= ORDER_MIN || mid.kind !== 'desktop', '종목보다 주문이 먼저 줄었다');
  });

  test('종목 접기는 UI-1의 검증된 폭을 그대로 쓴다', () => {
    // 같은 숫자를 두 곳에 적으면 한쪽만 바뀐다.
    const l = planTradingLayout(DESKTOP_MIN);
    eq(l.market.mode, 'compact');
    eq(l.market.width, SIDEBAR_COMPACT);
  });

  test('데스크톱 하한 바로 아래면 태블릿 배치로 간다 — 눌러 담지 않는다', () => {
    const l = planTradingLayout(DESKTOP_MIN - 1);
    assert(l.kind !== 'desktop', `${DESKTOP_MIN - 1}px에서 아직 데스크톱이다`);
    eq(l.order.mode, 'sheet');
  });

  test('태블릿·모바일에서는 주문이 시트다 — PC 주문창을 줄이지 않는다', () => {
    for (const w of [TABLET_MIN, 700, 770, 560, 430, 390, 360]) {
      const l = planTradingLayout(w);
      assert(l.kind !== 'desktop', `${w}px에서 데스크톱 3열을 유지한다`);
      eq(l.order.mode, 'sheet');
      eq(l.market.mode, 'drawer');
    }
  });

  test('태블릿과 모바일을 구분한다', () => {
    eq(planTradingLayout(TABLET_MIN).kind, 'tablet');
    eq(planTradingLayout(TABLET_MIN - 1).kind, 'mobile');
  });

  test('중앙은 태블릿·모바일에서 폭을 전부 갖는다', () => {
    eq(planTradingLayout(770).center, 770);
    eq(planTradingLayout(390).center, 390);
  });

  // ── 모르는 값 ──────────────────────────────────────────────
  test('폭을 모르면 3열을 그리지 않는다', () => {
    // 모르는 채로 PC를 그리면 좁은 화면에서 한 번 깨진 뒤 고쳐진다.
    for (const bad of [0, -100, NaN, undefined, null, '1600']) {
      const l = planTradingLayout(bad as any);
      assert(l.kind !== 'desktop', `${String(bad)}에서 데스크톱을 그린다`);
    }
  });

  test('배치마다 이유가 있다', () => {
    for (const w of [1600, 1000, 900, 770, 390, 0]) {
      assert(planTradingLayout(w).reason.length > 0, `폭 ${w}: 이유가 없다`);
    }
  });

  // ── 뉴스 레일 ──────────────────────────────────────────────
  test('레일을 두고도 3열이 되면 접지 않는다', () => {
    // 2560 - 240 - 300 = 2020 → 충분
    eq(shouldCollapseNewsRail(2560, 240, 300), false);
    eq(shouldCollapseNewsRail(1920, 240, 300), false);
  });

  test('레일 때문에 주문·중앙이 눌리면 레일을 접는다', () => {
    // 실측 고장 지점: 1664 - 240 - 300 = 1124 < DESKTOP_MIN(969+)
    // 1124는 넉넉하지만 1366·1440에서 무너졌다.
    eq(shouldCollapseNewsRail(1366, 240, 300), true);
    eq(shouldCollapseNewsRail(1440, 240, 300), true);
  });

  test('레일이 없거나 폭을 모르면 접지 않는다', () => {
    eq(shouldCollapseNewsRail(1366, 240, 0), false);
    eq(shouldCollapseNewsRail(0, 240, 300), false);
    eq(shouldCollapseNewsRail(NaN, 240, 300), false);
    eq(shouldCollapseNewsRail(1366, 240, undefined as any), false);
  });

  test('레일을 접은 뒤의 폭으로 배치를 다시 계산하면 하한을 지킨다', () => {
    for (const v of [1366, 1440, 1664, 1920]) {
      const collapse = shouldCollapseNewsRail(v, 240, 300);
      const avail = v - 240 - (collapse ? 48 : 300);   // 48 = UI-1의 접힌 레일 폭
      const l = planTradingLayout(avail);
      if (l.kind === 'desktop') {
        assert(l.order.width >= ORDER_MIN, `${v}: 주문 ${l.order.width}`);
        assert(l.center >= CENTER_MIN, `${v}: 중앙 ${l.center}`);
      }
    }
  });
}
