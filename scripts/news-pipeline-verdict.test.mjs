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
