'use client';
// src/lib/theme/useTheme.ts
//
// 테마 모드를 읽고 바꾼다.
//
// 화면에 적용하는 일은 <html data-theme>를 바꾸는 것뿐이다. 색은 전부
// CSS 변수라서 그 한 글자만 바뀌면 앱과 터미널이 같이 따라온다.
// 리액트가 다시 그리지 않으므로 차트 iframe도, 스크롤도, 입력 중이던
// 값도 그대로 있다.
import { useCallback, useEffect, useState } from 'react';
import {
  parseMode, resolveTheme, msUntilNextSwitch,
  THEME_STORAGE_KEY, type ThemeMode, type ResolvedTheme,
} from './themeMode';

/** <html>에 실제로 적용. 이 함수 하나만 DOM을 만진다 */
export function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
  // 주소창·상태바 색까지 맞춘다. 안 맞추면 스크롤 끝에서 다른 색이 비친다.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue('--t-bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');

  // 저장값을 읽어 온다. 서버 렌더에서는 알 수 없으므로 마운트 후에 한 번.
  // 화면 깜빡임은 layout의 인라인 스크립트가 미리 막는다.
  useEffect(() => {
    let m: ThemeMode = 'auto';
    try { m = parseMode(localStorage.getItem(THEME_STORAGE_KEY)); } catch {}
    setModeState(m);
  }, []);

  // 모드가 정해지면 적용하고, auto면 다음 전환 시각에 한 번 깨운다.
  //
  // 1분마다 확인하지 않는 이유: 배터리를 먹는다. 그렇다고 간격을 늘리면
  // 전환이 늦는다. 바뀌는 순간을 계산해 그때 한 번만 깨우면 둘 다 없다.
  useEffect(() => {
    let timer: any;
    const tick = () => {
      const now = new Date();
      const r = resolveTheme(mode, now.getHours());
      setResolved(r);
      applyTheme(r);
      if (mode === 'auto') timer = setTimeout(tick, msUntilNextSwitch(now));
    };
    tick();

    // 탭을 오래 열어 두면 타이머가 밀린다. 돌아왔을 때 한 번 맞춘다.
    const onVisible = () => { if (!document.hidden && mode === 'auto') { clearTimeout(timer); tick(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(THEME_STORAGE_KEY, m); } catch {}
  }, []);

  return { mode, resolved, setMode };
}
