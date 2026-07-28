// src/lib/nav/overlayStack.ts
//
// 열려 있는 오버레이(시트·모달)의 순서를 관리한다.
//
// 왜 순서가 필요한가
// ──────────────────
// 뒤로가기는 **맨 위 것 하나만** 닫아야 한다. 여러 개가 열려 있을 때
// 전부 닫아버리면 뒤로가기 한 번에 두 단계가 사라지고, 아무거나 닫으면
// 화면에 보이는 것은 그대로인 채 뒤에 가려진 것이 닫힌다 — 눌러도 아무
// 일이 없는 것처럼 보인다.
//
// z-index 순서로 정하지 않는 이유: 같은 층에 있는 둘 중 나중에 연 것이
// 위다. 정적인 우선순위로는 그걸 알 수 없다.

/** 열린 순서대로 쌓인 오버레이 id 목록 */
export type OverlayStack = readonly string[];

/**
 * 지금 열려 있는 것들을 반영한 새 스택.
 *
 * 이미 있던 것은 순서를 지키고, 새로 열린 것만 뒤에 붙인다. 닫힌 것은
 * 뺀다. 매번 새로 만들면 순서가 바뀌어 엉뚱한 것이 닫힌다.
 */
export function nextStack(prev: OverlayStack, openNow: readonly string[]): string[] {
  const open = new Set(openNow);
  const kept = prev.filter(id => open.has(id));
  const keptSet = new Set(kept);
  const added = openNow.filter(id => !keptSet.has(id));
  return [...kept, ...added];
}

/** 맨 위(가장 나중에 열린) 오버레이. 없으면 null */
export function topmost(stack: OverlayStack): string | null {
  return stack.length ? stack[stack.length - 1] : null;
}

/**
 * 스택 변화에 대해 히스토리를 어떻게 손볼지.
 *
 *  push  n개 → 오버레이가 열렸다. 뒤로가기가 닫을 수 있게 자리를 만든다
 *  back  n개 → 사용자가 X나 배경을 눌러 닫았다. 만들어 둔 자리를 치운다.
 *              안 치우면 뒤로가기를 눌렀을 때 아무 일도 안 일어난다
 *  none     → 뒤로가기로 닫힌 경우. 자리는 이미 브라우저가 치웠다.
 *              여기서 또 back을 부르면 이전 화면까지 넘어간다
 */
export function historyDelta(
  prevCount: number, nextCount: number, closedByPop: boolean,
): { action: 'push' | 'back' | 'none'; count: number } {
  if (nextCount > prevCount) return { action: 'push', count: nextCount - prevCount };
  if (nextCount < prevCount) {
    if (closedByPop) return { action: 'none', count: 0 };
    return { action: 'back', count: prevCount - nextCount };
  }
  return { action: 'none', count: 0 };
}
