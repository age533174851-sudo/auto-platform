// src/lib/ui/richText.test.ts

import { test, eq, assert } from '../../test/harness';
import { splitParagraphs, parseEmphasis } from './richText';

const flat = (s: string) => parseEmphasis(s).map(c => c.text).join('');

export function runRichTextTests() {
  console.log('[본문 렌더 — 문단과 강조를 잃지 않는다]');

  test('빈 줄로 문단을 나눈다', () => {
    eq(splitParagraphs('가\n\n나\n\n다').length, 3);
    eq(splitParagraphs('가\n나').length, 1);      // 한 줄 개행은 같은 문단
  });

  test('빈 문단은 버린다', () => {
    eq(splitParagraphs('가\n\n\n\n나').length, 2);
    eq(splitParagraphs('   ').length, 0);
    eq(splitParagraphs('').length, 0);
  });

  test('문자열이 아니면 빈 목록이다 — 던지지 않는다', () => {
    eq(splitParagraphs(null).length, 0);
    eq(splitParagraphs(undefined).length, 0);
    eq(splitParagraphs(42 as any).length, 0);
    eq(parseEmphasis(null).length, 0);
  });

  test('별표는 화면에 남지 않는다', () => {
    // 원래 고장: `**포지션 크기**`가 별표째로 보였다.
    const chunks = parseEmphasis('레버리지는 **명목가**를 키웁니다');
    assert(!chunks.some(c => c.text.includes('*')), `별표가 남았다: ${JSON.stringify(chunks)}`);
    eq(chunks.filter(c => c.strong).map(c => c.text).join(''), '명목가');
    eq(flat('레버리지는 **명목가**를 키웁니다'), '레버리지는 명목가를 키웁니다');
  });

  test('강조가 여럿이어도 각각 잡는다', () => {
    const chunks = parseEmphasis('**가**와 **나**');
    eq(chunks.filter(c => c.strong).map(c => c.text).join(','), '가,나');
    eq(flat('**가**와 **나**'), '가와 나');
  });

  test('짝이 없는 별표는 강조로 읽지 않는다', () => {
    // 여는 표시만 보고 끝까지 강조하면 원문보다 센 인상을 준다.
    const chunks = parseEmphasis('레버리지는 **위험합니다');
    eq(chunks.filter(c => c.strong).length, 0);
    eq(flat('레버리지는 **위험합니다'), '레버리지는 **위험합니다');
  });

  test('강조가 없으면 통째로 평문 한 조각이다', () => {
    const chunks = parseEmphasis('그냥 문장');
    eq(chunks.length, 1);
    eq(chunks[0].strong, false);
  });

  test('어떤 입력이든 글자를 잃지 않는다', () => {
    for (const s of ['**가**', '가**나', '****가', '가**', '**', 'a**b**c**d']) {
      const joined = flat(s);
      const stripped = s.replace(/\*\*(.+?)\*\*/g, '$1');
      assert(joined === stripped || joined.replace(/\*/g, '') === stripped.replace(/\*/g, ''),
        `글자가 바뀌었다: ${s} → ${joined}`);
    }
  });
}
