#!/usr/bin/env node
// scripts/test-reapply-migrations.mjs
//
// **못 세웠으면 어느 파일인지 말해야 한다.**
//
// 2026-11-13에 099가 들어오면서 main의 뮤테이션 증명이 멈췄는데, 로그에
// 남은 것은 "정본을 세우지 못했습니다" 한 줄이었다. 어느 파일인지가 없어
// 재적용 대상 14개를 손으로 좁혀야 했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapplyAfter, migrationsFrom } from './lib/reapply-migrations.mjs';

function fixture(names) {
  const dir = mkdtempSync(join(tmpdir(), 'reapply-'));
  for (const n of names) writeFileSync(join(dir, n), `-- ${n}\n`);
  return dir;
}

const NAMES = ['085_a.sql', '086_b.sql', '087_c.sql', '088_d.sql'];

test('★★ 재적용이 실패하면 그 파일 이름을 알린다', () => {
  const dir = fixture(NAMES);
  try {
    const seen = [];
    const ok = reapplyAfter(dir, '085_a.sql',
      (sql) => !/087_c/.test(sql),      // 087에서 실패한다
      (p) => seen.push(p));
    assert.equal(ok, false);
    assert.equal(seen.length, 1, '실패를 한 번만 알려야 한다');
    assert.ok(seen[0].endsWith('087_c.sql'), `어느 파일인지 틀렸다: ${seen[0]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★★ 첫 실패에서 멈춘다 — 어긋난 상태 위에 쌓지 않는다', () => {
  const dir = fixture(NAMES);
  try {
    const applied = [];
    reapplyAfter(dir, '085_a.sql', (sql) => {
      applied.push(sql.trim());
      return !/086_b/.test(sql);        // 086에서 실패
    }, () => {});
    assert.equal(applied.length, 1, `086 뒤까지 계속 세웠다: ${applied.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ 전부 세워지면 true 이고 onFail 은 불리지 않는다', () => {
  const dir = fixture(NAMES);
  try {
    let failed = 0;
    const ok = reapplyAfter(dir, '085_a.sql', () => true, () => { failed++; });
    assert.equal(ok, true);
    assert.equal(failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ onFail 을 안 넘겨도 예전처럼 동작한다 (호출부 하위호환)', () => {
  const dir = fixture(NAMES);
  try {
    assert.equal(reapplyAfter(dir, '085_a.sql', () => false), false);
    assert.equal(reapplyAfter(dir, '085_a.sql', () => true), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('자기 자신은 빼고 뒤엣것만 돌려준다', () => {
  const dir = fixture(NAMES);
  try {
    const after = migrationsFrom(dir, '086_b.sql', { includeSelf: false })
      .map(p => p.split('/').pop());
    assert.deepEqual(after, ['087_c.sql', '088_d.sql']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
