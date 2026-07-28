// src/lib/theme/colors.ts
//
// 색에 투명도를 입힌다.
//
// 왜 이 함수가 생겼나
// ───────────────────
// 예전에는 `T.acl + '20'`처럼 8자리 hex를 문자열로 이어 붙였다. T가 hex
// 리터럴일 때만 되는 방법이다. 밝은 테마를 넣으려고 T를 CSS 변수로 바꾸면
// `var(--t-acl)20`이 되는데, 이건 **에러가 나지 않고 그냥 무효**다.
// 색이 조용히 사라진다. 화면이 깨진 것도 아니고 로그도 없어서, 어디가
// 잘못됐는지 찾는 데 제일 오래 걸리는 종류의 고장이다.
//
// color-mix는 var()를 받는다. 그래서 테마가 바뀌면 투명한 색까지 같이
// 따라온다 — 리액트가 다시 그리지 않아도 된다.

/** 8자리 hex의 알파 두 자리를 퍼센트로. 'FF' → 100, '80' → 50.2 */
export function alphaHexToPercent(hex: string): number | null {
  if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
  return (parseInt(hex, 16) / 255) * 100;
}

/**
 * 색 + 투명도.
 *
 * @param color 어떤 CSS 색이든 (hex, var(--x), rgb(...))
 * @param alpha 두 자리 hex('20') 또는 0~1 숫자(0.125)
 *
 * 알아볼 수 없는 알파는 색을 그대로 돌려준다. 여기서 투명하게 만들어
 * 버리면 안 보이는 요소가 생기는데, 원래 색으로 두면 최소한 보인다.
 * 안 보이는 것보다 진한 게 낫다.
 */
export function withAlpha(color: string, alpha: string | number): string {
  let pct: number | null;
  if (typeof alpha === 'number') {
    pct = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) * 100 : null;
  } else {
    pct = alphaHexToPercent(alpha);
  }
  if (pct == null) return color;
  // 소수점 둘째 자리까지. 그 아래는 눈에 보이지 않는데 문자열만 길어진다.
  const p = Math.round(pct * 100) / 100;
  return `color-mix(in srgb, ${color} ${p}%, transparent)`;
}

/** 짧은 별칭. 호출부가 665곳이라 이름이 길면 줄바꿈이 늘어난다. */
export const A = withAlpha;
