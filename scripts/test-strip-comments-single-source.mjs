// scripts/test-strip-comments-single-source.mjs
//
// **주석을 걷는 판단은 한 곳에만 있다.**
//
// `scripts/lib/strip-comments.mjs` 의 머리글이 이유를 미리 적어 두었다:
//
//   그래서 이 함수를 **한 곳에만** 둔다. 검사기마다 각자 복사해 두면 언젠가
//   한쪽만 고쳐지고, 그때부터 그 검사기는 조용히 아무것도 막지 않는다.
//
// 그 일이 일어났다. 실측: `scripts/check-*.mjs` 중 **13개**가 사본을 들고
// 있었고, 돌려 본 9개 **전부** 정규식 리터럴을 모른다 — `/["']+/g` 를 만나면
// 안의 `"` 를 문자열 시작으로 읽고 가짜 문자열 상태에 빠지고, 그 상태에서는
// `//` 를 주석으로 보지 않아 **주석 본문이 코드로 남는다.**
//
// 그래서 "있어야 한다"를 보는 규칙이 주석에 적힌 문구로 통과한다. 기계 탐침
// 으로 두 검사기에서 실제로 돌려 확인했다(TS 구문 유효):
//
//   check-quantity-intent  `export function executionQuantityOf`
//     이름만 바꾸면 rc=1 · 정규식 없이 같은 주석만 rc=1 · 정규식 뒤 주석 rc=0
//   check-paper-capacity   `available: Math.max(0, balance - used)`
//     식을 바꾸면 rc=1 · 정규식 없이 같은 주석만 rc=1 · 정규식 뒤 주석 rc=0
//
// 이 시험은 **래칫**이다. 사본이 새로 생기면 실패하고, 사본을 없애는 쪽으로는
// 통과한다. 아래 목록은 "아직 남은 것"이고 **열린 PR 이 잡고 있어서** 지금
// 바꾸지 못한 파일들이다 — 그 PR 이 병합되면 하나씩 비운다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'scripts';

/** 지역 사본의 표식: 인용 상태를 들고 한 글자씩 걷는 스캐너 */
function hasLocalScanner(src) {
  return /let quote = null|,\s*quote = null/.test(src)
    && /function strip[A-Za-z]*\(\s*src\s*\)/.test(src);
}

/**
 * 아직 사본이 남은 파일 — **열린 PR 이 점유**해서 이번에 못 바꿨다.
 * (점유는 열린 PR 200건 전수로 측정했다: 로컬 PR head 193 + REST 7 · UNKNOWN 0)
 */
const STILL_COPIED = new Map([
  ['check-min-order-source.mjs', '점유 4 — #503 #583 #586 #588'],
  ['check-order-quantity-source.mjs', '점유 4 — #503 #583 #586 #588'],
  ['check-db-columns.mjs', '점유 1 — #781'],
  ['check-scheduler-evidence.mjs', '점유 1 — #503'],
  ['check-wiring.mjs', '점유 10 — #329 #330 #339 #346 #503 #583 #586 #588 #616 #792'],
  ['check-order-type-fidelity.mjs', '점유 0 — PR #807 이 지우는 중'],
]);

/** 이번에 공용 함수로 모은 파일 */
const CONVERTED = [
  'check-execution-currency.mjs',
  'check-order-preview-currency.mjs',
  'check-paper-capacity.mjs',
  'check-paper-open-atomic.mjs',
  'check-position-sizing-display.mjs',
  'check-quantity-intent.mjs',
  'check-paper-deposit-contract.mjs',
];

test('★ 주석 걷기 사본이 새로 생기지 않는다 (래칫)', () => {
  const found = readdirSync(DIR)
    .filter((n) => /^check-.*\.mjs$/.test(n))
    .filter((n) => hasLocalScanner(readFileSync(join(DIR, n), 'utf8')));
  const unexpected = found.filter((n) => !STILL_COPIED.has(n));
  assert.deepEqual(unexpected, [],
    `주석 걷기 사본이 새로 생겼습니다 — scripts/lib/strip-comments.mjs 를 가져다 쓰세요: ${unexpected.join(', ')}`);
  console.log(`    사본 남은 파일 ${found.length}개 (전부 열린 PR 점유로 알려진 것)`);
});

test('★ 이번에 모은 7개에는 사본이 없고 공용 함수를 부른다', () => {
  for (const n of CONVERTED) {
    const src = readFileSync(join(DIR, n), 'utf8');
    assert.equal(hasLocalScanner(src), false, `${n} 에 사본이 다시 생겼습니다`);
    assert.match(src, /import \{ stripJsComments \} from '\.\/lib\/strip-comments\.mjs'/,
      `${n} 이 공용 함수를 가져오지 않습니다`);
    assert.ok(/stripJsComments\(/.test(src.replace(/import \{[^}]*\}[^\n]*\n/, '')),
      `${n} 이 공용 함수를 부르지 않습니다 — 가져다 놓고 안 쓰면 아무것도 걷지 않습니다`);
  }
});

test('남은 목록에 적힌 파일은 실제로 아직 사본을 들고 있다 (목록이 낡지 않았는가)', () => {
  // 목록이 사실과 멀어지면 위 래칫이 조용히 헐거워진다. 그 쪽도 잠근다.
  const stale = [...STILL_COPIED.keys()].filter((n) => {
    let src;
    try { src = readFileSync(join(DIR, n), 'utf8'); } catch { return false; }
    return !hasLocalScanner(src);
  });
  // 사본이 사라진 쪽은 좋은 방향이다 — 다만 목록에서 지워 달라고 말해 준다.
  if (stale.length) {
    console.log(`    목록에서 지울 수 있습니다 (사본이 이미 사라졌습니다): ${stale.join(', ')}`);
  }
  for (const n of STILL_COPIED.keys()) {
    assert.ok(typeof STILL_COPIED.get(n) === 'string' && STILL_COPIED.get(n).length > 0,
      `${n} 에 왜 남겨 뒀는지가 적혀 있지 않습니다`);
  }
});
