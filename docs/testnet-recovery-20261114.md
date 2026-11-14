# TESTNET recovery verification — 2026-11-14

Baseline main: `1ccf19b01650591dbe8421e98233e855042cf4e8`.
Integrates the existing Draft PR #525; retains its history and scopes the additional fixes here.

## Observed production failure

The user authorized actual exchange Demo/TESTNET experiments. LIVE is not authorized.
The manually dispatched existing main workflow [43540297402](https://github.com/age533174851-sudo/auto-platform/actions/runs/43540297402) recorded run `f9fff7dc-3195-430e-b9ee-18f9643b63cf` as STOPPED/BLOCKED before any new smoke order.
Two historical Binance UNKNOWN attempts lack ORDERS_ZERO proof. Gate has a separate recorded ORDERS_ZERO FAIL and remains blocked.
The workflow incorrectly reported success with an empty attempt list. This is a proven reporting failure; it is not evidence of a successful buy/sell or of the exact unprovided on-screen error.

## Changes

- Reuse #525: authenticated, owned TESTNET UNKNOWN rows only; signed position/regular/Algo reads; two flat observations at least ten minutes apart, expiring after six hours. Historical verdicts and recorded FAILs are preserved. Fresh ordinary preflight still applies to new orders.
- Retain current main Binance strict quantity, malformed-response, and unaddressable-order guards during the three merge conflict resolutions.
- Attestation persistence requires exactly the requested row ID. A missing readback cannot be reported as success.
- Compare the original JSONB steps, state and mode during UPDATE. Concurrent evidence cannot be overwritten by a stale snapshot.
- Correlate workflow evidence with the exact run ID returned by its start request. Require all requested unique attempts, completion, actual fills, protection readback, closure and both zero proofs. BLOCKED and zero executed attempts fail the experiment.

## Local evidence

- Existing integration: 7,470 pass / 0 fail after merging with main.
- Added attestation regression RED: 7,470 pass / 2 fail (unconfirmed write and lost concurrent evidence). GREEN: 7,472 pass / 0 fail.
- Executed workflow Python classifier offline against seven response scenarios: RED 2 pass / 5 fail; GREEN 7 / 0. No venue calls in these tests.
- Web and Worker builds pass. TypeScript comparison and complete CI results are recorded in the PR conversation.
- Native PostgreSQL ten-slot tests inside npm test were explicitly skipped without TEN_SLOT_PG_URL; no new 10-slot certification.

## Production status and boundaries

No new merge, deployment, production DB repair, exposure attestation, or actual testnet fill was performed by this patch. The production PAPER automation remains separate and continues server-side; WAIT at capacity one is not a new fill or an error.
The existing #525 attestation route requires the authenticated owner JWT and rejects administrator impersonation. This patch deliberately does not create a privileged authentication shortcut. It also does not add a UI recovery control or a server recovery scheduler. Authenticated end-to-end attestation and actual repeated Demo fills are still unverified and must not be described as complete.

A bounded task checks the approved Demo/PAPER paths hourly at :30 on November 14, 11:30–23:30 KST. It does not retry unchanged blockers, modify code, merge, deploy, edit DB records, or change trading/risk policy. It may use the existing normal TESTNET smoke workflow only after legitimate recovery evidence and normal safety gates permit it. Its existence does not establish that trades are running.

## Release and rollback

This Draft requires separate merge/deployment approval under the user's existing release boundary. No schema migration is required. After approved release, validate authenticated owner/foreign-owner/LIVE rejection, actual three-book observations ten minutes apart, durable readback, then one SAFE testnet cycle before larger alternating batches. Gate remains blocked until its distinct recorded failure has a reviewed recovery.
Rollback is a normal reviewed revert and redeployment. Existing exposure guards must remain on; never delete or forge historical ledger evidence. A rollback of attestation support will cause those historical UNKNOWN rows to block again. Do not roll back or stop cleanup of a currently open smoke position.
