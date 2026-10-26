# News provider outage + cron authentication integration (2026-10-26)

**Verification-only branch — DO NOT MERGE OR DEPLOY.**

Source stack:
- #374: fail-closed CRON_SECRET authentication.
- #461: all configured news providers unavailable must return HTTP 503 / ok:false.
- #435: separate news-pipeline workflow verdict, **not included in this branch**.

This branch is based on #461 and targets `main` solely to trigger the
main-scoped `ci.yml` pull_request checks. No existing PR branch is modified.

Offline regression requirements:
1. Missing/malformed CRON_SECRET must reject before any fetch or DB call.
2. Every configured news API returns 429 / invalid response -> HTTP 503,
   `error=news_providers_unavailable`, zero DB writes.
3. A valid empty provider response (`[]`) is a normal zero-article run.
4. One provider failure with another valid empty response is partial success.
5. `npm test`, TypeScript baseline, production/worker build, checkers,
   and 100X mutation jobs must be reviewed at the exact head SHA.

Do not treat CI green as proof of live provider behavior. No operational DB
changes, TESTNET/LIVE orders, deployment, or merge are authorized.
