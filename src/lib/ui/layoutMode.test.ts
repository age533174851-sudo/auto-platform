// src/lib/ui/layoutMode.test.ts
//
// 실제로 난 일: 패드에서 왼쪽 전체 메뉴 + 가운데 매매 + 오른쪽
// 실시간시세/뉴스가 동시에 떠서, 가운데 주문판이 눌려 글자와 버튼이
// 겹쳤다. PC 배치를 그대로 줄여 넣은 결과다.
//
// 막으려는 것:
//  1. **뷰포트만 보고 배치를 정하는 것.** 갤럭시탭 분할화면에서
//     innerWidth는 1280인데 앱에 주어진 폭은 700px일 수 있다.
//     그때 DESKTOP 3열을 그리면 전부 깨진다
//  2. 폭이 모자랄 때 글자를 줄여 억지로 넣는 것 — 숫자가 잘리거나
//     버튼이 다른 패널 위로 올라간다. 배치를 바꿔야 한다
//  3. 패드에서 오른쪽 시세·뉴스가 300px를 먹는 것 — 시세를 못 보는
//     것보다 주문판이 눌리는 쪽이 위험하다
//  4. 하단 탭 열세 개를 한 줄에 두는 것
//  5. 지금 열려 있는 탭이 더보기 안으로 숨는 것
import { test, assert, eq } from '../../test/harness';
import {
  layoutModeOf, layoutPlanOf, tabSplitOf, fitsSideBySide,
  BREAKPOINTS, MIN_WIDTH, FLEX_SAFE, type TabItem,
} from './layoutMode';

export function runLayoutModeTests() {
  console.log('[레이아웃 — 뷰포트가 아니라 실제 폭으로 정한다]');

  test('분할화면에서 뷰포트를 믿지 않는다', () => {
    // 갤럭시탭 반반: innerWidth 1280, 실제 앱 폭 700.
    // 뷰포트를 믿으면 DESKTOP 3열이 700px 안에 들어가려다 깨진다.
    eq(layoutModeOf(700, 1280), 'MOBILE');
    eq(layoutModeOf(800, 1280), 'TABLET');
  });

  test('둘 중 작은 쪽을 쓴다', () => {
    eq(layoutModeOf(1600, 800), 'TABLET');
    eq(layoutModeOf(800, 1600), 'TABLET');
  });

  test('폭을 모르면 좁은 쪽으로 간다', () => {
    // 넓은 배치를 좁은 화면에 그리면 겹쳐서 못 쓴다.
    // 좁은 배치를 넓은 화면에 그리면 허전할 뿐이다.
    eq(layoutModeOf(null), 'MOBILE');
    eq(layoutModeOf(undefined), 'MOBILE');
    eq(layoutModeOf(0), 'MOBILE');
    eq(layoutModeOf('abc'), 'MOBILE');
  });

  test('경계값이 한 곳에 있다', () => {
    eq(layoutModeOf(BREAKPOINTS.tablet - 1), 'MOBILE');
    eq(layoutModeOf(BREAKPOINTS.tablet), 'TABLET');
    eq(layoutModeOf(BREAKPOINTS.desktop), 'DESKTOP');
    eq(layoutModeOf(BREAKPOINTS.wide), 'WIDE_DESKTOP');
  });

  test('실제 기기 폭이 의도대로 갈린다', () => {
    eq(layoutModeOf(1024), 'TABLET', 'iPad 세로');
    eq(layoutModeOf(1180), 'TABLET', 'iPad Pro 11 가로');
    eq(layoutModeOf(1280), 'DESKTOP');
    eq(layoutModeOf(1366), 'DESKTOP');
    eq(layoutModeOf(1440), 'DESKTOP');
    eq(layoutModeOf(1920), 'WIDE_DESKTOP');
    eq(layoutModeOf(2560), 'WIDE_DESKTOP');
    // 분할화면
    eq(layoutModeOf(800), 'TABLET');
    eq(layoutModeOf(700), 'MOBILE');
    eq(layoutModeOf(600), 'MOBILE');
  });

  console.log('[레이아웃 — 패드에서 PC 배치를 그리지 않는다]');

  test('패드에서 전체 메뉴를 펼치지 않는다', () => {
    // 220px는 패드에서 너무 비싸다.
    const p = layoutPlanOf(1024);
    eq(p.sidebar, 'RAIL');
    assert(p.sidebar !== 'FULL', '전체 메뉴 금지');
  });

  test('패드에서 오른쪽 시세·뉴스를 기본 숨김한다', () => {
    // 300px 가까이 먹는데 패드에서 항상 보여줄 이유가 없다.
    const p = layoutPlanOf(1180);
    eq(p.rightRailVisible, false);
    eq(p.rightRailOnDemand, true, '버튼으로는 열 수 있어야 한다');
    assert(p.reason.includes('차트와 주문판에 돌립니다'), p.reason);
  });

  test('패드 가로에서는 차트와 주문판이 나란히 간다', () => {
    const p = layoutPlanOf(1180, { portrait: false });
    eq(p.orderPanel, 'SIDE');
    assert(p.chartPct >= 60 && p.chartPct <= 65, String(p.chartPct));
  });

  test('패드 세로에서는 주문판을 아래로 내린다', () => {
    // 폭이 넉넉해도 세로에서 나란히 두면 둘 다 답답하다.
    const p = layoutPlanOf(1024, { portrait: true });
    eq(p.orderPanel, 'BELOW');
    eq(p.chartPct, 100);
  });

  test('분할화면으로 좁아지면 배치를 바꾼다', () => {
    // 글자를 줄이는 게 아니라 주문판을 내린다.
    const p = layoutPlanOf(800);
    eq(p.mode, 'TABLET');
    eq(p.orderPanel, 'BELOW');
    assert(p.reason.includes('둘 다 못 씁니다'), p.reason);
  });

  test('모바일은 거래 실행만 남긴다', () => {
    const p = layoutPlanOf(390);
    eq(p.sidebar, 'DRAWER');
    eq(p.orderPanel, 'SHEET');
    eq(p.chartPct, 100);
    eq(p.rightRailVisible, false);
  });

  console.log('[레이아웃 — 좁아지면 시세부터 접는다]');

  test('가운데가 좁아지면 데스크톱에서도 오른쪽을 접는다', () => {
    // 시세를 못 보면 불편하지만, 주문 버튼이 호가 위로 겹치면
    // 잘못된 주문이 나간다.
    const p = layoutPlanOf(1210);
    eq(p.mode, 'DESKTOP');
    eq(p.rightRailVisible, false);
    assert(p.reason.includes('주문판이 눌리는 쪽이 위험'), p.reason);
  });

  test('넉넉한 데스크톱에서는 오른쪽을 편다', () => {
    const p = layoutPlanOf(1500);
    eq(p.mode, 'DESKTOP');
    eq(p.rightRailVisible, true);
    eq(p.reason, '');
  });

  test('3열 상시 표시는 와이드에서만이다', () => {
    const p = layoutPlanOf(1920);
    eq(p.mode, 'WIDE_DESKTOP');
    eq(p.sidebar, 'FULL');
    eq(p.rightRailVisible, true);
  });

  console.log('[레이아웃 — 하단 탭]');

  const T = (n: number): TabItem[] =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `탭${i}` }));

  test('열세 개를 한 줄에 두지 않는다', () => {
    const s = tabSplitOf(T(13), layoutPlanOf(1024).bottomTabs);
    assert(s.visible.length <= 4, String(s.visible.length));
    eq(s.needsMore, true);
    assert(s.overflow.length > 0, '나머지는 더보기로');
  });

  test('더보기 버튼 자리를 센다', () => {
    // 안 세면 한 칸이 넘쳐서 줄이 깨진다.
    const s = tabSplitOf(T(13), 5);
    eq(s.visible.length, 4, '5칸 중 하나는 더보기');
  });

  test('지금 열려 있는 탭은 숨지 않는다', () => {
    // 숨으면 사용자는 자기가 어디 있는지 모른다.
    const s = tabSplitOf(T(13), 4, 't11');
    assert(s.visible.some(t => t.id === 't11'), '활성 탭이 보여야 한다');
  });

  test('고정 탭도 숨지 않는다', () => {
    const tabs: TabItem[] = [...T(10), { id: 'kill', label: 'KILL', pinned: true }];
    const s = tabSplitOf(tabs, 3);
    assert(s.visible.some(t => t.id === 'kill'), 'KILL은 항상 보인다');
  });

  test('탭이 적으면 더보기를 안 만든다', () => {
    const s = tabSplitOf(T(3), 5);
    eq(s.needsMore, false);
    eq(s.visible.length, 3);
  });

  test('탭이 없어도 안 터진다', () => {
    eq(tabSplitOf(null, 4).visible.length, 0);
    eq(tabSplitOf([], 0).needsMore, false);
  });

  console.log('[레이아웃 — 겹침을 미리 막는다]');

  test('두 패널이 안 들어가면 false다', () => {
    // 차트 420 + 주문판 320 + 여백
    assert(!fitsSideBySide(700, MIN_WIDTH.chart, MIN_WIDTH.orderPanel), '700은 부족');
    assert(fitsSideBySide(800, MIN_WIDTH.chart, MIN_WIDTH.orderPanel), '800은 충분');
  });

  test('폭을 모르면 나란히 두지 않는다', () => {
    eq(fitsSideBySide(null, 100, 100), false);
  });

  test('flex 자식 안전값이 있다', () => {
    // min-width:0이 없으면 flex 자식은 내용보다 작아지지 않는다.
    // 긴 숫자 하나가 패널 전체를 밀어내고 옆 패널을 화면 밖으로 보낸다.
    eq(FLEX_SAFE.minWidth, 0);
    eq(FLEX_SAFE.minHeight, 0);
  });
}
