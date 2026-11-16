// scripts/lib/workflow-concurrency.mjs
//
// **`concurrency.group` 이 하나면, 서로 상관없는 PR 들이 서로를 취소한다.**
//
// 2026-11-13 실측. `auto-merge.yml` 의 필수 체크 `auto-merge-gate` 가
// PR #576 의 HEAD `cfe3efcb` 에 **아예 생기지 않았다.**
//
//     auto-merge | pull_request_target | completed/cancelled | run 43380706304
//       잡 수 = 0                      ← 하나도 시작하지 않았다
//
// 시험이 실패한 것이 아니다. **시작조차 못 했다.** 원인은 이 두 줄이다:
//
//     concurrency:
//       group: auto-merge          ← 저장소 전체가 한 그룹
//       cancel-in-progress: false
//
// 그룹이 하나뿐이라, 어느 PR 의 신호든 같은 줄에 선다. GitHub 은 한
// 그룹에 **대기(pending) 를 하나만** 둔다 — 세 번째가 오면 먼저 기다리던
// 것을 버린다. `cancel-in-progress: false` 는 *돌고 있는* 것을 지키는
// 설정이지 *기다리는* 것을 지키지 않는다.
//
// 그래서 PR A 의 `pull_request_target` 이 PR B 의 `check_suite` 에게
// 밀려 사라지고, A 에는 필수 체크가 영영 보고되지 않는다. `main` ruleset
// 의 필수 검사는 `verify` 와 `auto-merge-gate` 둘이므로, A 는 다른 것이
// 다 초록이어도 병합할 수 없다. **그리고 아무 데도 그 이유가 안 남는다.**
//
// ## 고치는 방향 — PR 마다 다른 줄에 세운다
//
// 같은 PR 의 연속 이벤트는 **같은 그룹**이어야 한다(직렬화가 의도다 —
// 같은 PR 에 대해 병합 판정이 동시에 두 번 돌면 안 된다). 다른 PR 은
// **다른 그룹**이어야 한다(서로 취소하면 안 된다).
//
// 어려운 점은 **이벤트마다 PR 을 가리키는 칸이 다르다**는 것이다:
//
//     pull_request_target   github.event.pull_request.head.sha
//     pull_request_review   github.event.pull_request.head.sha
//     check_suite           github.event.check_suite.head_sha
//     workflow_run          github.event.workflow_run.head_sha
//     status                github.event.sha
//     schedule              **없음**
//     workflow_dispatch     **없음**
//
// PR 번호가 아니라 **head SHA** 로 묶는다. `status` 이벤트에는 PR 번호가
// 아예 없고 SHA 만 있기 때문이다. SHA 로 묶으면 같은 커밋에 대한 모든
// 신호가 한 줄에 서고, 다른 PR(다른 커밋)은 건드리지 않는다.
//
// SHA 를 못 찾는 이벤트(`schedule`·`workflow_dispatch`)는 `github.run_id`
// 로 떨어뜨린다 — **매번 다른 그룹**이 되어 누구도 취소하지 않고 누구에게도
// 취소당하지 않는다. 30분 안전망이 다른 PR 의 신호에 밀려 사라지면
// 그물의 뜻이 없어진다.
//
// **`github.sha` 는 일부러 쓰지 않는다.** 그 값은 `schedule` 에서 기본
// 브랜치의 SHA 라서 모든 예약 실행이 다시 한 그룹이 된다 — 고치려던 모양이
// 그대로 돌아온다.
//
// `cancel-in-progress` 는 `false` 로 둔다. 참으로 바꾸면 돌고 있던 병합
// 판정이 중간에 끊긴다.

/** `concurrency:` 블록을 꺼낸다. 없으면 null. */
export function concurrencyOf(src) {
  const text = String(src ?? '');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^concurrency:\s*$/.test(l));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') { body.push(l); continue; }
    if (!/^\s/.test(l)) break;
    body.push(l);
  }
  const blob = body.join('\n');
  const gm = /group:\s*(?:>-|>|\|-|\|)?\s*\n?([\s\S]*?)(?=\n\s*cancel-in-progress:|\n\S|$)/.exec(blob)
    || /group:\s*(.+)/.exec(blob);
  const cm = /cancel-in-progress:\s*(\S+)/.exec(blob);
  const group = gm ? gm[1].replace(/^['"]|['"]$/g, '').split('\n').map((s) => s.trim()).join('').trim() : null;
  return { group, cancelInProgress: cm ? cm[1].trim() : null };
}

/** 점 경로를 컨텍스트에서 읽는다. 없으면 빈 문자열(거짓). */
export function readPath(ctx, path) {
  let cur = ctx;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = cur[seg];
  }
  if (cur == null) return '';
  return String(cur);
}

/**
 * `${{ a || b || 'lit' }}` 를 컨텍스트로 푼다.
 *
 * 지원하는 것은 `||` 사슬과 점 경로·따옴표 리터럴뿐이다. 더 복잡한
 * 식이 들어오면 **모른다고 답한다** — 모르는 것을 통과로 적지 않는다.
 */
export function evalExpr(expr, ctx) {
  const terms = String(expr).split('||').map((t) => t.trim());
  for (const t of terms) {
    if (/^'[^']*'$/.test(t) || /^"[^"]*"$/.test(t)) {
      const lit = t.slice(1, -1);
      if (lit !== '') return lit;
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(t)) {
      return { unknown: t };
    }
    const v = readPath(ctx, t);
    if (v !== '') return v;
  }
  return '';
}

/** 그룹 문자열을 컨텍스트로 푼다. 못 푸는 식이 있으면 `{unknown}`. */
export function evalGroup(group, ctx) {
  let out = '';
  let i = 0;
  const g = String(group ?? '');
  while (i < g.length) {
    const open = g.indexOf('${{', i);
    if (open < 0) { out += g.slice(i); break; }
    out += g.slice(i, open);
    const close = g.indexOf('}}', open);
    if (close < 0) return { unknown: g.slice(open) };
    const v = evalExpr(g.slice(open + 3, close), ctx);
    if (v && typeof v === 'object') return v;
    out += v;
    i = close + 2;
  }
  return out;
}

/**
 * 이벤트별 합성 페이로드. 같은 PR = 같은 head SHA.
 *
 * **`run_id` 는 이벤트마다 다르게 준다.** 실제로 각 이벤트는 별개의
 * 워크플로 실행이고 `github.run_id` 는 그때마다 다르다. 처음에 나는
 * 다섯 이벤트에 같은 `run_id` 를 줬고, 그래서 `group: ...${{ github.run_id }}`
 * 같은 **매번 고유한 그룹**(= 같은 PR 직렬화가 깨지는 모양)을 이 판정이
 * 통과시켰다. 픽스처가 현실과 다르면 판정도 현실을 못 잰다.
 */
export function eventContexts({ sha, prNumber, runId }) {
  const g = (ev, event) => ({ github: { run_id: `${runId}-${ev}`, event } });
  const pr = { pull_request: { number: prNumber, head: { sha } } };
  return {
    pull_request_target: g('prt', pr),
    pull_request_review: g('prr', pr),
    check_suite: g('cs', { check_suite: { head_sha: sha, pull_requests: [{ number: prNumber }] } }),
    workflow_run: g('wr', { workflow_run: { head_sha: sha } }),
    status: g('st', { sha }),
  };
}

/** PR 을 가리키지 못하는 이벤트 — 매번 다른 그룹이어야 한다. */
export function soloContexts(runIds) {
  return runIds.map((runId) => ({ github: { run_id: runId, event: {} } }));
}

/**
 * 그룹 식이 세 가지를 지키는가.
 *
 * 반환은 문장 배열. 비어 있으면 통과.
 */
export function concurrencyFindings({ group, cancelInProgress, where = '' }) {
  const found = [];
  const at = where ? `${where}: ` : '';

  if (group == null) {
    found.push(`${at}\`concurrency.group\` 을 읽지 못했습니다 — 못 읽은 것을 통과로 적지 않습니다`);
    return found;
  }

  // ① 상수 그룹이면 저장소 전체가 한 줄에 선다.
  if (!group.includes('${{')) {
    found.push(`${at}\`concurrency.group\` 이 상수입니다 (\`${group}\`) — `
      + '서로 상관없는 PR 들이 같은 줄에 서고, 대기 중인 run 이 서로 취소됩니다 '
      + '(필수 체크가 **생기지도 않습니다**)');
    return found;
  }

  const A = evalGroup(group, eventContexts({ sha: 'aaa111', prNumber: 1, runId: 'r1' }).pull_request_target);
  if (A && typeof A === 'object') {
    found.push(`${at}그룹 식을 풀지 못했습니다 (\`${A.unknown}\`) — `
      + '판정할 수 없는 식은 통과로 적지 않습니다');
    return found;
  }

  // ② 같은 PR 의 모든 이벤트는 **같은 그룹**이어야 한다 (직렬화가 의도다).
  const same = eventContexts({ sha: 'aaa111', prNumber: 1, runId: 'r1' });
  for (const [ev, ctx] of Object.entries(same)) {
    const g = evalGroup(group, ctx);
    if (g && typeof g === 'object') {
      found.push(`${at}\`${ev}\` 에서 그룹 식을 풀지 못했습니다 (\`${g.unknown}\`)`);
      continue;
    }
    if (g !== A) {
      found.push(`${at}\`${ev}\` 가 같은 PR 인데 다른 그룹이 됩니다 (\`${g}\` ≠ \`${A}\`) — `
        + '같은 PR 에 병합 판정이 동시에 두 번 돌 수 있습니다');
    }
  }

  // ③ 다른 PR 은 **다른 그룹**이어야 한다 (서로 취소하면 안 된다).
  const other = eventContexts({ sha: 'bbb222', prNumber: 2, runId: 'r2' });
  for (const [ev, ctx] of Object.entries(other)) {
    const g = evalGroup(group, ctx);
    if (typeof g === 'string' && g === A) {
      found.push(`${at}다른 PR 의 \`${ev}\` 가 같은 그룹이 됩니다 (\`${g}\`) — `
        + 'PR A 와 B 가 서로의 대기 run 을 취소합니다');
    }
  }

  // ④ PR 을 못 가리키는 이벤트(schedule·dispatch)는 **매번 다른 그룹**이어야 한다.
  const [s1, s2] = soloContexts(['r9', 'r10']).map((c) => evalGroup(group, c));
  if (typeof s1 === 'string' && typeof s2 === 'string') {
    if (s1 === s2) {
      found.push(`${at}\`schedule\`·\`workflow_dispatch\` 가 매번 같은 그룹입니다 (\`${s1}\`) — `
        + '30분 안전망이 서로를 취소합니다');
    }
    if (s1 === A) {
      found.push(`${at}\`schedule\` 이 PR 의 그룹과 겹칩니다 (\`${s1}\`) — `
        + '안전망이 PR 신호에 밀려 사라집니다');
    }
  }

  // ⑤ 돌고 있는 병합 판정을 중간에 끊지 않는다.
  if (String(cancelInProgress).toLowerCase() === 'true') {
    found.push(`${at}\`cancel-in-progress: true\` 입니다 — `
      + '돌고 있던 병합 판정이 중간에 끊깁니다');
  }
  if (cancelInProgress == null) {
    found.push(`${at}\`cancel-in-progress\` 가 없습니다 — 기본값에 기대지 않습니다`);
  }

  return found;
}

/**
 * **이 워크플로가 모든 PR HEAD 에서 깨어나는가.**
 *
 * 겹침 제어를 고쳐도 애초에 깨어나지 않으면 체크는 역시 안 생긴다.
 * 실패하는 길이 둘인데 한쪽만 고치면 다른 쪽으로 같은 증상이 난다
 * (`CLAUDE.md` 상습 고장 ②).
 *
 * `opened` 가 빠져 있던 것이 #585 가 센 233건 중 154건의 원인이다 —
 * 새 PR 이 열려도 run 이 생기지 않았다. #608 이 그 한 줄을 더했고,
 * 여기서 **다시 빠지지 않게 센다.**
 */
export const REQUIRED_PR_TARGET_TYPES = [
  ['opened', '새 PR 이 열려도 run 이 생기지 않습니다 (#585 의 154건)'],
  ['synchronize', '새 커밋이 올라와도 그 HEAD 에 체크가 안 생깁니다'],
  ['reopened', '다시 연 PR 에 체크가 안 생깁니다'],
  ['ready_for_review', '초안을 풀어도 체크가 안 생깁니다'],
  ['labeled', '라벨을 붙여도 판정이 돌지 않습니다'],
];

/** `pull_request_target:` 의 `types:` 목록을 꺼낸다. 없으면 null. */
export function prTargetTypes(src) {
  const m = /pull_request_target:\s*\n\s*types:\s*\[([^\]]*)\]/.exec(String(src ?? ''));
  if (!m) return null;
  return m[1].split(',').map((t) => t.trim()).filter(Boolean);
}

/** 트리거 쪽 지적. */
export function triggerFindings(src, where = '') {
  const at = where ? `${where}: ` : '';
  const types = prTargetTypes(src);
  if (types == null) {
    return [`${at}\`pull_request_target.types\` 를 읽지 못했습니다 — `
      + '못 읽은 것을 통과로 적지 않습니다'];
  }
  const out = [];
  for (const [t, why] of REQUIRED_PR_TARGET_TYPES) {
    if (!types.includes(t)) out.push(`${at}\`pull_request_target.types\` 에 \`${t}\` 가 없습니다 — ${why}`);
  }
  return out;
}

// ── 자기 점검 ──

const BROKEN = 'auto-merge';
const FIXED = "auto-merge-${{ github.event.pull_request.head.sha "
  + '|| github.event.check_suite.head_sha || github.event.workflow_run.head_sha '
  + '|| github.event.sha || github.run_id }}';
const PR_NUMBER_ONLY = 'auto-merge-${{ github.event.pull_request.number || github.run_id }}';
const ALWAYS_UNIQUE = 'auto-merge-${{ github.run_id }}';

const CASES = [
  { what: '지금의 상수 그룹을 잡는다', group: BROKEN, cancel: 'false', bad: true },
  { what: '고친 식은 통과한다', group: FIXED, cancel: 'false', bad: false },
  { what: 'PR 번호만 쓰면 `status` 가 다른 그룹이 되어 잡힌다',
    group: PR_NUMBER_ONLY, cancel: 'false', bad: true },
  { what: '매번 고유한 그룹은 같은 PR 직렬화를 깨뜨려 잡힌다',
    group: ALWAYS_UNIQUE, cancel: 'false', bad: true },
  { what: '`cancel-in-progress: true` 를 잡는다', group: FIXED, cancel: 'true', bad: true },
  { what: '`cancel-in-progress` 가 없으면 잡는다', group: FIXED, cancel: null, bad: true },
  { what: '풀지 못하는 식은 통과로 적지 않는다',
    group: 'auto-merge-${{ hashFiles(1) }}', cancel: 'false', bad: true },
];

export function selfTest() {
  const failed = [];
  for (const c of CASES) {
    const n = concurrencyFindings({ group: c.group, cancelInProgress: c.cancel }).length;
    if ((n > 0) !== c.bad) failed.push(`${c.what} — 기대 ${c.bad ? 'RED' : 'GREEN'}, 실제 지적 ${n}건`);
  }
  // 파서가 실제 YAML 모양을 읽는지.
  const yml = 'on:\n  status:\nconcurrency:\n  group: >-\n'
    + `    ${FIXED}\n  cancel-in-progress: false\n\npermissions:\n  contents: write\n`;
  const got = concurrencyOf(yml);
  if (got?.group !== FIXED) failed.push(`접은 줄(>-) 그룹을 못 읽었습니다: ${JSON.stringify(got?.group)}`);
  if (got?.cancelInProgress !== 'false') failed.push('cancel-in-progress 를 못 읽었습니다');
  const flat = concurrencyOf('concurrency:\n  group: auto-merge\n  cancel-in-progress: false\n');
  if (flat?.group !== 'auto-merge') failed.push('한 줄 그룹을 못 읽었습니다');
  if (concurrencyOf('on:\n  status:\n') !== null) failed.push('없는 블록을 있다고 읽었습니다');

  // 트리거 판정
  const full = 'on:\n  pull_request_target:\n    types: [opened, labeled, unlabeled, synchronize, reopened, ready_for_review]\n';
  if (triggerFindings(full).length !== 0) failed.push('온전한 types 목록을 잡았습니다');
  const noOpened = full.replace('opened, labeled', 'labeled');
  const f1 = triggerFindings(noOpened);
  if (f1.length !== 1 || !f1[0].includes('opened')) {
    failed.push(`\`opened\` 누락을 못 잡았습니다 (지적 ${f1.length}건)`);
  }
  if (triggerFindings('on:\n  status:\n').length !== 1) {
    failed.push('types 를 못 읽은 것을 통과로 적었습니다');
  }

  return { total: CASES.length + 4 + 3, failed };
}
