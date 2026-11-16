# Binance TESTNET protection recovery — review and release evidence

Updated 2026-11-16. This reuses PR #346; #347 is an ancestor. Integrated main
`13effcff07aaf897773684ce08ddd8faab1c4698` after #525 was merged.

## Actual problem and resulting behavior

Binance rejected conditional STOP/TP through the regular `/fapi/v1/order`
endpoint with -4120. Entry can already have filled when this happens. The
REQUIRED protection policy then unwinds, while uncertain outcomes block retries.
Neither a workflow success nor a regular-only empty book proves a safe cycle.

The first integration enabled Algo only for `smoke-test:` signals. Thus it could
pass a smoke exercise while ordinary manual/scalp/daily-ladder requests still
used the rejected endpoint. The common transport selector is now wired to those
three server routes for verified Binance TESTNET fixed-stop requests. Market
entry + ONE_WAY are the supported scope. Unsupported limit/position modes are
rejected before entry; this does not certify them. Manual OPTIONAL and automatic
REQUIRED protection policies are preserved. NO_FIXED_SL, LIVE, Gate and the
original strategy are not changed. Existing-position TPSL edits are outside this
entry transport change and are not claimed fixed.

Every Algo child requires an existing owned live_orders parent, verified TESTNET
connection without withdrawal permission, durable exact-row CAS before POST,
stable clientAlgoId, lossless algoId and actual active-order readback. A lost
reply never permits a second POST. Ordinary 36-character parent IDs use a stable
full-parent/purpose/sequence hash so SL and TP cannot collapse to one truncated ID.
Existing owned-format IDs remain stable. IDs are not cancellation authority;
immutable parent ownership is.

Recovery preserves UNKNOWN history. Flat observations require positionRisk,
regular openOrders and openAlgoOrders. Exact cancellation uses the Algo namespace
and actual receipt/individual CANCELED readback/open-book absence. Foreign orders
are not canceled. New entry remains blocked by unresolved children. This change
does not certify autonomous strategy re-entry after every venue-triggered exit;
actual strategy lifecycle/recovery must be checked before enabling schedules.

## Schema ordering

100 adds child intents and is safely re-applicable. 101 fixes the old PAPER
single-bot lease race. Current main already includes multi-bot 102/103, so a late
application of 101 must NOT overwrite their newer claim function. The migration
now leaves an existing multi-bot function intact; on a clean replay it still
installs the single-bot fix before 102/103 replace it. No deployed migration
099/102/103 file is rewritten. Both local DB harnesses replay 099/101/102/103.

## Evidence (offline unless explicitly stated)

- RED: ordinary automatic and manual executor requests rejected by the smoke-only
  scope (2 failures). GREEN: 7653 harness checks, zero failures, including actual
  executor -> fake venue -> owned cleanup / position and both-book zero evidence.
- RED: applying 101 after 103 changed the claim function fingerprint. GREEN:
  native PostgreSQL PAPER suite 13/13, including unchanged newer-function hash,
  30 eight-way claim rounds, crash/lease recovery, multi-bot isolation and RLS.
- Native PostgreSQL + official PostgREST + supabase-js verifies concurrent Algo
  claims, commit-then-lost DB reply, no resend, historical attestation, 100 replay
  and distinct persisted children for a 36-character parent. No actual venue.
- Web and Worker builds pass. TypeScript: main 73 / head 73 existing diagnostics;
  normalized added/removed diagnostics 0/0. Full static checks and exact-head CI
  are reported separately in the PR conversation; prior-head results are not
  borrowed as new-head evidence.

## Release and remaining actual verification

Production metadata at 2026-11-16 10:15 KST still lacks testnet_algo_intents;
historical Binance UNKNOWN and Gate ORDERS_ZERO FAIL remain. No exchange
submit/cancel, production DB write, release or risk-policy change was made here.

After separately approved reviewed merge/schema100+101/release, confirm actual
web/Worker/main SHA and schema. Use legitimate owner-scoped exposure recovery,
then one SAFE TESTNET cycle before any batch. Actual entry/fill, active SL/TP,
close, POSITION_ZERO and regular+Algo ORDERS_ZERO are mandatory. Stop on any
UNKNOWN/FAIL/BLOCKED. Operational ten-slot certification remains 0/10.

Rollback: stop new experiments, reconcile any in-flight entry/owned protection,
then use a reviewed code revert. Preserve ownership/intents and history; do not
Cancel All or delete positions/attempts to clear a gate.
