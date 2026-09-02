// src/lib/ui/richText.ts
//
// **글로 적어 둔 구조를 화면에서 잃지 않는다.**
//
// 아카데미 본문은 문단(`\n\n`)과 강조(`**...**`)를 담고 있는데, 화면은
// 문자열 하나를 그대로 `<div>`에 넣고 있었다. 그러면 문단은 한 덩어리로
// 붙고 `**`는 별표 두 개로 보인다. 읽는 사람 입장에서는 글이 깨진 것이다.
//
// 마크다운 라이브러리를 새로 넣지 않는다. 필요한 것은 두 가지뿐이고,
// 그 두 가지의 판단은 화면 없이 확인할 수 있어야 하므로 여기에 둔다.

/** 강조 여부가 표시된 글 조각 */
export interface TextChunk {
  text: string;
  strong: boolean;
}

/** 빈 줄로 문단을 나눈다. 빈 문단은 버린다. */
export function splitParagraphs(src: unknown): string[] {
  if (typeof src !== 'string') return [];
  return src.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * `**...**`를 강조 조각으로 나눈다.
 *
 * 짝이 맞지 않는 `**`는 강조로 읽지 않고 **글자 그대로 남긴다.** 여는
 * 표시만 있는 글을 끝까지 강조로 칠하면 원래 글보다 센 인상을 준다.
 */
export function parseEmphasis(src: unknown): TextChunk[] {
  if (typeof src !== 'string' || src === '') return [];
  const out: TextChunk[] = [];
  let rest = src;
  while (rest.length > 0) {
    const open = rest.indexOf('**');
    if (open < 0) break;
    const close = rest.indexOf('**', open + 2);
    if (close < 0) break;              // 짝이 없다 — 나머지는 평문이다
    const inner = rest.slice(open + 2, close);
    if (inner.length === 0) {          // `****`는 강조할 것이 없다
      out.push({ text: rest.slice(0, close + 2), strong: false });
      rest = rest.slice(close + 2);
      continue;
    }
    if (open > 0) out.push({ text: rest.slice(0, open), strong: false });
    out.push({ text: inner, strong: true });
    rest = rest.slice(close + 2);
  }
  if (rest.length > 0) out.push({ text: rest, strong: false });
  return out;
}
