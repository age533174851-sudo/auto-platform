// scripts/test-strip-comments-single-source.mjs
//
// **주석을 걷는 판단은 한 곳에만 있다.**
//
// `scripts/lib/strip-comments.mjs` 의 머리글이 이유를 미리 적어 두었다:
//
//   그래서 이 함수를 **한 곳에만** 둔다. 검사기마다 각자 복사해 두면 언젠가
//   한쪽만 고쳐지고, 그때부터 그 검사기는 조용히 아무것도 막지 않는다.
//
// ## 정정 — 처음 적은 숫자가 적게 센 것이었다
//
// 이 시험을 처음 쓸 때 사본을 **13개**로 적었다. 틀렸다. 그때 탐지기가
// `quote = null` **한 가지 모양**만 봤기 때문이다. 사본은 이름도 구현도
// 제각각이다 — `stripJs` · `stripTs` · `stripSql` · `stripComments` ·
// `stripTsComments` · `stripSqlComments` · `stripYamlComments` · `strip`,
// 그리고 `let q = false` 로 걷는 것까지 있다.
//
// 기준 SHA `ed00c1a4` 에서 최종 탐지기로 세니 **파일 39개**다. 이 브랜치가
// **24개**를 공용 함수로 모은 뒤 남은 것이 **18개**다 (`check-paper-capacity` ·
// `check-paper-open-atomic` · `check-mock-single-source` 는 JS 쪽만 지웠고 SQL
// 사본이 남아 있어서 양쪽에 다 센다).
//
// 숫자를 두 번 고쳤다. 13 → 38 → 39. 두 번째 정정은 **아래 대조 시험이
// 잡았다** — 탐지기가 `export function strip…` 을 못 봐서 공용 파일 자신이
// "사본 없음"으로 읽혔고, 넓히니 `check-ci-downloads` 가 새로 나왔다.
// 세는 쪽이 틀리면 래칫에 구멍이 생긴다.
//
// **못 센 것을 0으로 적지 않는다.** 숫자를 고치고, 탐지기를 넓혀서 다음에는
// 세는 쪽이 틀리지 않게 한다.
//
// ## 왜 중요한가
//
// 돌려 본 사본은 전부 **정규식 리터럴을 모른다** — `/["']+/g` 를 만나면 안의
// `"` 를 문자열 시작으로 읽고 가짜 문자열 상태에 빠지고, 그 상태에서는 `//`
// 를 주석으로 보지 않아 **주석 본문이 코드로 남는다.** 그러면 "있어야 한다"를
// 보는 규칙이 주석에 적힌 문구로 통과한다. 기계 탐침으로 실제로 돌려
// 확인했다(TS 구문 유효):
//
//   check-quantity-intent  `export function executionQuantityOf`
//     이름만 바꾸면 rc=1 · 정규식 없이 같은 주석만 rc=1 · 정규식 뒤 주석 rc=0
//   check-paper-capacity   `available: Math.max(0, balance - used)`
//     식을 바꾸면 rc=1 · 정규식 없이 같은 주석만 rc=1 · 정규식 뒤 주석 rc=0
//
// SQL 사본도 같다 — `check-paper-challenge-core` 의 지역 판은 줄 단위로
// `--` 만 떼므로 **블록 주석을 모른다**. 복합 외래키("남의 계좌·남의 챌린지에
// 줄을 붙일 수 있습니다")를 단일 칸으로 바꾸고 원문을 `/* … */` 에 남기면
// 통과했다(삭제 대조 rc=1 · 줄 주석 rc=1 · 블록 주석 **rc=0**).
//
// ## 이 시험이 하는 일 — 한 방향 래칫
//
// 사본이 **새로** 생기면 실패하고, 없애는 쪽으로는 통과한다. 아래 목록은
// "아직 남은 것"이고 대부분 **열린 PR 이 점유**해서 지금 바꾸지 못한다.
// 점유는 열린 PR 200건 전수로 쟀다 (로컬 PR head 193 + REST 7 · UNKNOWN 0).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'scripts';

/**
 * 지역 사본의 선언 이름들 (`stripJs` · `stripSql` · `stripComments` …).
 *
 * `export` 가 붙은 꼴도 센다. 처음엔 빼먹었고, 아래 대조 시험이 그것을
 * 잡았다 — 공용 파일 자신이 `export function stripJsComments(` 이라서
 * "사본이 없다"로 읽혔다. 탐지기가 못 보는 모양이 곧 래칫의 구멍이다.
 */
function localStripperNames(src) {
  return [...src.matchAll(/^(?:export\s+)?(?:function|const)\s+(strip[A-Za-z]*)\s*(?:=\s*)?\(/gm)]
    .map((m) => m[1]);
}

/**
 * 이름이 `strip*` 가 아닌 사본도 있다. 인용 상태를 들고 한 글자씩 걷는
 * 스캐너의 모양으로 잡는다 — `check-db-columns` 가 그렇다.
 */
function hasUnnamedScanner(src) {
  return /let quote = null|,\s*quote = null|let q = false/.test(src);
}

function hasLocalCopy(src) {
  return localStripperNames(src).length > 0 || hasUnnamedScanner(src);
}

/**
 * 아직 사본이 남은 파일 → 왜 남겼는지.
 *
 * 점유가 0 인데 남아 있는 것은 **다음 회차의 할 일**이다. `stripSql*` 쪽은
 * 공용 `stripSqlComments` 가 main 에 올라간 뒤에야 바꿀 수 있다 (PR #795).
 */
const STILL_COPIED = new Map([
  // ── 열린 PR 점유 ──
  ['check-claude-hourly.mjs', '점유 6'],
  ['check-credential-exposure.mjs', '점유 1'],
  ['check-db-columns.mjs', '점유 1 — #781 (이름이 strip* 가 아닌 스캐너)'],
  ['check-min-order-source.mjs', '점유 4 — #503 #583 #586 #588'],
  ['check-order-quantity-source.mjs', '점유 4 — #503 #583 #586 #588'],
  ['check-order-type-fidelity.mjs', '점유 0 — PR #807 이 지우는 중'],
  ['check-paper-challenge-finalizer.mjs', '점유 11'],
  ['check-paper-spot-holdings.mjs', '점유 1 — #792'],
  ['check-scheduler-evidence.mjs', '점유 1 — #503'],
  ['check-venue-precision.mjs', '점유 4 — #503 #583 #586 #588'],
  ['check-wiring.mjs', '점유 10'],

  // ── SQL 사본: 공용 `stripSqlComments` 가 main 에 올라간 뒤 (#795) ──
  //
  // `check-paper-capacity` · `check-paper-open-atomic` 은 이 브랜치가 **JS
  // 사본만** 지웠고 `stripSql` 이 남아 있다. `check-paper-challenge-core` 의
  // 지역 판은 줄 단위로 `--` 만 떼므로 **블록 주석을 모른다** — 복합 외래키를
  // 단일 칸으로 바꾸고 원문을 `/* … */` 에 남기면 통과했다(실측 rc=0).
  ['check-migration-catalog-types.mjs', 'SQL 사본 — #795 뒤'],
  ['check-mock-single-source.mjs', 'SQL 사본 — JS 쪽은 이번에 모았다 (#795 뒤)'],
  ['check-paper-capacity.mjs', 'SQL 사본 — JS 쪽만 지웠다 (#795 뒤)'],
  ['check-paper-challenge-core.mjs', 'SQL 사본 — 블록 주석 구멍 실측 (#795 뒤)'],
  ['check-paper-open-atomic.mjs', 'SQL 사본 — JS 쪽만 지웠다 (#795 뒤)'],

  // ── 셸 주석: 공용 파일에 셸 제거기가 없다 ──
  ['check-ci-downloads.mjs', '셸(`#`) 사본 — 공용 파일에 해당 함수가 없다'],

  // ── 바꾸면 깨진다: 공용 판이 **줄 정렬을 잃는다** ──
  //
  // 실측으로 잡았다. 이 검사기의 지역 판은 블록 주석의 **개행을 남긴다**
  // (그 주석이 이유를 적어 두었다 — "줄 번호가 어긋나면 오류 위치가 틀린다").
  // 공용 `stripJsComments` 는 블록 주석을 접으므로 `WalletPage.tsx` 의 줄이
  // 5칸 밀리고, 그 검사기의 면제가 어긋나 **원문에서 거짓 실패**가 났다
  // (`toFixed` 개수는 두 판 모두 2로 같았다 — 새 위반을 찾은 것이 아니다).
  // 공용 판이 개행을 남기도록 고친 뒤에 바꾼다 — `stripSqlComments` 는 #795
  // 에서 이미 그렇게 한다.
  ['check-display-layer.mjs', '공용 판이 줄 정렬을 잃는다 — 실측 거짓 실패'],
]);

/** 이번에 **JS** 사본을 공용 함수로 모은 파일 */
const CONVERTED = [
  // 첫 묶음 — JS 사본
  'check-execution-currency.mjs',
  'check-order-preview-currency.mjs',
  'check-paper-capacity.mjs',
  'check-paper-open-atomic.mjs',
  'check-position-sizing-display.mjs',
  'check-quantity-intent.mjs',
  'check-paper-deposit-contract.mjs',
  // 둘째 묶음 — 점유 0 인 나머지 (rc·표준출력 전문 대조 전부 동일)
  'check-exit-venue.mjs',
  'check-first-eval.mjs',
  'check-gate-spot-precision.mjs',
  'check-kill-switch-contract.mjs',
  'check-ledger-ingest.mjs',
  'check-paper-autotrade.mjs',
  'check-paper-wiring.mjs',
  'check-practice-boundary.mjs',
  'check-practice-ledger-env.mjs',
  'check-product-registry.mjs',
  'check-reconcile-truth.mjs',
  'check-scheduled-exit-runner.mjs',
  'check-spot-precision.mjs',
  'check-worker-coverage.mjs',
  'check-mock-single-source.mjs',
  // `#` 주석이라 JS 가 아니다 — 공용 YAML 제거기로 간다
  'check-admin-auth-contract.mjs',
  // 생성 러너가 아니라 워크플로를 읽는다 — 공용 YAML 제거기
  'check-wake-paths.mjs',
];

/** `stripJsComments` 가 아니라 `stripYamlComments` 로 간 것 */
const YAML_CONVERTED = new Set(['check-admin-auth-contract.mjs', 'check-wake-paths.mjs']);

test('★ 주석 걷기 사본이 새로 생기지 않는다 (래칫)', () => {
  const found = readdirSync(DIR)
    .filter((n) => /^check-.*\.mjs$/.test(n))
    .filter((n) => hasLocalCopy(readFileSync(join(DIR, n), 'utf8')));
  const unexpected = found.filter((n) => !STILL_COPIED.has(n));
  assert.deepEqual(unexpected, [],
    `주석 걷기 사본이 새로 생겼습니다 — scripts/lib/strip-comments.mjs 를 가져다 쓰세요: ${unexpected.join(', ')}`);
  console.log(`    사본 남은 파일 ${found.length}개 — 전부 목록에 사유가 적혀 있다`);
});

test('★ 모은 파일에는 해당 사본이 없고 공용 함수를 부른다', () => {
  for (const n of CONVERTED) {
    const src = readFileSync(join(DIR, n), 'utf8');
    const want = YAML_CONVERTED.has(n) ? 'stripYamlComments' : 'stripJsComments';
    // 남아 있어도 되는 것은 **다른 언어의 사본**뿐이다 (SQL 은 #795 뒤).
    const keep = YAML_CONVERTED.has(n) ? /^strip(Js|Sql|Shell)/i : /^strip(Sql|Yaml|Shell)/i;
    const same = localStripperNames(src).filter((x) => !keep.test(x));
    assert.deepEqual(same, [], `${n} 에 같은 언어의 사본이 남아 있습니다: ${same.join(', ')}`);
    assert.equal(hasUnnamedScanner(src), false, `${n} 에 이름 없는 스캐너가 남아 있습니다`);
    assert.ok(src.includes(`import { ${want} } from './lib/strip-comments.mjs'`),
      `${n} 이 공용 ${want} 를 가져오지 않습니다`);
    assert.ok(new RegExp(`${want}\\(`).test(src.replace(/import \{[^}]*\}[^\n]*\n/, '')),
      `${n} 이 공용 함수를 부르지 않습니다 — 가져다 놓고 안 쓰면 아무것도 걷지 않습니다`);
  }
  console.log(`    공용 함수로 모은 파일 ${CONVERTED.length}개`);
});

test('★ 남은 목록이 낡지 않았다 — 적힌 파일은 실제로 사본을 들고 있다', () => {
  // 목록이 사실과 멀어지면 래칫이 조용히 헐거워진다. 그 쪽도 본다.
  const gone = [];
  for (const [n, why] of STILL_COPIED) {
    assert.ok(typeof why === 'string' && why.length > 0, `${n} 에 왜 남겼는지가 없습니다`);
    let src;
    try { src = readFileSync(join(DIR, n), 'utf8'); } catch { gone.push(`${n} (파일 없음)`); continue; }
    if (!hasLocalCopy(src)) gone.push(n);
  }
  // 사라진 쪽은 좋은 방향이다 — 목록에서 지워 달라고 말해 준다 (실패시키지 않는다).
  if (gone.length) console.log(`    목록에서 지울 수 있습니다: ${gone.join(', ')}`);
});

test('대조 — 공용 파일 자신은 사본으로 세지 않는다', () => {
  // 탐지기가 `scripts/check-*.mjs` 만 본다. 공용 파일이 목록에 들어가면
  // 래칫이 영구 실패한다.
  const shared = readFileSync('scripts/lib/strip-comments.mjs', 'utf8');
  assert.ok(localStripperNames(shared).length >= 2, '공용 파일에 함수가 없습니다 — 경로가 바뀌었습니까');
  assert.equal([...STILL_COPIED.keys()].some((n) => n.includes('strip-comments')), false);
});
