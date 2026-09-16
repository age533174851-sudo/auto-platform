'use client';
// src/lib/trading/usePaperTarget.ts
//
// **고른 장부를 화면 전체가 하나로 본다.**
//
// 왜 훅 하나인가
// ──────────────
// 잔고는 챌린지 계좌를 보는데 주문은 기본 계좌로 나가는 것이 이 구조에서
// 제일 쉽게 나는 고장이다. 컴포넌트마다 자기 `useState`를 들면 반드시
// 그렇게 된다 — 하나만 바뀌는 순간이 생긴다.
//
// 그래서 값을 **모듈 수준에 하나** 두고 구독자가 나눠 쓴다.
// `useBinanceStream`이 심볼별 허브를 두는 것과 같은 이유다.
//
// 왜 컨텍스트가 아닌가
// ────────────────────
// 이 값은 터미널 안(`/terminal`)과 밖(`/`의 매매·모의 탭) 양쪽에서 쓰인다.
// `TerminalProvider`에 넣으면 밖에서 못 쓰고, 밖에 또 하나를 만들면 값이
// 둘이 된다 — 없애려던 고장이 그대로 돌아온다.
import { useCallback, useSyncExternalStore } from 'react';
import {
  DEFAULT_TARGET, restoreTarget, isValidTarget, sameTarget, type PaperTarget,
} from './paperTarget';

const KEY = 'tg_paper_target_v1';

let current: PaperTarget = DEFAULT_TARGET;
let loaded = false;
const subs = new Set<() => void>();

function readStored(): PaperTarget {
  try {
    if (typeof window === 'undefined') return DEFAULT_TARGET;
    return restoreTarget(window.localStorage.getItem(KEY));
  } catch {
    // 저장소를 못 읽는 것은 **고른 적 없는 것**과 같다. 기본 계좌다.
    return DEFAULT_TARGET;
  }
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  current = readStored();
}

function emit() { for (const f of subs) f(); }

/** 장부를 바꾼다. **계약에 맞지 않는 값은 받지 않는다.** */
export function setPaperTarget(next: PaperTarget) {
  ensureLoaded();
  if (!isValidTarget(next)) return;          // 잘못된 값으로 갈아치우지 않는다
  if (sameTarget(current, next)) return;     // 같은 값이면 다시 그리지 않는다
  current = next;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* 저장 못 해도 이번 세션은 바뀐 값으로 돈다 */ }
  emit();
}

export function getPaperTarget(): PaperTarget {
  ensureLoaded();
  return current;
}

function subscribe(cb: () => void) {
  ensureLoaded();
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/**
 * 지금 고른 장부.
 *
 * 서버 렌더에서는 **기본 계좌**다. `localStorage`를 서버에서 읽을 수 없고,
 * 읽은 척하면 첫 그림과 두 번째 그림이 달라진다.
 */
export function usePaperTarget(): [PaperTarget, (t: PaperTarget) => void] {
  const value = useSyncExternalStore(subscribe, getPaperTarget, () => DEFAULT_TARGET);
  const set = useCallback((t: PaperTarget) => setPaperTarget(t), []);
  return [value, set];
}
