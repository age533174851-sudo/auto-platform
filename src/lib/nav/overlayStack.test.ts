// src/lib/nav/overlayStack.test.ts
//
// 막으려는 사고:
//  1. 뒤로가기 한 번에 모달과 화면이 같이 닫히는 것 — 두 단계가 사라진다
//  2. 뒤로가기가 가려진 쪽을 닫는 것 — 눌러도 아무 일이 없어 보인다
//  3. X로 닫은 뒤 만들어 둔 히스토리 자리를 안 치우는 것 — 그 다음
//     뒤로가기가 먹통이 된다
//  4. 뒤로가기로 닫혔는데 back을 또 부르는 것 — 이전 화면까지 넘어간다
import { test, assert, eq } from '../../test/harness';
import { nextStack, topmost, historyDelta } from './overlayStack';

const arrEq = (a: readonly string[], b: readonly string[]) =>
  eq(a.join(','), b.join(','));

export function runOverlayStackTests() {
  console.log('[오버레이 — 열린 순서]');

  test('새로 열린 것이 맨 위다', () => {
    arrEq(nextStack([], ['more']), ['more']);
    arrEq(nextStack(['more'], ['more', 'login']), ['more', 'login']);
    eq(topmost(nextStack(['more'], ['more', 'login'])), 'login');
  });

  test('이미 열린 것의 순서는 지킨다', () => {
    // openNow의 순서가 바뀌어도 먼저 열린 more가 아래에 남아야 한다
    arrEq(nextStack(['more', 'login'], ['login', 'more']), ['more', 'login']);
  });

  test('닫힌 것은 빠진다', () => {
    arrEq(nextStack(['more', 'login'], ['more']), ['more']);
    arrEq(nextStack(['more'], []), []);
  });

  test('가운데 것만 닫혀도 나머지 순서는 그대로', () => {
    arrEq(nextStack(['a', 'b', 'c'], ['a', 'c']), ['a', 'c']);
    eq(topmost(nextStack(['a', 'b', 'c'], ['a', 'c'])), 'c');
  });

  test('아무것도 없으면 맨 위도 없다', () => {
    eq(topmost([]), null);
  });

  console.log('[오버레이 — 히스토리 손질]');

  test('열리면 뒤로가기가 닫을 자리를 만든다', () => {
    const d = historyDelta(0, 1, false);
    eq(d.action, 'push'); eq(d.count, 1);
  });

  test('두 개가 한 번에 열리면 자리도 두 개', () => {
    const d = historyDelta(0, 2, false);
    eq(d.action, 'push'); eq(d.count, 2);
  });

  test('X로 닫으면 만들어 둔 자리를 치운다', () => {
    const d = historyDelta(1, 0, false);
    eq(d.action, 'back', '안 치우면 다음 뒤로가기가 먹통이 된다');
    eq(d.count, 1);
  });

  test('뒤로가기로 닫혔으면 아무것도 하지 않는다', () => {
    const d = historyDelta(1, 0, true);
    eq(d.action, 'none', 'back을 또 부르면 이전 화면까지 넘어간다');
    eq(d.count, 0);
  });

  test('변화가 없으면 건드리지 않는다', () => {
    eq(historyDelta(0, 0, false).action, 'none');
    eq(historyDelta(2, 2, true).action, 'none');
  });

  test('여러 개가 한 번에 닫히면 그만큼 되돌린다', () => {
    const d = historyDelta(2, 0, false);
    eq(d.action, 'back'); eq(d.count, 2);
  });
}
