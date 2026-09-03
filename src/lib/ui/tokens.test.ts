// src/lib/ui/tokens.test.ts
//
// 이 테스트가 막는 것: **정본이라고 적어 두고 아무도 안 지키는 상태.**
//
// 스케일은 값 목록이라 "테스트할 게 없어 보인다". 그래서 테스트가 없고,
// 없으니까 값이 조용히 갈라진다. 실제로 이 저장소에는 글자 크기 스케일이
// 두 벌 있었다(앱 F.* / 터미널 FS.*).

import { test, assert, eq } from '../../test/harness';
import { SP, R, FS, FW, CONTROL, BORDER_W } from './tokens';
import { MIN_CONTROL_TARGET, SIDEBAR_COMPACT, RAIL_COLLAPSED } from './panelPrefs';

/**
 * 스케일에 있는 값인가.
 *
 * 정본에 있던 것을 여기로 옮겼다 — 검사에만 쓰였기 때문이다. 화면이
 * 부르지 않는 함수를 정본에 두면 "쓰이는 것"과 "만들어 둔 것"이 섞인다.
 */
const inScale = (scale: Record<string, number>, v: number) => Object.values(scale).includes(v);

const asc = (o: Record<string, number>) => {
  const v = Object.values(o);
  for (let i = 1; i < v.length; i += 1) if (v[i] <= v[i - 1]) return false;
  return true;
};

export function runTokensTests() {
  console.log('[디자인 토큰 — 정본이 하나이고 실제로 지켜지는가]');

  // ── 스케일의 모양 ─────────────────────────────────────────
  test('스케일은 커지는 순서다 — 이름이 크기를 말해야 한다', () => {
    // sm이 md보다 크면 다음 사람이 이름을 보고 고를 수 없다.
    assert(asc(SP), `SP가 오름차순이 아니다: ${JSON.stringify(SP)}`);
    assert(asc(FS), `FS가 오름차순이 아니다: ${JSON.stringify(FS)}`);
    assert(asc(FW), `FW가 오름차순이 아니다: ${JSON.stringify(FW)}`);
  });

  test('반지름은 pill을 빼고 오름차순이다', () => {
    const { pill, ...rest } = R;
    assert(asc(rest), `R가 오름차순이 아니다: ${JSON.stringify(rest)}`);
    assert(pill > 100, 'pill은 완전히 둥근 값이어야 한다');
  });

  test('값이 전부 유한한 숫자다 — NaN이 하나 섞이면 그 자리는 스타일이 통째로 빠진다', () => {
    for (const [name, scale] of Object.entries({ SP, R, FS, FW, CONTROL })) {
      for (const [k, v] of Object.entries(scale)) {
        assert(Number.isFinite(v), `${name}.${k}가 숫자가 아니다: ${v}`);
        assert(v > 0, `${name}.${k}가 0 이하다: ${v}`);
      }
    }
    eq(BORDER_W, 1);
  });

  // ── 최소 터치 크기는 한 곳에서 온다 ───────────────────────
  test('최소 터치 크기를 두 번 선언하지 않는다', () => {
    // UI-1에서 26px 버튼을 만들었다가 되돌린 값이다. 여기에 40을
    // 다시 적으면 panelPrefs와 갈라진다.
    eq(CONTROL.min, MIN_CONTROL_TARGET);
  });

  test('접힌 레일과 좁은 사이드바는 최소 타깃을 담을 수 있다', () => {
    // 칸이 버튼보다 좁으면 버튼이 칸 밖으로 나가고, 그것을 음수 마진으로
    // 덮는 것이 UI-1에서 금지된 바로 그 수법이다.
    assert(RAIL_COLLAPSED >= CONTROL.min, `접힌 레일(${RAIL_COLLAPSED})이 최소 타깃보다 좁다`);
    assert(SIDEBAR_COMPACT >= CONTROL.min, `좁은 사이드바(${SIDEBAR_COMPACT})가 최소 타깃보다 좁다`);
  });

  test('기본·큰 버튼은 최소 타깃을 넘는다', () => {
    assert(CONTROL.md >= CONTROL.min, `기본 버튼(${CONTROL.md})이 최소 타깃보다 작다`);
    assert(CONTROL.lg >= CONTROL.min, `큰 버튼(${CONTROL.lg})이 최소 타깃보다 작다`);
  });

  // ── 실제 화면 값이 스케일 안에 있는가 ─────────────────────
  test('이미 화면에 있는 값이 스케일에 들어 있다', () => {
    // 스케일이 현실을 못 담으면 옮길 수 없고, 옮기려면 화면을 바꿔야 한다.
    // 이번 단계는 리디자인이 아니므로 현실 쪽이 기준이다.
    assert(inScale(R, 18), 'Card가 쓰는 반지름 18이 스케일에 없다');
    assert(inScale(FS, 9), '앱 화면 489곳이 쓰는 9px가 스케일에 없다');
    assert(inScale(FS, 10) && inScale(FS, 11) && inScale(FS, 12),
      '가장 많이 쓰이는 글자 크기가 스케일에 없다');
    assert(inScale(SP, 8) && inScale(SP, 12) && inScale(SP, 16), '주요 간격이 스케일에 없다');
  });

  test('inScale은 스케일 밖 값을 통과시키지 않는다', () => {
    eq(inScale(SP, 7), false);
    eq(inScale(FS, 8), false);
    eq(inScale(R, 999), true);
  });
}
