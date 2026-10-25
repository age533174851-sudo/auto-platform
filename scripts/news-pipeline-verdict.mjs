import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STAGES = new Set(['news', 'calendar', 'ai']);

/** A successful HTTP transport is not proof that a cron job succeeded. */
export function newsPipelineVerdict(stage, status, body) {
  if (!STAGES.has(stage)) return { ok: false, reason: 'unknown_stage' };
  if (!/^\d{3}$/.test(String(status))) return { ok: false, reason: 'invalid_http_status' };
  if (String(status) !== '200') return { ok: false, reason: `http_${status}` };

  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return { ok: false, reason: 'invalid_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok !== true) {
    return { ok: false, reason: 'application_not_ok' };
  }
  // AI article-level failures are reported by the API and retried separately.
  return { ok: true, reason: 'ok' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stage, status, bodyPath] = process.argv.slice(2);
  if (!bodyPath) {
    console.error('usage: node scripts/news-pipeline-verdict.mjs <news|calendar|ai> <HTTP status> <response file>');
    process.exitCode = 1;
  } else {
    try {
      const result = newsPipelineVerdict(stage, status, readFileSync(bodyPath, 'utf8'));
      console.log(`news-pipeline ${stage}: ${result.ok ? 'OK' : 'FAIL'} (${result.reason})`);
      if (!result.ok) process.exitCode = 1;
    } catch {
      console.error(`news-pipeline ${stage}: FAIL (response_unreadable)`);
      process.exitCode = 1;
    }
  }
}
