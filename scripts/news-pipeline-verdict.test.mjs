import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newsPipelineVerdict } from './news-pipeline-verdict.mjs';

for (const stage of ['news', 'calendar', 'ai']) {
  test(`${stage}: HTTP 200 + ok:true passes (including empty batches)`, () => {
    assert.equal(newsPipelineVerdict(stage, '200', '{"ok":true,"saved":0,"failed":3}').ok, true);
  });
  for (const code of ['401', '403', '404', '429', '500', '503']) {
    test(`${stage}: HTTP ${code} fails closed`, () => {
      assert.equal(newsPipelineVerdict(stage, code, '{"ok":true}').ok, false);
    });
  }
  for (const body of ['{"ok":false}', '{"error":"storage failed"}', '{}', 'not-json', '[]', 'null', '{"ok":"true"}']) {
    test(`${stage}: HTTP 200 but invalid or unsuccessful body fails closed: ${body}`, () => {
      assert.equal(newsPipelineVerdict(stage, '200', body).ok, false);
    });
  }
}

test('missing status and unknown stage fail closed', () => {
  assert.equal(newsPipelineVerdict('news', '', '{"ok":true}').ok, false);
  assert.equal(newsPipelineVerdict('unexpected', '200', '{"ok":true}').ok, false);
});

test('CLI exits nonzero on HTTP 200 + ok:false, without printing response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-news-verdict-'));
  try {
    const bodyPath = join(dir, 'response.json');
    writeFileSync(bodyPath, '{"ok":false,"secret":"must-not-print"}');
    const r = spawnSync(process.execPath, [new URL('./news-pipeline-verdict.mjs', import.meta.url).pathname, 'calendar', '200', bodyPath], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /must-not-print/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Cleanup's HTTP 200 is not proof that each table was actually cleaned. */
const cleanupRow = (overrides = {}) => ({
  table: 'news_articles', eligible: 2, total: 10, deleted: 2, skipped: '', ...overrides,
});
const cleanupBody = (rows, overrides = {}) => JSON.stringify({
  ok: true, applied: true, tables: rows, rejected: [], ...overrides,
});
test('cleanup: successful deletion passes', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200', cleanupBody([cleanupRow()])).ok, true);
});
test('cleanup: legitimately empty table passes', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200',
    cleanupBody([cleanupRow({ eligible: 0, deleted: 0, skipped: '지울 것 없음' })])).ok, true);
});
for (const overrides of [
  { eligible: null, deleted: 0, skipped: '개수 조회 실패' },
  { total: null },
  { deleted: 0, skipped: '삭제 실패: DB' },
  { deleted: 0, skipped: '전체 삭제 방어' },
  { deleted: 1 },
  { eligible: -1 },
  { deleted: Number.NaN },
]) {
  test(`cleanup: bad per-table evidence fails closed (${JSON.stringify(overrides)})`, () => {
    assert.equal(newsPipelineVerdict('cleanup', '200',
      cleanupBody([cleanupRow(overrides)])).ok, false);
  });
}
test('cleanup: empty table list is not completion evidence', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200', cleanupBody([])).ok, false);
});
test('cleanup: preview is not an apply success', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200',
    cleanupBody([cleanupRow()], { applied: false })).ok, false);
});
test('cleanup: malformed table evidence fails', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200',
    cleanupBody([{ table: 'news_articles', eligible: 0, total: 0, deleted: 0 }])).ok, false);
});
test('cleanup: rejected default rule is visible without changing retention policy', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200',
    cleanupBody([cleanupRow()], { rejected: [{ table: 'ai_cache', reason: 'minimum 7 days' }] })).reason,
    'ok_with_rejected_rules');
});
for (const status of ['401', '500']) {
  test(`cleanup: HTTP ${status} fails`, () => {
    assert.equal(newsPipelineVerdict('cleanup', status, cleanupBody([cleanupRow()])).ok, false);
  });
}
// #505 returns HTTP 207 while preserving confirmed partial DELETE counts.
// The cron workflow must never treat that partial result as completed cleanup.
test('cleanup: #505 confirmed 4,998/4,999 partial DELETE (HTTP 207) fails closed', () => {
  const response = cleanupBody([
    cleanupRow({ eligible: 4999, total: 10000, deleted: 4998, skipped: '' }),
  ], { ok: false, totalDeleted: 4998 });
  assert.deepEqual(newsPipelineVerdict('cleanup', '207', response),
    { ok: false, reason: 'http_207' });
});

test('cleanup: HTTP 200 ok:false fails', () => {
  assert.equal(newsPipelineVerdict('cleanup', '200',
    cleanupBody([cleanupRow()], { ok: false })).ok, false);
});
test('cleanup: CLI rejects table error without echoing sensitive response body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-cleanup-verdict-'));
  try {
    const bodyPath = join(dir, 'response.json');
    writeFileSync(bodyPath, cleanupBody([cleanupRow({ deleted: 0, skipped: '삭제 실패: must-not-print' })]));
    const r = spawnSync(process.execPath,
      [new URL('./news-pipeline-verdict.mjs', import.meta.url).pathname, 'cleanup', '200', bodyPath],
      { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /must-not-print/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
