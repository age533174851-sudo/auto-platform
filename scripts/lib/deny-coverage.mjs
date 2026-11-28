// scripts/lib/deny-coverage.mjs
//
// **낱말이 적혀 있는 것과 그 명령이 막히는 것은 다르다.**
//
// 무인 회차의 울타리는 두 자리에서 "이 명령이 금지 목록에 있는가"를
// 물었고, 둘 다 **목록 문자열 전체에 대한 부분일치**였다:
//
//   scripts/check-claude-hourly.mjs  ⑨   m[1].includes(d)
//   scripts/lib/autodev-delivery.mjs ④   denyText.includes(d)
//
// 그래서 낱말만 들어 있으면 통과했다. 기준 main ed00c1a4 의 격리
// worktree 에서 실제 금지 목록을 바꿔 넣고 `check-claude-hourly.mjs` 를
// 돌려서 얻은 값 (rc 만 보지 않고 ⑨ 의 문장이 나오는지로 귀속했다):
//
//   대조 · 원문 그대로                                      rc=0  OK
//   대조 ★★ --disallowedTools 줄을 지운다                    rc=1  OK
//   Bash(curl:*) → Bash(curl --unix-socket:*)              rc=0  구멍
//   Bash(psql:*) → Bash(psql-dump:*)                       rc=0  구멍
//   Bash(gh pr merge:*) → Bash(gh pr merge-queue:*)        rc=0  구멍
//   Bash(gh workflow run:*) → Bash(echo gh workflow run)   rc=0  구멍
//   Bash(curl:*) → Read(docs/curl.md)                      rc=0  구멍
//
// 뒤의 둘이 방향을 보여 준다 — **무해한 항목이 금지 요구를 채웠다.**
// `Read(docs/curl.md)` 는 Bash 를 하나도 막지 않는데 관문은 `curl` 이
// 막혔다고 적는다. 첫 줄은 더 조용하다: 좁은 꼴만 막아 두면 관문은
// "막혔다"고 적는데 평범한 `curl https://…` 는 그대로 열려 있다. `curl`
// 하나로 배포된 앱이나 거래소로 직접 요청을 만들 수 있다.
// **못 막은 것을 막았다고 적는 것은 UNKNOWN 을 0 으로 적는 것보다 나쁘다.**
//
// 왜 판정이 여기 있고 `autodev-delivery.mjs` 안이 아닌가
// ───────────────────────────────────────────────────────────────────
// `scripts/lib/autodev-delivery.mjs` 는 **제출 통로 울타리 경로**다
// (`check-autodev-safety.mjs`). 무인 회차는 자기 제출 통로를 고칠 수
// 없다 — 그 관문이 옳다. 그래서 판정을 통로 밖 이 파일에 두고, 통로
// 파일에서는 **매칭 규칙만 읽어 온다**(새 파서를 만들지 않는다).
//
// 그 결과 ④ 는 아직 부분일치로 남아 있다. 닫으려면 통로 파일을 고쳐야
// 하고 그것은 승인 사항이다. **닫았다고 적지 않는다** — 통과한다는
// 사실 자체를 `scripts/test-autodev-deny-coverage.mjs` 에 시험으로 남겼다.
import {
  bashRuleBody,
  bashRuleMatchesEither,
  splitTools,
} from './autodev-delivery.mjs';

/**
 * CLI 수준에서 **반드시 막혀 있어야 하는 명령.**
 *
 * 허용 목록이 관문이고 이쪽은 그 위의 한 겹이다. 그래도 `curl` 하나만
 * 열려 있으면 배포된 앱이나 거래소로 직접 요청을 만들 수 있다.
 *
 * 이 목록은 `check-claude-hourly.mjs` 안에 **따로** 있었다. 목록과 판정이
 * 같은 곳에 있어야 갈리지 않는다.
 */
export const MUST_DENY_COMMANDS = [
  'gh workflow run',
  'gh pr merge',
  'curl',
  'psql',
];

/** 금지 대조에 쓰는 대표 인자. 인자가 붙은 꼴도 막히는지 보려는 것이다. */
export const DENY_PROBE_ARG = 'x';

/**
 * 금지 목록이 이 명령을 **실제로** 막는가.
 *
 * 낱말을 세지 않고 문서의 매칭 규칙으로 대조한다
 * (`bashRuleMatchesEither` — `autodev-delivery.mjs` 의 정본). 요구는 둘:
 *
 *   ① `Bash(...)` 규칙이어야 한다 — `Read(...)` 는 Bash 를 막지 않는다
 *   ② 맨 명령과 **인자가 붙은 꼴**을 둘 다 막아야 한다 — 맨 꼴만 막으면
 *      `curl https://…` 가 지나간다
 *
 * 지금 두 갈래의 실제 금지 목록은 요구 7개(`MUST_DENY_COMMANDS` 4 +
 * `MUST_STAY_DENIED` 3)를 이 기준으로 모두 막는다(`Bash(curl:*)` 처럼
 * `:*` 로 적혀 있다). 그래서 이 강화로 main 이 빨강이 되지 않는다 —
 * 두 갈래 7×2 를 돌려서 확인했다.
 */
export function denyCovers(denyList, command) {
  const rules = (Array.isArray(denyList) ? denyList : splitTools(denyList))
    .filter((r) => bashRuleBody(r) != null);
  const withArg = `${command} ${DENY_PROBE_ARG}`;
  return rules.some((r) => bashRuleMatchesEither(r, command)
    && bashRuleMatchesEither(r, withArg));
}

/**
 * 판정 자기 점검 — **낱말이 아니라 명령이 막히는지** 센다.
 *
 * 다섯 줄이 검사기를 실제로 돌려 얻은 구멍 그대로다. 이 판정이 틀리면
 * 그 뒤의 초록은 아무 뜻이 없으므로 검사기가 갈래 검사보다 먼저 돌린다.
 */
const CASES = [
  { what: '정본 꼴은 막는다',
    deny: 'Bash(curl:*)', cmd: 'curl', want: true },
  { what: '좁은 꼴만 막으면 맨 명령은 열려 있다',
    deny: 'Bash(curl --unix-socket:*)', cmd: 'curl', want: false },
  { what: '이름이 더 긴 다른 명령은 막는 것이 아니다',
    deny: 'Bash(psql-dump:*)', cmd: 'psql', want: false },
  { what: '하위 명령이 다르면 막는 것이 아니다',
    deny: 'Bash(gh pr merge-queue:*)', cmd: 'gh pr merge', want: false },
  { what: '낱말만 품은 무해한 항목은 금지가 아니다',
    deny: 'Bash(echo gh workflow run)', cmd: 'gh workflow run', want: false },
  { what: 'Bash 규칙이 아니면 Bash 를 막지 못한다',
    deny: 'Read(docs/curl.md)', cmd: 'curl', want: false },
  { what: '맨 꼴만 막으면 인자가 붙은 호출이 지나간다',
    deny: 'Bash(curl)', cmd: 'curl', want: false },
  { what: '목록 중 하나라도 실제로 막으면 막힌 것이다',
    deny: 'Bash(echo curl),Bash(curl:*)', cmd: 'curl', want: true },
  { what: '빈 목록은 아무것도 막지 못한다',
    deny: '', cmd: 'curl', want: false },
  { what: '지금 저장소의 실제 꼴은 그대로 막힌다',
    deny: 'Bash(git push origin main:*)', cmd: 'git push origin main', want: true },
  { what: '항목 배열로 넘겨도 같은 판정이다',
    deny: ['Bash(psql:*)'], cmd: 'psql', want: true },
];

export function selfTest() {
  const failed = [];
  for (const c of CASES) {
    const got = denyCovers(c.deny, c.cmd);
    if (got !== c.want) {
      const shown = Array.isArray(c.deny) ? c.deny.join(',') : c.deny;
      failed.push(`${c.what} — 기대 ${c.want}, 실제 ${got} (\`${shown}\` vs \`${c.cmd}\`)`);
    }
  }
  return { total: CASES.length, failed };
}
