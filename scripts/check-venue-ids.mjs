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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const DIR = 'src/lib/exchanges';
/** 파서 자신은 예외다 — 여기가 유일하게 JSON.parse를 부르는 곳이다 */
const ALLOW = new Set(['losslessJson.ts', 'losslessJson.test.ts']);

const problems = [];

/**
 * **훑지 않은 것을 "없음"으로 적지 않는다.**
 *
 * 예전에는 `readdirSync(DIR)` 하나였다. 그것은 **한 겹만** 본다. 그래서
 * 하위 폴더가 하나 생기면 그 아래 파일은 전부 검사 밖으로 나가고,
 * 집계는 그대로 "전부 lossless 파서로 읽습니다"라고 적었다.
 *
 * 실측했다 (main ed00c1a4):
 *
 *   src/lib/exchanges/zzsub/bad.ts 에 `await r.json()`
 *     → ✅ 거래소 응답을 전부 lossless 파서로 읽습니다   rc=0
 *   src/lib/engine/zzsub/bad.ts 에 `Number(o.order_id)`
 *     → ✅ 같은 문장                                      rc=0
 *   readdirSync를 빈 결과로 만듦
 *     → ✅ 같은 문장                                      rc=0
 *
 *   src/lib/exchanges/zzbad.ts 에 `await r.json()` (바로 아래)
 *     → ❌ 응답을 .json()으로 읽습니다                    rc=1  (맞다)
 *
 * 이 검사가 막는 고장은 2026-08-16에 **실제로 났다** — 주문 번호가
 * 뭉개져 취소가 전부 실패하고 포지션 0에 보호주문 2건이 남았다. 그
 * 관문이 폴더 한 겹에 조용히 비는 것은 둘 수 없다.
 *
 * 지금은 세 디렉터리가 평평하다(실측: 하위 폴더 0개 · 바로 아래 .ts
 * 50 · 231 · 16개). 그래서 훑기를 재귀로 넓혀도 **지금 잡히는 것은
 * 늘지 않는다** — 늘어나는 것은 앞으로 생길 폴더에 대한 보호다.
 */
const walkFailures = [];
function tsFiles(dir, out = []) {
  let names;
  try { names = readdirSync(dir); }
  catch (e) { walkFailures.push(`${dir} (${errCode(e)})`); return out; }
  for (const name of names) {
    const p = join(dir, name).replace(/\\/g, '/');
    let st;
    try { st = statSync(p); }
    catch (e) { walkFailures.push(`${p} (${errCode(e)})`); continue; }
    if (st.isDirectory()) tsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 예외에서 원인 코드만 꺼낸다 — 경로 외의 내용은 적지 않는다 */
function errCode(e) {
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e);
  return code.slice(0, 40);
}

/** 디렉터리별로 센다 — 어디가 0으로 떨어졌는지 집계 줄에 남는다 */
const scanned = [];
function scan(dir) {
  const files = tsFiles(dir);
  scanned.push({ dir, count: files.length });
  return files;
}

for (const path of scan(DIR)) {
  // 테스트는 고정 데이터를 직접 만든다 — 거래소 응답이 아니다.
  const name = basename(path);
  if (name.endsWith('.test.ts') || ALLOW.has(name)) continue;
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
    // ── 식별자를 숫자로 바꾸는 것 ──
    //
    // 예전 정규식은 `[\w$]*\.?(?:…|id)`라 **이름이 id로 끝나기만 하면**
    // 걸렸다. `Number(grid.stepSize)`의 `grid`가 `gr` + `id`로 쪼개져
    // 잡혔다 — 주문 번호와 아무 상관이 없는 줄이다.
    //
    // 속성 접근(`x.id`)이거나 그 이름 자체(`id`)일 때만 본다.
    if (/(?:Number|parseInt)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*!?\s*\.\s*(?:order_?[Ii]d|id)|(?:order_?[Ii]d|id))\b/.test(code)) {
      problems.push(`${at}  주문 번호를 숫자로 바꿉니다 — 번호는 계산 대상이 아닙니다`);
    }
  });
}

// 실행 경로 쪽에서도 번호를 숫자로 만들지 않는지 본다.
for (const rel of ['src/lib/engine', 'src/lib/smoke']) {
  for (const path of scan(rel)) {
    if (basename(path).endsWith('.test.ts')) continue;
    const src = readFileSync(path, 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/(?:Number|parseInt)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*!?\s*\.\s*order_?[Ii]d|order_?[Ii]d)\b/.test(code)) {
        problems.push(`${path}:${i + 1}  주문 번호를 숫자로 바꿉니다`);
      }
    });
  }
}

// ── 발견이 성립했는가 ──
//
// 이 검사의 결론은 "새는 곳 없음"이다. 그 문장은 파일을 실제로 읽은
// 뒤에만 참이다. 읽은 것이 0이면 그것은 "없음"이 아니라 **아직 모른다**다.
if (walkFailures.length > 0) {
  console.error('❌ 훑지 못한 디렉터리가 있습니다 — 못 본 것은 통과가 아닙니다:\n');
  for (const f of walkFailures) console.error('  ' + f);
  console.error('\n그 아래에서 주문 번호가 숫자로 읽히는지 아무도 보지 않았습니다.');
  process.exit(1);
}
const empty = scanned.filter(s0 => s0.count === 0);
if (empty.length > 0) {
  console.error('❌ 검사 대상 .ts 파일이 0개인 디렉터리가 있습니다:\n');
  for (const e of empty) console.error(`  ${e.dir}`);
  console.error('\n경로가 바뀌었는지 확인해야 합니다. 읽은 것이 0이면');
  console.error('"새는 곳 없음"은 참이 아니라 아직 모른다는 뜻입니다.');
  process.exit(1);
}

if (problems.length) {
  console.error('❌ 거래소 주문 번호가 숫자로 읽히는 곳이 있습니다:\n');
  for (const p of problems) console.error('  ' + p);
  console.error(`\n${problems.length}건. 주문 번호는 처음 받은 순간부터 끝까지 십진 문자열입니다.`);
  process.exit(1);
}

const tally = scanned.map(s0 => `${s0.dir} ${s0.count}개`).join(' · ');
console.log('✅ 거래소 응답을 전부 lossless 파서로 읽습니다 — 주문 번호가 숫자로 새는 곳 없음');
console.log(`   읽은 파일(하위 폴더 포함): ${tally} · 훑지 못한 디렉터리 0`);
