// scripts/test-ai-council.mjs
//
// **AI 합의체가 비용과 비밀에 대해 약속한 것을 지키는지 본다.**
//
// 이 시험은 네트워크를 쓰지 않는다. `fetch`를 인자로 받는 자리에 가짜를
// 꽂아 **몇 번 불렀는지**를 센다 — 라운드 상한은 "코드에 적혀 있다"가
// 아니라 "실제로 그만큼만 부른다"로 증명해야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ROUNDS, MAX_FILES, MAX_DIFF_BYTES,
  SEATS, HOUSE_RULES, seatAvailability, packDiff, redact,
  runCouncil, buildReport, DRY_RUN_FIXTURE,
} from './ai-council.mjs';
import { parseJsonStream, buildFixture } from './ai-council-fixture.mjs';

const KEYS = { OPENAI_API_KEY: 'k-openai', ANTHROPIC_API_KEY: 'k-anthropic', GEMINI_API_KEY: 'k-gemini' };

/** 부른 횟수를 세는 가짜 fetch. 본문은 공급자 모양에 맞춰 돌려준다 */
function fakeFetch(opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    if (opts.failFor && opts.failFor(String(url))) {
      return { ok: false, status: 400, json: async () => ({ error: { message: '가짜 거절' } }) };
    }
    const text = opts.text ?? '의견 본문';
    if (String(url).includes('openai.com')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
    }
    if (String(url).includes('anthropic.com')) {
      return { ok: true, status: 200, json: async () => ({ content: [{ text }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
  };
  return { impl, calls };
}

const ctx = () => ({ title: 't', sha: 'abc', description: '', diff: 'diff' });

test('라운드는 2에서 끝난다 — 호출 횟수로 증명한다', async () => {
  assert.equal(MAX_ROUNDS, 2);
  const f = fakeFetch();
  const out = await runCouncil(ctx(), { env: { ...KEYS }, fetchImpl: f.impl });
  assert.equal(out.rounds.length, 2, '라운드 수');
  // 자리 3개 × 라운드 2 = 6회. 그 이상 부르면 비용이 새는 것이다.
  assert.equal(f.calls.length, 6, `호출 횟수 (실제 ${f.calls.length})`);
});

test('자리가 하나뿐이면 2라운드를 돌지 않는다 — 혼자 반박할 상대가 없다', async () => {
  const f = fakeFetch();
  const out = await runCouncil(ctx(), { env: { OPENAI_API_KEY: 'k' }, fetchImpl: f.impl });
  assert.equal(out.rounds.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(out.skipped.sort(), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']);
});

test('키가 없으면 크래시하지 않고 어느 키가 없는지 적는다', async () => {
  const f = fakeFetch();
  const out = await runCouncil(ctx(), { env: {}, fetchImpl: f.impl });
  assert.equal(f.calls.length, 0, '키가 없으면 한 번도 부르지 않는다');
  assert.match(out.error, /OPENAI_API_KEY/);
  assert.match(out.error, /ANTHROPIC_API_KEY/);
  assert.match(out.error, /GEMINI_API_KEY/);
  // 보고서도 터지지 않는다.
  const rep = buildReport(out, { title: 't' });
  assert.match(rep, /API 키가 하나도 없습니다/);
});

test('한 자리가 실패해도 나머지는 살아남고, 실패가 보고서에 남는다', async () => {
  const f = fakeFetch({ failFor: (u) => u.includes('anthropic.com') });
  const out = await runCouncil(ctx(), { env: { ...KEYS }, fetchImpl: f.impl });
  const r1 = out.rounds[0].results;
  const bad = r1.find((r) => r.id === 'claude');
  assert.ok(bad.error, 'claude 자리는 실패로 남는다');
  assert.match(bad.error, /AI_COUNCIL_ANTHROPIC_MODEL/, '무엇을 바꾸면 되는지 적는다');
  assert.equal(r1.filter((r) => r.text).length, 2, '나머지 둘은 본문을 받는다');
  const rep = buildReport(out, { title: 't' });
  assert.match(rep, /호출 실패/);
  assert.match(rep, /"문제 없음"이 아닙니다/, '실패를 통과로 읽지 않게 적는다');
});

test('diff 상한을 넘으면 자르고, **자른 사실을 본문에 적는다**', () => {
  const big = 'x'.repeat(MAX_DIFF_BYTES + 10);
  const p = packDiff([
    { filename: 'big.ts', changes: 999, patch: big },
    { filename: 'small.ts', changes: 1, patch: 'tiny' },
  ]);
  assert.equal(p.kept, 1, '큰 파일 하나가 들어가면 작은 것은 밀린다');
  assert.equal(p.omitted.length, 1);
  assert.match(p.body, /\[잘라냄\]/);
  assert.match(p.body, /small\.ts/, '빠진 파일의 이름은 남는다');
  assert.match(p.body, /확인하지 못했다/, '모델에게 모른다고 적으라고 알린다');
});

test('파일 수 상한을 넘으면 이름만 남기고 patch는 빼낸다', () => {
  const many = Array.from({ length: MAX_FILES + 3 }, (_, i) => ({
    filename: `f${i}.ts`, changes: 1, patch: 'p',
  }));
  const p = packDiff(many);
  assert.equal(p.kept, MAX_FILES);
  assert.equal(p.omitted.length, 3);
  for (const o of p.omitted) assert.match(o.why, /상한/);
});

test('patch 없는 파일(바이너리)을 "안 바뀐 것"으로 적지 않는다', () => {
  const p = packDiff([{ filename: 'logo.png', changes: 1 }]);
  assert.equal(p.kept, 0);
  assert.equal(p.omitted[0].filename, 'logo.png');
  assert.match(p.omitted[0].why, /patch 없음/);
});

test('키 값이 출력에 섞이면 지운다', () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-verysecretvalue123456';
  try {
    const out = redact('모델이 토큰을 되풀이했다: sk-verysecretvalue123456 끝');
    assert.ok(!out.includes('verysecretvalue'), '키 값이 남아 있다');
    assert.match(out, /\[REDACTED\]/);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test('모양만 키처럼 생긴 것도 지운다 — 환경변수에 없더라도', () => {
  const out = redact('AIzaFAKEfakefake1234 와 ghp_0123456789abcdefgh 와 sk-abcdefghijkl1234');
  assert.ok(!out.includes('AIzaFAKEfakefake1234'));
  assert.ok(!out.includes('ghp_0123456789abcdefgh'));
  assert.ok(!out.includes('sk-abcdefghijkl1234'));
});

test('자리 상태는 키의 유무만 말한다 — 값도 길이도 적지 않는다', () => {
  const a = seatAvailability({ OPENAI_API_KEY: 'k-1234567890' });
  const gpt = a.find((s) => s.id === 'gpt');
  assert.equal(gpt.present, true);
  assert.equal(JSON.stringify(a).includes('k-1234567890'), false, '값이 새어 나왔다');
  assert.equal(a.find((s) => s.id === 'claude').present, false);
  assert.equal(a.find((s) => s.id === 'gemini').present, false);
});

test('빈 문자열 키는 "있음"이 아니다', () => {
  const a = seatAvailability({ OPENAI_API_KEY: '   ' });
  assert.equal(a.find((s) => s.id === 'gpt').present, false);
});

test('프롬프트에 저장소 규칙이 실제로 실린다', async () => {
  const f = fakeFetch();
  await runCouncil(ctx(), { env: { OPENAI_API_KEY: 'k' }, fetchImpl: f.impl });
  const sent = String(f.calls[0].body.messages[0].content);
  for (const rule of HOUSE_RULES) {
    assert.ok(sent.includes(rule), `규칙이 빠졌다: ${rule}`);
  }
});

test('2라운드 프롬프트에는 **다른 자리의 1라운드 의견**이 실린다', async () => {
  const f = fakeFetch({ text: 'SEAT-OPINION-MARKER' });
  await runCouncil(ctx(), { env: { ...KEYS }, fetchImpl: f.impl });
  const second = f.calls.slice(3);
  assert.equal(second.length, 3);
  for (const c of second) {
    const body = JSON.stringify(c.body);
    assert.ok(body.includes('SEAT-OPINION-MARKER'), '남의 의견이 안 실렸다');
    assert.ok(body.includes('반박'), '반박을 요구하지 않았다');
  }
});

test('세 자리의 역할이 서로 다르다 — 같으면 토론이 아니라 메아리다', () => {
  const roles = SEATS.map((s) => s.role);
  assert.equal(new Set(roles).size, SEATS.length);
  const briefs = SEATS.map((s) => s.brief);
  assert.equal(new Set(briefs).size, SEATS.length);
});

test('보고서는 머지·배포를 하지 않았다고 적는다', () => {
  const rep = buildReport({ rounds: [], seats: [], skipped: [] }, { title: 't' });
  assert.match(rep, /머지·배포·주문을 하지 않았고/);
  assert.match(rep, /상한 2라운드/);
});

test('dry-run 고정 입력은 그대로 포장된다', () => {
  const p = packDiff(DRY_RUN_FIXTURE.files);
  assert.equal(p.kept, 1);
  assert.equal(p.omitted.length, 0);
  assert.match(p.body, /pending_orders_unreadable/);
});

// ══════════════════════════════════════════════════════════
// fixture 포장 — **목록을 못 읽은 것을 "변경 0건"으로 적지 않는다**
//
// 이 묶음이 생긴 이유: 이 포장이 워크플로 안의 인라인 JS였다. 그래서
// ① shellcheck가 `${…}`를 셸 확장으로 읽어 verify가 빨개졌고
// ② 시험을 붙일 자리가 없었다. 아래가 그 자리다.
// ══════════════════════════════════════════════════════════

test('fixture ① 한 덩어리 JSON을 읽는다', () => {
  assert.deepEqual(parseJsonStream('[{"filename":"a.ts"}]'), [[{ filename: 'a.ts' }]]);
});

test('★ fixture ② 이어 붙은 배열을 읽는다 — patch 안의 "][" 에 속지 않는다', () => {
  // `gh api --paginate` 는 페이지가 여럿이면 배열을 이어 붙여 낼 수 있다.
  // 그리고 diff 본문에는 `][` 가 흔히 들어 있다 — 문자열 밖의 괄호만 센다.
  const text = '[{"filename":"a.ts","patch":"x][y"}][{"filename":"b.ts","patch":"]["}]';
  const got = parseJsonStream(text).flat();
  assert.equal(got.length, 2);
  assert.equal(got[0].patch, 'x][y');
  assert.equal(got[1].filename, 'b.ts');
});

test('★ fixture ③ 빈 응답은 "변경 0건"이 아니다 — 던진다', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => parseJsonStream(bad), /읽지 못했습니다/,
      `빈 응답(${JSON.stringify(bad)})을 빈 목록으로 만들었다`);
  }
});

test('★ fixture ④ 깨진 JSON도 던진다 — 반쪽 응답을 목록으로 적지 않는다', () => {
  assert.throws(() => parseJsonStream('[{"filename":"a.ts"'), /읽지 못했습니다/);
});

test('★ fixture ⑤ patch 없는 파일을 버리지 않는다 — 이름이 남아야 보고서에 적힌다', () => {
  const { fixture } = buildFixture({ number: 7, title: 't' },
    [[{ filename: 'logo.png', changes: 1 }]]);
  assert.equal(fixture.files.length, 1);
  assert.equal(fixture.files[0].filename, 'logo.png');
  // packDiff 가 이것을 「patch 없음」으로 적는다. 여기서 버리면 사라진다.
  const p = packDiff(fixture.files);
  assert.equal(p.kept, 0);
  assert.match(p.omitted[0].why, /patch 없음/);
});

test('★ fixture ⑥ 이름을 못 읽은 항목 수를 0으로 뭉개지 않는다', () => {
  const { fixture, unnamed } = buildFixture({ number: 1 },
    [[{ filename: 'a.ts' }, { changes: 2 }, null]]);
  assert.equal(fixture.files.length, 1);
  assert.equal(unnamed, 2, '빠진 항목 수를 센다');
});

test('fixture ⑦ 제목·SHA·본문을 포장하고, 본문은 상한에서 자른다', () => {
  const { fixture } = buildFixture({
    number: 42, title: '제목', head: { sha: 'deadbeef' }, body: 'x'.repeat(5000),
  }, []);
  assert.equal(fixture.title, '#42 제목');
  assert.equal(fixture.sha, 'deadbeef');
  assert.equal(fixture.description.length, 4000);
});

test('fixture ⑧ PR 본문이 비어도 터지지 않는다', () => {
  const { fixture } = buildFixture(null, null);
  assert.equal(fixture.sha, null);
  assert.equal(fixture.description, '');
  assert.deepEqual(fixture.files, []);
  assert.match(fixture.title, /^#\?/, '번호를 모르면 ? 로 적는다 — 0이나 1로 지어내지 않는다');
});
