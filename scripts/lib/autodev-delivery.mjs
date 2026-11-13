// scripts/lib/autodev-delivery.mjs
//
// **무인 회차가 작업물을 내보내는 통로를 "이름"이 아니라 "모양"으로 센다.**
//
// 처음에 이 통로를 열 때 나는 허용 목록에 이름이 있는지만 셌다:
//
//     allow 에 `Bash(git push -u origin:*)` 가 있는가
//     deny  에 `git push -u origin main` 이 있는가
//
// 그 셈은 **틀렸다.** 공식 문서(code.claude.com/docs/en/permissions)가
// 적는 Bash 규칙의 뜻은 이렇다:
//
//   · "The `:*` suffix is an equivalent way to write a trailing wildcard,
//      so `Bash(ls:*)` matches the same commands as `Bash(ls *)`."
//   · "A `*` in a Bash rule matches any text, **including spaces**."
//   · "Claude Code matches everything before the first `*` as written."
//
// 따라서 `Bash(git push -u origin:*)` 는 `git push -u origin ` 뒤의
// **아무 글자나** 받는다 — `HEAD:main` 도, `--force` 도 받는다:
//
//     git push -u origin HEAD:main              ← main 으로 직접 밀린다
//     git push -u origin claude/dev-x --force   ← 역사를 다시 쓴다
//
// 그리고 내가 "구멍을 열면서 막았다"고 적은 금지 두 줄은 그 둘 중
// 어느 것도 잡지 못한다. `Bash(git push -u origin main:*)` 는 접두어가
// `git push -u origin main` 이라서 `HEAD:main` 과 글자가 다르고,
// `Bash(git push --force:*)` 는 접두어가 `git push --force` 라서
// **뒤에 붙은** `--force` 를 보지 못한다.
//
// 문서는 금지 목록의 한계를 아예 못 박아 둔다:
//
//   "A Bash rule matches the command text Claude writes … it **isn't a
//    security boundary** around the program."
//   `Bash(git push *)` 는 `git -C . push origin main` 을 막지 못한다.
//
// 즉 **금지 목록은 관문이 아니다.** 관문은 허용 목록이다 — 기본 모드에서
// 허용에 걸리지 않는 명령은 사람에게 묻고, 러너에는 답할 사람이 없다.
//
// 그래서 이 모듈은 두 가지를 한다:
//
//   ① 문서의 매칭 규칙을 구현해서, **허용 항목 하나하나가 금지된 모양을
//      표현할 수 있는지** 실제로 대조한다. 이름을 세지 않는다.
//   ② 제출 자체를 저장소가 가진 스크립트 한 개로 좁히고, 그 스크립트가
//      쓸 git argv 를 **여기서** 만든다. 모델이 refspec 이나 플래그를
//      넘길 자리가 없으면 그 모양은 표현 불가능해진다 — `CLAUDE.md`
//      "자동화보다 실패 지점 제거가 우선이다".
//
// `:*` 의 뜻에는 **아직 모르는 구석이 있다.** 문서는 `Bash(ls:*)` ≡
// `Bash(ls *)` 라고 적는데, 그 등가가 "콜론이 공백으로 바뀐다"는 뜻이면
// 접두어 뒤에 공백이 필수다. 그래서 두 읽기를 **모두** 재고, 어느 한쪽에서라도
// 금지된 모양이 통과하면 실패로 센다 — 모르는 것을 통과로 적지 않는다.

/** 제출 통로의 정본. 워크플로 허용 목록과 스크립트 경로가 여기서 만난다. */
export const SUBMIT_SCRIPT = 'scripts/autodev-submit.mjs';
export const SUBMIT_TOOL = `Bash(node ${SUBMIT_SCRIPT}:*)`;

/** 러너 안에서만 끝나는 도구 — 이것이 없으면 회차는 아무것도 담지 못한다. */
export const LOCAL_TOOLS = [
  ['Bash(git switch -c:*)', '새 브랜치를 만들 수 없습니다'],
  ['Bash(git add:*)', '변경을 담을 수 없습니다'],
  ['Bash(git commit:*)', '커밋할 수 없습니다 — 작업물이 러너에서 사라집니다'],
];

/**
 * **어떤 허용 항목도 표현할 수 없어야 하는 명령들.**
 *
 * 이름이 아니라 이 모양들로 센다. 허용 항목 하나가 이 중 하나와
 * 맞으면, 그 항목은 이름이 무엇이든 그 일을 할 수 있다는 뜻이다.
 */
export const FORBIDDEN_SHAPES = [
  ['git push origin main', 'main 으로 직접 밀 수 있습니다'],
  ['git push -u origin main', 'main 으로 직접 밀 수 있습니다'],
  ['git push -u origin HEAD:main', 'refspec 으로 main 에 밀 수 있습니다'],
  ['git push origin HEAD:main', 'refspec 으로 main 에 밀 수 있습니다'],
  ['git push -u origin claude/dev-x:main', 'refspec 으로 main 에 밀 수 있습니다'],
  ['git push -u origin claude/dev-x --force', '뒤에 붙은 --force 로 역사를 다시 쓸 수 있습니다'],
  // ── 선행 `--force` 도 센다 ──
  //
  // 2026-11-08에 구멍이 하나 드러났다. 위 두 줄은 **뒤에 붙은** `--force`만
  // 모양으로 갖고 있었다. 그래서 허용 항목에 `Bash(git push --force:*)`를
  // 넣으면 접두어가 `git push --force`라서 위 어느 모양과도 맞지 않고,
  // 검사기가 **통과시켰다.** 그런데 그 항목은 `git push --force origin main`
  // 과 `git push --force origin claude/dev-x`를 전부 허용한다 — 즉 이
  // 울타리가 막으려는 두 가지(main 강제 push, 역사 재작성)를 그대로 연다.
  //
  // 짧은 플래그 `-f`와 `--force-with-lease`도 같은 구멍이라 함께 적는다.
  ['git push --force origin main', '선행 --force 로 main 을 강제로 덮을 수 있습니다'],
  ['git push --force origin claude/dev-x', '선행 --force 로 역사를 다시 쓸 수 있습니다'],
  ['git push --force-with-lease origin main', '선행 force 로 main 을 덮을 수 있습니다'],
  ['git push -f origin main', '짧은 -f 로 main 을 강제로 덮을 수 있습니다'],
  ['git push -f origin claude/dev-x', '짧은 -f 로 역사를 다시 쓸 수 있습니다'],
  ['git push -u origin claude/dev-x --force-with-lease', '뒤에 붙은 force 로 역사를 다시 쓸 수 있습니다'],
  ['git push origin +claude/dev-x:main', '+refspec 으로 강제로 main 에 밀 수 있습니다'],
  ['gh pr merge 1 --merge', 'PR 을 스스로 병합할 수 있습니다'],
  ['gh workflow run ci.yml', '다른 워크플로를 깨울 수 있습니다'],
  ['gh pr create --title x --body y', 'Draft 가 아닌 PR 을 열 수 있습니다'],
  ['git -C . push origin main', 'git -C 우회로 main 에 밀 수 있습니다'],
  // **제 것보다 먼저 있던 구멍.** `gh api` 는 REST 를 그대로 부른다 —
  // 경로 접두어만 허용해도 뒤에 `--method PUT` 을 붙일 수 있으므로
  // main 에 파일을 쓰고, PR 을 병합하고, 워크플로를 깨울 수 있다.
  // 금지 쪽의 `Bash(gh api --method POST:*)` 는 접두어가
  // `gh api --method POST` 라서 `gh api repos/... --method POST` 와
  // 글자가 다르고, 그래서 아무것도 잡지 못한다.
  ['gh api repos/o/r/contents/README.md --method PUT -f message=x -f content=y',
    'main 의 파일을 REST 로 직접 쓸 수 있습니다'],
  ['gh api repos/o/r/pulls/1/merge --method PUT', 'PR 을 REST 로 병합할 수 있습니다'],
  ['gh api repos/o/r/actions/workflows/ci.yml/dispatches --method POST',
    '다른 워크플로를 REST 로 깨울 수 있습니다'],
  ['gh api repos/o/r/git/refs/heads/main --method PATCH -f sha=x',
    'main 이 가리키는 커밋을 REST 로 바꿀 수 있습니다'],
];

/**
 * 문서가 적는 복합 명령 구분자.
 *
 *   "The recognized command separators are `&&`, `||`, `;`, `|`, `|&`,
 *    `&`, and newlines. **Every subcommand must be allowed** for a
 *    compound command to run without a prompt."
 *
 * 그래서 금지된 모양이 복합 명령이면, **모든 조각이** 허용에 걸릴 때만
 * 표현 가능하다. 이것을 모델링하지 않으면 `Bash(git commit:*)` 같은
 * 무해한 항목에 거짓 RED 가 난다 — 늑대 소리를 내는 검사기는 무시당한다.
 */
export function splitSubcommands(command) {
  return String(command ?? '')
    .split(/\s*(?:\|\&|\&\&|\|\||;|\||\&|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 허용 목록 **전체**가 이 모양을 표현할 수 있는가.
 *
 * 조각 하나라도 아무 항목에도 걸리지 않으면 러너는 사람에게 묻고,
 * 답할 사람이 없으므로 그 모양은 표현 불가능하다.
 */
export function shapeExpressible(allowList, shape) {
  const parts = splitSubcommands(shape);
  if (parts.length === 0) return null;
  const hits = [];
  for (const part of parts) {
    const rule = allowList.find((r) => bashRuleMatchesEither(r, part));
    if (!rule) return null;
    hits.push(rule);
  }
  return [...new Set(hits)];
}

/**
 * 금지 목록에 계속 남아 있어야 하는 모양.
 *
 * **이것은 관문이 아니다** — 문서가 "isn't a security boundary" 라고
 * 적는다. 관문은 허용 목록이고, 이쪽은 그 위에 한 겹 더 두는 것이다.
 * 그래도 지우지는 않는다: 모델이 흔히 쓰는 모양을 한 번 더 걸러 준다.
 */
export const MUST_STAY_DENIED = [
  'git push origin main',
  'git push -u origin main',
  'git push --force',
];

/** `Bash(...)` 안쪽을 꺼낸다. Bash 규칙이 아니면 null. */
export function bashRuleBody(rule) {
  const m = /^Bash\((.*)\)$/.exec(rule.trim());
  return m ? m[1] : null;
}

/**
 * 문서의 매칭 규칙 구현.
 *
 * `colonSpace` 가 참이면 끝의 `:*` 를 ` *`(공백 + 와일드카드)로 읽고,
 * 거짓이면 `*`(공백 없음)로 읽는다. 문서의 등가 서술이 두 가지로
 * 읽히므로 **둘 다** 재고, 호출하는 쪽이 둘 중 하나라도 맞으면
 * 맞은 것으로 센다.
 */
export function bashRuleMatches(rule, command, { colonSpace = true } = {}) {
  const body = bashRuleBody(rule);
  if (body == null) return false;

  let pat = body;
  if (pat.endsWith(':*')) pat = pat.slice(0, -2) + (colonSpace ? ' *' : '*');

  const starCount = (pat.match(/\*/g) || []).length;
  const trailingSpaceStar = starCount === 1 && pat.endsWith(' *');

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  if (trailingSpaceStar) {
    // "A `*` at the end, with a space before it, also matches the bare
    //  command." — 그 등가는 **유일한 와일드카드일 때만** 성립한다.
    re = `${esc(pat.slice(0, -2))}(?: .*)?`;
  } else {
    re = pat.split('*').map(esc).join('[\\s\\S]*');
  }
  return new RegExp(`^${re}$`).test(command);
}

/** 두 읽기 중 어느 쪽으로든 맞으면 맞은 것으로 센다 (fail-closed). */
export function bashRuleMatchesEither(rule, command) {
  return bashRuleMatches(rule, command, { colonSpace: true })
    || bashRuleMatches(rule, command, { colonSpace: false });
}

/** `--allowedTools "a,b,c"` 의 값을 항목으로 쪼갠다. */
export function splitTools(list) {
  return String(list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 한 갈래의 허용·금지 목록을 보고 지적을 모은다.
 *
 * 반환은 문장 배열이다 — 비어 있으면 통과. 검사기가 이것을 그대로
 * 적고, 스크립트와 검사기가 **같은 파일**을 쓴다
 * (`CLAUDE.md`: 로직을 복제하지 않는다).
 */
export function deliveryFindings({ allow, deny, mode }) {
  const found = [];
  const allowList = splitTools(allow);
  const denyText = String(deny ?? '');

  // ① 통로가 있는가 — 제출 스크립트 하나와 러너 안 도구들.
  if (!allowList.includes(SUBMIT_TOOL)) {
    found.push(`허용 목록에 \`${SUBMIT_TOOL}\`가 없습니다 — `
      + '작업물을 내보낼 통로가 없습니다 (회차 지시가 성립하지 않습니다)');
  }
  for (const [need, why] of LOCAL_TOOLS) {
    if (!allowList.includes(need)) {
      found.push(`허용 목록에 \`${need}\`가 없습니다 — ${why}`);
    }
  }

  // ② **허용 목록이 금지된 모양을 표현할 수 있는가.**
  //
  // 이름을 세지 않는다. 문서의 매칭 규칙으로 직접 대조하고, 복합
  // 명령은 조각마다 센다 — 내가 만든 구멍
  // (`Bash(git push -u origin:*)`)과 제 것보다 먼저 있던 구멍
  // (`Bash(gh api repos/:*)`)이 여기서 걸린다.
  for (const [shape, why] of FORBIDDEN_SHAPES) {
    const rules = shapeExpressible(allowList, shape);
    if (rules) {
      found.push(`허용 목록이 \`${shape}\`를 표현할 수 있습니다 — ${why}`
        + ` · 걸린 항목: ${rules.map((r) => `\`${r}\``).join(' · ')}`
        + ' · 허용 목록이 관문입니다 (금지 목록은 우회 가능합니다)');
    }
  }

  // ③ 제출 스크립트는 **의도한 호출을 실제로 허용해야** 한다.
  //    두 읽기 모두에서 통해야 한다 — 한쪽에서만 통하면 회차는
  //    통로가 있다고 적힌 채로 아무것도 못 올린다.
  if (allowList.includes(SUBMIT_TOOL)) {
    const intended = `node ${SUBMIT_SCRIPT} --mode dev --title t --body-file /tmp/b.md`;
    for (const colonSpace of [true, false]) {
      if (!bashRuleMatches(SUBMIT_TOOL, intended, { colonSpace })) {
        found.push(`\`${SUBMIT_TOOL}\`가 의도한 호출을 허용하지 않습니다`
          + `(\`:*\`를 ${colonSpace ? '공백+와일드카드' : '와일드카드'}로 읽을 때) — `
          + '통로가 있다고 적힌 채로 아무것도 올리지 못합니다');
      }
    }
  }

  // ④ 금지 목록은 그대로 둔다 (관문은 아니지만 한 겹 더다).
  for (const d of MUST_STAY_DENIED) {
    if (!denyText.includes(d)) {
      found.push(`금지 목록에서 \`${d}\`가 빠졌습니다 — `
        + '관문은 아니지만 모델이 흔히 쓰는 모양을 한 겹 더 걸러 줍니다');
    }
  }

  // ⑤ 파일 도구 — **통로만 열고 손을 묶어 두면 회차는 아무것도 못 한다.**
  //    갈래를 모르면 재지 못한 것이고, 재지 못한 것을 통과로 적지 않는다.
  if (!LANE_EDIT_SAMPLES[mode]) {
    found.push(`갈래를 모릅니다: ${JSON.stringify(mode)} — `
      + '파일 도구 울타리를 재지 못했습니다 (못 잰 것을 통과로 적지 않습니다)');
  } else {
    found.push(...fileToolFindings({ allow: allowList, deny: splitTools(denyText), mode }));
  }

  return found;
}

/** 갈래별 브랜치 접두어. 워크플로의 `branch_prefix`와 같아야 한다. */
export const LANE_BRANCH_PREFIX = {
  dev: 'claude/dev-',
  trading: 'claude/trading-',
};

/**
 * **제출 계획을 여기서 만든다.**
 *
 * 스크립트는 이 함수가 돌려준 argv 를 그대로 `execFileSync` 에 넘긴다.
 * 모델이 넘길 수 있는 것은 `mode`·`title`·`body-file` 뿐이고, git 에
 * 갈 refspec·플래그는 **전부 여기서 글자로 박는다.** 그래서
 * `HEAD:main`·`--force`·`+refspec` 은 표현할 자리가 없다.
 */
export function submitPlan({ mode, branch }) {
  const prefix = LANE_BRANCH_PREFIX[mode];
  if (!prefix) {
    return { ok: false, why: `갈래를 모릅니다: ${JSON.stringify(mode)} — dev 또는 trading 이어야 합니다` };
  }
  const b = String(branch ?? '');
  if (!b) return { ok: false, why: '현재 브랜치를 읽지 못했습니다 — 모르는 것을 밀지 않습니다' };
  if (b === 'HEAD') {
    return { ok: false, why: 'detached HEAD 입니다 — 올릴 브랜치가 없습니다' };
  }
  if (b === 'main') {
    return { ok: false, why: 'main 에서는 제출하지 않습니다' };
  }
  // 모양을 **허용으로** 좁힌다. 금지 목록을 늘리는 방식은 또 빠뜨린다.
  if (!new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9][A-Za-z0-9._-]{0,59}$`).test(b)) {
    return { ok: false, why: `브랜치 이름이 \`${prefix}\` + 영숫자 모양이 아닙니다: ${JSON.stringify(b)}`
      + ' — refspec·옵션·경로가 섞여 들어오는 자리를 없앱니다' };
  }

  return {
    ok: true,
    branch: b,
    // 완전한 refspec 을 **양쪽 다** 적는다. `<src>:<dst>` 가 글자로
    // 박혀 있으면 dst 를 바꿀 자리가 없다.
    pushArgv: ['push', '--set-upstream', 'origin', `refs/heads/${b}:refs/heads/${b}`],
    prArgv: ['pr', 'create', '--draft', '--base', 'main', '--head', b],
  };
}

const SUBMIT_CASES = [
  { what: 'dev 갈래의 정상 브랜치', mode: 'dev', branch: 'claude/dev-fix-x-20261104', ok: true },
  { what: 'trading 갈래의 정상 브랜치', mode: 'trading', branch: 'claude/trading-a1', ok: true },
  { what: 'main 은 거부', mode: 'dev', branch: 'main', ok: false },
  { what: 'detached HEAD 는 거부', mode: 'dev', branch: 'HEAD', ok: false },
  { what: 'refspec 이 섞인 브랜치는 거부', mode: 'dev', branch: 'claude/dev-x:main', ok: false },
  { what: '+refspec 은 거부', mode: 'dev', branch: '+claude/dev-x:main', ok: false },
  { what: '옵션처럼 보이는 이름은 거부', mode: 'dev', branch: '--force', ok: false },
  { what: '경로 거슬러 올라가기는 거부', mode: 'dev', branch: 'claude/dev-../../x', ok: false },
  { what: '공백이 섞이면 거부', mode: 'dev', branch: 'claude/dev-x --force', ok: false },
  { what: '다른 갈래 접두어는 거부', mode: 'dev', branch: 'claude/trading-x', ok: false },
  { what: '접두어 없는 이름은 거부', mode: 'dev', branch: 'fix/whatever', ok: false },
  { what: '빈 이름은 거부', mode: 'dev', branch: '', ok: false },
  { what: '모르는 갈래는 거부', mode: 'nope', branch: 'claude/dev-x', ok: false },
];

/**
 * 제가 틀렸던 자리를 시험으로 박아 둔다.
 *
 * 매칭 구현이 틀리면 ②의 대조가 전부 거짓 음성이 되므로, **구현이
 * 문서와 같은 답을 내는지** 먼저 센다.
 */
const MATCH_CASES = [
  // 내가 만든 구멍 — 두 읽기 모두에서 통과해 버린다.
  { rule: 'Bash(git push -u origin:*)', cmd: 'git push -u origin HEAD:main', want: true,
    what: '`-u origin` 접두어는 refspec 으로 main 을 가리킬 수 있다' },
  { rule: 'Bash(git push -u origin:*)', cmd: 'git push -u origin claude/dev-x --force', want: true,
    what: '`-u origin` 접두어는 뒤에 붙은 --force 를 막지 못한다' },
  // 내가 "막았다"고 적은 금지 두 줄이 그것을 못 잡는다.
  { rule: 'Bash(git push -u origin main:*)', cmd: 'git push -u origin HEAD:main', want: false,
    what: '`-u origin main` 금지는 HEAD:main 을 잡지 못한다' },
  { rule: 'Bash(git push --force:*)', cmd: 'git push -u origin claude/dev-x --force', want: false,
    what: '`--force` 금지는 뒤에 붙은 --force 를 잡지 못한다' },
  // 문서 표의 행들 — 구현이 문서와 같은 답을 내는지.
  { rule: 'Bash(npm run build)', cmd: 'npm run build --watch', want: false,
    what: '와일드카드 없는 규칙은 정확히 그 명령만' },
  { rule: 'Bash(npm run *)', cmd: 'npm run', want: true,
    what: '끝의 ` *` 는 맨 명령도 받는다' },
  { rule: 'Bash(npm run *)', cmd: 'npm install', want: false,
    what: '접두어가 다르면 안 받는다' },
  { rule: 'Bash(ls *)', cmd: 'lsof', want: false,
    what: '끝의 ` *` 앞 공백은 규칙의 일부다' },
  { rule: 'Bash(* --help *)', cmd: 'npm --help', want: false,
    what: '맨 명령 등가는 유일한 와일드카드일 때만' },
  { rule: 'Bash(* --help *)', cmd: 'npm --help x', want: true,
    what: '중간 와일드카드는 공백을 포함해 받는다' },
  // 제출 스크립트는 git 을 표현하지 못한다.
  { rule: SUBMIT_TOOL, cmd: 'git push origin main', want: false,
    what: '제출 스크립트 허용은 git 을 표현하지 못한다' },
  { rule: SUBMIT_TOOL, cmd: `node ${SUBMIT_SCRIPT} --mode dev --title t --body-file /tmp/b.md`, want: true,
    what: '제출 스크립트 허용은 의도한 호출을 받는다' },
];

/**
 * 복합 명령 분리와 "표현 가능한가" 판정.
 *
 * 처음에 나는 조각 분리를 모델링하지 않아서 `Bash(git commit:*)` 하나에
 * "복합 명령으로 main 에 밀 수 있습니다"라는 **거짓 RED** 를 냈다.
 * 그 자리를 시험으로 박아 둔다.
 */
const SHAPE_CASES = [
  { what: 'git commit 허용만으로는 복합 push 를 표현하지 못한다',
    allow: ['Bash(git commit:*)'],
    shape: 'git commit --amend -m x && git push -u origin HEAD:main',
    expressible: false },
  { what: 'commit 과 push 가 둘 다 허용되면 복합 push 를 표현한다',
    allow: ['Bash(git commit:*)', 'Bash(git push -u origin:*)'],
    shape: 'git commit --amend -m x && git push -u origin HEAD:main',
    expressible: true },
  { what: '`gh api repos/` 접두어는 REST PUT 으로 main 에 쓸 수 있다',
    allow: ['Bash(gh api repos/:*)'],
    shape: 'gh api repos/o/r/contents/README.md --method PUT -f message=x -f content=y',
    expressible: true },
  { what: '`gh api repos/` 접두어는 REST PUT 으로 PR 을 병합할 수 있다',
    allow: ['Bash(gh api repos/:*)'],
    shape: 'gh api repos/o/r/pulls/1/merge --method PUT',
    expressible: true },
  { what: '읽기 전용 gh 항목들은 금지된 모양을 하나도 표현하지 못한다',
    allow: ['Bash(gh pr list:*)', 'Bash(gh pr view:*)', 'Bash(gh issue list:*)'],
    shape: 'gh api repos/o/r/pulls/1/merge --method PUT',
    expressible: false },
  { what: '제출 스크립트 허용은 금지된 모양을 하나도 표현하지 못한다',
    allow: [SUBMIT_TOOL, ...LOCAL_TOOLS.map(([t]) => t)],
    shape: 'git push -u origin HEAD:main',
    expressible: false },
];

export function selfTest() {
  const failed = [];

  for (const c of SHAPE_CASES) {
    const got = shapeExpressible(c.allow, c.shape) != null;
    if (got !== c.expressible) {
      failed.push(`${c.what} — 기대 ${c.expressible}, 실제 ${got}`);
    }
  }

  // **제출 통로만 허용하면 금지된 모양이 하나도 남지 않아야 한다.**
  // 이 단정이 깨지면 내가 고른 통로가 통로가 아니다.
  {
    const minimal = [SUBMIT_TOOL, ...LOCAL_TOOLS.map(([t]) => t)];
    const leaks = FORBIDDEN_SHAPES.filter(([s]) => shapeExpressible(minimal, s) != null);
    if (leaks.length > 0) {
      failed.push(`제출 통로만 허용해도 ${leaks.length}개 모양이 표현 가능합니다`
        + ` — 첫 건: ${leaks[0][0]}`);
    }
  }

  for (const c of MATCH_CASES) {
    const got = bashRuleMatchesEither(c.rule, c.cmd);
    if (got !== c.want) {
      failed.push(`${c.what} — 기대 ${c.want}, 실제 ${got} (\`${c.rule}\` vs \`${c.cmd}\`)`);
    }
  }

  for (const c of SUBMIT_CASES) {
    const got = submitPlan({ mode: c.mode, branch: c.branch });
    if (got.ok !== c.ok) {
      failed.push(`${c.what} — 기대 ok=${c.ok}, 실제 ok=${got.ok}`);
      continue;
    }
    if (got.ok) {
      // 밀 때 쓰는 argv 에 위험한 글자가 섞이지 않는지 센다.
      const flat = got.pushArgv.join(' ');
      if (/--force|\+refs|:refs\/heads\/main$/.test(flat)) {
        failed.push(`${c.what} — push argv 에 위험한 모양이 있습니다`);
      }
      if (!got.prArgv.includes('--draft')) {
        failed.push(`${c.what} — PR argv 에 \`--draft\` 가 없습니다`);
      }
    }
  }

  // **내가 올렸던 목록 그 자체**를 통째로 넣어 본다. 지적이 0건이면
  // 이 판정은 아무것도 막지 못한다는 뜻이다.
  const myBrokenAllow = 'Bash(npm test),Bash(git switch -c:*),Bash(git add:*),'
    + 'Bash(git commit:*),Bash(git push -u origin:*),Bash(gh pr create:*)';
  const myBrokenDeny = 'Bash(git push --force:*),Bash(git push origin main:*),'
    + 'Bash(git push -u origin main:*)';
  const onMine = deliveryFindings({ allow: myBrokenAllow, deny: myBrokenDeny });
  if (onMine.length === 0) {
    failed.push('2026-11-04 에 제가 올린 허용 목록을 통과시킵니다 — 이 판정은 아무것도 막지 못합니다');
  }

  // 파일 도구 판정도 같은 자리에서 자기를 증명한다.
  const fileSelf = fileToolSelfTest();
  failed.push(...fileSelf.failed);

  return {
    total: SHAPE_CASES.length + 1 + MATCH_CASES.length + SUBMIT_CASES.length + 1
      + fileSelf.total,
    failed,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 파일 도구 — **통로만 열고 손을 묶어 두면 회차는 여전히 아무것도 못 한다**
// ─────────────────────────────────────────────────────────────────────
//
// 2026-11-04에 제출 통로를 열었다. 그런데 두 갈래의 허용 목록에는
// `Bash(...)` 항목만 있고 `Read`·`Glob`·`Grep`·`Edit`가 **하나도 없다.**
//
// 공식 문서가 적는 그대로다: 허용 목록이 관문이고, 거기 없는 도구는
// 사람에게 묻는다. 러너에는 답할 사람이 없다. 그래서 회차는
//
//   · 파일을 열어 볼 수 없고 (`Read` 없음)
//   · 이름으로도 내용으로도 찾을 수 없고 (`Glob`·`Grep` 없음)
//   · 한 글자도 고칠 수 없다 (`Edit` 없음)
//
// 2026-11-11 Dev 회차가 `permission denials 11`과 `error_max_turns`
// (41/40)로 끝난 자리가 이것이다 — 묻고, 막히고, 턴만 쓴다.
//
// **통로(올리기)와 손(고치기)은 둘 다 있어야 한다.** 하나만 있으면
// 회차는 여전히 `✅ 변경 없음`으로 끝나고, "고칠 것이 없었다"와
// "고칠 수 없었다"가 또 구분되지 않는다.
//
// ## 그런데 손을 열면 울타리를 만질 수 있다
//
// 그래서 Bash 쪽과 **같은 방식**으로 센다. 이름을 세지 않고, 경로
// 규칙이 금지된 경로를 **표현할 수 있는지** 직접 대조한다.
//
// 다만 Bash 와 한 가지가 다르다. Bash 규칙은 모델이 쓴 **명령 글자**에
// 맞춰지므로 문서가 "isn't a security boundary"라고 못 박는다. 파일
// 도구의 경로 규칙은 도구가 **실제로 여는 경로**에 맞춰지므로 금지
// 목록이 한 겹 더 역할을 한다. 그래도 그것에 기대지 않는다 — 관문은
// 여전히 허용 목록이고, 금지는 그 위의 두 번째 겹이다.
//
// ## 두 가지 세기로 나눈다 (섞으면 둘 다 약해진다)
//
// **가) 울타리 경로** — 어느 갈래도 건드리면 안 되는 것:
//      워크플로 · 제출 통로 2파일 · 마이그레이션 · `.env` 류.
//      → 허용 목록이 **표현조차 못 해야** 하고, 금지에도 있어야 한다.
//      수가 적고 잘 안 변해서 이 세기를 감당할 수 있다.
//
// **나) 갈래 범위** — dev 가 거래 엔진을 건드리면 안 되는 것:
//      → 금지 목록 + `check-autodev-safety`가 **실제 diff** 를 보고 잡는다.
//      허용 쪽까지 좁히려면 `src/` 밑 디렉터리를 일일이 적어야 하는데,
//      그러면 디렉터리가 하나 생길 때마다 손이 묶인다. 적어 놓고
//      배선을 안 하는 것보다 나쁜 것이 **다음 사람이 못 쓰는 울타리**다.
//
// 이 차이를 숨기지 않는다. 가)는 허용+금지 두 겹, 나)는 금지 한 겹과
// diff 검사다.

/** 읽기 전용 파일 도구. 이것이 없으면 회차는 고칠 자리를 찾지 못한다. */
export const READ_TOOLS = [
  ['Read', '파일을 열어 볼 수 없습니다 — 고칠 자리를 찾지 못합니다'],
  ['Glob', '파일을 이름으로 찾을 수 없습니다'],
  ['Grep', '파일을 내용으로 찾을 수 없습니다 — RED 를 재현할 자리를 못 찾습니다'],
];

/** 파일을 **바꾸는** 도구들. 어느 것이 열려 있든 같은 울타리를 받는다. */
export const FILE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * 갈래가 고칠 수 있어야 하는 대표 경로.
 *
 * 하나라도 못 고치면 그 갈래는 자기 일을 할 수 없다. 샘플이라 실제
 * 파일일 필요는 없지만, **갈래 범위를 대표하는 모양**이어야 한다.
 */
export const LANE_EDIT_SAMPLES = {
  dev: [
    ['src/app/api/health/route.ts', '화면·API 경로'],
    ['src/lib/kernel/sample.ts', '공용 순수 바닥'],
    ['scripts/check-wiring.mjs', '검사기'],
    ['src/lib/kernel/sample.test.ts', '시험 파일'],
  ],
  trading: [
    ['src/lib/strategies/runStrategy.ts', '전략 경로'],
    ['src/lib/engine/sample.ts', '엔진 경로'],
    ['worker/src/sample.ts', '워커'],
    ['scripts/check-wiring.mjs', '검사기'],
  ],
};

/**
 * **가-1) 바깥 울타리 경로** — 고치는 범위 바깥에 있는 것.
 *
 * `src/`·`scripts/` 를 열어도 여기엔 닿지 않는다. 그래서 가장 센 세기를
 * 걸 수 있다: **허용 목록이 표현조차 못 해야 하고, 금지에도 있어야 한다.**
 */
export const FENCE_PATHS_OUTSIDE = [
  ['.github/workflows/claude-hourly-dev.yml', '제 울타리를 스스로 넓힐 수 있습니다'],
  ['.github/workflows/claude-hourly-trading.yml', '제 울타리를 스스로 넓힐 수 있습니다'],
  ['.github/workflows/ci.yml', '검사기를 부르는 자리를 스스로 지울 수 있습니다'],
  ['.github/workflows/auto-merge.yml', '병합 관문을 스스로 바꿀 수 있습니다'],
  ['supabase/migrations/0999_sample.sql', '운영 DB 스키마는 별도 승인 사항입니다'],
  ['.env', '시크릿이 담기는 자리입니다'],
  ['.env.local', '시크릿이 담기는 자리입니다'],
];

/**
 * **가-2) 안쪽 울타리 경로** — 고치는 범위 **안에** 있는 것.
 *
 * 제출 통로 2파일은 `scripts/` 밑에 있다. 회차가 검사기와 시험을 고치려면
 * `scripts/` 를 열어야 하는데, 그러면 이 두 파일도 그 안에 들어온다.
 * 허용 목록에는 빼기가 없으므로 **"허용이 표현조차 못 한다"를 여기엔 걸 수 없다.**
 * 걸려면 `scripts/` 밑 파일 이름을 하나하나 적어야 하고, 그러면 파일이
 * 하나 생길 때마다 손이 묶인다.
 *
 * 그래서 이쪽은 **금지가 관문이다.** Bash 쪽과 다르게 그래도 되는 이유가 있다:
 *
 *   · Bash 규칙은 모델이 **쓴 글자**에 맞춰진다. 그래서 같은 일을 하는 다른
 *     글자(`git -C . push`)로 빠져나갈 수 있고, 문서가 "isn't a security
 *     boundary" 라고 못 박는다.
 *   · 파일 도구의 경로 규칙은 도구가 **실제로 여는 경로**에 맞춰진다.
 *     경로는 정규화되므로 `scripts/../scripts/autodev-submit.mjs` 도 같은
 *     경로로 떨어진다. 다른 글자로 같은 파일을 가리킬 자리가 없다.
 *   · 심링크로 돌아가려면 `ln` 이 필요한데 Bash 허용 목록에 없다.
 *
 * 그래서 여기엔 **정확한 경로 금지**를 요구하고, 금지가 빠지면 RED 로 센다.
 * 그리고 `check-autodev-safety` 가 **실제 diff** 로 한 겹 더 잡는다(세 겹).
 */
export const FENCE_PATHS_INSIDE = [
  [SUBMIT_SCRIPT, '올리는 모양(refspec · --draft)을 스스로 넓힐 수 있습니다'],
  ['scripts/lib/autodev-delivery.mjs', '울타리 판정 자체를 스스로 고칠 수 있습니다'],
];

/** 두 종류를 합친 것. 자기 점검과 보고가 쓴다. */
export const FENCE_PATHS = [...FENCE_PATHS_OUTSIDE, ...FENCE_PATHS_INSIDE];

/**
 * **나) 갈래 범위** — 금지 목록과 `check-autodev-safety` 가 맡는다.
 *
 * `check-autodev-safety.mjs`의 `TRADING_PATHS` 와 같은 목록이어야 한다.
 * 두 곳이 갈리면 한쪽만 고치는 상습 고장이 난다.
 */
export const LANE_DENY_PATHS = {
  dev: [
    'src/lib/engine/**', 'src/lib/strategies/**', 'src/lib/exchanges/**',
    'src/lib/smoke/**', 'src/lib/execution/**', 'src/lib/risk/**',
    'src/lib/backtest/**', 'worker/**',
  ],
  trading: [],
};

/** `Edit(src/**)` 의 `Edit` 와 `src/**` 를 가른다. 그 도구가 아니면 null. */
export function fileRuleBody(rule, tool) {
  const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(String(rule ?? '').trim());
  return m ? m[1] : null;
}

/** 경로를 정규화한다 — `src/../.github/x` 가 울타리를 넘지 못하게. */
export function normalizePath(p) {
  const out = [];
  for (const seg of String(p ?? '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * gitignore 모양의 경로 규칙을 맞춰 본다.
 *
 * `loose` 가 참이면 와일드카드 없는 규칙을 **디렉터리 접두어로도** 읽는다
 * (`Edit(src)` 가 `src/a.ts` 를 받을 수 있다고 본다). 금지된 경로를
 * 대조할 때 이쪽을 쓴다 — 모르는 쪽을 통과로 적지 않는다.
 */
export function fileRuleMatches(pattern, path, { loose = false } = {}) {
  const pat = String(pattern ?? '').replace(/^\.\//, '').replace(/^\/+/, '');
  const target = normalizePath(path);
  if (pat === '') return false;

  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const toRe = (p) => {
    let re = '';
    let i = 0;
    while (i < p.length) {
      if (p.startsWith('**/', i)) { re += '(?:[^/]+/)*'; i += 3; continue; }
      if (p.startsWith('**', i)) { re += '[\\s\\S]*'; i += 2; continue; }
      if (p[i] === '*') { re += '[^/]*'; i += 1; continue; }
      if (p[i] === '?') { re += '[^/]'; i += 1; continue; }
      re += esc(p[i]); i += 1;
    }
    return re;
  };

  if (new RegExp(`^${toRe(pat)}$`).test(target)) return true;
  if (loose && !pat.includes('*')) {
    // 디렉터리 이름만 적힌 규칙으로도 읽어 본다.
    return new RegExp(`^${toRe(pat)}/[\\s\\S]*$`).test(target);
  }
  return false;
}

/**
 * 허용 목록의 **파일 쓰기 규칙 중** 이 경로를 표현할 수 있는 것.
 *
 * 경로 인자가 없는 맨 `Edit`·`Write` 는 **무엇이든** 표현한다 — 그것이
 * 가장 흔한 사고다.
 */
export function pathExpressible(allowList, path, { loose = true } = {}) {
  const hits = [];
  for (const rule of allowList) {
    const r = String(rule ?? '').trim();
    for (const tool of FILE_WRITE_TOOLS) {
      if (r === tool) { hits.push(r); break; }
      const body = fileRuleBody(r, tool);
      if (body != null && fileRuleMatches(body, path, { loose })) { hits.push(r); break; }
    }
  }
  return hits.length ? [...new Set(hits)] : null;
}

/**
 * 금지 목록이 **그 도구로** 이 경로를 막는가. 맨 도구 이름 하나도 막는 것으로 센다.
 *
 * **도구를 구분해야 한다.** 처음에 나는 어느 쓰기 도구의 금지든 하나만
 * 맞으면 "막혔다"고 셌다. 그러면 금지에 `Write(.github/**)` 가 남아 있는 한
 * `Edit(.github/**)` 를 **지워도 통과한다** — 실제로는 `Edit` 로 워크플로를
 * 고칠 수 있는데도. 변이 시험이 그 자리를 잡았다. 금지 규칙은 도구마다
 * 따로 걸리므로 여기서도 도구마다 센다.
 */
export function pathDenied(denyList, path, tool) {
  for (const rule of denyList) {
    const r = String(rule ?? '').trim();
    if (r === tool) return r;
    const body = fileRuleBody(r, tool);
    if (body != null && fileRuleMatches(body, path, { loose: false })) return r;
  }
  return null;
}

/** 허용 목록이 **실제로 열어 둔** 쓰기 도구들. 금지는 이것들에 대해 요구한다. */
export function allowedWriteTools(allowList) {
  const out = new Set();
  for (const rule of allowList) {
    const r = String(rule ?? '').trim();
    for (const tool of FILE_WRITE_TOOLS) {
      if (r === tool || fileRuleBody(r, tool) != null) out.add(tool);
    }
  }
  return [...out];
}

/**
 * **권한 흐름이 한 걸음도 끊기지 않는가.**
 *
 * 찾기 → 읽기 → 고치기 → 시험 → 담기 → 올리기. 한 걸음이라도 허용에
 * 걸리지 않으면 러너는 사람에게 묻고, 답할 사람이 없어 회차가 거기서
 * 끝난다. 끊긴 걸음을 문장으로 돌려준다 — 비어 있으면 흐름이 산다.
 */
export function flowBlockers({ allow, deny, mode }) {
  const allowList = Array.isArray(allow) ? allow : splitTools(allow);
  const out = [];

  for (const [tool, why] of READ_TOOLS) {
    if (!allowList.some((r) => r === tool || fileRuleBody(r, tool) != null)) {
      out.push(`${tool}: ${why}`);
    }
  }

  const samples = LANE_EDIT_SAMPLES[mode] ?? [];
  const denyList = Array.isArray(deny) ? deny : splitTools(deny);
  for (const [p, what] of samples) {
    // 고칠 수 있으려면 허용에 **엄격한 읽기로도** 걸려야 하고,
    // 금지에 걸리면 안 된다.
    if (!pathExpressible(allowList, p, { loose: false })) {
      out.push(`Edit(${p}): 고칠 수 없습니다 (${what})`);
    } else if (pathDenied(denyList, p, 'Edit')) {
      out.push(`Edit(${p}): 금지 목록에 걸립니다 (${what}) — 허용과 금지가 서로 어긋납니다`);
    }
  }

  const bashSteps = [
    ['npm test', 'RED·GREEN 을 돌릴 수 없습니다'],
    ['git add -A', '변경을 담을 수 없습니다'],
    ['git commit -m x', '커밋할 수 없습니다'],
    [`node ${SUBMIT_SCRIPT} --mode ${mode} --title t --body-file /tmp/b.md`,
      '작업물을 올릴 수 없습니다'],
  ];
  for (const [cmd, why] of bashSteps) {
    if (!shapeExpressible(allowList, cmd)) out.push(`Bash(${cmd}): ${why}`);
  }

  return out;
}

/**
 * 파일 도구 쪽 지적을 모은다. `deliveryFindings` 가 이것을 합친다.
 */
export function fileToolFindings({ allow, deny, mode }) {
  const allowList = Array.isArray(allow) ? allow : splitTools(allow);
  const denyList = Array.isArray(deny) ? deny : splitTools(deny);
  const found = [];

  // 허용이 열어 둔 쓰기 도구마다 금지를 요구한다. 하나도 없으면 `Edit` 기준으로
  // 센다 — 그래야 "쓰기 도구가 없어서 금지도 필요 없다"가 통과로 적히지 않는다.
  const writeTools = allowedWriteTools(allowList);
  if (writeTools.length === 0) writeTools.push('Edit');

  // ① 흐름이 끊긴 자리 — 손이 묶여 있으면 통로가 있어도 소용없다.
  for (const b of flowBlockers({ allow: allowList, deny: denyList, mode })) {
    found.push(`권한 흐름이 끊깁니다 — ${b}`);
  }

  // ② 경로 없는 맨 `Edit`·`Write` 는 무엇이든 연다.
  for (const tool of FILE_WRITE_TOOLS) {
    if (allowList.includes(tool)) {
      found.push(`허용 목록에 경로 없는 \`${tool}\`가 있습니다 — `
        + '그 하나로 워크플로와 제출 통로까지 전부 고칠 수 있습니다 '
        + `(\`${tool}(src/**)\` 처럼 경로를 적어야 합니다)`);
    }
  }

  // ③ **가-1) 바깥 울타리** — 허용이 표현조차 못 해야 하고, 금지에도 있어야 한다.
  for (const [p, why] of FENCE_PATHS_OUTSIDE) {
    const rules = pathExpressible(allowList, p);
    if (rules) {
      found.push(`허용 목록이 \`${p}\` 수정을 표현할 수 있습니다 — ${why}`
        + ` · 걸린 항목: ${rules.map((r) => `\`${r}\``).join(' · ')}`
        + ' · 허용 목록이 관문입니다');
    }
    for (const tool of writeTools) {
      if (!pathDenied(denyList, p, tool)) {
        found.push(`금지 목록이 \`${tool}\`로 \`${p}\` 수정하는 것을 막지 않습니다 — ${why}`
          + ' · 허용이 관문이지만 금지는 그 위의 두 번째 겹입니다');
      }
    }
  }

  // ④ **가-2) 안쪽 울타리** — 고치는 범위 안에 있으므로 **금지가 관문이다.**
  //    정확한 경로로 적혀 있어야 한다. 넓은 글로브로 적으면 다음 사람이
  //    범위를 줄일 때 같이 사라진다.
  for (const [p, why] of FENCE_PATHS_INSIDE) {
    for (const tool of writeTools) {
      if (!denyList.some((r) => fileRuleBody(r, tool) === p)) {
        found.push(`금지 목록에 정확한 \`${tool}(${p})\`가 없습니다 — ${why}`
          + ' · 이 경로는 고치는 범위 안에 있어서 **금지가 관문입니다**');
      }
    }
  }

  // ⑤ **나) 갈래 범위** — 금지 한 겹 + `check-autodev-safety` 의 diff 검사.
  for (const pattern of LANE_DENY_PATHS[mode] ?? []) {
    for (const tool of writeTools) {
      if (!denyList.some((r) => fileRuleBody(r, tool) === pattern)) {
        found.push(`금지 목록에 \`${tool}(${pattern})\`가 없습니다 — `
          + `${mode} 갈래는 그 경로를 고치면 안 됩니다 `
          + '(`check-autodev-safety`가 diff 로도 잡지만, 도구 수준에서도 막습니다)');
      }
    }
  }

  // ⑥ 권한 자체를 꺼 버리는 모양.
  for (const r of [...allowList, ...denyList]) {
    if (/bypassPermissions|dangerously-skip-permissions|acceptEdits/.test(r)) {
      found.push(`도구 목록에 권한을 꺼 버리는 모양이 있습니다: \`${r}\` — `
        + '울타리를 우회하는 것은 울타리를 지우는 것과 같습니다');
    }
  }

  return found;
}

// ── 파일 도구 판정의 자기 점검 ──

const FILE_MATCH_CASES = [
  { what: '`src/**` 는 깊은 경로도 받는다',
    pat: 'src/**', path: 'src/lib/a/b.ts', want: true },
  { what: '`src/**` 는 다른 뿌리를 받지 않는다',
    pat: 'src/**', path: 'worker/src/a.ts', want: false },
  { what: '`src/*` 는 한 칸만 받는다',
    pat: 'src/*', path: 'src/lib/a.ts', want: false },
  { what: '경로 거슬러 올라가기는 정규화로 막힌다',
    pat: 'src/**', path: 'src/../.github/workflows/claude-hourly-dev.yml', want: false },
  { what: '거슬러 올라가 돌아오면 여전히 안쪽이다',
    pat: 'src/**', path: 'src/lib/../app/page.tsx', want: true },
  { what: '`**/.env*` 는 어느 깊이의 .env 도 받는다',
    pat: '**/.env*', path: 'a/b/.env.local', want: true },
  { what: '`**/.env*` 는 뿌리의 .env 도 받는다',
    pat: '**/.env*', path: '.env', want: true },
  { what: '정확한 파일 이름 규칙은 그 파일만',
    pat: 'scripts/autodev-submit.mjs', path: 'scripts/autodev-other.mjs', want: false },
  { what: '`./` 접두어는 같은 경로로 읽는다',
    pat: './src/**', path: 'src/a.ts', want: true },
];

const FILE_LOOSE_CASES = [
  { what: '느슨한 읽기는 디렉터리 이름만 적힌 규칙도 센다',
    pat: '.github', path: '.github/workflows/ci.yml', want: true },
  { what: '엄격한 읽기는 그것을 세지 않는다',
    pat: '.github', path: '.github/workflows/ci.yml', want: false, loose: false },
];

/** 실제로 올리려는 모양 — 이것이 통과하지 못하면 고쳐도 소용없다. */
export const LANE_FILE_TOOLS = {
  dev: {
    allow: ['Read', 'Glob', 'Grep', 'Edit(src/**)', 'Edit(scripts/**)'],
    deny: [
      'Edit(.github/**)', 'Write(.github/**)',
      `Edit(${SUBMIT_SCRIPT})`, 'Edit(scripts/lib/autodev-delivery.mjs)',
      'Edit(supabase/**)', 'Edit(**/.env*)', 'Read(**/.env*)',
      ...LANE_DENY_PATHS.dev.map((p) => `Edit(${p})`),
    ],
  },
  trading: {
    allow: ['Read', 'Glob', 'Grep', 'Edit(src/**)', 'Edit(scripts/**)', 'Edit(worker/**)'],
    deny: [
      'Edit(.github/**)', 'Write(.github/**)',
      `Edit(${SUBMIT_SCRIPT})`, 'Edit(scripts/lib/autodev-delivery.mjs)',
      'Edit(supabase/**)', 'Edit(**/.env*)', 'Read(**/.env*)',
    ],
  },
};

const BASH_FLOOR = [
  'Bash(npm test)', 'Bash(git add:*)', 'Bash(git commit:*)',
  `Bash(node ${SUBMIT_SCRIPT}:*)`,
];

const FILE_FLOW_CASES = [
  { what: 'dev 의 최종 목록은 흐름을 끊지 않는다', mode: 'dev',
    allow: [...LANE_FILE_TOOLS.dev.allow, ...BASH_FLOOR],
    deny: LANE_FILE_TOOLS.dev.deny, blocked: false },
  { what: 'trading 의 최종 목록은 흐름을 끊지 않는다', mode: 'trading',
    allow: [...LANE_FILE_TOOLS.trading.allow, ...BASH_FLOOR],
    deny: LANE_FILE_TOOLS.trading.deny, blocked: false },
  { what: '`Read` 가 없으면 흐름이 끊긴다', mode: 'dev',
    allow: [...LANE_FILE_TOOLS.dev.allow.filter((t) => t !== 'Read'), ...BASH_FLOOR],
    deny: LANE_FILE_TOOLS.dev.deny, blocked: true },
  { what: '`Edit` 범위가 없으면 흐름이 끊긴다', mode: 'dev',
    allow: ['Read', 'Glob', 'Grep', ...BASH_FLOOR],
    deny: LANE_FILE_TOOLS.dev.deny, blocked: true },
  { what: '제출 통로가 없으면 흐름이 끊긴다', mode: 'dev',
    allow: [...LANE_FILE_TOOLS.dev.allow, 'Bash(npm test)', 'Bash(git add:*)', 'Bash(git commit:*)'],
    deny: LANE_FILE_TOOLS.dev.deny, blocked: true },
  { what: '지금 main 의 목록(파일 도구 0개)은 흐름을 끊는다', mode: 'dev',
    allow: BASH_FLOOR, deny: [], blocked: true },
];

const FILE_FENCE_CASES = [
  { what: '맨 `Edit` 는 울타리를 표현한다',
    allow: ['Edit'], path: '.github/workflows/ci.yml', expressible: true },
  { what: '`Edit(src/**)` 는 워크플로를 표현하지 못한다',
    allow: ['Edit(src/**)'], path: '.github/workflows/ci.yml', expressible: false },
  { what: '`Edit(scripts/**)` 는 제출 통로를 표현한다 — 그래서 금지가 필요하다',
    allow: ['Edit(scripts/**)'], path: SUBMIT_SCRIPT, expressible: true },
  { what: '`Write(.github/**)` 도 쓰기 도구로 센다',
    allow: ['Write(.github/**)'], path: '.github/workflows/ci.yml', expressible: true },
  { what: '읽기 도구는 쓰기로 세지 않는다',
    allow: ['Read', 'Glob', 'Grep'], path: '.github/workflows/ci.yml', expressible: false },
];

export function fileToolSelfTest() {
  const failed = [];

  for (const c of FILE_MATCH_CASES) {
    const got = fileRuleMatches(c.pat, c.path);
    if (got !== c.want) failed.push(`${c.what} — 기대 ${c.want}, 실제 ${got}`);
  }
  for (const c of FILE_LOOSE_CASES) {
    const got = fileRuleMatches(c.pat, c.path, { loose: c.loose !== false });
    if (got !== c.want) failed.push(`${c.what} — 기대 ${c.want}, 실제 ${got}`);
  }
  for (const c of FILE_FENCE_CASES) {
    const got = pathExpressible(c.allow, c.path) != null;
    if (got !== c.expressible) failed.push(`${c.what} — 기대 ${c.expressible}, 실제 ${got}`);
  }
  for (const c of FILE_FLOW_CASES) {
    const got = flowBlockers({ allow: c.allow, deny: c.deny, mode: c.mode });
    if ((got.length > 0) !== c.blocked) {
      failed.push(`${c.what} — 기대 ${c.blocked ? '끊김' : '안 끊김'}, `
        + `실제 ${got.length}건${got.length ? ` (${got[0]})` : ''}`);
    }
  }

  // **최종 목록에 지적이 하나도 없어야 한다.** 이 단정이 깨지면 내가 고른
  // 범위가 범위가 아니다. 그리고 바깥 울타리는 허용이 표현조차 못 해야 한다.
  for (const mode of ['dev', 'trading']) {
    const allow = [...LANE_FILE_TOOLS[mode].allow, ...BASH_FLOOR];
    const deny = LANE_FILE_TOOLS[mode].deny;

    const findings = fileToolFindings({ allow, deny, mode });
    if (findings.length > 0) {
      failed.push(`${mode} 최종 목록에 지적 ${findings.length}건이 남습니다 — 첫 건: ${findings[0]}`);
    }
    const reachable = FENCE_PATHS_OUTSIDE.filter(([p]) => pathExpressible(allow, p) != null);
    if (reachable.length > 0) {
      failed.push(`${mode} 허용 목록이 바깥 울타리 ${reachable.length}개를 표현합니다`
        + ` — 첫 건: ${reachable[0][0]}`);
    }
    const undenied = FENCE_PATHS.filter(([p]) => !pathDenied(deny, p, 'Edit'));
    if (undenied.length > 0) {
      failed.push(`${mode} 금지 목록이 ${undenied.length}개 울타리 경로를 막지 않습니다`
        + ` — 첫 건: ${undenied[0][0]}`);
    }

    // **금지를 한 줄 빼면 RED 가 나야 한다.** 안쪽 울타리는 금지가 관문이라
    // 이 단정이 깨지면 그 관문이 없는 것과 같다.
    for (const [fence] of FENCE_PATHS_INSIDE) {
      const weakened = deny.filter((r) => fileRuleBody(r, 'Edit') !== fence);
      if (weakened.length === deny.length) {
        failed.push(`${mode} 금지 목록에 \`${fence}\` 정확 항목이 아예 없습니다`);
        continue;
      }
      if (fileToolFindings({ allow, deny: weakened, mode }).length === 0) {
        failed.push(`${mode} 금지에서 \`${fence}\`를 빼도 통과합니다 — 그 금지는 관문이 아닙니다`);
      }
    }

    // **범위를 넓히는 변이도 RED 가 나야 한다.**
    for (const wide of ['Edit', 'Write', 'Edit(.github/**)', 'Edit(**)']) {
      if (fileToolFindings({ allow: [...allow, wide], deny, mode }).length === 0) {
        failed.push(`${mode} 허용에 \`${wide}\`를 더해도 통과합니다`);
      }
    }
  }

  // **dev 는 거래 엔진을 금지로 막아야 한다.**
  for (const pattern of LANE_DENY_PATHS.dev) {
    const sample = pattern.replace('/**', '/sample.ts');
    if (!pathDenied(LANE_FILE_TOOLS.dev.deny, sample, 'Edit')) {
      failed.push(`dev 금지 목록이 거래 엔진 경로를 막지 않습니다: ${sample}`);
    }
  }

  // **지금 main 의 목록을 통째로 넣으면 지적이 나와야 한다.**
  const mainAllow = 'Bash(npm ci),Bash(npm test),Bash(npx tsc --noEmit),'
    + 'Bash(git switch -c:*),Bash(git add:*),Bash(git commit:*),'
    + `Bash(node ${SUBMIT_SCRIPT}:*)`;
  if (fileToolFindings({ allow: mainAllow, deny: '', mode: 'dev' }).length === 0) {
    failed.push('파일 도구가 하나도 없는 목록을 통과시킵니다 — 이 판정은 아무것도 막지 못합니다');
  }

  return {
    total: FILE_MATCH_CASES.length + FILE_LOOSE_CASES.length + FILE_FENCE_CASES.length
      + FILE_FLOW_CASES.length
      + 2 * (3 + FENCE_PATHS_INSIDE.length + 4)
      + LANE_DENY_PATHS.dev.length + 1,
    failed,
  };
}
