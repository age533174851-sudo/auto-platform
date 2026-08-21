#!/usr/bin/env node
// scripts/check-migrations.mjs
//
// **"만들어 놓고 배선을 안 함"을 CI에서 잡는다.**
//
// 이 저장소에서 가장 자주 난 사고가 그거다. 마이그레이션 파일은
// 커밋됐는데 아무도 적용하지 않았고, 화면은 옛 목록 기준으로 초록을
// 켰다. 054·055·056이 전부 그랬다.
//
// 여기서 보는 것:
//   1. 모든 .sql이 번호를 갖거나 LEGACY에 이유가 적혀 있는가
//   2. 번호가 겹치지 않는가
//   3. src/lib/system/migrationManifest.ts가 최신인가
//   4. 자동으로 못 도는 마이그레이션이 몇 개인가 (있으면 사유를 적는다)
import { readFileSync, existsSync, globSync } from 'node:fs';
import { buildManifest, renderManifest, OUT, LEGACY } from './gen-migration-manifest.mjs';

let bad = 0;
const err = (m) => { console.error(`::error::${m}`); bad += 1; };

const built = await buildManifest();

// 1. 배선 안 된 파일
if (built.unlisted.length) {
  err(`번호도 없고 LEGACY에도 없는 마이그레이션 파일: ${built.unlisted.join(', ')}`);
  console.error('   → 번호를 붙여 자동 파이프라인에 넣거나, gen-migration-manifest.mjs의 LEGACY에 이유를 적으세요.');
}

// 2. 번호 중복 — 순서가 두 갈래가 되면 어느 쪽이 먼저인지 아무도 모른다
const byId = new Map();
for (const r of built.rows) {
  if (byId.has(r.id)) err(`마이그레이션 번호 ${r.id}가 겹칩니다: ${byId.get(r.id)} · ${r.name}`);
  else byId.set(r.id, r.name);
}

// 3. 목록 파일이 최신인가
const want = renderManifest(built);
const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
if (have !== want) {
  err('src/lib/system/migrationManifest.ts가 낡았습니다 — `npm run gen:migrations`를 실행하고 커밋하세요');
  if (have) {
    const hn = (have.match(/name: '/g) || []).length;
    console.error(`   현재 ${hn}개 기록 · 실제 ${built.rows.length}개`);
  }
}

// 4. 자동으로 못 도는 것
const manual = built.rows.filter(r => r.risk !== 'ADDITIVE');
if (manual.length) {
  console.log(`자동 적용 대상이 아닌 마이그레이션 ${manual.length}개 (승인 필요):`);
  for (const m of manual) console.log(`  · ${m.name} — ${m.risk}`);
  console.log('  자동 파이프라인은 이 파일들을 실행하지 않습니다. 명령 기반 승인이 필요합니다.');
}

// 5. 화면·응답이 사람에게 운영 숙제를 넘기지 않는가
//
// **"Supabase SQL 편집기에서 실행하세요"는 자동화 미완성의 증거다.**
// 적용은 migrate 워크플로가 자동으로 한다. 사람에게 남는 말은
// "자동으로 적용하는 중" 또는 "권한이 없어 자동 처리하지 못했습니다"뿐이다.
//
// 주석은 뺀다 — 왜 그렇게 했는지 설명하는 글에는 옛 문구가 나올 수밖에 없다.
const CHORE_PHRASES = [
  { re: /마이그레이션[^\n'"`]{0,20}(?:을|를)\s*적용하세요/, why: '마이그레이션 적용을 사람에게 시킵니다' },
  { re: /SQL\s*(?:Editor|편집기)[^\n'"`]{0,30}(?:실행|붙여|적용)/i, why: 'SQL 편집기 작업을 사람에게 시킵니다' },
  { re: /fly\s+logs[^\n'"`]{0,20}(?:확인|보)/i, why: 'Fly 로그 확인을 사람에게 시킵니다' },
  { re: /heartbeat[^\n'"`]{0,20}확인하세요/i, why: 'heartbeat 확인을 사람에게 시킵니다' },
  { re: /SHA[^\n'"`]{0,20}비교하세요/i, why: 'SHA 대조를 사람에게 시킵니다' },
];

{
  const files = [
    ...globSync('src/components/**/*.tsx'),
    ...globSync('src/app/**/*.tsx'),
    ...globSync('src/app/api/**/*.ts'),
    ...globSync('src/lib/**/*.ts'),
  ].filter(f => !f.endsWith('.test.ts'));

  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;   // 주석은 설명이다
      for (const c of CHORE_PHRASES) {
        if (c.re.test(line)) err(`${f}:${i + 1} — ${c.why}\n     ${t.slice(0, 110)}`);
      }
    });
  }
}

if (bad === 0) {
  console.log(`마이그레이션 배선 확인: 파일 ${built.rows.length}개 · 자동 적용 ${built.rows.length - manual.length}개 · `
    + `자동 대상 아님 ${manual.length}개 · 구파일 ${Object.keys(LEGACY).length}개`);
}
process.exit(bad ? 1 : 0);
