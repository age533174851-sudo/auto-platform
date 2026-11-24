#!/usr/bin/env node
// scripts/run-all-checkers.mjs
//
// **검사기 전수를 한 곳에서 돈다.**
//
// 전에는 이 루프가 `claude-hourly-trading.yml` 안에 YAML 로 적혀 있었고,
// 인자를 받는 검사기가 새로 생길 때마다 그 워크플로를 고쳐야 했다.
// 무인 회차는 `.github/workflows/` 를 못 건드리므로 **자기가 깨뜨린 것을
// 자기가 못 고쳤다.** 왜 그 관문이 옳은지와 이 파일이 생긴 이유는
// `scripts/lib/checker-sweep.mjs` 머리말에 있다.
//
// 제외 판단은 여기 없다 — 정본은 그 파일이고 여기서는 따르기만 한다.
// `scripts/check-checker-sweep.mjs` 가 그 목록이 거짓말하지 않는지 센다.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { sweepPlan, SWEEP_EXCLUSIONS } from './lib/checker-sweep.mjs';

/** `scripts/check-*.mjs` — 시험 파일은 검사기가 아니다 */
export function checkerFiles(dir = 'scripts') {
  return readdirSync(dir)
    .filter((n) => /^check-.+\.mjs$/.test(n) && !/\.test\.mjs$/.test(n))
    .sort()
    .map((n) => `${dir}/${n}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = checkerFiles();
  const plan = sweepPlan({ files, exclusions: SWEEP_EXCLUSIONS });
  const failed = [];

  const run = (file, args) => {
    const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });
    if (r.status === 0) return true;
    failed.push(file);
    console.log(`::error::검사기 실패: ${file}${args.length ? ' ' + args.join(' ') : ''}`);
    // 원인 줄만 몇 개 — 본문을 통째로 쏟지 않는다.
    for (const line of String(r.stdout || '').split('\n').filter((l) => /^(❌|   · )/.test(l)).slice(0, 3)) {
      console.log(line);
    }
    return false;
  };

  for (const f of plan.bare) run(f, []);
  for (const { file, args } of plan.withArgs) run(file, args);

  // **덮는 곳을 값으로 적는다.** 조용히 빠지면 다음 사람이 빠진 줄 모른다.
  for (const { file, coveredBy } of plan.deferred) {
    console.log(`건너뜀: ${file} — 여기서는 못 돌린다. ${coveredBy} 가 돈다`);
  }

  console.log(`검사기 ${plan.bare.length + plan.withArgs.length}개 실행 · `
    + `건너뜀 ${plan.deferred.length}개 · 실패 ${failed.length}개`);
  if (failed.length) process.exitCode = 1;
}
