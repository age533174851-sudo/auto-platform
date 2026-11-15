#!/usr/bin/env node
// scripts/test-reapply-migrations.mjs
//
// **덮어쓴 것만 다시 세운다. 그리고 못 세웠으면 어느 파일인지 말한다.**
//
// 2026-11-13에 099가 들어오면서 main의 뮤테이션 증명이 멈췄다. 두 가지가
// 겹친 사고였다:
//
//   ① 되돌릴 때 **뒤 번호를 전부** 다시 세웠다. 그래서 099처럼 되돌릴
//      것이 하나도 없는 파일까지 재적용 대상이었고, 그 파일이 재적용
//      불가라 증명 19건이 통째로 멈췄다. **아무도 몰랐다.**
//   ② 로그에 남은 것은 "정본을 세우지 못했습니다" 한 줄이었다. 어느
//      파일인지가 없어 재적용 대상 14개를 손으로 좁혀야 했다.
//
// 아래 시험이 둘 다 못박는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reapplyAfter, migrationsFrom, redefinitionsAfter, definedObjects,
} from './lib/reapply-migrations.mjs';

/** 이름 → SQL 본문. 본문을 안 주면 주석만 든 파일이 된다. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'reapply-'));
  for (const [n, sql] of Object.entries(files)) writeFileSync(join(dir, n), sql);
  return dir;
}

/** 085가 두 함수를 정의하고, 086·088이 그중 하나씩 덮어쓰는 판.
 *  087·099는 자기 것만 만든다 — 되돌릴 것이 없다. */
const REAL = {
  '085_a.sql': 'CREATE OR REPLACE FUNCTION public.money_apply() RETURNS void AS $$ $$ LANGUAGE sql;\n'
             + 'CREATE OR REPLACE FUNCTION public.open_position() RETURNS void AS $$ $$ LANGUAGE sql;\n',
  '086_b.sql': 'CREATE OR REPLACE FUNCTION public.open_position() RETURNS void AS $$ $$ LANGUAGE sql;\n',
  '087_c.sql': 'CREATE OR REPLACE FUNCTION public.cancel() RETURNS void AS $$ $$ LANGUAGE sql;\n',
  // 099를 닮았다 — 표만 만들고, 085의 함수를 **부르기만** 한다.
  '099_d.sql': 'CREATE TABLE public.automation (id uuid);\n'
             + 'CREATE OR REPLACE FUNCTION public.auto_open() RETURNS void AS $$\n'
             + '  SELECT public.open_position();\n$$ LANGUAGE sql;\n',
  '100_e.sql': 'CREATE OR REPLACE FUNCTION public.money_apply() RETURNS void AS $$ $$ LANGUAGE sql;\n',
};

test('★★ #636 — 되돌릴 것이 없는 파일은 재적용 대상이 아니다', () => {
  const dir = fixture(REAL);
  try {
    const after = redefinitionsAfter(dir, '085_a.sql').map(p => p.split('/').pop());
    assert.deepEqual(after, ['086_b.sql', '100_e.sql'],
      `099처럼 되돌릴 것 없는 파일이 끌려 들어왔다: ${after.join(', ')}`);
    assert.ok(!after.includes('099_d.sql'),
      '099가 대상에 들어오면 그 파일이 재적용 불가일 때 증명이 통째로 멈춘다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★★ 부르기만 하는 것은 덮어쓰는 것이 아니다', () => {
  // 099_d는 open_position을 호출한다. 호출까지 세면 099가 다시 끌려오고
  // 이 수정이 아무것도 고치지 못한다.
  const objs = definedObjects(REAL['099_d.sql']);
  assert.ok(objs.has('auto_open'), '자기가 정의한 것은 센다');
  assert.ok(!objs.has('open_position'), '부르기만 한 것을 정의로 세었다');
});

test('★★ 재적용이 실패하면 그 파일 이름을 알린다', () => {
  const dir = fixture(REAL);
  try {
    const seen = [];
    const ok = reapplyAfter(dir, '085_a.sql',
      (sql) => !/public\.money_apply/.test(sql) || /085/.test(sql),  // 100_e에서 실패
      (p) => seen.push(p));
    assert.equal(ok, false);
    assert.equal(seen.length, 1, '실패를 한 번만 알려야 한다');
    assert.ok(seen[0].endsWith('100_e.sql'), `어느 파일인지 틀렸다: ${seen[0]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★★ 첫 실패에서 멈춘다 — 어긋난 상태 위에 쌓지 않는다', () => {
  const dir = fixture(REAL);
  try {
    const applied = [];
    reapplyAfter(dir, '085_a.sql', (sql) => { applied.push(sql); return false; }, () => {});
    assert.equal(applied.length, 1, `첫 실패 뒤에도 계속 세웠다: ${applied.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ 전부 세워지면 true 이고 onFail 은 불리지 않는다', () => {
  const dir = fixture(REAL);
  try {
    let failed = 0;
    const ok = reapplyAfter(dir, '085_a.sql', () => true, () => { failed++; });
    assert.equal(ok, true);
    assert.equal(failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ onFail 을 안 넘겨도 동작한다 (호출부 하위호환)', () => {
  const dir = fixture(REAL);
  try {
    assert.equal(reapplyAfter(dir, '085_a.sql', () => false), false);
    assert.equal(reapplyAfter(dir, '085_a.sql', () => true), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ 덮어쓰는 것이 하나도 없으면 아무것도 세우지 않고 true', () => {
  const dir = fixture(REAL);
  try {
    let n = 0;
    // 087은 자기 함수만 만들고 뒤에서 아무도 덮어쓰지 않는다.
    const ok = reapplyAfter(dir, '087_c.sql', () => { n++; return true; });
    assert.equal(ok, true);
    assert.equal(n, 0, `세울 것이 없는데 ${n}개를 세웠다`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrationsFrom 은 그대로 — 자기 자신은 빼고 뒤엣것 전부', () => {
  const dir = fixture(REAL);
  try {
    const after = migrationsFrom(dir, '086_b.sql', { includeSelf: false })
      .map(p => p.split('/').pop());
    assert.deepEqual(after, ['087_c.sql', '099_d.sql', '100_e.sql']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ 실제 저장소에서 099는 재적용 대상이 아니다', () => {
  for (const base of ['085_paper_challenge_accounting.sql',
                      '086_paper_challenge_finalizer.sql',
                      '087_paper_challenge_cancel.sql']) {
    const got = redefinitionsAfter('supabase/migrations', base).map(p => p.split('/').pop());
    assert.ok(!got.includes('099_paper_automation.sql'),
      `${base}의 재적용 대상에 099가 있다 — #636이 다시 난다: ${got.join(', ')}`);
  }
});
