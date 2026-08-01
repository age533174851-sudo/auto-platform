// src/lib/commands/keymap.test.ts
//
// 단축키에서 틀리면 안 되는 것 순서대로:
//   1. 입력창에서 터지지 않는가        ← 여기가 틀리면 주문이 나간다
//   2. 확인이 필요한 것이 확인을 거치는가
//   3. 순서가 제대로 잡히는가

import { test, eq, assert } from '../../test/harness';
import {
  normalizeChord, shouldIgnoreTarget, feedChord, resolveOutcome, prettyChord,
  activeBindings, DEFAULT_BINDINGS, DEFAULT_PROFILE,
  EMPTY_SEQUENCE, NO_CONFIRM, SEQUENCE_TIMEOUT_MS, CONFIRM_WINDOW_MS,
  type Binding, type SequenceState,
} from './keymap';
import { needsConfirm, EXTRA_COMMANDS } from './registry';
import type { Command } from './types';

const NOW = 1_000_000;

const BINDINGS: Binding[] = [
  { sequence: 'mod+k',        commandId: 'palette.open', label: '팔레트' },
  { sequence: 'g m',          commandId: 'menu.market',  label: '시장' },
  { sequence: 'g n',          commandId: 'menu.news',    label: '뉴스' },
  { sequence: 'esc esc esc',  commandId: 'order.cancelAll', label: '전체 취소', trading: true },
  { sequence: 'shift+b',      commandId: 'order.buy',    label: '시장가 매수', trading: true },
];

const cmd = (id: string, danger: Command['danger'] = 'safe'): Command => ({
  id, label: id, cat: 'c', danger, action: { kind: 'invoke', value: id },
});

export function runKeymapTests() {
  console.log('[단축키 — 입력창에서는 터지지 않는다]');

  test('input에 포커스가 있으면 무시한다 — 수량칸의 B가 매수가 되면 안 된다', () => {
    eq(shouldIgnoreTarget({ tagName: 'INPUT' }), true);
    eq(shouldIgnoreTarget({ tagName: 'input' }), true, '소문자 태그명도 잡아야 한다');
  });

  test('textarea·select도 무시한다', () => {
    eq(shouldIgnoreTarget({ tagName: 'TEXTAREA' }), true);
    eq(shouldIgnoreTarget({ tagName: 'SELECT' }), true);
  });

  test('contenteditable도 무시한다 — 메모에 BTC를 적다가 주문이 나가면 안 된다', () => {
    eq(shouldIgnoreTarget({ tagName: 'DIV', isContentEditable: true }), true);
  });

  test('체크박스형 input도 무시한다 — 예외 목록이 틀리는 순간 주문이 나간다', () => {
    eq(shouldIgnoreTarget({ tagName: 'INPUT', type: 'checkbox' }), true);
    eq(shouldIgnoreTarget({ tagName: 'INPUT', type: 'range' }), true);
  });

  test('일반 요소에서는 동작한다', () => {
    eq(shouldIgnoreTarget({ tagName: 'DIV' }), false);
    eq(shouldIgnoreTarget({ tagName: 'BODY' }), false);
    eq(shouldIgnoreTarget({ tagName: 'BUTTON' }), false);
  });

  test('대상이 없으면 막지 않는다', () => {
    eq(shouldIgnoreTarget(null), false);
    eq(shouldIgnoreTarget(undefined), false);
  });

  console.log('[단축키 — 키 이름 정규화]');

  test('맥과 윈도우를 같은 코드로 — mod 하나로 합친다', () => {
    eq(normalizeChord({ key: 'k', metaKey: true }), 'mod+k');
    eq(normalizeChord({ key: 'k', ctrlKey: true }), 'mod+k');
  });

  test('대문자로 들어와도 소문자 코드', () => {
    eq(normalizeChord({ key: 'K', metaKey: true }), 'mod+k');
    eq(normalizeChord({ key: 'B', shiftKey: true }), 'shift+b');
  });

  test('이름 있는 키를 짧게', () => {
    eq(normalizeChord({ key: 'Escape' }), 'esc');
    eq(normalizeChord({ key: 'ArrowUp' }), 'up');
    eq(normalizeChord({ key: ' ' }), 'space');
  });

  test('shift가 이미 문자에 반영된 경우는 shift를 붙이지 않는다', () => {
    // Shift+/ → 브라우저가 '?'를 준다. 'shift+?'가 아니라 '?'로 봐야
    // 사용자가 기대하는 이름과 맞는다.
    eq(normalizeChord({ key: '?', shiftKey: true }), '?');
    eq(normalizeChord({ key: '!', shiftKey: true }), '!');
  });

  test('글자와 이름 있는 키에는 shift를 붙인다', () => {
    eq(normalizeChord({ key: 'b', shiftKey: true }), 'shift+b');
    eq(normalizeChord({ key: 'Escape', shiftKey: true }), 'shift+esc');
  });

  test('수정키 순서가 고정이다 — 같은 조합이 두 이름을 갖지 않게', () => {
    eq(normalizeChord({ key: 'b', metaKey: true, altKey: true, shiftKey: true }), 'mod+alt+shift+b');
  });

  test('수정키만 누른 것은 코드가 아니다', () => {
    eq(normalizeChord({ key: 'Shift', shiftKey: true }), '');
    eq(normalizeChord({ key: 'Control', ctrlKey: true }), '');
    eq(normalizeChord({ key: 'Meta', metaKey: true }), '');
    eq(normalizeChord({ key: 'Alt', altKey: true }), '');
  });

  test('빈 키는 빈 코드', () => {
    eq(normalizeChord({ key: '' }), '');
  });

  console.log('[단축키 — 순서]');

  test('한 번에 끝나는 단축키', () => {
    const r = feedChord(EMPTY_SEQUENCE, 'mod+k', NOW, BINDINGS);
    eq(r.match?.commandId, 'palette.open');
    eq(r.pending, false);
    eq(r.state.buffer.length, 0, '실행 후에는 버퍼를 비운다');
  });

  test('두 단계 조합 — g 다음 m', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    eq(a.match, null);
    eq(a.pending, true, 'g는 아직 완성이 아니다');
    const b = feedChord(a.state, 'm', NOW + 200, BINDINGS);
    eq(b.match?.commandId, 'menu.market');
    eq(b.pending, false);
  });

  test('같은 접두사에서 다른 갈래로', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    eq(feedChord(a.state, 'n', NOW + 100, BINDINGS).match?.commandId, 'menu.news');
  });

  test('반복 입력도 같은 방식 — esc 세 번', () => {
    let s: SequenceState = EMPTY_SEQUENCE;
    let r = feedChord(s, 'esc', NOW, BINDINGS);
    eq(r.match, null); eq(r.pending, true);
    r = feedChord(r.state, 'esc', NOW + 100, BINDINGS);
    eq(r.match, null); eq(r.pending, true);
    r = feedChord(r.state, 'esc', NOW + 200, BINDINGS);
    eq(r.match?.commandId, 'order.cancelAll', '세 번째에 완성돼야 한다');
  });

  test('esc 두 번만 누르면 아무 일도 없다', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'esc', NOW, BINDINGS);
    const b = feedChord(a.state, 'esc', NOW + 100, BINDINGS);
    eq(b.match, null);
  });

  test('너무 오래 쉬면 순서가 끊긴다', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    const b = feedChord(a.state, 'm', NOW + SEQUENCE_TIMEOUT_MS + 1, BINDINGS);
    eq(b.match, null, '시간이 지났으면 실행되면 안 된다');
    eq(b.pending, false);
  });

  test('제한 시간 경계에서는 아직 이어진다', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    const b = feedChord(a.state, 'm', NOW + SEQUENCE_TIMEOUT_MS, BINDINGS);
    eq(b.match?.commandId, 'menu.market');
  });

  test('엉뚱한 키를 눌렀다가 다시 g m을 치면 먹는다 — 버퍼만 비우면 한 번 씹힌다', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    const b = feedChord(a.state, 'x', NOW + 100, BINDINGS);
    eq(b.match, null);
    eq(b.pending, false, 'x로는 아무것도 시작되지 않는다');
    const c = feedChord(b.state, 'g', NOW + 200, BINDINGS);
    eq(c.pending, true, '여기서 g가 다시 시작돼야 한다');
    eq(feedChord(c.state, 'm', NOW + 300, BINDINGS).match?.commandId, 'menu.market');
  });

  test('g 다음 g는 새 g로 다시 시작한다', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    const b = feedChord(a.state, 'g', NOW + 100, BINDINGS);
    eq(b.pending, true, '두 번째 g가 새 시작이어야 한다');
    eq(feedChord(b.state, 'm', NOW + 200, BINDINGS).match?.commandId, 'menu.market');
  });

  test('빈 코드는 상태를 건드리지 않는다 — Shift만 눌러도 순서가 깨지면 안 된다', () => {
    const a = feedChord(EMPTY_SEQUENCE, 'g', NOW, BINDINGS);
    const b = feedChord(a.state, '', NOW + 100, BINDINGS);
    eq(b.state.buffer.join(' '), 'g', '버퍼가 유지돼야 한다');
    eq(feedChord(b.state, 'm', NOW + 200, BINDINGS).match?.commandId, 'menu.market');
  });

  console.log('[단축키 — 확인 단계]');

  test('safe는 바로 실행한다', () => {
    const r = resolveOutcome(cmd('menu.market'), NO_CONFIRM, NOW, needsConfirm);
    eq(r.kind, 'run');
  });

  test('reducing도 바로 실행한다 — 급할 때 확인창이 뜨면 그게 손실이다', () => {
    const r = resolveOutcome(cmd('risk.kill', 'reducing'), NO_CONFIRM, NOW, needsConfirm);
    eq(r.kind, 'run');
  });

  test('guarded는 첫 입력에 실행되지 않는다', () => {
    const r = resolveOutcome(cmd('order.buy', 'guarded'), NO_CONFIRM, NOW, needsConfirm);
    eq(r.kind, 'ask');
    eq(r.confirm.commandId, 'order.buy');
  });

  test('제한 시간 안에 같은 단축키를 다시 누르면 실행된다', () => {
    const first = resolveOutcome(cmd('order.buy', 'guarded'), NO_CONFIRM, NOW, needsConfirm);
    const second = resolveOutcome(cmd('order.buy', 'guarded'), first.confirm, NOW + 500, needsConfirm);
    eq(second.kind, 'run');
    eq(second.confirm.commandId, null, '실행 후에는 확인 상태를 비운다');
  });

  test('시간이 지나면 다시 물어본다 — 한참 뒤의 같은 키가 확인으로 읽히면 안 된다', () => {
    const first = resolveOutcome(cmd('order.buy', 'guarded'), NO_CONFIRM, NOW, needsConfirm);
    const late = resolveOutcome(
      cmd('order.buy', 'guarded'), first.confirm, NOW + CONFIRM_WINDOW_MS + 1, needsConfirm);
    eq(late.kind, 'ask', '다시 확인을 요청해야 한다');
  });

  test('다른 커맨드의 확인 상태는 이어지지 않는다', () => {
    const first = resolveOutcome(cmd('order.buy', 'guarded'), NO_CONFIRM, NOW, needsConfirm);
    const other = resolveOutcome(cmd('order.sell', 'guarded'), first.confirm, NOW + 100, needsConfirm);
    eq(other.kind, 'ask', '매수 확인이 매도 실행으로 넘어가면 안 된다');
  });

  test('커맨드가 없으면 아무 일도 없다', () => {
    const r = resolveOutcome(null, NO_CONFIRM, NOW, needsConfirm);
    eq(r.kind, 'none');
  });

  console.log('[단축키 — 기본 키맵]');

  test('기본 키맵에 매매 단축키가 없다 — 없는 커맨드에 키를 걸지 않는다', () => {
    for (const b of DEFAULT_BINDINGS) {
      eq(b.trading, undefined, `${b.sequence}에 매매 표시가 붙어 있다`);
    }
  });

  test('매매 단축키는 기본으로 꺼져 있다', () => {
    eq(DEFAULT_PROFILE.enableTrading, false);
    const withTrading = { bindings: BINDINGS, enableTrading: false };
    const on = activeBindings(withTrading).map(b => b.commandId);
    assert(!on.includes('order.buy'), '꺼져 있는데 매수 단축키가 살아 있다');
    assert(!on.includes('order.cancelAll'), '꺼져 있는데 전체취소가 살아 있다');
    assert(on.includes('menu.market'), '일반 단축키는 살아 있어야 한다');
  });

  test('켜면 매매 단축키가 들어온다', () => {
    const on = activeBindings({ bindings: BINDINGS, enableTrading: true }).map(b => b.commandId);
    assert(on.includes('order.buy'), '켰는데 안 들어온다');
    eq(on.length, BINDINGS.length);
  });

  test('같은 순서에 두 커맨드를 걸지 않는다 — 먼저 찾은 것만 실행돼 하나는 죽는다', () => {
    const seqs = DEFAULT_BINDINGS.map(b => b.sequence);
    eq(new Set(seqs).size, seqs.length, `중복: ${seqs.join(', ')}`);
  });

  test('한 단축키가 다른 단축키의 앞부분이면 안 된다 — 앞의 것이 절대 실행되지 않는다', () => {
    for (const a of DEFAULT_BINDINGS) {
      for (const b of DEFAULT_BINDINGS) {
        if (a === b) continue;
        assert(!b.sequence.startsWith(a.sequence + ' '),
          `${a.sequence}가 ${b.sequence}의 앞부분이다`);
      }
    }
  });

  test('모든 바인딩에 설명이 있다 — 도움말에서 빈 줄이 되면 안 된다', () => {
    for (const b of DEFAULT_BINDINGS) {
      assert(!!b.label && !!b.commandId, `${b.sequence}에 설명이나 커맨드가 없다`);
    }
  });

  test('바인딩이 가리키는 커맨드가 실제로 있는 곳에서 온다', () => {
    // 없는 커맨드에 키를 걸면 눌러도 아무 일이 없다. 그건 고장인데 화면에서는
    // 구분되지 않는다. id는 EXTRA_COMMANDS에 있거나 MENU에서 온 것(menu.*)이어야
    // 한다 — MENU 항목의 실제 존재는 아래 별도 테스트가 본다.
    const extraIds = new Set(EXTRA_COMMANDS.map(c => c.id));
    for (const b of DEFAULT_BINDINGS) {
      const ok = extraIds.has(b.commandId) || b.commandId.startsWith('menu.');
      assert(ok, `${b.sequence} → ${b.commandId}: 출처가 없다`);
    }
  });

  test('menu.* 바인딩이 가리키는 메뉴 id가 실제 MENU에 있다', () => {
    // MENU_IDS는 lib/menuItems.tsx에서 그대로 옮겨 적은 것이다. menuItems를
    // import하면 lucide-react가 딸려와 테스트 러너에서 못 돈다(node_modules
    // 없음). 목록이 갈리면 이 테스트가 아니라 실제 화면에서 조용히 깨지므로,
    // 메뉴를 지울 때는 여기도 같이 봐야 한다.
    const MENU_IDS = new Set([
      'trading','strategies','fear_dca','backtest','paper','auto','autobot',
      'history','risk_settings','market','news','analysis','season','briefing',
      'calendar','scanner','portfolio','growth','dividends','ai_portfolio',
      'academy','posters','review','social','accounts','settings','alerts',
      'diagnostics','safety',
    ]);
    for (const b of DEFAULT_BINDINGS) {
      if (!b.commandId.startsWith('menu.')) continue;
      const menuId = b.commandId.slice('menu.'.length);
      assert(MENU_IDS.has(menuId), `${b.sequence} → 메뉴 '${menuId}'가 MENU에 없다`);
    }
  });

  console.log('[단축키 — 도움말 표기]');

  test('맥과 윈도우를 다르게 적는다', () => {
    eq(prettyChord('mod+k', true), '⌘K');
    eq(prettyChord('mod+k', false), 'Ctrl+K');
    eq(prettyChord('shift+b', true), '⇧B');
    eq(prettyChord('shift+b', false), 'Shift+B');
  });

  test('순서는 사람이 읽는 말로', () => {
    eq(prettyChord('g m', false), 'G 다음 M');
    eq(prettyChord('esc esc esc', false), 'Esc 다음 Esc 다음 Esc');
  });

  test('한 글자는 대문자로', () => {
    eq(prettyChord('?', false), '?');
    eq(prettyChord('g', false), 'G');
  });
}
