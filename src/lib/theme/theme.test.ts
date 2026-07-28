// src/lib/theme/theme.test.ts
//
// 막으려는 사고:
//  1. var()에 hex 알파를 이어 붙여 색이 조용히 사라지는 것
//  2. 19시~07시를 h>=19 && h<7로 써서 밤에 항상 거짓이 되는 것
//     — 밤에만 재현되는 버그다
//  3. auto 타이머가 0ms로 걸려 무한히 다시 깨는 것
//  4. 저장값이 깨졌을 때 화면이 안 그려지는 것
import { test, assert, eq } from '../../test/harness';
import { withAlpha, alphaHexToPercent } from './colors';
import {
  parseMode, themeForHour, resolveTheme, msUntilNextSwitch,
  LIGHT_FROM_HOUR, DARK_FROM_HOUR,
} from './themeMode';

export function runThemeTests() {
  console.log('[테마 — 투명도]');

  test('hex 알파를 퍼센트로', () => {
    eq(alphaHexToPercent('ff'), 100);
    eq(alphaHexToPercent('00'), 0);
    assert(Math.abs((alphaHexToPercent('80') ?? 0) - 50.196) < 0.01);
  });

  test('CSS 변수에도 투명도가 걸린다', () => {
    const r = withAlpha('var(--t-acl)', '40');
    assert(r.includes('color-mix'), r);
    assert(r.includes('var(--t-acl)'), r);
    assert(!/var\(--t-acl\)40/.test(r), 'var 뒤에 hex를 붙이면 CSS가 조용히 무효가 된다');
  });

  test('0~1 숫자도 받는다', () => {
    assert(withAlpha('#fff', 0.25).includes('25%'), withAlpha('#fff', 0.25));
    assert(withAlpha('#fff', 1).includes('100%'));
  });

  test('알아볼 수 없는 알파는 색을 그대로 둔다', () => {
    // 투명하게 만들면 요소가 사라진다. 안 보이는 것보다 진한 게 낫다.
    eq(withAlpha('#fff', 'zz'), '#fff');
    eq(withAlpha('#fff', NaN), '#fff');
    eq(withAlpha('var(--x)', '1'), 'var(--x)');
  });

  test('범위를 벗어난 숫자는 잘라 넣는다', () => {
    assert(withAlpha('#fff', 5).includes('100%'));
    assert(withAlpha('#fff', -2).includes('0%'));
  });

  console.log('[테마 — 모드 해석]');

  test('깨진 저장값은 auto', () => {
    eq(parseMode(null), 'auto');
    eq(parseMode(''), 'auto');
    eq(parseMode('보라색'), 'auto');
    eq(parseMode(undefined), 'auto');
  });

  test('아는 값은 그대로', () => {
    eq(parseMode('dark'), 'dark');
    eq(parseMode('LIGHT'), 'light');
    eq(parseMode(' auto '), 'auto');
  });

  test('고정 모드는 시각을 무시한다', () => {
    eq(resolveTheme('dark', 12), 'dark');
    eq(resolveTheme('light', 3), 'light');
  });

  console.log('[테마 — 시간에 맞춰]');

  test('낮은 밝고 밤은 어둡다', () => {
    eq(themeForHour(12), 'light');
    eq(themeForHour(9), 'light');
    eq(themeForHour(2), 'dark');
    eq(themeForHour(23), 'dark');
  });

  test('자정을 넘는 구간이 끊기지 않는다', () => {
    // h >= 19 && h < 7 로 쓰면 여기가 전부 light가 된다
    for (const h of [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6]) {
      eq(themeForHour(h), 'dark', `${h}시가 어둡지 않다`);
    }
    for (const h of [7, 8, 12, 17, 18]) {
      eq(themeForHour(h), 'light', `${h}시가 밝지 않다`);
    }
  });

  test('경계 시각이 정확하다', () => {
    eq(themeForHour(LIGHT_FROM_HOUR - 1), 'dark');
    eq(themeForHour(LIGHT_FROM_HOUR), 'light');
    eq(themeForHour(DARK_FROM_HOUR - 1), 'light');
    eq(themeForHour(DARK_FROM_HOUR), 'dark');
  });

  test('이상한 시각에도 화면은 그려진다', () => {
    eq(themeForHour(NaN), 'dark');
    eq(themeForHour(25), 'dark');    // 25 % 24 = 1시
    eq(themeForHour(-1), 'dark');    // 23시
  });

  console.log('[테마 — 다음 전환까지]');

  const at = (h: number, m = 0) => { const d = new Date(2026, 0, 15, h, m, 0, 0); return d; };

  test('아침 전에는 07시를 기다린다', () => {
    eq(msUntilNextSwitch(at(3)), 4 * 3600_000);
  });

  test('낮에는 19시를 기다린다', () => {
    eq(msUntilNextSwitch(at(12)), 7 * 3600_000);
  });

  test('밤에는 다음 날 07시를 기다린다', () => {
    eq(msUntilNextSwitch(at(22)), 9 * 3600_000);
  });

  test('경계에 정확히 걸려도 0을 반환하지 않는다', () => {
    // 0으로 타이머를 걸면 즉시 다시 깨어나 무한 루프가 된다
    assert(msUntilNextSwitch(at(7)) > 0, '07시 정각');
    assert(msUntilNextSwitch(at(19)) > 0, '19시 정각');
  });

  test('언제 재도 항상 양수다', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30, 59]) {
        assert(msUntilNextSwitch(at(h, m)) > 0, `${h}:${m}`);
      }
    }
  });
}
