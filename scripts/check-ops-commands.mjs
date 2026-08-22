#!/usr/bin/env node
// scripts/check-ops-commands.mjs
//
// **정의만 있고 아무 데서도 안 도는 명령이 있었다.**
//
// `SYNC_SECRETS`는 세 곳에 있었다:
//
//   opsCommand.ts    명령 정의 ✓
//   OpsPage.tsx      "시크릿 동기화해" 버튼 ✓
//   ops-runner.mjs   실행 분기 ✓
//
// 그런데 `opsQueue.ts`가 **따로 손으로 들고 있던** 실행 가능 목록에만
// 빠져 있었다. 그래서 요청은 큐에 들어간 뒤 `UNKNOWN_COMMAND`로
// 만료됐고, 그 다음부터 화면에는 "실행할 요청이 없습니다"만 떴다.
//
// 버튼도 있고 명령도 있고 실행 코드도 있는데 **영원히 안 도는 상태**다.
// 그리고 아무것도 빨간불이 아니다 — 테스트도 전부 초록이었다.
//
// 목록 자체는 없앴다(`runBy`에서 뽑는다). 이 검사는 남은 절반을 본다:
// **큐로 가는 명령에 실제 실행 분기가 있는가.** 목록을 없애도 실행
// 분기를 안 쓰면 같은 자리에서 다시 멈춘다.

import { readFileSync } from 'fs';

const SPEC = 'src/lib/ops/opsCommand.ts';
const RUNNER = 'scripts/ops-runner.mjs';
const UI = 'src/components/pages/OpsPage.tsx';

const spec = readFileSync(SPEC, 'utf8');
const runner = readFileSync(RUNNER, 'utf8');
const ui = readFileSync(UI, 'utf8');

// 명령과 runBy를 한 쌍으로 읽는다.
const commands = [];
for (const m of spec.matchAll(/command:\s*'([A-Z_]+)'[\s\S]*?runBy:\s*'(IMMEDIATE|QUEUE)'/g)) {
  commands.push({ name: m[1], runBy: m[2] });
}
// 같은 이름이 두 번 잡히면(중첩 매칭) 첫 것만 남긴다.
const seen = new Set();
const specs = commands.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));

if (specs.length === 0) {
  console.error(`❌ ${SPEC}에서 명령을 하나도 읽지 못했습니다 — 이 검사가 헛돌고 있습니다`);
  process.exit(1);
}

const problems = [];

for (const c of specs) {
  // 사람이 부를 말이 있는가. 없으면 화면에 버튼이 있어도 파싱이 안 된다.
  const phraseAt = spec.indexOf(`command: '${c.name}' }`);
  if (phraseAt < 0 && !new RegExp(`command:\\s*'${c.name}'\\s*\\}`).test(spec)) {
    problems.push({ c, what: '사람이 쓰는 말(PHRASES)이 없습니다',
      why: '버튼이 있어도 parseOpsCommand가 못 읽으면 요청이 만들어지지 않습니다' });
  }

  if (c.runBy === 'QUEUE') {
    // 실행기에 분기가 있는가. `cmd === 'X'` 꼴을 찾는다.
    if (!new RegExp(`cmd\\s*===\\s*'${c.name}'`).test(runner)) {
      problems.push({ c, what: `${RUNNER}에 실행 분기가 없습니다`,
        why: '큐에 들어가지만 아무도 실행하지 않습니다 — 요청은 만료되고 화면에는 "실행할 요청이 없습니다"만 뜹니다' });
    }
  } else {
    // 즉시 실행 명령이 실행기 분기에 있으면, 같은 일을 두 곳에서 한다.
    if (new RegExp(`cmd\\s*===\\s*'${c.name}'`).test(runner)) {
      problems.push({ c, what: `즉시 실행 명령인데 ${RUNNER}에도 분기가 있습니다`,
        why: '같은 판단이 두 곳에 있으면 언젠가 갈립니다' });
    }
  }
}

// 화면 버튼이 정의에 없는 명령을 부르고 있지 않은가.
for (const m of ui.matchAll(/command:\s*'([A-Z_]+)'/g)) {
  if (!seen.has(m[1])) {
    problems.push({ c: { name: m[1], runBy: '?' }, what: `${UI}가 정의에 없는 명령을 부릅니다`,
      why: '누르면 auth/parse 단계에서 조용히 아무 일도 일어나지 않습니다' });
  }
}

if (problems.length > 0) {
  console.error('❌ 운영 명령 배선이 끊겨 있습니다\n');
  for (const p of problems) {
    console.error(`  ${p.c.name} (${p.c.runBy})`);
    console.error(`    ${p.what}`);
    console.error(`    ${p.why}\n`);
  }
  console.error('버튼도 있고 명령도 있는데 아무 데서도 안 도는 상태가 됩니다 —');
  console.error('그리고 그때 빨간불은 어디에도 안 켜집니다.');
  process.exit(1);
}

const q = specs.filter(s => s.runBy === 'QUEUE').length;
console.log(`✅ 운영 명령 ${specs.length}개 · 큐 실행 ${q}개 전부 분기 있음 · 끊긴 배선 0건`);
