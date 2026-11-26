// scripts/test-paper-spot-audit-position.mjs
//
// **운영 DB 읽기전용 감사 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-paper-spot-holdings.mjs` 는 운영 DB 를 읽는 감사 워크플로가
// ① 읽기 전용으로만 열고 ② 그 사실을 값으로 확인하고 ③ MATCH 아니면
// 실패로 끝나는지를 본다. 그 단정이 전부 **워크플로 원문**에 걸려 있었다.
//
// 실측된 결과: 같은 글자가 머리말 주석이나 `- name:` 단계 제목에 있으면
// 그것으로 만족했다. `BEGIN TRANSACTION READ ONLY` 는 파일에 5개인데
// 실제 SQL 은 2개뿐이고(주석 1 + 단계 제목 2), 하한이 `>= 2` 라
// **실제 SQL 두 줄을 다 지워도 관문이 통과를 적었다.**
// 기계 탐침(한 줄씩 지우고 / 들여쓰기를 지키며 주석 처리) 수치:
// 후보 406 · 필요 23 · **구멍 18** → 고친 뒤 필요 36 · **구멍 0**.
//
// 아래 시험은 그 탐침에서 실제로 통과했던 변형들을 그대로 박아 둔다.
// 하나라도 다시 통과하면 그 자리에 구멍이 다시 열린 것이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-paper-spot-holdings.mjs');
const AUDIT = 'audit-production-paper-spot-holdings.yml';
const REPLAY = 'supabase-replay.yml';

/**
 * 검사기를 **격리된 작업 폴더**에서 돌린다.
 *
 * 이 검사기는 워크플로 말고도 마이그레이션·화면·소스를 읽는다. 저장소를
 * 통째로 복사하지 않고, `.github` 만 실제로 복사하고 나머지는 심링크한다.
 * 검사기 파일 자체는 저장소 경로로 부르므로 `./lib/` 를 제대로 집는다.
 * `node --test` 는 파일을 병렬로 돌리니, 실제 저장소 파일은 건드리지 않는다.
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'spot-pos-'));
  for (const e of readdirSync(REPO)) {
    if (e === '.github' || e === '.git') continue;
    symlinkSync(join(REPO, e), join(dir, e));
  }
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  cpSync(join(REPO, '.github/workflows'), join(dir, '.github/workflows'), { recursive: true });
  if (mutate) mutate((name) => join(dir, '.github/workflows', name));
  const r = spawnSync('node', [CHECKER], { cwd: dir, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 줄 번호(1부터)를 **들여쓰기를 지키며** 주석 처리한다. */
function commentOut(path, lineNo, marker) {
  const L = readFileSync(path, 'utf8').split('\n');
  const s = L[lineNo - 1];
  const indent = s.length - s.replace(/^\s*/, '').length;
  L[lineNo - 1] = s.slice(0, indent) + marker + s.slice(indent);
  writeFileSync(path, L.join('\n'));
}

function dropLines(path, nums) {
  const L = readFileSync(path, 'utf8').split('\n');
  writeFileSync(path, L.filter((_, i) => !nums.includes(i + 1)).join('\n'));
}

/** 실제 워크플로에서 어떤 모양의 줄이 몇 번째인지 — 줄 번호를 박지 않는다. */
function lineNos(name, re) {
  const L = readFileSync(join(REPO, '.github/workflows', name), 'utf8').split('\n');
  return L.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
}

test('대조군 — 실제 저장소에서 검사기가 통과한다', () => {
  const { rc, out } = runChecker(null);
  assert.equal(rc, 0, out);
});

test('★ 실제 SQL 의 읽기 전용 트랜잭션을 지우면 막힌다 (삭제·주석 둘 다)', () => {
  // 탐침에서 둘 다 rc=0 이었다 — 운영 DB 감사가 읽기 전용 0개로 돌아도
  // 관문이 ✅ 를 적는 모양이다.
  const nos = lineNos(AUDIT, /^\s*BEGIN TRANSACTION READ ONLY;/);
  assert.equal(nos.length, 2, `실제 SQL 의 BEGIN 이 2개여야 한다 (지금 ${nos.length})`);

  const dropped = runChecker((p) => dropLines(p(AUDIT), nos));
  assert.equal(dropped.rc, 1, '지웠는데 통과했다');
  assert.match(dropped.out, /읽기 전용 트랜잭션/);

  const commented = runChecker((p) => { for (const n of nos) commentOut(p(AUDIT), n, '-- '); });
  assert.equal(commented.rc, 1, 'SQL 주석 처리했는데 통과했다');
  assert.match(commented.out, /읽기 전용 트랜잭션/);
});

test('★ 읽기 전용이었다는 "값 확인"을 주석 처리하면 막힌다', () => {
  const nos = lineNos(AUDIT, /grep -q 'READ_ONLY=on'/);
  assert.equal(nos.length, 2, `값 확인이 2곳이어야 한다 (지금 ${nos.length})`);
  const r = runChecker((p) => commentOut(p(AUDIT), nos[1], '# '));
  assert.equal(r.rc, 1, '주석 처리했는데 통과했다');
  assert.match(r.out, /읽기 전용이었다는 증거/);
});

test('★ MATCH 아니면 실패로 끝내는 줄을 주석 처리하면 막힌다', () => {
  const nos = lineNos(AUDIT, /verdict.*!=.*'MATCH'/);
  assert.ok(nos.length >= 1, '판정 줄이 있어야 한다');
  const r = runChecker((p) => commentOut(p(AUDIT), nos[0], '# '));
  assert.equal(r.rc, 1);
  assert.match(r.out, /MATCH가 아닌데 성공으로 끝납니다|UNKNOWN이 있어도/);
});

test('★ heredoc 여는 줄을 주석 처리하면 막힌다 — SQL 파일이 안 만들어진다', () => {
  // 내 첫 수정이 남긴 구멍이다(:139 · :427). 원문에서 `<<'SQL'` 을 찾으면
  // 주석 처리된 여는 줄도 heredoc 으로 세어, 감사가 질의를 하나도
  // 만들지 않는데 본문이 "도는 SQL" 로 잡혔다.
  const nos = lineNos(AUDIT, /<<'SQL'/);
  assert.ok(nos.length >= 1);
  const r = runChecker((p) => commentOut(p(AUDIT), nos[0], '# '));
  assert.equal(r.rc, 1, 'heredoc 여는 줄을 주석 처리했는데 통과했다');
});

test('★ 금지 구문은 자리를 가리지 않고 잡는다 — 좁히면 그게 구멍이다', () => {
  // 필수 앵커를 자리로 좁히는 것은 안전한 방향이지만, **금지** 구문을
  // 좁히면 반대로 빠져나갈 길이 생긴다. 세 자리 전부 잡아야 한다.
  const sqlAt = lineNos(AUDIT, /^\s*BEGIN TRANSACTION READ ONLY;/)[0];
  const inSql = runChecker((p) => {
    const f = p(AUDIT); const L = readFileSync(f, 'utf8').split('\n');
    L.splice(sqlAt, 0, '          INSERT INTO public.paper_positions VALUES (1);');
    writeFileSync(f, L.join('\n'));
  });
  assert.equal(inSql.rc, 1, 'SQL 본문의 쓰기 구문을 놓쳤다');
  assert.match(inSql.out, /쓰기 문장/);

  const shAt = lineNos(AUDIT, /grep -q 'READ_ONLY=on'/)[0];
  const inShell = runChecker((p) => {
    const f = p(AUDIT); const L = readFileSync(f, 'utf8').split('\n');
    L.splice(shAt, 0, '          psql -c "DELETE FROM public.paper_accounts"');
    writeFileSync(f, L.join('\n'));
  });
  assert.equal(inShell.rc, 1, '셸의 쓰기 구문을 놓쳤다');

  const envAt = lineNos(AUDIT, /^\s*ACTIVATION_SHA\s*:/)[0];
  const inYaml = runChecker((p) => {
    const f = p(AUDIT); const L = readFileSync(f, 'utf8').split('\n');
    L.splice(envAt, 0, '      NOTE_X: TRUNCATE public.paper_positions');
    writeFileSync(f, L.join('\n'));
  });
  assert.equal(inYaml.rc, 1, 'YAML 값의 쓰기 구문을 놓쳤다');
});

test('★ 재생 게이트: 088 를 부르는 줄을 주석 처리하면 막힌다', () => {
  const nos = lineNos(REPLAY, /n_ok.*-lt 90/);
  assert.equal(nos.length, 1);
  const r = runChecker((p) => commentOut(p(REPLAY), nos[0], '# '));
  assert.equal(r.rc, 1, '주석 처리했는데 통과했다');
  assert.match(r.out, /확인 건수 하한/);
});

test('설명 주석에 적힌 금지 구문으로는 불평하지 않는다 — 거짓 양성 0', () => {
  // 감사 워크플로 :153 은 heredoc 안의 `--` 주석으로 금지된 표 이름을
  // 적어 둔 자리다. 영역별로 걷지 않으면 관문이 그것을 보고 불평한다.
  const { rc, out } = runChecker(null);
  assert.equal(rc, 0, out);
  assert.doesNotMatch(out, /Supabase CLI의 장부 표/);
});
