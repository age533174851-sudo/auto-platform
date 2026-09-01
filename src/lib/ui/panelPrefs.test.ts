// src/lib/ui/panelPrefs.test.ts
//
// 이 테스트가 막는 것 셋:
//  · **저장된 폭이 본문을 잡아먹는 것** — 넓은 모니터에서 늘린 값이
//    좁은 노트북에서 그대로 강제되면 가운데가 400px가 된다
//  · **접었는데 빈 자리만 남는 것** — 접기의 목적은 가운데를 넓히는 것이다
//  · **모르는 저장값이 화면을 못 뜨게 하는 것**

import { test, eq, assert } from '../../test/harness';
import {
  parseLeftMode, parseRightMode, parseMenuView, parseRailWidth,
  clampRailWidth, railMaxFor, railWidthFor, sidebarWidthFor,
  nextLeftMode, nextRightMode, railWidthFromKey, railWidthFromPointer,
  RAIL_MIN, RAIL_MAX, RAIL_DEFAULT, RAIL_COLLAPSED, RAIL_STEP,
  SIDEBAR_EXPANDED, SIDEBAR_WIDE, SIDEBAR_COMPACT, CENTER_MIN,
  MIN_CONTROL_TARGET,
} from './panelPrefs';

export function runPanelPrefsTests() {
  console.log('[PC 껍데기 — 접기·폭 조절이 본문을 잡아먹지 않는다]');

  // ── 저장된 값 읽기 ────────────────────────────────────────
  test('모르는 값은 기본값으로 돌린다', () => {
    eq(parseLeftMode('compact'), 'compact');
    eq(parseLeftMode('expanded'), 'expanded');
    eq(parseLeftMode(null), 'expanded');
    eq(parseLeftMode('무엇인가'), 'expanded');

    eq(parseRightMode('collapsed'), 'collapsed');
    eq(parseRightMode(undefined), 'expanded');

    eq(parseMenuView('grid'), 'grid');
    eq(parseMenuView('list'), 'list');
    // 저장된 적 없는 사용자에게 어느 날 갑자기 다른 모양을 주지 않는다
    eq(parseMenuView(null), 'list');
    eq(parseMenuView('tile'), 'list');
  });

  test('빈 문자열을 폭 0으로 읽지 않는다', () => {
    // Number('')은 0이다. 그대로 쓰면 레일이 사라진다.
    eq(parseRailWidth(''), RAIL_DEFAULT);
    eq(parseRailWidth(null), RAIL_DEFAULT);
    eq(parseRailWidth('없는값'), RAIL_DEFAULT);
    eq(parseRailWidth('320'), 320);
  });

  // ── 폭 조이기 ─────────────────────────────────────────────
  test('넓은 화면에서는 저장한 폭이 그대로 산다', () => {
    eq(clampRailWidth(400, 1920, SIDEBAR_EXPANDED), 400);
    eq(clampRailWidth(240, 1920, SIDEBAR_EXPANDED), 240);
  });

  test('최소·최대를 넘는 값은 조인다', () => {
    eq(clampRailWidth(9999, 2560, SIDEBAR_WIDE), RAIL_MAX);
    eq(clampRailWidth(10, 1920, SIDEBAR_EXPANDED), RAIL_MIN);
    eq(clampRailWidth(0, 1920, SIDEBAR_EXPANDED), RAIL_MIN);
  });

  test('좁은 화면에서는 저장된 큰 폭을 강제하지 않는다', () => {
    // 1366에서 사이드바 220 + 레일 420이면 가운데가 726 — 아직 괜찮다.
    // 그래서 가운데 최소값이 실제로 걸리는 폭으로 확인한다.
    const w = 1100;
    const got = clampRailWidth(RAIL_MAX, w, SIDEBAR_EXPANDED);
    assert(got < RAIL_MAX, `좁은 화면인데 최대폭이 그대로다: ${got}`);
    // 조인 뒤에도 가운데는 최소폭을 지킨다
    assert(w - SIDEBAR_EXPANDED - got >= CENTER_MIN,
      `가운데가 ${w - SIDEBAR_EXPANDED - got}로 최소(${CENTER_MIN})보다 좁다`);
  });

  test('가운데 최소폭은 어떤 화면에서도 계산에 들어간다', () => {
    for (const vw of [1024, 1100, 1280, 1366, 1440, 1920, 2560]) {
      const max = railMaxFor(vw, SIDEBAR_EXPANDED);
      assert(max >= RAIL_MIN, `${vw}: 최대폭이 최소폭보다 작다`);
      assert(max <= RAIL_MAX, `${vw}: 최대폭이 상한을 넘었다`);
      // 최대까지 늘려도 가운데는 최소폭 이상이거나, 애초에 자리가 없어
      // RAIL_MIN으로 떨어진 경우다.
      const center = vw - SIDEBAR_EXPANDED - max;
      assert(center >= CENTER_MIN || max === RAIL_MIN,
        `${vw}: 가운데가 ${center}인데 레일이 ${max}다`);
    }
  });

  test('1024에서도 접힌 뒤 가운데가 최소폭을 지킨다', () => {
    // 접힌 폭을 34에서 48로 넓혔다. 가장 좁은 PC(1024)에서 그 14px이
    // 가운데를 최소폭 아래로 밀지 않는지 확인한다.
    const vw = 1024;
    for (const left of ['expanded', 'compact'] as const) {
      const sb = sidebarWidthFor(left, vw);
      const shut = vw - sb - railWidthFor('collapsed', RAIL_DEFAULT);
      assert(shut >= CENTER_MIN,
        `${left}에서 접었을 때 가운데가 ${shut} — 최소(${CENTER_MIN})보다 좁다`);
      // 접는 쪽이 항상 이득이어야 한다
      const open = vw - sb - clampRailWidth(RAIL_DEFAULT, vw, sb);
      assert(shut > open, `${left}에서 접었는데 가운데가 안 넓어졌다: ${open} → ${shut}`);
    }
  });

  test('NaN이 들어와도 화면이 그려질 수 있는 값을 돌려준다', () => {
    const got = clampRailWidth(Number.NaN, 1920, SIDEBAR_EXPANDED);
    assert(Number.isFinite(got) && got >= RAIL_MIN, `못 쓰는 값: ${got}`);
  });

  // ── 접기 ──────────────────────────────────────────────────
  test('접으면 남는 자리가 눈에 띄게 줄어든다', () => {
    const open = railWidthFor('expanded', 300);
    const shut = railWidthFor('collapsed', 300);
    eq(open, 300);
    eq(shut, RAIL_COLLAPSED);
    // 접기의 목적은 가운데를 넓히는 것이다. 접었는데 폭이 그대로면
    // 빈 자리만 남는다 — 이 테스트가 그것을 막는다.
    assert(shut < open, '접었는데 폭이 줄지 않았다');
    // 다만 0은 아니다. 0이면 다시 펴는 버튼이 본문 위에 떠야 한다.
    assert(shut > 0, '완전히 0이면 다시 펼 자리가 없다');
  });

  test('접힌 칸이 그 안의 버튼보다 좁지 않다', () => {
    // 이 저장소에서 실제로 났던 고장: 접기 버튼을 26×26으로 만들어 놓고
    // 주석에 "마우스가 있는 PC에서만 보인다"고 적었다. 사이드바는 768px,
    // 레일은 1024px부터 보이므로 태블릿에서는 손으로 누른다.
    //
    // 그 다음 고장은 그것을 고치는 과정에서 난다 — 버튼만 40px로 키우고
    // 칸은 34px로 두면 펼치기 버튼이 칸 밖으로 나간다. 그러면 음수 마진이나
    // transform으로 덮고 싶어지고, 그건 이 작업이 없애려는 겹침이다.
    //
    // 그래서 둘의 관계를 값으로 잠근다. 픽셀을 정규식으로 묶는 것이 아니라
    // **같은 상수를 보고 있다는 사실**을 확인한다.
    assert(RAIL_COLLAPSED >= MIN_CONTROL_TARGET,
      `접힌 레일(${RAIL_COLLAPSED})이 조작 최소 크기(${MIN_CONTROL_TARGET})보다 좁다`);
    assert(SIDEBAR_COMPACT >= MIN_CONTROL_TARGET,
      `접힌 사이드바(${SIDEBAR_COMPACT})가 조작 최소 크기(${MIN_CONTROL_TARGET})보다 좁다`);
    // 딱 맞으면 여백이 0이라 버튼이 칸에 꽉 낀다. 좌우로 숨 쉴 자리를 둔다.
    assert(RAIL_COLLAPSED - MIN_CONTROL_TARGET >= 4,
      `접힌 레일에 좌우 여백이 없다: ${RAIL_COLLAPSED - MIN_CONTROL_TARGET}px`);
  });

  test('조작 최소 크기는 손가락이 누를 수 있는 값이다', () => {
    // 40은 흔히 쓰는 하한이다. 이보다 작아지면 태블릿에서 오조작이 는다.
    assert(MIN_CONTROL_TARGET >= 40, `조작 최소 크기가 너무 작다: ${MIN_CONTROL_TARGET}`);
  });

  test('사이드바 접기도 폭을 실제로 줄인다', () => {
    assert(sidebarWidthFor('compact', 1920) < sidebarWidthFor('expanded', 1920),
      '사이드바를 접었는데 폭이 그대로다');
    eq(sidebarWidthFor('compact', 1920), SIDEBAR_COMPACT);
    eq(sidebarWidthFor('expanded', 1366), SIDEBAR_EXPANDED);
    eq(sidebarWidthFor('expanded', 1440), SIDEBAR_WIDE);
    // 접은 상태는 화면 폭과 무관하다 — 아이콘 크기는 안 변한다
    eq(sidebarWidthFor('compact', 1366), SIDEBAR_COMPACT);
  });

  test('토글은 두 번 누르면 제자리로 온다', () => {
    eq(nextLeftMode(nextLeftMode('expanded')), 'expanded');
    eq(nextRightMode(nextRightMode('collapsed')), 'collapsed');
    eq(nextLeftMode('expanded'), 'compact');
    eq(nextRightMode('expanded'), 'collapsed');
  });

  // ── 키보드 ────────────────────────────────────────────────
  test('방향키로도 폭을 바꿀 수 있다', () => {
    const vw = 1920, sb = SIDEBAR_EXPANDED;
    // 손잡이는 레일 왼쪽에 있다 — 왼쪽으로 가면 레일이 넓어진다
    eq(railWidthFromKey('ArrowLeft', 300, vw, sb), 300 + RAIL_STEP);
    eq(railWidthFromKey('ArrowRight', 300, vw, sb), 300 - RAIL_STEP);
    eq(railWidthFromKey('End', 300, vw, sb), RAIL_MIN);
    eq(railWidthFromKey('Home', 300, vw, sb), railMaxFor(vw, sb));
    // 다루지 않는 키는 건드리지 않는다 — null이면 호출한 쪽이
    // preventDefault를 하지 않고 브라우저 기본 동작을 살린다
    eq(railWidthFromKey('Tab', 300, vw, sb), null);
    eq(railWidthFromKey('a', 300, vw, sb), null);
  });

  test('키보드로도 한계를 넘지 못한다', () => {
    const vw = 1920, sb = SIDEBAR_EXPANDED;
    eq(railWidthFromKey('ArrowRight', RAIL_MIN, vw, sb), RAIL_MIN);
    eq(railWidthFromKey('ArrowLeft', RAIL_MAX, vw, sb), RAIL_MAX);
  });

  // ── 드래그 ────────────────────────────────────────────────
  test('포인터 위치가 폭이 된다 — 레일은 오른쪽 끝에 붙어 있다', () => {
    const vw = 1920, sb = SIDEBAR_EXPANDED;
    eq(railWidthFromPointer(1920 - 320, vw, sb), 320);
    // 창 밖으로 끌어도 한계 안에 머문다
    eq(railWidthFromPointer(-500, vw, sb), railMaxFor(vw, sb));
    eq(railWidthFromPointer(5000, vw, sb), RAIL_MIN);
  });

  test('드래그 결과는 항상 정수다', () => {
    // 소수 폭을 CSS에 넣으면 하위 픽셀 때문에 경계선이 흐려진다
    const got = railWidthFromPointer(1920 - 300.4, 1920, SIDEBAR_EXPANDED);
    eq(got, Math.round(got));
  });
}
