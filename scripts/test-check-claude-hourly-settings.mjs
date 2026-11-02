// scripts/test-check-claude-hourly-settings.mjs
//
// #533 — 무인 회차 울타리가 **워크플로 YAML만** 보던 자리를 고정한다.
//
// 왜 필요한가: 이 저장소는 `.claude/settings.local.json`을 git으로 추적한다.
// Claude Code는 체크아웃된 그 파일을 설정으로 읽고, 공식 설정 색인은
// `apiKeyHelper`와 `env`의 적용 범위를 **"Any file"** 로 적는다. 즉 커밋된
// 설정 파일에 `apiKeyHelper` 한 줄을 넣으면 **워크플로 YAML은 그대로인데**
// OAuth 전용 회차가 종량제 키로 인증할 수 있고, YAML만 읽는 검사기는
// 그것을 보지 못한다(측정: 가짜 값을 넣은 추적 파일에 대해 ✅ exit 0).
//
// 이 시험이 고정하는 것:
//
//   ① 여섯 이름을 **키 이름으로** 찾는다 (대소문자 무시)
//   ② 이름을 **품고 있을 뿐인** 다른 키는 찾지 않는다 (거짓 빨강 방지)
//   ③ **값은 절대 돌려주지 않는다** — 값이 토큰일 수 있다
//   ④ 끝까지 못 봤으면 "없음"이 아니라 `truncated`로 적는다

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOverrideKeys, overrideNameOf, OAUTH_OVERRIDE_NAMES, MAX_DEPTH,
} from './lib/oauth-override-names.mjs';

/** 이 저장소에 실제로 커밋돼 있는 모양 — 권한 규칙만 */
const REAL_SHAPE = { permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] } };

const SECRET = 'THIS-VALUE-MUST-NEVER-APPEAR-IN-OUTPUT';

test('권한 규칙만 있는 설정 — 찾는 것이 없다', () => {
  const { hits, truncated } = findOverrideKeys(REAL_SHAPE);
  assert.deepEqual(hits, []);
  assert.equal(truncated, false);
});

test('apiKeyHelper 한 줄 — 우선순위 ④로 OAuth를 밀어낸다', () => {
  const { hits } = findOverrideKeys({ ...REAL_SHAPE, apiKeyHelper: SECRET });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'apiKeyHelper');
  assert.equal(hits[0].path, 'apiKeyHelper');
});

test('env.ANTHROPIC_AUTH_TOKEN — 우선순위 ②, 경로까지 적는다', () => {
  const { hits } = findOverrideKeys({ env: { ANTHROPIC_AUTH_TOKEN: SECRET } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'env.ANTHROPIC_AUTH_TOKEN');
});

test('소문자로 적어도 찾는다 — 액션 입력·JSON 키는 표기가 섞인다', () => {
  const { hits } = findOverrideKeys({ env: { anthropic_api_key: SECRET } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'ANTHROPIC_API_KEY');
});

test('여섯 이름 전부 — 하나도 빠뜨리지 않는다', () => {
  for (const [name] of OAUTH_OVERRIDE_NAMES) {
    const { hits } = findOverrideKeys({ env: { [name]: SECRET } });
    assert.equal(hits.length, 1, `${name}을 찾지 못했습니다`);
    assert.equal(hits[0].name, name);
  }
});

test('배열·중첩 안에 숨겨도 찾는다', () => {
  const { hits } = findOverrideKeys({ a: [{ b: { apiKeyHelper: SECRET } }] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'a.[0].b.apiKeyHelper');
});

test('이름을 품고 있을 뿐인 키는 찾지 않는다 — 거짓 빨강을 만들지 않는다', () => {
  const { hits } = findOverrideKeys({
    env: { MY_ANTHROPIC_API_KEY_BACKUP: SECRET, NOTE_ABOUT_APIKEYHELPER: SECRET },
  });
  assert.deepEqual(hits, []);
});

test('값은 어디에도 돌려주지 않는다 — 값이 토큰일 수 있다', () => {
  const { hits } = findOverrideKeys({
    apiKeyHelper: SECRET,
    env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: SECRET },
  });
  assert.equal(hits.length, 3);
  assert.ok(!JSON.stringify(hits).includes(SECRET), '결과에 값이 섞여 있습니다');
});

test('너무 깊으면 "없음"이 아니라 못 봤다고 적는다', () => {
  let deep = { apiKeyHelper: SECRET };
  for (let i = 0; i <= MAX_DEPTH + 2; i += 1) deep = { nest: deep };
  const { hits, truncated } = findOverrideKeys(deep);
  assert.equal(truncated, true, '끝까지 못 봤는데 truncated가 거짓입니다');
  assert.equal(hits.length, 0, '못 본 자리를 찾았다고 적었습니다');
});

test('overrideNameOf — 공백·대소문자를 흘려보내지 않는다', () => {
  assert.equal(overrideNameOf(' ANTHROPIC_API_KEY ')?.name, 'ANTHROPIC_API_KEY');
  assert.equal(overrideNameOf('apikeyhelper')?.name, 'apiKeyHelper');
  assert.equal(overrideNameOf('model'), null);
});
