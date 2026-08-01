// src/lib/commands/keymap.ts
//
// 전역 단축키 — 커맨드 레지스트리 위의 **키맵**.
//
// 팔레트와 같은 목록을 쓴다. 키를 핸들러에 직접 박지 않는 이유는 커맨드
// 레지스트리(registry.ts) 주석에 적어 뒀다: 창구마다 판단하면 그중 하나는
// 반드시 위험 등급을 빼먹는다.
//
// ─────────────────────────────────────────────────────────────
// 이 파일에서 가장 중요한 것: 입력창에서는 단축키가 **터지지 않는다**
// ─────────────────────────────────────────────────────────────
// 매매 앱에서 `Shift+B`를 시장가 매수에 걸어 두면, 수량 입력칸에 숫자를
// 치다가 대문자 B가 들어가는 순간 주문이 나간다. 메모칸에 'BTC 봐야 함'을
// 적는 것도 같은 결과다. 그래서 포커스가 입력 요소에 있으면 조건 없이
// 무시한다. "입력 중일 때는 빼자"가 아니라 **기본이 무시**다.
//
// ─────────────────────────────────────────────────────────────
// 순서(시퀀스)를 반복 횟수와 같은 방식으로 다룬다
// ─────────────────────────────────────────────────────────────
// `g m`(시장으로 이동)과 `esc esc esc`(전체 취소)는 구현상 같은 문제다 —
// "정해진 순서의 키가 제한 시간 안에 들어왔는가". 특수 처리를 따로 두면
// 한쪽에만 있는 버그가 생긴다. 그래서 하나의 버퍼로 처리한다.

import type { Command } from './types';

/** 시퀀스가 끊기는 시간. 이보다 오래 쉬면 버퍼를 버린다 */
export const SEQUENCE_TIMEOUT_MS = 1200;

/**
 * `guarded` 커맨드의 두 번째 입력을 기다리는 시간.
 *
 * 팔레트는 화면에 확인 문구가 남아 있어 여유가 있지만, 단축키는 화면에
 * 아무것도 없을 수 있다. 너무 길게 두면 한참 뒤에 같은 키를 눌렀을 때
 * "확인"으로 해석돼 의도하지 않은 실행이 된다.
 */
export const CONFIRM_WINDOW_MS = 4000;

// ── 키 이름 정규화 ────────────────────────────────────────────

/** 브라우저가 주는 key 값을 짧은 이름으로 */
const KEY_ALIAS: Record<string, string> = {
  escape: 'esc',
  ' ': 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  delete: 'del',
};

/** 이름이 있는 키 (한 글자가 아닌 것) */
const NAMED_KEYS = new Set([
  'esc', 'space', 'up', 'down', 'left', 'right', 'del',
  'enter', 'tab', 'backspace', 'home', 'end', 'pageup', 'pagedown',
]);

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * 이벤트 → 코드(chord) 문자열. 예: `mod+k`, `shift+b`, `esc`, `?`
 *
 * ctrl과 meta를 둘 다 `mod`로 합친다. 맥과 윈도우에 각각 바인딩을 두면
 * 한쪽만 고치는 일이 생기고, 사용자는 자기 OS에서만 안 되는 것을 본다.
 *
 * shift를 붙이는 규칙이 까다롭다: `Shift+/`를 누르면 브라우저는 key로 `?`를
 * 준다. 여기에 `shift+`를 붙이면 `shift+?`가 되는데, 사용자가 기대하는
 * 이름은 `?`다. 그래서 **shift가 이미 문자에 반영된 경우(글자가 아닌 키)는
 * 접두사를 붙이지 않는다.** 글자(a~z)와 이름 있는 키에만 붙인다.
 */
export function normalizeChord(e: KeyEventLike): string {
  const raw = String(e.key ?? '');
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const key = KEY_ALIAS[lower] ?? lower;

  // 수정키 자체가 눌린 것은 코드가 아니다
  if (key === 'shift' || key === 'control' || key === 'meta' || key === 'alt') return '';

  const isLetter = key.length === 1 && key >= 'a' && key <= 'z';
  const isNamed = NAMED_KEYS.has(key);

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && (isLetter || isNamed)) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

// ── 포커스 가드 ───────────────────────────────────────────────

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  /** input의 type 속성 */
  type?: string;
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * 이 대상에 포커스가 있으면 단축키를 무시해야 하는가.
 *
 * INPUT 전체를 무시한다 — 체크박스나 버튼형 input만 골라 허용하고 싶어질
 * 수 있지만, 그 예외 목록이 틀리는 순간 조용히 주문이 나간다. 단축키
 * 하나 못 쓰는 불편과 잘못된 주문은 비교 대상이 아니다.
 */
export function shouldIgnoreTarget(t: TargetLike | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = String(t.tagName ?? '').toUpperCase();
  return TEXT_ENTRY_TAGS.has(tag);
}

// ── 바인딩 ────────────────────────────────────────────────────

export interface Binding {
  /** 공백으로 구분한 코드 순서. `g m`, `esc esc esc`, `mod+k` */
  sequence: string;
  /** 실행할 커맨드 id (registry의 id) */
  commandId: string;
  /** 도움말에 보여줄 설명 */
  label: string;
  /**
   * 주문·청산에 관한 단축키인가.
   *
   * 이 표시가 있는 바인딩은 `enableTrading`이 켜져 있을 때만 동작한다.
   * 기본은 꺼짐 — 매매 단축키는 켜는 순간부터 손이 기억하기 전까지가
   * 가장 위험한 구간이라, 사용자가 스스로 켜야 한다.
   */
  trading?: boolean;
}

/**
 * 기본 키맵.
 *
 * 여기에 **주문 단축키가 없다.** `Shift+B`(시장가 풀매수) 같은 것을 요청
 * 받았지만, 지금 레지스트리에는 주문 커맨드가 없다(registry.ts 참조 —
 * 킬스위치조차 connectionId 때문에 화면 이동으로만 넣었다). 없는 커맨드에
 * 키를 걸면 눌러도 아무 일이 없고, 그건 "고장"인데 화면에서는 구분되지
 * 않는다. 주문 커맨드를 배선할 때 여기에 `trading: true`로 추가한다.
 *
 * `g`로 시작하는 두 단계 조합을 쓰는 이유: 한 글자 단축키는 개수가 금방
 * 떨어지고, 무엇보다 오타로 눌리기 쉽다. 이동은 급할 일이 없으니 두 번
 * 누르는 편이 낫다.
 */
export const DEFAULT_BINDINGS: Binding[] = [
  { sequence: 'mod+k', commandId: 'palette.open',   label: '빠른 명령 팔레트' },
  { sequence: '?',     commandId: 'help.keys',      label: '단축키 도움말' },
  { sequence: 'g m',   commandId: 'menu.market',    label: '시장 보기로' },
  { sequence: 'g n',   commandId: 'menu.news',      label: '뉴스로' },
  { sequence: 'g c',   commandId: 'menu.calendar',  label: '경제캘린더로' },
  { sequence: 'g p',   commandId: 'menu.portfolio', label: '포트폴리오로' },
  { sequence: 'g a',   commandId: 'menu.auto',      label: '자동매매로' },
  { sequence: 'g t',   commandId: 'nav.terminal',   label: 'Pro 터미널로' },
  { sequence: 'g r',   commandId: 'menu.risk_settings', label: '리스크 관리로' },
  { sequence: 'g s',   commandId: 'menu.settings',  label: '설정으로' },
];

export interface HotkeyProfile {
  bindings: Binding[];
  /** 매매 단축키를 켤지. 기본 꺼짐 */
  enableTrading: boolean;
}

export const DEFAULT_PROFILE: HotkeyProfile = {
  bindings: DEFAULT_BINDINGS,
  enableTrading: false,
};

/** 지금 쓸 수 있는 바인딩만 */
export function activeBindings(profile: HotkeyProfile): Binding[] {
  return profile.bindings.filter(b => !b.trading || profile.enableTrading);
}

// ── 시퀀스 판정 ───────────────────────────────────────────────

export interface SequenceState {
  /** 지금까지 눌린 코드 */
  buffer: string[];
  /** 마지막 입력 시각 (epoch ms) */
  lastAt: number;
}

export const EMPTY_SEQUENCE: SequenceState = { buffer: [], lastAt: 0 };

export interface FeedResult {
  state: SequenceState;
  /** 완성된 바인딩. 없으면 null */
  match: Binding | null;
  /** 더 눌러야 완성되는 중간 상태인가 (화면에 힌트를 띄울 수 있다) */
  pending: boolean;
}

/**
 * 코드 하나를 흘려 넣고 결과를 본다. 순수 함수 — 시각을 인자로 받는다.
 *
 * 규칙:
 *  1. 마지막 입력에서 너무 오래 쉬었으면 버퍼를 버린다
 *  2. 버퍼 + 이번 코드가 어떤 바인딩과 **정확히** 같으면 실행
 *  3. 아니고 어떤 바인딩의 **앞부분**이면 기다린다
 *  4. 둘 다 아니면 버퍼를 버리고, **이번 코드 하나로 다시 시도한다**
 *
 * 4번이 중요하다. `g` 다음에 엉뚱한 `x`를 누르고 다시 `g m`을 치는 흔한
 * 경우, 버퍼만 비우고 끝내면 그 `g`가 먹히지 않아 한 번 더 눌러야 한다.
 * 사용자는 단축키가 씹혔다고 느낀다.
 */
export function feedChord(
  prev: SequenceState,
  chord: string,
  nowMs: number,
  bindings: Binding[],
): FeedResult {
  if (!chord) return { state: prev, match: null, pending: false };

  const stale = prev.buffer.length > 0 && nowMs - prev.lastAt > SEQUENCE_TIMEOUT_MS;
  const base = stale ? [] : prev.buffer;

  const tryBuffer = (buf: string[]): FeedResult | null => {
    const joined = buf.join(' ');
    const exact = bindings.find(b => b.sequence === joined);
    if (exact) {
      // 실행했으면 버퍼를 비운다. 남겨 두면 다음 키가 이어진 것으로 읽힌다.
      return { state: { buffer: [], lastAt: nowMs }, match: exact, pending: false };
    }
    const isPrefix = bindings.some(b => b.sequence.startsWith(joined + ' '));
    if (isPrefix) {
      return { state: { buffer: buf, lastAt: nowMs }, match: null, pending: true };
    }
    return null;
  };

  const withBase = tryBuffer([...base, chord]);
  if (withBase) return withBase;

  // 버퍼를 버리고 이번 코드 하나로 다시 본다
  if (base.length > 0) {
    const alone = tryBuffer([chord]);
    if (alone) return alone;
  }

  return { state: { buffer: [], lastAt: nowMs }, match: null, pending: false };
}

// ── 확인이 필요한 커맨드의 두 번째 입력 ───────────────────────

export interface ConfirmState {
  commandId: string | null;
  askedAt: number;
}

export const NO_CONFIRM: ConfirmState = { commandId: null, askedAt: 0 };

export type HotkeyOutcome =
  /** 바로 실행한다 */
  | { kind: 'run'; command: Command; confirm: ConfirmState }
  /** 확인을 요청한다 — 같은 단축키를 한 번 더 누르면 실행 */
  | { kind: 'ask'; command: Command; confirm: ConfirmState }
  /** 실행할 것이 없다 */
  | { kind: 'none'; confirm: ConfirmState };

/**
 * 매칭된 바인딩을 어떻게 처리할지.
 *
 * `guarded`면 첫 입력은 확인 요청이고, 제한 시간 안에 같은 단축키를 다시
 * 눌러야 실행된다. 팔레트의 'Enter 두 번'과 같은 규칙이다 — 판단을 두 곳에
 * 나눠 적지 않기 위해 needsConfirm 하나만 본다.
 */
export function resolveOutcome(
  command: Command | null,
  prev: ConfirmState,
  nowMs: number,
  needsConfirm: (c: Command) => boolean,
): HotkeyOutcome {
  if (!command) return { kind: 'none', confirm: prev };

  if (!needsConfirm(command)) {
    return { kind: 'run', command, confirm: NO_CONFIRM };
  }

  const fresh = prev.commandId === command.id && nowMs - prev.askedAt <= CONFIRM_WINDOW_MS;
  if (fresh) return { kind: 'run', command, confirm: NO_CONFIRM };

  return { kind: 'ask', command, confirm: { commandId: command.id, askedAt: nowMs } };
}

/** 도움말 표시용 — 코드를 사람이 읽는 모양으로 */
export function prettyChord(sequence: string, isMac: boolean): string {
  return sequence
    .split(' ')
    .map(chord =>
      chord
        .split('+')
        .map(part => {
          if (part === 'mod') return isMac ? '⌘' : 'Ctrl';
          if (part === 'shift') return isMac ? '⇧' : 'Shift';
          if (part === 'alt') return isMac ? '⌥' : 'Alt';
          if (part === 'esc') return 'Esc';
          if (part === 'space') return 'Space';
          if (part.length === 1) return part.toUpperCase();
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(isMac ? '' : '+'))
    .join(' 다음 ');
}
