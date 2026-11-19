#!/usr/bin/env node
// scripts/test-worker-env-example.mjs
//
// **워커 설정표가 소스와 갈리면, 그 표대로 세팅한 사람은 조용히 당한다.**
//
// 무엇이 실제로 있었나
// ────────────────────
// `worker/.env.example`은 "TRAIGO Worker — Railway 환경변수"라는 제목으로
// 넣어야 할 값을 적어 둔 표다. 그런데 그 표에 **`APP_URL`과 `ADMIN_SECRET`이
// 없었다.** 소스는 둘 다 요구한다:
//
//     if (!APP_URL || !APP_ADMIN_SECRET) { ... 예약 깨우기를 건너뛴다 }
//
// 즉 표대로 세팅하면 워커는 뜨고, 심장박동도 찍고, 로그도 깨끗한데
// **예약을 하나도 깨우지 않는다.** 오류가 안 난다. 2026-11-13에 호스트를
// 옮길지 검토하다 발견했다 — 옮겼다면 09:00 진입이 조용히 사라졌을 것이다.
//
// `CLAUDE.md`: "경로가 둘인데 한쪽만 고침". 표와 소스가 그 둘이다.
//
// 그래서 **표를 손으로 맞추지 않고, 갈리면 빨개지게** 한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SRC_DIR = 'worker/src';
const EXAMPLE = 'worker/.env.example';

/**
 * 표에 없어도 되는 이름과 그 이유.
 *
 * **"그냥 빼 두자"가 아니라 이유를 적는다.** 이유를 못 적겠으면 표에 넣어야
 * 하는 값이다.
 */
export const NOT_IN_EXAMPLE = {
  FLY_MACHINE_ID: '제공자(Fly)가 넣는다',
  RAILWAY_REPLICA_ID: '제공자(Railway)가 넣는다',
  CLOUD_RUN_EXECUTION: '제공자(Cloud Run)가 넣는다',
  HOSTNAME: '컨테이너가 넣는다',
  GIT_SHA: '배포가 넣는다 (Dockerfile ARG · Railway는 RAILWAY_GIT_COMMIT_SHA)',
  NEXT_PUBLIC_APP_URL: 'APP_URL의 대체 이름 — 둘 중 하나만 있으면 된다',
  EXCHANGE_ENCRYPTION_KEY: 'ENCRYPTION_KEY의 대체 이름 — 둘 중 하나만 있으면 된다',
};

/** `worker/src`의 모든 `.ts`가 읽는 환경변수 이름 */
export function envNamesRead(dir = SRC_DIR) {
  const out = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) out.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g)) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * 표가 **적어 둔** 이름. 주석 처리된 줄은 세지 않는다 —
 * 주석은 "넣으라"가 아니라 "이런 것도 있다"이고, 세팅하는 사람은 넘긴다.
 */
export function exampleKeys(file = EXAMPLE) {
  const out = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

export function missingFromExample(read, keys, skip = NOT_IN_EXAMPLE) {
  return read.filter(n => !keys.includes(n) && !Object.hasOwn(skip, n));
}

test('★★ 워커가 읽는 환경변수는 전부 .env.example에 있다 (표와 소스가 갈리지 않는다)', () => {
  const read = envNamesRead();
  assert.ok(read.length > 5, `worker/src에서 환경변수를 못 읽었다 (${read.length}개) — 검사가 헛돌고 있다`);
  const keys = exampleKeys();
  assert.ok(keys.length > 3, `${EXAMPLE}에서 이름을 못 읽었다 (${keys.length}개)`);
  const missing = missingFromExample(read, keys);
  assert.deepEqual(missing, [],
    `소스는 읽는데 ${EXAMPLE}에 없다: ${missing.join(', ')}\n`
    + '  → 표에 넣거나, 넣지 않아도 되는 이유를 NOT_IN_EXAMPLE에 적으세요');
});

test('★ 예외 목록에는 이유가 붙어 있다 — 빈 이유로 구멍을 내지 않는다', () => {
  for (const [name, why] of Object.entries(NOT_IN_EXAMPLE)) {
    assert.ok(String(why || '').trim().length >= 5, `${name}의 예외 이유가 비었습니다`);
  }
});

test('★ 표에만 있고 아무도 안 읽는 이름은 없다 — 죽은 설정을 남기지 않는다', () => {
  const read = envNamesRead();
  const dead = exampleKeys().filter(k => !read.includes(k)
    && !Object.hasOwn(NOT_IN_EXAMPLE, k));
  assert.deepEqual(dead, [],
    `${EXAMPLE}에 적혀 있는데 worker/src 어디서도 읽지 않습니다: ${dead.join(', ')}`);
});
