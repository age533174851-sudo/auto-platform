#!/usr/bin/env node
// scripts/ai-council-fixture.mjs
//
// **PR 본문과 변경 파일 목록(JSON)을 토론 입력으로 포장한다.**
//
// 왜 워크플로 안의 인라인 JS가 아니라 파일인가
// ─────────────────────────────────────────────
//   ① 인라인으로 두면 shellcheck가 JS 템플릿의 `${…}`를 셸 확장으로
//      읽고(SC2016) `verify`가 빨개진다 — 2026-11-21에 실제로 그랬다.
//      그때 로컬 `actionlint`는 조용했다. shellcheck가 깔려 있지 않으면
//      actionlint가 그 검사를 **건너뛰기** 때문이다. 조용한 것이 통과가
//      아니었다.
//   ② 인라인 JS에는 **시험을 붙일 자리가 없다.** 포장이 조용히 빈
//      목록을 만들어도 아무도 모르고, 보고서에는 "지적 없음"이 남는다.
//
// ★ **목록을 읽지 못한 것을 "변경 0건"으로 적지 않는다.** 빈 응답·깨진
//   JSON은 던진다. 여기서 빈 배열을 만들면 합의체가 아무 diff도 못 보고
//   "문제를 찾지 못했다"는 보고서를 올린다 — 가장 비싼 거짓말이다.

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 이어 붙은 JSON 값들을 전부 읽는다.
 *
 * `gh api --paginate`는 페이지가 여럿이면 배열을 **이어 붙여** 내놓을 수
 * 있다(`[…][…]`). 그건 한 덩어리 JSON이 아니다. 문자열 안의 `][`를
 * 구분자로 착각하면 patch 본문에서 깨지므로, 따옴표를 세며 훑는다.
 */
export function parseJsonStream(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('빈 응답입니다 — 변경 파일 목록을 읽지 못했습니다');
  try { return [JSON.parse(t)]; } catch { /* 값이 여러 개일 수 있다 */ }

  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { out.push(JSON.parse(t.slice(start, i + 1))); start = -1; }
    }
  }
  if (depth !== 0 || out.length === 0) {
    throw new Error('응답을 JSON으로 읽지 못했습니다 — 목록을 비어 있는 것으로 적지 않습니다');
  }
  return out;
}

/**
 * fixture를 만든다. **patch 없는 파일을 버리지 않는다** — 이름을 남겨야
 * `packDiff`가 「확인하지 못한 파일」로 적을 수 있다. 여기서 버리면 그
 * 파일은 보고서에서 아예 사라진다.
 */
export function buildFixture(pr, filesRaw) {
  const p = pr && typeof pr === 'object' ? pr : {};
  const flat = (Array.isArray(filesRaw) ? filesRaw : [filesRaw]).flat();
  const named = flat.filter(f => f && typeof f.filename === 'string' && f.filename);
  const unnamed = flat.length - named.length;
  return {
    fixture: {
      title: `#${p.number ?? '?'} ${String(p.title ?? '')}`.trim(),
      sha: p.head && typeof p.head === 'object' ? (p.head.sha ?? null) : null,
      description: String(p.body ?? '').slice(0, 4000),
      files: named.map(f => ({ filename: f.filename, changes: f.changes, patch: f.patch })),
    },
    // 이름 없는 항목 수. **0으로 뭉개지 않는다** — 있으면 적는다.
    unnamed,
  };
}

function main(argv) {
  const [prPath, filesPath, outPath] = argv;
  if (!prPath || !filesPath || !outPath) {
    console.error('사용법: node scripts/ai-council-fixture.mjs <pr.json> <files.json> <out.json>');
    return 2;
  }
  const pr = parseJsonStream(readFileSync(prPath, 'utf8'))[0];
  const files = parseJsonStream(readFileSync(filesPath, 'utf8'));
  const { fixture, unnamed } = buildFixture(pr, files);
  writeFileSync(outPath, JSON.stringify(fixture));
  console.log(`파일 ${fixture.files.length}개를 모았습니다`);
  if (unnamed > 0) {
    console.log(`⚠️ 이름을 읽지 못한 항목 ${unnamed}건은 빠졌습니다 — 그 파일의 판단은 보고서에 없습니다`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('ai-council-fixture.mjs')) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) {
    // **조용히 빈 fixture를 쓰지 않는다.** 시끄럽게 멈춘다.
    console.error(`❌ fixture를 만들지 못했습니다: ${e?.message || e}`);
    process.exit(1);
  }
}
