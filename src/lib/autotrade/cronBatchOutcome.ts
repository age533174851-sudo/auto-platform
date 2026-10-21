// src/lib/autotrade/cronBatchOutcome.ts
// A successful HTTP request is not proof that every scheduled evaluation succeeded.
// Pure classification only: no DB, venue, order, or policy side effects.
export type CronBatchStatus = 'ok' | 'failed' | 'skipped';

export interface CronBatchInput {
  readError: string | null;
  scheduled: number;
  results: ReadonlyArray<{ ok?: unknown; saveError?: unknown }>;
  cronLogError?: string | null;
}

export interface CronBatchVerdict {
  ok: boolean;
  status: CronBatchStatus;
  failedCount: number;
  incomplete: boolean;
  error: string | null;
}

export function classifyCronBatch(input: CronBatchInput): CronBatchVerdict {
  const { readError, scheduled, results, cronLogError = null } = input;
  const incomplete = !Number.isInteger(scheduled) || scheduled < 0 || results.length !== scheduled;
  const failedCount = results.filter(r => r?.ok !== true || Boolean(r.saveError)).length;
  const status: CronBatchStatus = readError || incomplete || failedCount > 0
    ? 'failed'
    : scheduled === 0 ? 'skipped' : 'ok';
  const error = readError
    || (incomplete ? 'cron_results_incomplete' : null)
    || (failedCount > 0 ? 'schedule_evaluation_failed' : null)
    || (cronLogError ? 'cron_log_failed' : null);
  return { ok: status !== 'failed' && !cronLogError, status, failedCount, incomplete, error };
}
