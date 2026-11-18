// scripts/test-autodev-fence.mjs
//
// **CI가 안 돌리는 자기 점검은 없는 자기 점검이다.**
//
// `check-autodev-safety.mjs` 는 `--self-test` 로 임시 저장소를 만들어
// 울타리 판정을 실제로 돌려 본다. 그런데 2026-11-18까지 **아무도 그걸
// 부르지 않았다.** 대조군이 분명하다:
//
//     check-100x-mutations --self-test   claude-hourly-trading.yml 에서 1회
//                                        mutation-100x-pr313.yml 에서 1회
//     check-autodev-safety --self-test   **0회**
//
// 그래서 울타리 자기 점검은 사람이 손으로 돌릴 때만 돌았다. 울타리를
// 지키는 판정의 시험이 그 상태였다.
//
// 이 파일이 그 구멍을 메운다. 이름이 `test-*.mjs` 라서 `ci.yml` 의
// **글롭 하나**(`node --test scripts/test-*.mjs`)가 자동으로 집어 가고,
// `check-ci-script-tests` 가 그 글롭이 이름 목록으로 되돌아가지 못하게
// 막는다 — 워크플로를 고치지 않고 배선된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function selfTest() {
  try {
    return { code: 0, out: execFileSync(process.execPath,
      ['scripts/check-autodev-safety.mjs', '--self-test'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

test('울타리 자기 점검이 실제로 돌고 통과한다', () => {
  const r = selfTest();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ 울타리 자기 점검 \d+\/\d+/);
});

test('**셈이 0이 아니다** — 아무것도 안 보고 통과하지 않는다', () => {
  // "0/0 통과"는 통과가 아니다. 이 저장소가 두 번 당한 모양이다.
  const m = selfTest().out.match(/울타리 자기 점검 (\d+)\/(\d+)/);
  assert.ok(m, '자기 점검 수를 읽지 못했습니다');
  assert.equal(m[1], m[2]);
  assert.ok(Number(m[2]) >= 16, `자기 점검이 ${m[2]}건뿐입니다 — 시험이 사라졌을 수 있습니다`);
});

test('권한을 넓히는 다섯 모양이 전부 거부 대상으로 남아 있다', () => {
  // 시험 이름이 바뀌거나 사라지면 여기서 잡는다. 관문이 아니라
  // **관문의 시험이** 조용히 줄어드는 것을 막는다.
  const out = selfTest().out;
  for (const must of [
    '토큰 권한을 올리면 거부한다',
    '도구 허용 목록을 넓히면 거부한다',
    '시크릿을 새로 받으면 거부한다',
    '셸 본문에서 시크릿을 끌어와도 거부한다',
    '더 자주 깨어나게 하면 거부한다',
    '워크플로를 새로 만들면 거부한다',
    '워크플로를 지우면 거부한다',
  ]) {
    assert.ok(out.includes(must), `자기 점검에서 사라졌습니다: ${must}`);
  }
});

test('무해한 변경은 통과로 남아 있다 — 넓힌 쪽도 지킨다', () => {
  const out = selfTest().out;
  assert.ok(out.includes('셸 본문만 바꾸면 통과한다'));
  assert.ok(out.includes('주석만 더하면 통과한다'));
});
