import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STAGES = new Set(['news', 'calendar', 'ai', 'cleanup']);

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
  if (stage === 'cleanup') {
    // HTTP 200 / ok:true can still mean a table's count or DELETE failed.
    // The endpoint intentionally continues to other tables after an error.
    if (parsed.applied !== true || !Array.isArray(parsed.tables) || parsed.tables.length === 0 ||
        !Array.isArray(parsed.rejected)) {
      return { ok: false, reason: 'cleanup_incomplete' };
    }
    for (const row of parsed.tables) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          typeof row.table !== 'string' || row.table.length === 0 ||
          !Number.isSafeInteger(row.eligible) || row.eligible < 0 ||
          !Number.isSafeInteger(row.total) || row.total < 0 ||
          !Number.isSafeInteger(row.deleted) || row.deleted < 0 ||
          typeof row.skipped !== 'string') {
        return { ok: false, reason: 'cleanup_invalid_table_evidence' };
      }
      // No-op is expected when the table has nothing eligible.
      if (row.eligible === 0 && row.deleted === 0 && row.skipped === '지울 것 없음') continue;
      // A safety limit or DB error must be visible as an incomplete cleanup.
      // No error text is printed, because database errors can contain sensitive data.
      if (row.skipped || row.deleted !== row.eligible) {
        return { ok: false, reason: 'cleanup_table_not_completed' };
      }
    }
    // The current default plan rejects ai_cache's 1-day rule (minimum 7 days).
    // Preserve this visible partial-plan signal without changing retention policy.
    return { ok: true, reason: parsed.rejected.length ? 'ok_with_rejected_rules' : 'ok' };
  }
  // AI article-level failures are reported by the API and retried separately.
  return { ok: true, reason: 'ok' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stage, status, bodyPath] = process.argv.slice(2);
  if (!bodyPath) {
    console.error('usage: node scripts/news-pipeline-verdict.mjs <news|calendar|ai|cleanup> <HTTP status> <response file>');
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
