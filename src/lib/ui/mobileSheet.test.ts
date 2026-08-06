// src/lib/ui/mobileSheet.test.ts
//
// 막으려는 것:
//  1. **뒤로가기가 시트를 닫는 게 아니라 화면을 벗어나는 것.** 주문
//     시트에서 수량을 다 적어 놓고 습관적으로 뒤로가기를 누르면
//     거래 화면에서 나가 버리고, 돌아오면 적어 둔 것이 없다
//  2. 히스토리에 쓰레기가 쌓여 뒤로가기를 다섯 번 눌러야 화면을
//     벗어나는 것 — 사용자에게는 앱이 멈춘 것으로 보인다
//  3. 뒤로가기 한 번에 두 칸이 물러나는 것
//  4. 키보드가 [주문] 버튼을 덮은 채로 사용자가 숫자를 치는 것
//  5. visualViewport가 없는 브라우저에서 없는 키보드 자리를 비워 두는 것
import { test, assert, eq } from '../../test/harness';
import {
  historyAction, keyboardInset, isKeyboardOpen, sheetMetrics, KEYBOARD_MIN_PX,
} from './mobileSheet';

export function runMobileSheetTests() {
  console.log('[모바일 시트 — 뒤로가기]');

  test('열리면 히스토리에 한 칸을 넣는다', () => {
    eq(historyAction({ open: false, pushed: false }, { open: true, pushed: false }), 'PUSH');
  });

  test('X로 닫으면 넣어 둔 칸을 뺀다', () => {
    // 안 빼면 쌓인다. 다섯 번 열고 닫으면 뒤로가기를 다섯 번 눌러야
    // 화면을 벗어난다 — 앱이 멈춘 것으로 보인다.
    eq(historyAction({ open: true, pushed: true }, { open: false, pushed: true }), 'POP');
  });

  test('뒤로가기로 닫힌 것에는 POP을 하지 않는다', () => {
    // 브라우저가 이미 한 칸을 뺐다. 여기서 또 빼면 뒤로가기 한 번에
    // 두 칸이 물러난다.
    eq(historyAction(
      { open: true, pushed: true },
      { open: false, pushed: true, closedByPop: true },
    ), 'NONE');
  });

  test('넣은 적이 없으면 뺄 것도 없다', () => {
    eq(historyAction({ open: true, pushed: false }, { open: false, pushed: false }), 'NONE');
  });

  test('이미 넣어 뒀으면 두 번 넣지 않는다', () => {
    eq(historyAction({ open: false, pushed: true }, { open: true, pushed: true }), 'NONE');
  });

  test('상태가 안 바뀌면 아무것도 안 한다', () => {
    eq(historyAction({ open: true, pushed: true }, { open: true, pushed: true }), 'NONE');
    eq(historyAction({ open: false, pushed: false }, { open: false, pushed: false }), 'NONE');
  });

  test('첫 렌더에 열려 있으면 넣는다', () => {
    eq(historyAction(null, { open: true, pushed: false }), 'PUSH');
    eq(historyAction(null, { open: false, pushed: false }), 'NONE');
  });

  console.log('[모바일 시트 — 키보드]');

  test('키보드가 가린 높이를 잰다', () => {
    // iOS Safari는 키보드가 올라와도 innerHeight를 안 바꾼다.
    // 바뀌는 것은 visualViewport.height다.
    eq(keyboardInset({ windowHeight: 844, viewportHeight: 508 }), 336);
    eq(isKeyboardOpen({ windowHeight: 844, viewportHeight: 508 }), true);
  });

  test('밀려 올라간 만큼도 가려진 것으로 센다', () => {
    eq(keyboardInset({ windowHeight: 844, viewportHeight: 500, offsetTop: 44 }), 300);
  });

  test('주소창이 접힌 정도는 키보드가 아니다', () => {
    // 이걸 키보드로 읽으면 스크롤할 때마다 시트가 들썩인다.
    eq(keyboardInset({ windowHeight: 844, viewportHeight: 844 - (KEYBOARD_MIN_PX - 1) }), 0);
    eq(keyboardInset({ windowHeight: 844, viewportHeight: 844 - KEYBOARD_MIN_PX }), KEYBOARD_MIN_PX);
  });

  test('못 재면 0이다 — 없는 키보드 자리를 비워 두지 않는다', () => {
    // visualViewport가 없는 브라우저에서 빈 칸이 생기면 고장으로 보인다.
    eq(keyboardInset({ windowHeight: 844 }), 0);
    eq(keyboardInset({ viewportHeight: 508 }), 0);
    eq(keyboardInset(null), 0);
    eq(keyboardInset({}), 0);
  });

  test('뷰포트가 더 큰 경우에도 음수를 내지 않는다', () => {
    // 회전 직후 한 프레임 동안 이런 값이 온다.
    eq(keyboardInset({ windowHeight: 390, viewportHeight: 844 }), 0);
  });

  console.log('[모바일 시트 — 높이와 여백]');

  test('키보드가 없으면 지금까지와 똑같다', () => {
    // 안 쓰는 브라우저에서 화면이 달라지면 안 된다.
    const m = sheetMetrics({ windowHeight: 844, viewportHeight: 844 }, 88);
    eq(m.maxHeight, '88vh');
    eq(m.keyboardOpen, false);
    assert(m.paddingBottom.includes('safe-area-inset-bottom'), m.paddingBottom);
  });

  test('키보드가 올라오면 높이를 줄이고 여백을 준다', () => {
    // 높이만 줄이면 내용이 키보드 뒤로 들어가고,
    // 여백만 주면 시트가 화면 위로 넘친다. 둘 다 해야 한다.
    const m = sheetMetrics({ windowHeight: 844, viewportHeight: 508 }, 88);
    eq(m.keyboardOpen, true);
    eq(m.maxHeight, 'calc(88vh - 336px)');
    eq(m.paddingBottom, '336px');
    assert(!m.paddingBottom.includes('safe-area'),
      '홈 인디케이터는 키보드가 덮고 있다 — 두 번 더하면 버튼이 더 밀린다');
  });

  test('시트마다 다른 최대 높이를 지킨다', () => {
    eq(sheetMetrics({ windowHeight: 844, viewportHeight: 844 }, 60).maxHeight, '60vh');
    eq(sheetMetrics({ windowHeight: 844, viewportHeight: 508 }, 60).maxHeight, 'calc(60vh - 336px)');
  });
}
