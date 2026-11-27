// scripts/test-strip-comments.mjs
//
// **주석을 걷는 공용 함수는 17개 검사기가 함께 쓴다.**
//
// 그래서 이 함수가 틀리면 그 17개가 **한꺼번에** 틀린다. 그런데 시험이
// 하나도 없었다. 이번에 두 가지 탈선을 실측해 고치고 그 둘을 못 박는다.
//
// ① 정규식 리터럴을 몰랐다
//
//    `/["']+/g` 를 만나면 안의 `"` 를 문자열 시작으로 읽고 **가짜 문자열
//    상태**에 빠진다. 그 상태에서는 `//` 를 주석으로 보지 않으므로
//    **주석 본문이 코드로 남는다.** `scripts/ops-runner.mjs:50` 이 그랬고,
//    인용 상태가 73·86·175·237·303행으로 이어져 410행부터 끝까지 닫히지
//    않았다. 그 바람에 106행 주석의 `vercelSha: mainSha` 가 코드로 남아,
//    그 문구를 금지하는 `check-deploy-evidence` 가 원문에서 거짓 양성을 냈다.
//
// ② 템플릿 `${ … }` 안이 코드인 것을 몰랐다
//
//    백틱만 세면 `${ … \`중첩\` … }` 에서 짝이 어긋난다.
//    `scripts/claude-exec-category.mjs` 296~327행이 그렇게 이어졌다.
//
// 실측: 걷은 결과에 `//` 줄이 남는 파일이 **1611개 중 127개 → 10개**.
// 남은 10개는 전부 **템플릿 리터럴 안의 `//`**, 즉 데이터다(생성되는 파일의
// 머리글·Pine Script 본문 등). 그건 남아야 맞다.
//
// 방향: 탈선 중에는 글자가 **남으므로** "있어야 한다"를 보는 검사가 주석에
// 적힌 문구로 **통과**한다 — 조용히 열리는 쪽이다. 반대로 나눗셈을 정규식
// 으로 오인하면 **코드를 먹는다.** 그래서 그 구분도 같이 못 박는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsComments, stripSqlComments, stripYamlComments } from './lib/strip-comments.mjs';

test('★ 정규식 리터럴 안의 인용부호에 속지 않는다', () => {
  const src = 'const re = /["\']+/g;\n// MARK\nconst keep = 1;\n';
  const out = stripJsComments(src);
  assert.doesNotMatch(out, /MARK/, '주석이 코드로 남았습니다');
  assert.match(out, /const keep = 1/);
});

test('★ 문자 클래스 안의 / 는 정규식의 끝이 아니다', () => {
  const out = stripJsComments('const re = /[/"]/g;\n// MARK\nconst keep = 1;\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /const keep = 1/);
});

test('★ 템플릿 ${ } 안은 코드다 — 중첩 백틱에 어긋나지 않는다', () => {
  const out = stripJsComments('const s = `a ${ `b` } c`;\n// MARK\nconst keep = 1;\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /const keep = 1/);
});

test('★ ${ } 안의 객체 리터럴 중괄호를 세어 템플릿으로 돌아온다', () => {
  const out = stripJsComments('const s = `${ {a: 1}.a } tail`;\n// MARK\nconst keep = 1;\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /const keep = 1/);
});

test('나눗셈을 정규식으로 오인해 코드를 먹지 않는다 — 좁히는 쪽 대조', () => {
  // 이쪽으로 틀리면 **코드가 사라진다.** 금지 문구를 보는 검사가 조용히
  // 아무것도 못 보게 되므로, 위 ★들보다 이 대조가 더 중요하다.
  const out = stripJsComments('const a = x / y;\nconst b = z / w;\nconst KEEP = 1;\n');
  assert.match(out, /const a = x \/ y/);
  assert.match(out, /const b = z \/ w/);
  assert.match(out, /KEEP/);
});

test('키워드 뒤의 / 는 정규식이다', () => {
  const out = stripJsComments('function f(s){ return /a"b/.test(s); }\n// MARK\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /return \/a"b\/\.test/);
});

test('템플릿·문자열 안의 // 는 데이터이므로 남는다', () => {
  assert.match(stripJsComments('const s = `x\n// data\n`;\n'), /\/\/ data/);
  assert.match(stripJsComments("const u = 'https://example.com';\n"), /https:\/\/example\.com/);
});

test('평범한 줄 주석·블록 주석·JSX 주석은 걷는다', () => {
  assert.doesNotMatch(stripJsComments('// MARK\nconst x=1;'), /MARK/);
  assert.doesNotMatch(stripJsComments('/* MARK */\nconst x=1;'), /MARK/);
  assert.doesNotMatch(stripJsComments('<div>{/* MARK */}</div>'), /MARK/);
});

test('★ 실제 ops-runner.mjs — 주석 속 금지 문구가 코드로 남지 않는다', () => {
  const raw = readFileSync('scripts/ops-runner.mjs', 'utf8');
  // 그 문구는 원문의 **주석**에 역사로 적혀 있다 (앵커가 바뀌면 이 시험을 고친다)
  assert.match(raw, /예전에는 관측하지 않고/, '앵커가 바뀌었습니다');
  assert.match(raw, /vercelSha: mainSha/);
  const code = stripJsComments(raw);
  assert.doesNotMatch(code, /vercelSha\s*:\s*mainSha/,
    '주석에만 있는 금지 문구가 코드로 남았습니다 — 거짓 양성이 됩니다');
  // 같은 파일의 진짜 코드는 남아 있어야 한다
  assert.match(code, /observedVercelSha\(/);
  assert.match(code, /readVercelSha\(\)/);
});

test('★ 실제 claude-exec-category.mjs — 템플릿 뒤 주석이 코드로 남지 않는다', () => {
  const raw = readFileSync('scripts/claude-exec-category.mjs', 'utf8');
  assert.match(raw, /거부가 있을 때만 적는다/, '앵커가 바뀌었습니다');
  const code = stripJsComments(raw);
  assert.doesNotMatch(code, /거부가 있을 때만 적는다/);
});

test('stripYamlComments 는 인용 안의 # 를 자르지 않는다 (기존 계약)', () => {
  assert.equal(stripYamlComments('run: echo "a # b"').trim(), 'run: echo "a # b"');
  assert.equal(stripYamlComments('key: v  # 이유').trim(), 'key: v');
  assert.equal(stripYamlComments('color: "#fff"').trim(), 'color: "#fff"');
});

// ── SQL(마이그레이션) ─────────────────────────────────────────────
//
// 마이그레이션을 읽는 검사기들도 **줄머리만** 뗀다. `check-paper-challenge-wiring`
// 에서 실측한 구멍 세 개를 여기서 못 박는다 — 지우면 rc=1 인데 꼬리 주석으로
// 옮기면 rc=0 이었다. 그중 `c.user_id = p_user` 는 **개수를 세는** 규칙이라
// 주석이 그대로 한 곳으로 셌고, 그 조건이 빠지면 남의 챌린지가 닫힌다.

test('★ SQL 꼬리 주석을 걷는다 — 줄머리만 떼던 자리', () => {
  assert.equal(stripSqlComments('AND TRUE -- AND c.close_intent IS NULL'), 'AND TRUE ');
  assert.equal(stripSqlComments('  TRUE -- paper_event_time_guard(p_event_effective_at)'), '  TRUE ');
  assert.equal(stripSqlComments('   AND TRUE -- c.user_id = p_user'), '   AND TRUE ');
});

test('문자열·식별자 안의 -- 는 값이므로 남는다 — 좁히는 쪽 대조', () => {
  // 실제로 `054_worker_version.sql` 의 COMMENT 문구가 이 모양이다.
  for (const src of [
    "SELECT 'a--b';",
    "SELECT 'it''s--x';",
    'SELECT "col--x" FROM t;',
    "COMMENT ON COLUMN t.c IS 'SHA (ARG GIT_SHA <- fly-deploy --build-arg)';",
  ]) {
    assert.equal(stripSqlComments(src), src, `값이 잘렸습니다: ${src}`);
  }
});

test('★ 달러 인용 본문 안의 주석도 걷는다 (plpgsql 코드다)', () => {
  // 이 저장소의 마이그레이션 15개가 `AS $$ … $$` 꼴이고, 위에서 뚫린 앵커가
  // 전부 그 본문 안에 있다. 안쪽을 불투명하게 두면 아무것도 걷지 못한다.
  const src = 'AS $$\n  v := 1; -- c.user_id = p_user\n$$';
  assert.equal(stripSqlComments(src), 'AS $$\n  v := 1; \n$$');
  // 태그가 붙은 꼴도 같다
  assert.equal(stripSqlComments('$body$ x -- y\n$body$'), '$body$ x \n$body$');
  // 본문 안의 문자열은 그 안에서 다시 불투명하다
  assert.equal(stripSqlComments("$$ v := 'a--b'; -- c\n$$"), "$$ v := 'a--b'; \n$$");
});

test('위치 인자 $1 을 달러 인용 여닫이로 읽지 않는다', () => {
  assert.equal(stripSqlComments('SELECT $1, $2 -- x'), 'SELECT $1, $2 ');
});

test('블록 주석은 겹치고, 줄바꿈은 남는다', () => {
  assert.equal(stripSqlComments('a /* x /* y */ z */ b'), 'a   b');
  // 여러 줄 주석을 한 칸으로 접으면 뒤의 줄 번호가 밀린다. 처음에 접어 놓고
  // 쟀다가 `094` 의 리터럴 12개가 "사라졌다"고 나왔고, 실제로는 밀린 것이었다.
  const src = 'a\n/*\n 주석\n*/\nb';
  assert.equal(stripSqlComments(src).split('\n').length, src.split('\n').length);
});

test('★ 실제 마이그레이션 111개 — 코드 줄의 문자열 리터럴을 하나도 먹지 않는다', () => {
  // 반대 방향이 더 위험하다: 코드를 먹으면 금지 문구를 보는 검사가 조용히
  // 아무것도 못 보게 된다. 줄 정렬이 유지되는지도 같이 본다.
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 50, `마이그레이션을 못 찾았습니다 (${files.length}개)`);
  let counted = 0, lost = 0, shifted = 0;
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    const L = src.split('\n');
    const A = stripSqlComments(src).split('\n');
    if (L.length !== A.length) shifted += 1;
    for (let i = 0; i < L.length; i += 1) {
      if (/^\s*(--|\/\*|\*)/.test(L[i])) continue;          // 원래도 버려진 줄
      const dash = L[i].indexOf('--');
      for (const m of L[i].matchAll(/'(?:[^']|'')*'/g)) {
        if (dash >= 0 && m.index > dash) continue;           // 꼬리 주석 안의 값
        counted += 1;
        if (!(A[i] ?? '').includes(m[0])) lost += 1;
      }
    }
  }
  assert.equal(shifted, 0, '줄 정렬이 밀린 파일이 있습니다');
  assert.equal(lost, 0, `코드 줄의 리터럴 ${lost}개가 잘렸습니다 (센 것 ${counted}개)`);
  console.log(`    마이그레이션 ${files.length}개 · 코드 줄 리터럴 ${counted}개 · 잘린 것 0개 · 줄 정렬 유지`);
});

test('★ 실제 087 — 소유자 조건 3곳이 꼬리 주석으로 셀 수 없다', () => {
  // `check-paper-challenge-wiring` 이 세는 바로 그 조건이다.
  const src = readFileSync('supabase/migrations/087_paper_challenge_cancel.sql', 'utf8');
  const real = [...stripSqlComments(src).matchAll(/c\.user_id = p_user/g)].length;
  assert.equal(real, 3, `걷은 뒤 ${real}곳입니다 — 원문은 3곳이어야 합니다`);
  // 한 곳을 꼬리 주석으로 옮기면 2곳으로 줄어야 한다 (예전엔 3곳으로 셌다)
  const holed = src.replace('c.user_id = p_user', 'TRUE -- c.user_id = p_user');
  assert.equal([...stripSqlComments(holed).matchAll(/c\.user_id = p_user/g)].length, 2);
  // 줄머리만 떼던 예전 방식으로는 3곳으로 세어졌다 — 그게 구멍이었다
  const lineHead = (t) => t.split('\n').filter((l) => !/^\s*(--|\/\*|\*)/.test(l)).join('\n');
  assert.equal([...lineHead(holed).matchAll(/c\.user_id = p_user/g)].length, 3);
});

// ── 줄 정렬 ───────────────────────────────────────────────────────
//
// 사본이 생긴 이유 하나가 이것이었다. `check-display-layer` 의 지역 판은
// 블록 주석의 **개행을 남기고** 그 주석이 이유를 적어 두었다 — "줄 번호가
// 어긋나면 오류 위치가 틀린다". 공용 판이 접고 있었으므로, 그 검사기를
// 공용 함수로 바꾸면 `WalletPage.tsx` 의 줄이 5칸 밀려 **원문에서 거짓
// 실패**가 났다(`toFixed` 개수는 두 판 모두 2로 같았다 — 새 위반이 아니다).
//
// 공용 함수가 소비처가 필요로 하는 성질을 갖고 있지 않으면 각자 복사한다.
// 그래서 여기서 그 성질을 못 박는다.

test('★ 여러 줄 블록 주석을 걷어도 줄 수가 그대로다', () => {
  const src = 'const a = 1;\n/*\n 주석\n 두 줄\n*/\nconst b = 2;';
  const out = stripJsComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(out, /주석/);           // 내용은 사라진다
  assert.match(out.split('\n')[5], /const b = 2;/);   // 자리도 그대로다
});

test('★ 실제 src 전체 — 걷은 뒤 줄 수가 달라지는 파일이 없다', () => {
  const walk = (d) => {
    let out = [];
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) out = out.concat(walk(p));
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  };
  const files = walk('src');
  assert.ok(files.length > 500, `src 를 못 훑었습니다 (${files.length}개)`);
  const shifted = files.filter((f) => {
    const s = readFileSync(f, 'utf8');
    return s.split('\n').length !== stripJsComments(s).split('\n').length;
  });
  assert.deepEqual(shifted, [], `줄 정렬이 밀리는 파일이 있습니다: ${shifted.slice(0, 3).join(', ')}`);
  console.log(`    src ${files.length}개 · 줄 정렬 밀림 0개`);
});

test('대조 — JSX 한 줄 블록 주석은 개행을 늘리지 않는다', () => {
  // 개행을 "남긴다"가 "더한다"가 되면 반대로 밀린다.
  assert.equal(stripJsComments('<div>{/* MARK */}</div>'), '<div>{}</div>');
  assert.equal(stripJsComments('a(/* x */); b();').split('\n').length, 1);
});
