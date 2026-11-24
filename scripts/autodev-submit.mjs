#!/usr/bin/env node
// scripts/autodev-submit.mjs
//
// **무인 회차가 작업물을 내보내는 단 하나의 통로.**
//
// 쓰는 법:
//
//     node scripts/autodev-submit.mjs --mode dev \
//       --title "fix(x): 한 줄 요약" --body-file /tmp/pr-body.md
//
// 왜 스크립트인가 — 허용 목록에 `Bash(git push -u origin:*)` 를 두면
// 그 접두어 뒤의 아무 글자나 들어온다. 공식 문서가 적는 그대로다:
// `*` 는 공백을 포함한 아무 글자나 받고, 끝의 `:*` 는 끝의 와일드카드와
// 같다. 그래서 그 한 줄은 `git push -u origin HEAD:main` 과
// `git push -u origin claude/dev-x --force` 를 **둘 다** 허용한다.
// 금지 목록으로는 막지 못한다 — 문서가 "isn't a security boundary"
// 라고 못 박고, `git -C . push` 한 번에 비켜 간다.
//
// 그래서 **통로를 명령 모양이 아니라 코드로 좁힌다.** 회차가 넘길 수
// 있는 것은 `--mode`·`--title`·`--body-file` 뿐이고, git 과 gh 에 갈
// argv 는 `scripts/lib/autodev-delivery.mjs` 가 만든다. refspec 도
// `--draft` 도 거기서 글자로 박히므로 바꿀 자리가 없다.
// (`CLAUDE.md`: "자동화보다 실패 지점 제거가 우선이다".)
//
// 이 스크립트는 **셸을 거치지 않는다.** `execFileSync` 에 argv 배열을
// 넘기므로 제목·본문에 무엇이 들어와도 명령으로 해석되지 않는다.
//
// 비밀값은 적지 않는다 — 토큰은 읽지도 않고, 실패 본문도 그대로 뿜지
// 않는다. git·gh 의 표준 출력은 사람이 보는 로그로 흘려 보낸다.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { submitPlan, SUBMIT_SCRIPT } from './lib/autodev-delivery.mjs';

const die = (m) => {
  console.error(`❌ ${m}`);
  console.error(`::error::${m}`);
  process.exit(1);
};

/** `--k v` 만 읽는다. 모르는 키는 거부한다 — 조용히 무시하지 않는다. */
function parseArgs(argv) {
  const known = new Set(['--mode', '--title', '--body-file']);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!known.has(k)) die(`모르는 인자입니다: ${JSON.stringify(k)} — `
      + `${SUBMIT_SCRIPT} 는 --mode · --title · --body-file 만 받습니다`);
    const v = argv[i + 1];
    if (v == null) die(`${k} 의 값이 없습니다`);
    out[k.slice(2)] = v;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const need of ['mode', 'title', 'body-file']) {
  if (!args[need]) die(`--${need} 가 없습니다`);
}

const bodyFile = args['body-file'];
if (!existsSync(bodyFile)) die('본문 파일이 없습니다 — 읽지 못한 것을 올리지 않습니다');
const body = readFileSync(bodyFile, 'utf8');
if (!body.trim()) die('본문 파일이 비어 있습니다 — 설명 없는 PR 은 올리지 않습니다');

const title = args.title.trim();
if (!title) die('--title 이 비어 있습니다');
if (title.length > 200) die(`--title 이 너무 깁니다 (${title.length}자)`);

/** 읽기만 한다. 실패하면 "모름"으로 두고 멈춘다 — 통과로 보지 않는다. */
function gitRead(...a) {
  try {
    return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const branch = gitRead('rev-parse', '--abbrev-ref', 'HEAD');
if (branch == null) die('현재 브랜치를 읽지 못했습니다 — 모르는 것을 밀지 않습니다');

const plan = submitPlan({ mode: args.mode, branch });
if (!plan.ok) die(plan.why);

// **올릴 것이 있는지 먼저 센다.** 커밋이 없으면 빈 브랜치가 올라가고
// 빈 PR 이 열린다 — 사람이 열어 보고 아무것도 없는 것을 보게 된다.
const ahead = gitRead('rev-list', '--count', `origin/main..${plan.branch}`);
if (ahead == null) die('main 과의 차이를 세지 못했습니다 — 세지 못한 것을 올리지 않습니다');
if (Number(ahead) === 0) {
  console.log('✅ main 과 다른 커밋이 없습니다 — 올릴 것이 없습니다 '
    + '(고칠 것이 없는 회차는 정상입니다)');
  process.exit(0);
}

// 담기지 않은 변경이 남아 있으면 그것은 **올라가지 않는다.** 반쯤 올린
// 작업물을 PR 로 여는 것보다 멈추는 쪽이 낫다.
const dirty = gitRead('status', '--porcelain');
if (dirty == null) die('작업 트리 상태를 읽지 못했습니다');
if (dirty) die(`커밋되지 않은 변경이 ${dirty.split('\n').length}건 남아 있습니다 — `
  + '담기지 않은 것은 올라가지 않습니다');

function run(cmd, argv) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  try {
    execFileSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    // 오류 본문에 토큰이 섞여 들어올 수 있으므로 그대로 다시 적지 않는다.
    die(`${cmd} ${argv[0]} 가 실패했습니다 (위 출력 참고)`);
  }
}

run('git', plan.pushArgv);
run('gh', [...plan.prArgv, '--title', title, '--body-file', bodyFile]);

console.log(`✅ ${plan.branch} 올림 · Draft PR 열림`);
