// scripts/lib/workflow-authority.mjs
//
// **울타리는 "어느 파일인가"가 아니라 "무엇을 할 수 있게 되는가"다.**
//
// `CLAUDE.md` 가 금지하는 것은 문자 그대로 이것이다:
//
//     `.github/workflows/`를 건드릴 수 없다 —
//     **제 울타리를 스스로 넓히는 변경을 제안할 수 없다.**
//
// 금지의 이유는 뒷문장이고, 구현은 앞문장이었다. 경로 전체를 막으면
// 취지보다 넓게 막힌다 — 그래서 **권한과 아무 상관없는 수정까지** 막혔다:
//
//     2026-11-15~18  검사기 전수에서 인자 받는 검사기를 빼는 한 줄
//                    → 울타리가 막음 → #679 가 승인 대기 → main 이 며칠 빨감
//     2026-11-18     ci.yml 에 검사기 호출 한 줄을 더하는 것
//                    → 같은 이유로 막힘
//
// 둘 다 회차가 **제 권한을 1mm도 넓히지 않는** 변경이다. 그런데 같은
// 빨간불로 막혔고, 그때마다 사람이 눌러야 했다.
//
// 그래서 막는 기준을 **취지와 같게** 바꾼다 — 경로가 아니라 **권한 표면**을
// 본다. 표면이 그대로면 통과, 한 글자라도 달라지면 거부다.
//
// ## 권한 표면에 무엇이 들어가나
//
// "이 워크플로가 무엇을 할 수 있는가"를 정하는 줄이다. 셸 본문(`run:`)과
// 주석은 들어가지 않는다 — 그 둘은 능력을 바꾸지 않는다.
//
//   on:                   언제 깨어나는가 (스스로 더 자주 깨어날 수 없다)
//   permissions:          토큰이 무엇을 할 수 있는가
//   secrets.*             어떤 비밀을 받는가
//   env: 의 키            무엇이 환경에 깔리는가
//   uses:                 어떤 액션을 끌어오는가 (남의 코드)
//   --allowedTools        회차가 쓸 수 있는 도구
//   --disallowedTools     회차가 못 쓰는 도구
//   concurrency / timeout 겹침과 상한
//   with: 의 키           액션에 넘기는 설정(토큰·ref 포함)
//
// **값까지 본다.** `permissions: contents: read` 를 `write` 로 바꾸는 것은
// 키가 같고 값만 다르다 — 그게 정확히 막아야 할 모양이다.
//
// ## 왜 이것이 약화가 아닌가
//
// 전: 워크플로 파일을 건드리면 거부 — 권한 변경도 거부되지만 무해한
//     수정도 거부된다.
// 후: 권한 표면이 바뀌면 거부 — 권한 변경은 **그대로** 거부되고,
//     무해한 수정만 통과한다.
//
// 막는 집합은 줄지 않았다. 통과시키는 집합이 늘었을 뿐이고, 늘어난
// 쪽에는 권한을 바꾸는 변경이 하나도 없다. 못 읽은 파일은 통과로 적지
// 않는다 — 읽지 못하면 그 사실로 거부한다.

/** 이 줄이 권한 표면인가 */
const AUTHORITY_LINE = [
  /^\s*on\s*:/,                      // 깨어나는 조건
  /^\s*permissions\s*:/,
  /^\s*(contents|actions|pull-requests|issues|checks|statuses|id-token|packages|deployments|security-events|pages|discussions|repository-projects)\s*:\s*\S/,
  /^\s*uses\s*:/,
  /^\s*with\s*:/,
  /^\s*env\s*:/,
  /^\s*concurrency\s*:/,
  /^\s*cancel-in-progress\s*:/,
  /^\s*group\s*:/,
  /^\s*timeout-minutes\s*:/,
  /^\s*(schedule|workflow_dispatch|workflow_run|workflow_call|push|pull_request|pull_request_target|check_suite|check_run|status|repository_dispatch|issue_comment|release)\s*:/,
  /^\s*-\s*cron\s*:/,
  /^\s*(branches|tags|paths|paths-ignore|types)\s*:/,
  /^\s*[A-Z][A-Z0-9_]*\s*:/,         // env 키 (대문자 관례)
];

/** 줄 안 어디에 있어도 권한을 바꾸는 모양 */
const AUTHORITY_ANYWHERE = [
  /secrets\./,
  /--allowedTools/,
  /--disallowedTools/,
  /\$\{\{\s*(secrets|vars)\./,
  /GITHUB_TOKEN/,
  /ANTHROPIC_[A-Z_]*/,
];

/** YAML 주석을 뗀다 — 설명은 능력이 아니다 */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * 워크플로 원문에서 **권한 표면만** 뽑는다. 들여쓰기까지 남긴다 —
 * 같은 키가 다른 깊이로 옮겨 가면 효력이 달라질 수 있다.
 */
export function authoritySurface(src) {
  const out = [];
  for (const raw of String(src ?? '').split('\n')) {
    const line = stripComment(raw);
    if (line.trim() === '') continue;
    const hit = AUTHORITY_LINE.some((re) => re.test(line))
      || AUTHORITY_ANYWHERE.some((re) => re.test(line));
    if (hit) out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/**
 * 한 파일의 권한 표면이 그대로인가.
 *
 * `before`/`after` 가 `null` 이면 **읽지 못한 것**이다 — 통과로 적지
 * 않는다(`CLAUDE.md`: UNKNOWN 을 0으로 적지 않는다). 파일이 새로
 * 생기거나 지워지는 것은 표면 전체가 생기거나 사라지는 것이므로 변경이다.
 */
export function authorityFindings({ path, before, after }) {
  if (before == null && after == null) {
    return [`${path}: 양쪽을 다 읽지 못했습니다 — 못 읽은 것을 통과로 적지 않습니다`];
  }
  if (before == null) return [`${path}: 워크플로를 새로 만들었습니다 — 권한 표면이 통째로 생깁니다`];
  if (after == null) return [`${path}: 워크플로를 지웠습니다 — 울타리가 사라질 수 있습니다`];

  const a = authoritySurface(before);
  const b = authoritySurface(after);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return [];

  const added = b.filter((l) => !a.includes(l));
  const removed = a.filter((l) => !b.includes(l));
  const sample = [...added.map((l) => `+ ${l.trim()}`), ...removed.map((l) => `- ${l.trim()}`)]
    .slice(0, 4);
  return [`${path}: 권한 표면이 바뀌었습니다 — 제 울타리는 스스로 넓힐 수 없습니다`
    + (sample.length ? `\n     ${sample.join('\n     ')}` : '')];
}
