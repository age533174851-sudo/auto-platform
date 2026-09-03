// src/lib/ui/tradingLayout.test.ts
//
// 이 테스트가 막는 것: **주문판과 중앙 차트가 조용히 눌리는 것.**
//
// 예전 배치는 퍼센트였다. 그래서 폭이 줄면 아무 경고 없이 주문판이
// 226px가 됐고, 그 안에서 라벨과 값이 겹쳤다. 겹침은 화면을 열어야
// 보이지만, 폭이 하한 아래로 내려간 것은 여기서 잡을 수 있다.

import { test, assert, eq } from '../../test/harness';
import {
  planTradingLayout, shouldCollapseNewsRail, railPresentationFor,
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

  // ── 뉴스 레일: 네 번째 영역을 칸으로 상주시켜도 되는 폭인가 ──
  //
  // 한동안 이 판단은 "칸으로 두고도 거래 최소폭이 남는가" 하나였다.
  // 1664는 1664-240-300=1124 >= 974라 그 조건을 통과했고, 통과한 결과가
  // 종목 200 · 차트 574 · 주문 340 · 뉴스 300 — 네 칸 전부 하한이었다.
  // **사용자가 처음 결함을 발견한 화면이 바로 1664였다.** 그래서 폭이
  // 정말 남을 때(1920+)만 상주시킨다.
  test('1920 미만에서는 오른쪽 정보 레일을 상주시키지 않는다', () => {
    for (const v of [1024, 1280, 1366, 1440, 1664, 1800, 1919]) {
      eq(shouldCollapseNewsRail(v, 240, 300), true);
      eq(railPresentationFor(v, 240, 300), 'overlay');
    }
  });

  test('1920 이상은 폭이 정말 남을 때 칸으로 상주시킨다', () => {
    eq(shouldCollapseNewsRail(1920, 240, 300), false);
    eq(shouldCollapseNewsRail(2560, 240, 300), false);
    eq(railPresentationFor(1920, 240, 300), 'column');
    eq(railPresentationFor(2560, 240, 300), 'column');
  });

  test('1919와 1920 사이에서만 바뀐다', () => {
    // 경계를 슬쩍 옮기는 변경을 잡기 위해 두 값을 직접 못박는다.
    eq(shouldCollapseNewsRail(1919, 240, 300), true);
    eq(shouldCollapseNewsRail(1920, 240, 300), false);
    eq(railPresentationFor(1919, 240, 300), 'overlay');
    eq(railPresentationFor(1920, 240, 300), 'column');
  });

  test('1920을 넘겨도 거래 최소폭이 안 남으면 상주시키지 않는다', () => {
    // 폭 조건 하나만으로 대체하지 않는다 — 둘 다 만족해야 칸이다.
    // 1920 - 500 - 600 = 820 < DESKTOP_MIN(974)
    eq(shouldCollapseNewsRail(1920, 500, 600), true);
    eq(railPresentationFor(1920, 500, 600), 'overlay');
  });

  test('레일이 없거나 폭을 모르면 접지 않는다', () => {
    eq(shouldCollapseNewsRail(1366, 240, 0), false);
    eq(shouldCollapseNewsRail(0, 240, 300), false);
    eq(shouldCollapseNewsRail(NaN, 240, 300), false);
    eq(shouldCollapseNewsRail(1366, 240, undefined as any), false);
  });

  test('폭을 모르면 덮지 않는다', () => {
    // 덮어 놓고 못 닫는 것이 더 나쁘다.
    eq(railPresentationFor(0, 240, 300), 'column');
    eq(railPresentationFor(NaN, 240, 300), 'column');
    eq(railPresentationFor(1440, 240, 0), 'column');
  });

  test('접는 판단과 여는 방식은 같은 판단이다', () => {
    // 두 곳에 따로 두면 언젠가 한쪽만 바뀐다.
    for (let v = 900; v <= 2600; v += 13) {
      const collapse = shouldCollapseNewsRail(v, 240, 300);
      const pres = railPresentationFor(v, 240, 300);
      eq(collapse, pres === 'overlay');
    }
  });

  test('겹침으로 열면 거래영역 폭이 그대로라 배치가 안 바뀐다', () => {
    // 1664는 사용자가 처음 결함을 발견한 화면이다. 뉴스를 열어도
    // desktop·중앙·주문이 그대로여야 한다.
    for (const v of [1366, 1440, 1664, 1919]) {
      const pres = railPresentationFor(v, 240, 300);
      eq(pres, 'overlay');
      // 겹침이면 칸 폭은 접힌 띠(48)로 유지된다
      const avail = v - 240 - 48;
      const l = planTradingLayout(avail);
      assert(l.kind === 'desktop', `${v}: 레일을 열었더니 ${l.kind}가 됐다`);
      assert(l.order.width >= ORDER_MIN, `${v}: 주문 ${l.order.width}`);
      assert(l.center >= CENTER_MIN, `${v}: 중앙 ${l.center}`);
    }
  });

  test('1664는 뉴스를 접은 폭에서 하한에 붙어 있지 않다', () => {
    // 4열이던 시절의 1664는 차트 574 — 560 하한 바로 위였다.
    const l = planTradingLayout(1664 - 240 - 48);
    eq(l.kind, 'desktop');
    eq(l.market.mode, 'expanded');
    assert(l.center > CENTER_MIN + 40, `중앙이 아직 하한에 붙어 있다: ${l.center}`);
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
