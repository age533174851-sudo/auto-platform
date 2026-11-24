// scripts/test-ai-issue-council.mjs
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { councilOutcome } from "./lib/council-outcome.mjs";

// ══ 판정 ══

test("댓글 0건 + 호출 전부 실패 → 실패로 끝난다 (success가 아니다)", () => {
  const r = councilOutcome({ posted: 0, r1Errors: ["x", "y"], r2Errors: ["z"] });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.summary, /호출이 전부 실패/);
  assert.match(r.summary, /아무 의견도 남기지 못했습니다/);
});

test("댓글 0건 + 오류도 0건 → 그래도 실패다 (조용히 아무것도 안 한 것)", () => {
  const r = councilOutcome({ posted: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.summary, /쓸 내용이 0/);
});

test("댓글이 하나라도 있으면 통과 — 일부 실패는 기록으로 남는다", () => {
  const r = councilOutcome({ posted: 2, r1Errors: ["a"], keyless: ["openai"] });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.summary, /남긴 댓글 2건/);
  assert.match(r.summary, /R1 오류 1건/);
  assert.match(r.summary, /키 미등록 1건 \(openai\)/);
});

test("오류 메시지 자체를 요약에 펼치지 않는다 (건수만)", () => {
  const r = councilOutcome({ posted: 0, r1Errors: ["sk-SHOULD-NOT-APPEAR"] });
  assert.ok(!r.summary.includes("SHOULD-NOT-APPEAR"), "오류 본문이 요약에 실리면 안 된다");
});

test("이상한 입력을 통과로 읽지 않는다", () => {
  for (const bad of [undefined, null, {}, { posted: "" }, { posted: NaN }, { posted: -3 }]) {
    const r = councilOutcome(bad);
    assert.equal(r.ok, false, `입력 ${JSON.stringify(bad)}`);
  }
});

// ══ 배선 ══
//
// 판정을 만들어 놓고 스크립트가 안 부르면 워크플로는 그대로 거짓
// 초록을 켠다. 이 저장소에서 가장 자주 난 고장이 그것이라 소스에서 직접 센다.

test('★ ai-issue-council.mjs가 councilOutcome을 실제로 부르고 종료코드에 반영한다', () => {
  const src = readFileSync(new URL("./ai-issue-council.mjs", import.meta.url), "utf8");
  assert.match(src, /from\s+["']\.\/lib\/council-outcome\.mjs["']/, "모듈을 import해야 한다");
  assert.match(src, /councilOutcome\(/, "불러야 한다");
  assert.match(src, /process\.exit\(\s*outcome\.exitCode\s*\)/, "종료코드에 반영해야 한다");
});

test('★ R1 오류가 R2 댓글 각주에만 의존하지 않는다 (별도 배열로 센다)', () => {
  const src = readFileSync(new URL("./ai-issue-council.mjs", import.meta.url), "utf8");
  assert.match(src, /r1Errors/, "R1 오류를 따로 모아야 한다");
  assert.match(src, /r2Errors/, "R2 오류도 따로 모아야 한다");
});
