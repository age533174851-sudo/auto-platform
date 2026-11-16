-- 097_jobs_killswitch_active_unique.sql
--
-- #398: two workers can both read "no active kill-switch job" and insert.
-- The read/insert sequence is not a transaction. A lease check alone is not
-- atomic with INSERT, so the database must reject the second active job.
--
-- SAFETY: Do not apply to any operating DB without separate user approval.
-- Before approval, inspect existing duplicates with this READ-ONLY query:
--   SELECT connection_id, count(*) FROM public.jobs
--   WHERE action = 'KILL_SWITCH_EXECUTE'
--     AND status IN ('PENDING', 'PROCESSING')
--     AND connection_id IS NOT NULL
--   GROUP BY connection_id HAVING count(*) > 1;
--
-- If duplicates exist, index creation FAILS. This migration deliberately does
-- not cancel, merge, or delete any job; operator review is required.
-- Existing COMPLETED/FAILED/CANCELLED jobs remain unrestricted so recovery can
-- create a fresh job after a previous attempt has ended.
--
-- NOTE: this prevents simultaneous active jobs, not a later job created after
-- an earlier one COMPLETES while kill_switch_state stays active. Exchange-side
-- idempotency and kill-switch reset semantics need separate review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_kill_switch_per_connection
  ON public.jobs (connection_id)
  WHERE action = 'KILL_SWITCH_EXECUTE'
    AND status IN ('PENDING', 'PROCESSING')
    AND connection_id IS NOT NULL;
