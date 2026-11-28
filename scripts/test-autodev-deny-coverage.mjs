// scripts/test-autodev-deny-coverage.mjs
//
// **낱말이 적혀 있는 것과 그 명령이 막히는 것은 다르다.**
//
// `node --test scripts/test-*.mjs` (ci.yml 의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main ed00c1a4 · 격리 worktree 에서 실제
// 금지 목록을 바꿔 넣고 `check-claude-hourly.mjs` 를 돌려서 얻은 값)
// ───────────────────────────────────────────────────────────────────
// 무인 회차의 울타리는 두 자리에서 "이 명령이 금지 목록에 있는가"를
// 물었고, 둘 다 **목록 문자열 전체에 대한 부분일치**였다:
//
//   scripts/check-claude-hourly.mjs  ⑨   m[1].includes(d)
//   scripts/lib/autodev-delivery.mjs ④   denyText.includes(d)
//
// 그래서 낱말만 들어 있으면 통과했다 (rc 만 보지 않고 ⑨ 의 문장이
// 나오는지로 귀속했다):
//
//   대조 · 원문 그대로                                      rc=0  OK
//   대조 ★★ --disallowedTools 줄을 지운다                    rc=1  OK
//   Bash(curl:*) → Bash(curl --unix-socket:*)              rc=0  구멍
//   Bash(psql:*) → Bash(psql-dump:*)                       rc=0  구멍
//   Bash(gh pr merge:*) → Bash(gh pr merge-queue:*)        rc=0  구멍
//   Bash(gh workflow run:*) → Bash(echo gh workflow run)   rc=0  구멍
//   Bash(curl:*) → Read(docs/curl.md)                      rc=0  구멍
//
// 뒤의 둘이 방향을 보여 준다 — **무해한 항목이 금지 요구를 채웠다.**
// `Read(docs/curl.md)` 는 Bash 를 하나도 막지 않는데 관문은 `curl` 이
// 막혔다고 적는다. 첫 줄은 더 조용하다: 좁은 꼴만 막아 두면 관문은
// "막혔다"고 적는데 평범한 `curl https://…` 는 그대로 열려 있다.
//
// 아직 열려 있는 쪽 (닫았다고 적지 않는다)
// ───────────────────────────────────────────────────────────────────
// ④는 `scripts/lib/autodev-delivery.mjs` 안에 있고 그 파일은 **제출 통로
// 울타리 경로**다(`check-autodev-safety.mjs` 가 막는다). 무인 회차는 자기
// 제출 통로를 고칠 수 없다 — 그 관문이 옳다. 그래서 ④는 아직 부분일치고,
// **그것이 통과한다는 사실 자체**를 아래 시험으로 남겼다. ④가 고쳐지면
// 그 시험이 먼저 깨지고, 그때 이 머리말을 같이 고치면 된다.
//
// 이 시험이 모듈 `selfTest()` 와 겹치지 않는 자리
// ───────────────────────────────────────────────────────────────────
// `scripts/lib/deny-coverage.mjs` 의 `selfTest()` 는 **합성 목록**으로
// 판정 자체를 증명하고 매 회차 검사기가 먼저 돌린다. 이 시험은 **지금
// 저장소의 실제 워크플로 두 개**를 읽어 요구 7개 × 두 갈래가 정말
// 막히는지 보고, ⑨가 쓰는 꺼내기(첫 일치 하나)의 전제를 센다.
// 판정 사본을 늘리지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MUST_STAY_DENIED, deliveryFindings } from './lib/autodev-delivery.mjs';
import {
  DENY_PROBE_ARG,
  MUST_DENY_COMMANDS,
  denyCovers,
  selfTest,
} from './lib/deny-coverage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANES = [
  { wf: '.github/workflows/claude-hourly-dev.yml', mode: 'dev' },
  { wf: '.github/workflows/claude-hourly-trading.yml', mode: 'trading' },
];

/** 실제 워크플로에서 금지 목록을 꺼낸다 — ⑨와 같은 정규식이다 */
const denyListOf = (wf) => {
  const raw = readFileSync(join(ROOT, wf), 'utf8');
  // 이 시험은 전제를 스스로 적는다. ⑨는 **첫 일치 하나**를 읽는다. 표시가
  // 한 곳뿐일 때만 "첫 일치"가 곧 "살아 있는 목록"이다. 둘이 되면 뒤쪽은
  // 아무도 보지 않으므로, 그 순간 이 시험이 먼저 깨져야 한다.
  const hits = raw.split('\n').filter((l) => l.includes('--disallowedTools'));
  assert.equal(hits.length, 1,
    `${wf}: \`--disallowedTools\` 가 ${hits.length}곳입니다 — 첫 일치만 읽는 판정이 `
    + '살아 있는 목록을 본다는 보장이 깨집니다');
  const m = raw.match(/--disallowedTools\s+"([^"]*)"/);
  assert.ok(m, `${wf}: 금지 목록을 읽지 못했습니다`);
  return m[1];
};

// ── 대조 — 지금 저장소의 실제 울타리는 요구를 모두 막는다 ──────────
//
// 이 대조가 깨지면 전수가 빨강이 된다. 깨지는 경우는 둘이다 — 누가
// 워크플로의 금지 항목을 좁혔거나, 이 판정이 지나치게 좁아졌거나.
for (const lane of LANES) {
  test(`대조 — ${lane.mode} 갈래의 실제 금지 목록이 요구를 모두 막는다`, () => {
    const deny = denyListOf(lane.wf);
    for (const d of [...MUST_DENY_COMMANDS, ...MUST_STAY_DENIED]) {
      assert.equal(denyCovers(deny, d), true,
        `${lane.wf}: \`${d}\` 가 실제로 막히지 않습니다`);
    }
  });
}

// ── ★ 실제로 돌려서 구멍이던 다섯 모양 ───────────────────────────
for (const [how, deny, cmd] of [
  ['좁은 꼴만 막는다 (맨 명령 열림)', 'Bash(curl --unix-socket:*)', 'curl'],
  ['이름이 더 긴 다른 명령', 'Bash(psql-dump:*)', 'psql'],
  ['하위 명령이 다르다', 'Bash(gh pr merge-queue:*)', 'gh pr merge'],
  ['낱말만 품은 무해한 항목', 'Bash(echo gh workflow run)', 'gh workflow run'],
  ['Bash 규칙조차 아니다', 'Read(docs/curl.md)', 'curl'],
]) {
  test(`★ ${how} — \`${deny}\` 는 \`${cmd}\` 를 막는 것이 아니다`, () => {
    assert.equal(denyCovers(deny, cmd), false,
      `부분일치로 세면 통과한다: ${deny}`);
    // 낱말은 분명히 들어 있다 — 그래서 예전 판정이 통과시켰다. 이 단정이
    // 깨지면 위의 모양이 더 이상 대조가 아니다.
    assert.ok(deny.includes(cmd), '이 모양은 낱말을 품고 있어야 대조가 성립한다');
  });
}

test('★ 맨 꼴만 막으면 인자가 붙은 호출이 지나간다', () => {
  assert.equal(denyCovers('Bash(curl)', 'curl'), false);
  assert.equal(denyCovers('Bash(curl:*)', 'curl'), true);
  assert.ok(DENY_PROBE_ARG.length > 0, '대조 인자가 비어 있으면 둘째 요구가 사라진다');
});

// ── ④ 는 아직 부분일치다 (통과한다는 사실을 남긴다) ───────────────
test('아직 열림 — deliveryFindings ④ 는 낱말만 품은 금지 목록을 통과시킨다', () => {
  // `Bash(echo git push origin main)` 는 `git push origin main` 을 하나도
  // 막지 않는다. 그런데 ④는 낱말이 있으므로 조용하다.
  const deny = MUST_STAY_DENIED.map((d) => `Bash(echo ${d})`).join(',');
  for (const d of MUST_STAY_DENIED) {
    assert.equal(denyCovers(deny, d), false,
      `대조 전제: \`${d}\` 는 실제로 막히지 않아야 한다`);
  }
  const found = deliveryFindings({ allow: '', deny, mode: 'trading' });
  const flagged = found.filter((f) => MUST_STAY_DENIED.some((d) => f.includes(d)));
  assert.deepStrictEqual(flagged, [],
    '④가 고쳐졌다면 이 시험과 이 파일 머리말을 같이 고쳐라 — '
    + `지금은 통과하는 것이 사실이다. 나온 지적: ${flagged.join(' / ')}`);
});

// ── 판정 자기 점검이 살아 있는가 ─────────────────────────────────
test('대조 — 금지 대조 판정 자기 점검이 통과한다', () => {
  const r = selfTest();
  assert.deepStrictEqual(r.failed, [], `자기 점검 실패: ${r.failed.join(' / ')}`);
  assert.ok(r.total >= 11, `자기 점검 자료가 줄었다: ${r.total}`);
});
