// scripts/lib/checker-sweep.mjs
//
// **제외 목록이 워크플로 안에 있으면, 그 목록을 고치는 일이 무인 회차의
// 능력 밖이 된다.**
//
// 2026-11-15 ~ 11-18 실측. `claude-hourly-trading.yml` 의 `검사기 전수
// 재확인` 스텝은 `scripts/check-*.mjs` 를 **인자 없이** 전부 부른다.
// 그 모양으로는 통과할 수 없는 검사기가 생기면 그 갈래는 매 회차 빨개진다.
//
//     #615 가 check-autotrade-tick-response.mjs 를 더했다
//       → trading 갈래가 그때부터 매 회차 실패
//       → 고치려면 .github/workflows/ 를 고쳐야 한다
//       → `check-autodev-safety` 가 막는다:
//            "무인 회차가 워크플로를 고쳤습니다 — 제 울타리는 스스로
//             넓힐 수 없습니다"
//       → #679 가 승인을 기다리는 동안 main 이 며칠째 빨갰다
//
// **그 관문은 옳다.** 무인 회차가 제 울타리를 넓히게 두면 울타리가 아니다.
// 그래서 관문을 건드리지 않고 **고쳐야 할 것이 울타리 안으로 들어오게**
// 한다 — 제외 목록을 YAML 에서 꺼내 이 파일에 둔다.
//
// 그러면 인자를 받는 검사기가 새로 생겨도 `scripts/` 하나만 고치면 되고,
// `.github/workflows/` 는 여전히 아무도 못 건드린다. 울타리는 그대로이고
// 울타리를 넘어야 할 이유가 없어진다 (`CLAUDE.md`: 자동화보다 실패 지점
// 제거가 우선이다).
//
// ## 빼는 것과 버리는 것은 다르다
//
// 제외는 "안 돌린다"가 아니라 **"여기서는 이 모양으로 못 돌린다"** 이다.
// 그래서 모든 항목이 둘 중 하나를 반드시 갖는다:
//
//   runWith    러너가 **다른 인자로 직접 돌린다**
//   coveredBy  **다른 파일이 돌린다** — 그 파일이 실제로 이 검사기를
//              언급하는지 검사기가 확인한다 (주장만으로는 통과 못 한다)
//
// 둘 다 없으면 그건 조용히 버리는 것이므로 **실패**다.

import { stripYamlComments } from './strip-comments.mjs';

/** 제외 대상의 기준 이름 (`scripts/check-x.mjs` → `check-x.mjs`) */
export function baseName(p) {
  const s = String(p ?? '');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * 인자 없이 `node <파일>` 로는 돌릴 수 없는 검사기들.
 *
 * **값으로 적는다.** "셋 있다"가 아니라 어느 것이고 왜인지, 그리고
 * 대신 어디서 도는지를 적는다.
 */
export const SWEEP_EXCLUSIONS = [
  {
    file: 'scripts/check-100x-mutations.mjs',
    why: '전수 변이는 수십 분이 걸린다 — 판단 자기 점검만 `--self-test` 로 돈다',
    // **러너 안으로 넣지 않는다.** 넣으면 워크플로만 읽어서는 그게
    // 돌았는지 알 수 없다. `check-claude-hourly` 가 그 한 줄이 실행
    // 단계에 **보이게** 있는지를 못 박아 두고 있고, 그 핀은 옳다.
    runWith: null,
    coveredBy: '.github/workflows/claude-hourly-trading.yml',
  },
  {
    file: 'scripts/check-autodev-safety.mjs',
    why: '`--mode` 기본값이 `dev` 라, trading 갈래가 제 일을 하면 "dev 갈래가 거래 엔진을 건드렸다"로 떨어진다',
    runWith: null,
    coveredBy: '.github/workflows/claude-hourly-trading.yml',
  },
  {
    file: 'scripts/check-autotrade-tick-response.mjs',
    why: '응답 본문 파일을 인자로 받는 CLI 다 — 인자가 없으면 본문을 못 읽은 것이므로 fail-closed 한다 (관문이 옳다)',
    runWith: null,
    // **본체를 실제 응답 본문으로 돌리는 곳**이 여기다. `ci.yml` 은 시험
    // 파일(`.test.mjs`)을 돌리는 것이고 본체를 돌리는 것이 아니다 —
    // 둘을 같은 것으로 적으면 덮인다는 말이 느슨해진다.
    coveredBy: '.github/workflows/autotrade-tick.yml',
  },
];

/**
 * **PR CI 가 부르지 않는 검사기.** 위의 `SWEEP_EXCLUSIONS` 와 다른 질문이다.
 *
 *   SWEEP_EXCLUSIONS  러너가 **인자 없이** 돌릴 수 있는가
 *   CI_UNCOVERED      **PR 에서** 도는가
 *
 * 한 파일이 양쪽에 있을 수도, 한쪽에만 있을 수도 있다. 그래서 목록을
 * 합치지 않는다 — 합치면 둘 중 한 질문의 답이 사라진다.
 *
 * ## 왜 세는가
 *
 * `ci.yml` 은 검사기를 **이름으로 하나하나** 부른다(실측 2026-11-26:
 * `node scripts/check-*.mjs` 90줄 · 검사기 본체 95개 중 91개). 새 검사기를
 * 더해도 그 목록에 줄을 넣지 않으면 **PR 에서는 한 번도 돌지 않는다.**
 * 그리고 지금까지 그걸 세는 곳이 없었다.
 *
 * 실제로 그렇게 된 것이 있다. `scripts/run-tests.mjs` 가 그 사실을 적어
 * 두기까지 했다 — "그 검사기는 `ci.yml` 의 명시 목록에 없어서 … 판정만이라도
 * 여기서 돈다". 주석으로 적는 것은 다음 사람에게 전해지지 않는다.
 *
 * ## 늘면 빨강이다
 *
 * **이 목록은 올라가지 않는다.** 새 검사기는 `ci.yml` 에 줄을 넣는 것이
 * 정답이고, 그 줄은 `.github/workflows/` 라 승인이 필요하다. 승인 없이
 * 여기에 적어 넣어 통과시키는 것이 바로 이 관문이 막는 일이다.
 *
 * 각 항목은 **왜** PR 밖인지와 **실제로 어디서 도는지**를 값으로 적는다.
 * "넷 있다"가 아니라 어느 것이고 무엇이 그것을 돌리는가를 적는다.
 */
export const CI_UNCOVERED = [
  {
    file: 'scripts/check-autodev-safety.mjs',
    why: 'PR 에는 무인 회차의 변경이 없다 — 이 검사기는 무인 회차가 제 울타리를 넘었는지 보는 것이다',
    runsIn: '.github/workflows/claude-hourly-dev.yml · claude-hourly-trading.yml',
  },
  {
    file: 'scripts/check-autotrade-tick-response.mjs',
    why: '응답 본문 파일을 인자로 받는 CLI 다 — PR 에는 그 본문이 없다 (ci.yml 은 시험 파일만 돌린다)',
    runsIn: '.github/workflows/autotrade-tick.yml',
  },
  {
    file: 'scripts/check-auto-merge-switches.mjs',
    why: '전수는 매시 trading 갈래에서 돈다. PR 에서는 `run-tests.mjs` 가 `--self-test` 로 판정만 돌린다',
    runsIn: 'scripts/run-all-checkers.mjs (claude-hourly-trading.yml) · scripts/run-tests.mjs --self-test',
  },
  {
    file: 'scripts/check-undefined.mjs',
    why: 'tsc 전체를 다시 돌려 느리다. PR 에서는 `run-tests.mjs` 가 그 **판정 시험**만 돌린다 — 본체는 PR 에서 저장소를 훑지 않는다',
    runsIn: 'scripts/run-all-checkers.mjs (claude-hourly-trading.yml)',
  },
];

/**
 * `ci.yml` 이 `node scripts/<이름>` 으로 **부르는가.**
 *
 * **적혀 있는 것과 부르는 것은 다르다.** 처음 판은 raw 텍스트에서
 * `node\s+scripts/<이름>` 을 찾았다. 독립 검수(#792 코멘트 7197793263)가
 * 반례 둘을 실제 `ci.yml` 로 재현했고, 직접 확인했다 (HEAD aa445469):
 *
 *   원래 단계                                      → rc=0 · 부름 (맞다)
 *   `# run: node scripts/check-reconcile-truth.mjs` → rc=0 · **부름으로 셌다**
 *   `run: echo node scripts/check-reconcile-truth.mjs` → rc=0 · **부름으로 셌다**
 *   그 줄을 `run: true` 로 바꿈                     → rc=1 · 안 부름 (맞다)
 *
 * 주석 두 줄로 단계가 사라지고, `echo` 는 문장만 출력한다. 둘 다 검사기를
 * 돌리지 않는데 "선언 없이 빠진 것은 0건"이 찍혔다 — 제가 이 관문에
 * 적어 둔 바로 그 구분이 깨져 있었다.
 *
 * 그래서 두 가지를 본다:
 *
 *   ① **주석을 걷는다.** `ci.yml` 에는 지금도 주석 안에
 *      `node scripts/check-100x-mutations.mjs` 가 있다(전수 실행 안내).
 *      그 검사기는 같은 파일의 `--self-test` 줄로 실제로 돈다.
 *   ② **명령 위치만 센다.** 세미콜론·`&&`·`||`·파이프로 나눈 각 토막이
 *      `node` 로 시작해야 한다. `echo node …` 는 `echo` 로 시작하므로
 *      부름이 아니다. 앞에 붙는 환경변수 지정(`FOO=bar node …`)은
 *      명령 위치를 바꾸지 않으므로 허용한다.
 */
export function ciInvokes(ciText, file) {
  const name = baseName(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const call = new RegExp(`^node\\s+scripts/${name}(\\s|$)`);
  for (const raw of stripYamlComments(String(ciText ?? '')).split('\n')) {
    // `run: node …` 와 다중행 `run: |` 블록 안의 `node …` 를 같게 본다.
    const line = raw.replace(/^\s*-?\s*run\s*:\s*/, '');
    for (const seg of line.split(/&&|\|\||[;|]/)) {
      const cmd = seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
      if (call.test(cmd)) return true;
    }
  }
  return false;
}

/**
 * PR CI 밖에 있는 검사기가 **전부 선언돼 있는지** 센다.
 *
 * 세 가지를 본다:
 *   ① 선언 없이 PR 밖에 있는 검사기 — 새로 생긴 것이 조용히 안 돌고 있다
 *   ② 썩은 선언 — 파일이 없거나, `ci.yml` 이 이제 부르는데 선언이 남아 있다
 *   ③ 이유·도는 곳이 비어 있는 선언 — 다음 사람이 되돌릴 수 없다
 */
export function ciCoverageFindings({ files, ciText, declared = CI_UNCOVERED }) {
  const out = [];
  const byFile = new Map();
  for (const d of declared) {
    const f = d?.file;
    if (typeof f !== 'string' || f === '') { out.push('CI_UNCOVERED 항목에 `file` 이 없습니다'); continue; }
    if (byFile.has(f)) out.push(`${f}: CI_UNCOVERED 에 두 번 적혀 있습니다`);
    byFile.set(f, d);
    if (typeof d.why !== 'string' || d.why.trim() === '') out.push(`${f}: 왜 PR 밖인지가 비어 있습니다`);
    if (typeof d.runsIn !== 'string' || d.runsIn.trim() === '') out.push(`${f}: 실제로 어디서 도는지가 비어 있습니다`);
  }
  const have = new Set(files);
  for (const f of byFile.keys()) {
    if (!have.has(f)) { out.push(`${f}: CI_UNCOVERED 에 있는데 검사기 파일이 없습니다 — 선언이 썩었습니다`); continue; }
    if (ciInvokes(ciText, f)) out.push(`${f}: ci.yml 이 이제 부릅니다 — CI_UNCOVERED 에서 지우세요`);
  }
  for (const f of files) {
    if (ciInvokes(ciText, f) || byFile.has(f)) continue;
    out.push(`${f}: ci.yml 이 부르지 않습니다 — PR 에서 한 번도 돌지 않습니다.`
      + ' ci.yml 에 줄을 넣으십시오(승인 필요). 그 전까지 CI_UNCOVERED 에 이유와 도는 곳을 적지 않으면 통과하지 않습니다');
  }
  return out;
}

/**
 * 무엇을 어떻게 돌릴지 정한다. **러너는 이 결과만 따른다** — 러너 안에
 * 또 다른 제외 분기를 두지 않는다 (같은 판단이 두 곳에 있으면 갈린다).
 */
export function sweepPlan({ files, exclusions = SWEEP_EXCLUSIONS }) {
  const byFile = new Map(exclusions.map((e) => [e.file, e]));
  const bare = [];
  const withArgs = [];
  const deferred = [];
  for (const f of files) {
    const e = byFile.get(f);
    if (!e) { bare.push(f); continue; }
    if (Array.isArray(e.runWith) && e.runWith.length) withArgs.push({ file: f, args: e.runWith });
    else deferred.push({ file: f, coveredBy: e.coveredBy });
  }
  return { bare, withArgs, deferred };
}

/**
 * 제외 목록이 **거짓말하지 않는지** 센다. 읽기는 주입받는다 — 시험이
 * 디스크 없이 돌 수 있어야 한다.
 */
export function sweepFindings({ exclusions = SWEEP_EXCLUSIONS, exists, read }) {
  const out = [];
  const seen = new Set();
  for (const e of exclusions) {
    const f = e?.file;
    if (typeof f !== 'string' || f === '') { out.push('제외 항목에 `file` 이 없습니다'); continue; }
    if (seen.has(f)) out.push(`${f}: 제외 목록에 두 번 적혀 있습니다`);
    seen.add(f);

    // ① 썩은 선언 — 없는 파일을 빼 두면 다음 사람이 이유를 못 찾는다.
    if (!exists(f)) { out.push(`${f}: 제외 목록에 있는데 파일이 없습니다 — 선언이 썩었습니다`); continue; }

    // ② 이유 없는 제외는 다음 사람이 되돌릴 수 없다.
    if (typeof e.why !== 'string' || e.why.trim() === '') out.push(`${f}: 왜 뺐는지가 비어 있습니다`);

    const hasRun = Array.isArray(e.runWith) && e.runWith.length > 0;
    const hasCover = typeof e.coveredBy === 'string' && e.coveredBy !== '';

    // ③ 둘 다 없으면 조용히 버리는 것이다.
    if (!hasRun && !hasCover) { out.push(`${f}: 러너가 돌리지도 않고 덮는 곳도 없습니다 — 조용히 버려집니다`); continue; }
    if (hasRun && hasCover) out.push(`${f}: \`runWith\` 와 \`coveredBy\` 가 둘 다 있습니다 — 어디서 도는지가 둘로 갈립니다`);

    // ④ 덮는다고 **주장한 파일이 실제로 이 검사기를 언급하는가.**
    //    주장만으로 통과시키면 제외 목록이 검사기를 숨기는 자리가 된다.
    if (hasCover) {
      if (!exists(e.coveredBy)) { out.push(`${f}: 덮는다고 적은 \`${e.coveredBy}\` 가 없습니다`); continue; }
      const src = read(e.coveredBy) ?? '';
      if (!src.includes(baseName(f))) {
        out.push(`${f}: \`${e.coveredBy}\` 가 이 검사기를 부르지 않습니다 — 덮인다는 말이 사실이 아닙니다`);
      }
    }
  }
  return out;
}
