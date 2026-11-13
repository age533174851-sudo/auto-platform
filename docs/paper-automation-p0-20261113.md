# PAPER server repetition — P0 evidence and release boundary

Owner: Codex. Base: Draft #621, `6bf2d3fe5deb27f9e0b4b75dbd0cecbd2ed9471f`.
Main inspected: `220f800135eb9336e263200c32d8e2e80dad2a5d`.
The conflicting ChatGPT hourly development automation was paused and `is_enabled=false` was read back. Claude coordination is recorded on #621; this does not prove Claude has read it.

## Observed failures

- `/api/paper/run` performs one user-authenticated cycle. There was no persistent start/stop setting, due-run claim or browser-independent repetition for that runner. The production DB inspection found zero PAPER schedules and only historical closed PAPER positions; that is absence of execution evidence, not proof that all orders fail.
- The worker already calls the PAPER exit monitor about every minute. Its TESTNET scheduler is intentionally unchanged.
- In the HTTP integration RED case, an expired futures quote followed by a failed upstream read still produced `ENTERED`: `getPremiumIndex` preserves `STALE_CACHE`. The common PAPER price reader now requires `readPremiumIndex.freshness === 'FRESH'`. Quotes within the existing 45-second cache TTL retain the existing meaning of fresh.

## Implementation

`099_paper_automation.sql` adds per-user settings and durable evaluation runs. Service-only invoker RPCs control, claim, fence the final fill, and finish the evaluation. Authenticated users have ownership-scoped read policies and cannot execute these RPCs or write settings directly.

Start persists a default-account, USDM-only PAPER session; it does not place an order. Stop increments the generation and cancels outstanding claims before acknowledging. Expired claims reuse the same run ID with a new token. The token, generation, enabled state and deadline are checked under the settings/run/account locks at the final ledger write. The existing `paper_open_position` commits position, fee and durable run position ID in one transaction. A lost response recovers that position rather than generating another signal. The same account lock serializes capacity with manual PAPER orders. A reset account's changed `started_at` blocks stale entry sessions.

The existing PAPER exit-monitor wakeup invokes at most one due user after its protective sweep. JWT polling cannot advance automation. Failed/unknown protective exits suppress entries for that wakeup. The engine reuses `paperRunner`, `paperDispatch`, `buildPaperPlan`, account-scoped daily loss checks, regime collection and the existing atomic PAPER settlement. Declared time exits apply only to `paper-auto-v1` positions. Stop preserves global SL/TP/liquidation protection. This first version serializes one due user per wakeup; requested intervals can be delayed by backlog.

`/api/paper/automation` derives ownership from the existing validated user authentication. Its GET only reads and hides account IDs and lease tokens. The new PAPER panel uses GET for refresh, POST only for explicit start/stop, and displays requested state separately from observed completion, plus evaluation reasons, virtual fills, SL/TP/liquidation prices, balance, fees and realized PnL. All values refer explicitly to the default server PAPER account.

## Reproducible local evidence

- RED: starting a durable run fails because `paper_auto_control` does not exist before 099.
- GREEN: 9 real PostgreSQL 17 tests: persisted start, 8-way claim race, 8-way fill race with one fee, Stop fence, expired-token recovery, lost-response recovery, capacity including manual orders, expiration while waiting for an account lock, and service RPC permissions.
- Browser/HTTP integration: actual Next routes, supabase-js, official PostgREST 13.0.7, real local PostgreSQL and the existing money RPCs. Authentication and public market quotes are explicitly offline fixtures; unrelated dashboard cards are fixtures. No venue orders are sent.
- The browser starts automation and closes; the server fills, restarts as a new process, evaluates again without duplicating the position, persists Stop, and settles SL. Additional cases settle TP, liquidation and declared max hold. A reconnected browser reads the persisted history and PnL. The stale-quote RED case becomes `UNKNOWN_PRICE` without a new position.
- #621's manual futures SHORT also passes the actual browser confirmation, `/api/paper/order`, committed PostgreSQL position (SHORT with the correct stop direction), and `/api/paper/close` settlement. This verifies PAPER manual execution, not TESTNET/LIVE venue execution.
- Full regression after the price fix: 7,386 passed, 0 failed. Web and Worker builds passed. TypeScript diagnostics match main: 73 existing, zero added/removed after normalizing source line numbers and union-member order. All 82 static check scripts passed. Remote CI is recorded in the PR conversation; do not infer a completed remote check from this document alone.
- The first remote general CI correctly rejected the new screen timer until its read-only status polling was registered in `check-runtime.mjs`. The registry now classifies it as POLL; execution remains on the server. At the initial implementation SHA, remote PAPER HTTP/DB integration and the full official Supabase migration replay both passed. The follow-up commit reruns checks at its own SHA.

Commands (loopback scratch DB only):

```sh
TEN_SLOT_PG_URL=postgresql://USER@127.0.0.1:PORT/postgres node --test scripts/paper-automation-pg.test.mjs
TEN_SLOT_PG_URL=postgresql://USER@127.0.0.1:PORT/postgres PAPER_AUTO_POSTGREST_BIN=/path/to/postgrest node scripts/probe/paper-automation-flow.mjs
```

Set `TEN_SLOT_PSQL` if psql is not on PATH. The HTTP probe also needs Playwright/Chromium. It creates/drops its own scratch DB and launches/stops local servers. The dedicated CI runs this path and a full official Supabase migration replay without production credentials.

## Release and recovery

No production migration, merge, deployment, TESTNET/LIVE order, secret read/change or risk-policy change is authorized or performed. Operational ten-slot completion stays **0/10**. Direct order UI verification from #621 is separate from actual venue execution. Existing production TESTNET evaluations with `NO_BREAKOUT` do not prove order placement.

Release requires user approval for applying migration 099 to production, merging the stacked PRs, and deploying the reviewed web version. Check the existing worker's PAPER wakeup and admin authentication after rollout without submitting TESTNET/LIVE orders. Only after an approved PAPER-only start and observed durable evaluations/fills/settlements can operation be certified.

Recovery: stop new PAPER sessions via the persisted Stop control; keep the existing exit monitor running to protect open positions. Roll the web back to the prior deployment if needed. Keep the additive settings/history tables and existing PAPER ledger; do not delete ledger data or automatically reverse fills. Record outstanding positions before any further change. Re-enable the paused development automation only after assigning a non-conflicting scope.
