// src/lib/theme/themeMode.ts
//
// 어떤 테마를 보여줄지 정한다.
//
// 모드는 셋이다. 'auto'는 시각에 따라 밝음/어두움을 고른다.
//
// 시간 기준을 왜 이렇게 잡았나
// ─────────────────────────────
// 해가 지는 시각은 계절과 위도에 따라 다르지만, 그걸 맞추려면 위치 권한이
// 필요하다. 테마 하나 바꾸자고 위치를 물어보는 건 과하다. 그래서 고정
// 시각을 쓰되 경계를 넉넉히 둔다 — 07시부터 밝고, 19시부터 어둡다.
//
// 자정을 넘는 구간을 따로 다루는 이유: 19시~07시는 숫자가 커졌다가
// 작아진다. `h >= 19 && h < 7`로 쓰면 항상 거짓이라 밤에도 밝은 테마가
// 나온다. 이런 건 테스트가 없으면 밤에만 재현되는 버그가 된다.

export type ThemeMode = 'dark' | 'light' | 'auto';
/** 실제로 화면에 적용되는 값. 'auto'는 여기까지 오지 않는다 */
export type ResolvedTheme = 'dark' | 'light';

export const LIGHT_FROM_HOUR = 7;   // 07:00부터 밝음
export const DARK_FROM_HOUR = 19;   // 19:00부터 어두움

export const THEME_STORAGE_KEY = 'tg_theme_mode';

/** 저장값을 모드로. 모르는 값은 auto — 처음 쓰는 사람에게 가장 덜 놀랍다 */
export function parseMode(raw: unknown): ThemeMode {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'dark' || s === 'light' || s === 'auto' ? s : 'auto';
}

/** 이 시각에 auto가 고를 테마 */
export function themeForHour(hour: number): ResolvedTheme {
  if (!Number.isFinite(hour)) return 'dark';
  const h = Math.floor(hour) % 24;
  const norm = h < 0 ? h + 24 : h;
  return norm >= LIGHT_FROM_HOUR && norm < DARK_FROM_HOUR ? 'light' : 'dark';
}

/** 모드 + 시각 → 실제 적용할 테마 */
export function resolveTheme(mode: ThemeMode, hour: number): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode;
  return themeForHour(hour);
}

/**
 * auto일 때 다음 전환까지 남은 밀리초.
 *
 * 1분마다 확인하는 대신 정확히 바뀌는 순간에 한 번 깨우려고 쓴다.
 * 폴링은 배터리를 먹고, 그렇다고 간격을 늘리면 전환이 늦는다.
 */
export function msUntilNextSwitch(now: Date): number {
  const h = now.getHours();
  const nextHour = h < LIGHT_FROM_HOUR ? LIGHT_FROM_HOUR
    : h < DARK_FROM_HOUR ? DARK_FROM_HOUR
    : LIGHT_FROM_HOUR + 24;
  const target = new Date(now);
  target.setHours(nextHour, 0, 0, 0);
  const ms = target.getTime() - now.getTime();
  // 경계에 정확히 걸리면 0이 나온다. 0으로 타이머를 걸면 즉시 다시 깨어나
  // 무한 루프가 된다.
  return ms > 0 ? ms : 60_000;
}

export const MODE_LABEL: Record<ThemeMode, string> = {
  dark: '어두움', light: '밝음', auto: '시간에 맞춰',
};
