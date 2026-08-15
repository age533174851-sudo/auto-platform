#!/usr/bin/env node
// scripts/check-strategy-flags.mjs
//
// **점검인 줄 알았던 호출이 진짜 주문을 내면 안 된다.**
//
// 실제로 있던 고장
// ────────────────
// 레지스트리는 scalp의 점검 플래그를 `checkOnly`라고 선언했고,
// `strategyRunRequest()`가 그 이름으로 본문을 만들었다. 그런데 scalp
// 라우트는 `body.dryRun`만 읽었다 — **화면이 보낸 값을 아무도 안 읽어서**
// 조건이 맞으면 주문 경로까지 갔다.
//
// 타입은 이걸 못 잡는다. 두 곳 다 `any` 본문이고 이름은 문자열이다.
// 그래서 스크립트가 잡는다.
//
// 무엇을 검사하나
// ───────────────
//   1. 실행 가능한 전략(`executionReady`)마다 라우트 파일이 있는가
//   2. 그 라우트가 **점검 판정을 `checkOnlyOf`에 위임하는가**
//      (플래그 이름을 직접 읽으면 또 갈린다)
//   3. 위임하지 않는다면, 선언한 이름을 **실제로 읽고 있는가**
//
// 3번을 남겨 두는 이유: daily-ladder는 `checkOnly`와 `dryRun`을 둘 다
// 직접 읽고 있고 그건 맞는 동작이다. 옳게 동작하는 것을 억지로 바꾸다가
// 검증된 경로를 깨뜨리지 않는다.

import fs from 'node:fs';

const REGISTRY = 'src/lib/strategies/registry.ts';
const src = fs.readFileSync(REGISTRY, 'utf8');

// 레지스트리에서 (id, route, checkFlag, executionReady)를 뽑는다.
// 파서를 만들지 않는다 — 이 파일의 모양은 안정적이고, 모양이 바뀌면
// 아래에서 0개가 잡혀 실패한다(조용히 통과하지 않는다).
const specs = [];
for (const block of src.split(/\n\s*\{\s*\n/).slice(1)) {
  const id = block.match(/id:\s*'([^']+)'/)?.[1];
  const route = block.match(/route:\s*'([^']+)'/)?.[1];
  const flag = block.match(/checkFlag:\s*'([^']+)'/)?.[1];
  const exec = /executionReady:\s*true/.test(block);
  if (id && route && flag) specs.push({ id, route, flag, exec });
}

if (specs.length === 0) {
  console.error('❌ 레지스트리에서 전략을 하나도 읽지 못했습니다 — '
    + `${REGISTRY}의 모양이 바뀌었다면 이 스크립트도 같이 고치세요.`);
  console.error('   (0개를 "문제 없음"으로 읽으면 이 검사는 영원히 통과합니다)');
  process.exit(1);
}

let bad = false;
const lines = [];

for (const s of specs) {
  if (!s.exec) { lines.push(`   · ${s.id} — 실행 경로 없음(건너뜀)`); continue; }

  const file = `src/app/api${s.route.replace(/^\/api/, '')}/route.ts`;
  if (!fs.existsSync(file)) {
    console.error(`❌ ${s.id}: 레지스트리가 가리키는 라우트가 없습니다 — ${file}`);
    bad = true;
    continue;
  }
  const body = fs.readFileSync(file, 'utf8');

  const delegates = /checkOnlyOf\s*\(/.test(body);
  if (delegates) {
    lines.push(`   · ${s.id} — checkOnlyOf에 위임 ✅`);
    continue;
  }

  // 위임하지 않으면 **선언한 이름을 실제로 읽어야** 한다.
  // `body.dryRun` · `body?.dryRun` · `body['dryRun']` 전부 잡는다.
  const readsDeclared = new RegExp(`body\\s*\\??[.\\[]\\s*['"]?${s.flag}`).test(body);
  if (!readsDeclared) {
    console.error(`❌ ${s.id}: 레지스트리는 점검 플래그를 '${s.flag}'로 선언했는데 `
      + `${file}이 그 값을 읽지 않습니다.`);
    console.error('   화면의 [지금 점검하기]가 그 이름으로 보내므로, '
      + '이 상태면 점검 호출이 주문을 낼 수 있습니다.');
    console.error("   src/lib/strategies/checkFlag.ts의 checkOnlyOf()를 쓰세요.");
    bad = true;
    continue;
  }
  lines.push(`   · ${s.id} — '${s.flag}'를 직접 읽음 (위임 권장)`);
}

if (bad) {
  console.error('\n   점검과 실주문이 갈리면 사용자는 "주문은 안 냅니다"라고 '
    + '적힌 버튼을 누르고 주문을 냅니다.');
  process.exit(1);
}

console.log(`✅ 전략 점검 플래그 ${specs.length}개 · 어긋난 것 0개`);
for (const l of lines) console.log(l);
