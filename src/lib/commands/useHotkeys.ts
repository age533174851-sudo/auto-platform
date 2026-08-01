'use client';
// src/lib/commands/useHotkeys.ts
//
// 전역 단축키 리스너. 판단은 전부 keymap.ts에 있고 여기는 이벤트만 잇는다.
//
// 왜 이 파일이 얇아야 하는가
// ──────────────────────────
// 리스너는 테스트하기 어려운 자리다(전역 이벤트, 시각, 포커스). 그래서
// '어떤 키가 무엇을 실행하는지'와 '입력창에서 무시하는지'를 전부 순수
// 함수로 빼고, 이 파일에는 판단이 남지 않게 했다. 여기에 조건문이 늘기
// 시작하면 그만큼이 테스트 밖으로 나간다.
import { useCallback, useEffect, useRef } from 'react';
import {
  normalizeChord, shouldIgnoreTarget, feedChord, resolveOutcome,
  activeBindings, EMPTY_SEQUENCE, NO_CONFIRM,
  type HotkeyProfile, type SequenceState, type ConfirmState,
} from './keymap';
import { needsConfirm } from './registry';
import type { Command } from './types';

export interface UseHotkeysOptions {
  profile: HotkeyProfile;
  /** 커맨드 id → 커맨드. 없으면 실행하지 않는다 */
  lookup: (commandId: string) => Command | null;
  /** 실행 */
  onRun: (cmd: Command) => void;
  /** 확인이 필요할 때 — 사용자에게 알려야 한다 */
  onAsk?: (cmd: Command) => void;
  /** 단축키 전체를 끌 때 (예: 모달이 떠 있는 동안) */
  disabled?: boolean;
}

export function useHotkeys(opts: UseHotkeysOptions) {
  const { profile, lookup, onRun, onAsk, disabled } = opts;

  // 시퀀스·확인 상태는 ref에 둔다. state로 두면 키를 누를 때마다 앱 전체가
  // 다시 그려진다 — 차트가 있는 화면에서는 그게 그대로 체감된다.
  const seq = useRef<SequenceState>(EMPTY_SEQUENCE);
  const confirm = useRef<ConfirmState>(NO_CONFIRM);

  // 리스너는 한 번만 붙인다. 그래서 최신 값을 ref로 본다 — 값을 그대로
  // 담으면 첫 렌더의 함수에 갇힌다 (이 프로젝트의 popstate 리스너가 같은
  // 이유로 overlaysRef를 쓴다).
  const latest = useRef({ profile, lookup, onRun, onAsk, disabled });
  latest.current = { profile, lookup, onRun, onAsk, disabled };

  const handler = useCallback((e: KeyboardEvent) => {
    const cur = latest.current;
    if (cur.disabled) return;

    // 입력창에서는 조건 없이 무시한다. 이유는 keymap.ts에 적어 뒀다 —
    // 수량칸에 B를 치다가 주문이 나가는 것을 막는 것이 이 가드의 목적이다.
    if (shouldIgnoreTarget(e.target as any)) return;

    const chord = normalizeChord(e);
    if (!chord) return;

    const bindings = activeBindings(cur.profile);
    const now = Date.now();
    const fed = feedChord(seq.current, chord, now, bindings);
    seq.current = fed.state;

    // 순서의 앞부분이면 브라우저 기본 동작을 막는다. 'g'만 눌렀을 때
    // 페이지가 스크롤되거나 검색이 열리면 조합을 완성할 수 없다.
    if (fed.pending) { e.preventDefault(); return; }
    if (!fed.match) return;

    const cmd = cur.lookup(fed.match.commandId);
    // 커맨드를 못 찾으면 아무 일도 하지 않는다 — 그런데 이건 배선 실수이므로
    // 조용히 넘기지 않고 개발 중에 보이게 남긴다.
    if (!cmd) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[hotkeys] 커맨드를 찾을 수 없다: ${fed.match.commandId} (${fed.match.sequence})`);
      }
      return;
    }

    e.preventDefault();
    const out = resolveOutcome(cmd, confirm.current, now, needsConfirm);
    confirm.current = out.confirm;
    if (out.kind === 'run') cur.onRun(out.command);
    else if (out.kind === 'ask') cur.onAsk?.(out.command);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
