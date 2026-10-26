# Calendar provider outage + cron authentication cumulative CI

**Validation-only Draft — never merge/deploy.** Snapshot: 2026-10-26 KST.

- Parent #374: `607dc1c7a7203e0b4c458975e77dc94486a77d1b` (cron fail-closed).
- Child #463: `26034e9654fe6d991b03a4dd1542180d15ad6381` (calendar provider outage).
- This branch adds only this document to the #463 HEAD and targets `main` to trigger `ci.yml` (`pull_request.branches: [main]`).
- Main at creation: `38bb82172aa2bb56d0b44f5b10692ab99f33e3bd`. #374 and main diverged; do not infer clean cumulative merge from standalone CI.
- Offline cases: 7 pure provider verdict tests, 5 real GET-handler tests with stubbed fetch/DB; no real external API, orders or production database.
- Verify: `npm test` all 0 fail, `npx tsc --noEmit` no new errors relative to main, `npm run build`, `npm run worker:build`, relevant checkers, 100X 8 shards + aggregation.
- Never merge this validation PR. #374 and #463 require separate review and explicit merge approval.
