// scripts/check-venue-ids.mjs
//
// **거래소 응답을 그냥 JSON으로 읽으면 주문 번호가 깨진다.**
//
// 2026-08-16에 실제로 난 일: Gate 조건부 주문 번호가
//
//   2089209928026685400
//   2089209928399978500
//
// 로 저장돼 있었다. 끝이 `400` · `500`으로 뭉개진 것이 지문이다.
// Number.MAX_SAFE_INTEGER(9007199254740991)를 300배 넘게 벗어나서
// `JSON.parse`가 만든 순간 마지막 자릿수가 반올림됐고, 그 번호로 보낸
// 취소는 전부 `400 No order found with the given ID`로 돌아왔다.
// 포지션은 0인데 보호주문 2건이 남은 이유가 그것이다.
//
// 고친 뒤에도 **다음 사람이 `await r.json()` 한 줄을 새로 쓰면 그대로
// 돌아온다.** 그래서 검사로 막는다 — 이 저장소에서 반복된 고장은
// 전부 "한쪽만 고쳐졌다"였다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/lib/exchanges';
/** 파서 자신은 예외다 — 여기가 유일하게 JSON.parse를 부르는 곳이다 */
const ALLOW = new Set(['losslessJson.ts', 'losslessJson.test.ts']);

const problems = [];

for (const name of readdirSync(DIR)) {
  // 테스트는 고정 데이터를 직접 만든다 — 거래소 응답이 아니다.
  if (!name.endsWith('.ts') || name.endsWith('.test.ts') || ALLOW.has(name)) continue;
  const path = join(DIR, name);
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const at = `${path}:${i + 1}`;
    const code = line.replace(/\/\/.*$/, '');

    // 응답 본문을 표준 파서로 읽는 것 — 여기서 int64가 깨진다.
    // 에러 본문(code/msg)만 읽는 곳은 번호를 쓰지 않으므로 예외다.
    if (/\.\s*json\s*\(\s*\)/.test(code) && !/error message only/.test(line)) {
      problems.push(`${at}  응답을 .json()으로 읽습니다 — parseLossless(await r.text())를 쓰세요`);
    }
    // 에러 메시지를 뽑을 때의 JSON.parse는 허용한다(번호를 쓰지 않는다).
    if (/JSON\.parse\s*\(/.test(code) && !/msg|message|label|error/i.test(line)) {
      problems.push(`${at}  JSON.parse로 응답을 읽습니다 — 주문 번호가 깨집니다`);
    }
    // 식별자를 숫자로 바꾸는 것.
    if (/(?:Number|parseInt)\s*\(\s*[A-Za-z_$][\w$]*\.?(?:order_?[Ii]d|id)\b/.test(code)) {
      problems.push(`${at}  주문 번호를 숫자로 바꿉니다 — 번호는 계산 대상이 아닙니다`);
    }
  });
}

// 실행 경로 쪽에서도 번호를 숫자로 만들지 않는지 본다.
for (const rel of ['src/lib/engine', 'src/lib/smoke']) {
  for (const name of readdirSync(rel)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const path = join(rel, name);
    const src = readFileSync(path, 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/(?:Number|parseInt)\s*\(\s*[A-Za-z_$][\w$]*\.?(?:order_?[Ii]d)\b/.test(code)) {
        problems.push(`${path}:${i + 1}  주문 번호를 숫자로 바꿉니다`);
      }
    });
  }
}

if (problems.length) {
  console.error('❌ 거래소 주문 번호가 숫자로 읽히는 곳이 있습니다:\n');
  for (const p of problems) console.error('  ' + p);
  console.error(`\n${problems.length}건. 주문 번호는 처음 받은 순간부터 끝까지 십진 문자열입니다.`);
  process.exit(1);
}

console.log('✅ 거래소 응답을 전부 lossless 파서로 읽습니다 — 주문 번호가 숫자로 새는 곳 없음');
