# Binance TESTNET Algo integration — 2026-11-14

Foundation: Draft #525 head `6ac9921b66630e9fd0219e6837fe0f8987ece63e`, main `1ccf19b01650591dbe8421e98233e855042cf4e8`.
Reuses existing #346 payload/readback/cancellation contracts and #347 regular + Algo residual proof. This is their integration, not a duplicate Algo PR.

## Actual observed fault

USER smoke attempts `72194749-2648-49b8-9da7-de0e0476884f` (BTC) and `260ba1eb-2944-4a70-9a91-b31af6aceac7` (ETH), 2026-11-14 10:34 KST, failed to attach STOP with Binance `-4120 / Please use the Algo Order API endpoints instead`. Their order IDs and quantities are not proof of zero fills; both attempts remain UNKNOWN. Current production regular-only ORDERS_ZERO cannot certify Algo absence.

## Scoped implementation

- Only the server's verified Binance TESTNET smoke entry opts into the new transport. LIVE, original strategies, leverage, risk limits, position modes, and ordinary manual/automatic order routing are not changed by this staged integration. Ordinary non-smoke order paths are not certified fixed by this PR.
- Owner/connection/explicit TESTNET/no-withdrawal gates and ONE_WAY/fresh mark checks precede entry. Pure #346 payload checks remain mandatory. No unverified mode/quote fallback.
- Migration 100 adds `live_orders.testnet_algo_intents` beside the existing parent intent, with an object constraint and owner/connection index. Existing service-only UPDATE/RLS remains authoritative. No credential values are stored.
- A stable, purpose-specific clientAlgoId derives from the existing owned entry ID. An exact-row JSONB/status CAS must durably store SENT before the only Algo POST. Lost DB/venue responses never authorize resend.
- Acceptance validates lossless algoId, client ID, symbol, side and order kind; active protection requires exact open-Algo readback, including closing flags and current NEW status. The stored state must be read back before success.
- Protective IDs use `algo:<lossless-id>` so regular and Algo namespaces cannot collide. Exact single cancellation uses the Algo endpoint and requires matching receipt, individual CANCELED query and absence from the validated open book.
- The real smoke settlement reads both books, cancels only the current parent's Algo IDs, proves position zero and residual zero, and reconciles durable child intents. Another parent's same-strategy Algo text cannot authorize cancellation.
- Ambiguous child state blocks new entries. The existing authenticated recovery control can append two real flat observations at least ten minutes apart, expiring after six hours; original child state remains unchanged and the same child still cannot be resent.
- The Binance smoke result now returns actual fill/settled/protection evidence used by enteredVerdict. STARTED additionally requires durable HOLDING/deadline/identity readback; an unconfirmed write is UNKNOWN.
- The legacy executor no longer suggests switching to LIVE. The independent missing-fallback-reason extraction belongs to Claude #631; this integration leaves that legacy function unchanged to avoid overlapping ownership.

## Evidence and limits

- Merged #346/#347 foundation: 7,512 harness tests / 0 failures.
- Root negative control reproduces actual legacy -4120. New real engine -> real settle against FakeVenue sends Algo STOP/TP and cancels exactly their Algo IDs; no regular protective DELETE.
- Regression RED: same-strategy foreign Algo was canceled (1 erroneous DELETE); GREEN preserves it and reports incomplete cleanup.
- Regression RED: missing HOLDING/deadline write returned STARTED from an ENTERING row; GREEN requires exact stored deadline and identity.
- Final local harness: **7,524 pass / 0 fail**. Local web and Worker builds pass; TypeScript retains the existing main 73 diagnostics (no new diagnostic category/path). Native persistence test passes, including two-observation recovery without same-intent resend. CI evidence must be checked at the final published HEAD.
- The official Supabase replay CI also checks that authenticated owners can read their row but cannot forge Algo intent evidence.
- The obsolete research-only no-wiring assertion is replaced by a pure-contract no-transport boundary test plus actual-executor rejection tests (LIVE, Gate, ordinary strategies and unsupported modes have zero venue/DB side effects). The pure `executionAuthorized:false` contract remains unchanged.
- Core tests cover confirmed intent before POST, lost ACK no-resend, missing DB acknowledgement, wrong protective flags, LIVE/hedge gates and lossless IDs.
- Actual task-owned PostgreSQL + official PostgREST + supabase-js: missing migration RED, migration 100 GREEN; eight concurrent claimers produce one send permission, fresh client restart cannot resend, and lost DB response after COMMIT cannot resend. Recovery observations preserve historical submission state.
- Authentication/browser -> real Next -> PostgREST -> PostgreSQL recovery proof is in #525. This PR's venue engine/settlement HTTP is FakeVenue and the atomic persistence test is separate; this is not a real authenticated exchange end-to-end certification.
- Native/CI/build/typecheck results and exact final SHA are recorded in the PR conversation. Operational ten-slot verification stays **0/10**.

## Release approval and verification

No production schema apply, merge, deployment or actual new venue order/cancel was performed by this work. Migration 100 plus #525/#346 release need the user's separate approval. After all exact-head CI/100X/offline checks pass and approval exists, apply the reviewed migration, merge without protection bypass, verify deployed web/Worker versions, then validate real owner-scoped TESTNET books and one SAFE cycle before any alternating batch. Existing recorded FAIL/unknown guards remain on; no Cancel All or connection cloning.

Failure/readback ambiguity stops further experiments. A triggered/expired order is not forged into CANCELED; if its terminal/position evidence cannot be verified, it remains blocked for explicit reconciliation. A DB outage cannot be called a scheduled close: the holding-write fault path returns UNKNOWN and preserves protection/connection fences rather than STARTED.

Rollback: stop new smoke experiments through the existing control; complete/prove cleanup of any open cycle before reverting. Revert/redeploy the runtime patch with a reviewed PR. Keep migration 100 and all intent/evidence data; dropping the column would discard ownership/recovery evidence. Reverting to the old transport reintroduces -4120 and is not a reason to resume experiments.

## Exact-head CI follow-up: PAPER claim race

CI run 43549284321 at the first integrated head found two PAPER claim responses instead of one. A SELECT can retain its earlier snapshot while another claimant commits. Because 099 did not change the settings row, the late candidate could lock the current run and rotate its still-valid token. The final fill fence prevented this observation from proving duplicate fills; it is still a real lease violation.

A deterministic native test pauses the candidate with a test-only RLS/advisory barrier, commits another claim, then resumes it. RED: the stale candidate stole the live lease. New migration **101** rechecks the locked run before rotating its token; 099 remains unchanged. Lease duration and PAPER risk/interval/strategy settings remain unchanged. GREEN: native PAPER **10/10**, plus actual browser → Next/PostgREST/PG → browser close → server restart → repeated PAPER cycles and all protective exit fixtures. The native test adds no production hooks or privileges.

Release approval therefore covers **100 + 101**, #525 and this integration, followed by web/Worker deployment and one real SAFE TESTNET cycle. Retain 101's compatible lease correction on rollback; do not restore the known race. Latest-head checks supersede the failed first run and must pass before any release.
