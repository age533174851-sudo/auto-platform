// scripts/check-wiring.mjs
//
// **만들어 놓고 배선을 안 하는 것을 CI가 잡는다.**
//
// 이 저장소에서 가장 자주 난 고장이 이것이다. 실제로 있었던 것들:
//
//   · conviction.ts        판정 넷을 만들고 테스트까지 붙였는데
//                          저장소 전체에서 부르는 곳이 0곳이었다
//   · sleeveGate           전략 계좌를 멈추는 판정인데 아무도 안 불렀다.
//                          그래서 낙폭 정지가 한 번도 안 걸렸다
//   · applyRealized        손익을 적는 함수인데 안 불려서
//                          realized_pnl이 영영 0이었다
//   · reconcileSleeves     장부와 거래소가 어긋난 것을 찾는 판정인데
//                          어긋나도 아무도 안 봤다
//   · dataQuality.ts       이건 반대다 — 안 쓰인다고 내가 잘못 말했다.
//                          .ts만 찾고 .tsx를 빼먹었기 때문이다
//
// 마지막 것이 이 스크립트가 필요한 진짜 이유다. **손으로 세면 틀린다.**
// 정적 import, 동적 import, .ts와 .tsx, 재수출을 전부 봐야 하는데
// 한 번이라도 빠뜨리면 멀쩡한 모듈을 죽었다고 하거나 죽은 모듈을
// 살았다고 한다. 둘 다 나쁘다.
//
// 무엇을 검사하는가
// ─────────────────
// **판정 모듈만 본다.** lib/engine · lib/risk · lib/strategies ·
// lib/markets의 순수 판정 파일이 대상이다. 화면 컴포넌트나 라우트는
// 스스로가 종점이라 '소비자'라는 개념이 없다.
//
// 그리고 **파일 단위로 본다.** 함수 하나하나까지 세면 헬퍼·타입 가드까지
// 걸려서 소음이 된다. 파일이 통째로 안 불리는 것이 실제 고장이다.
//
// 규칙 하나: **새로 만든 파일은 기본으로 통과시키지 않는다.** 배선이
// 아직이면 ALLOW에 사유와 함께 적는다 — 그러면 그 목록 자체가
// "아직 안 붙인 것" 목록이 된다.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** 판정 모듈이 사는 곳 */
const WATCH_DIRS = [
  'src/lib/engine', 'src/lib/risk', 'src/lib/strategies', 'src/lib/markets',
  'src/lib/exchanges', 'src/lib/auth', 'src/lib/terminal', 'src/lib/ui', 'src/lib/nav',
  // 수익률·성과 귀속. **이 칸이 없던 동안 여기는 검사 밖이었다** —
  // 새 판정 디렉터리를 만들면 이 목록에도 같이 넣어야 한다.
  'src/lib/portfolio',
  // 백테스트 판정과 AI 출처 판정. 여기도 검사 밖이었다.
  'src/lib/backtest', 'src/lib/ai', 'src/lib/runtime',
];

/**
 * 어디서든 부를 수 있는 곳 — 여기 전부를 소비자로 본다.
 *
 * `worker`가 여기 있는 이유
 * ─────────────────────────
 * 24시간 워커는 웹이 쓰는 바로 그 거래소 모듈을 부른다
 * (`worker/src/index.ts` → `../../src/lib/exchanges/futuresExec`).
 * 그런데 이 목록이 src·scripts뿐이면 **워커만 부르는 모듈이 "아무도 안
 * 부른다"로 잡힌다.** 그러면 멀쩡히 배선된 것을 ALLOW에 적게 되고,
 * 그 순간 이 검사는 진짜로 끊긴 모듈을 덮기 시작한다.
 */
const SEARCH_DIRS = ['src', 'scripts', 'worker/src'];

/**
 * 아직 안 붙였지만 그럴 만한 이유가 있는 것.
 *
 * **비워 두는 것이 목표다.** 여기 적는 순간 그건 "언젠가 붙일 것"이라는
 * 약속이고, 약속이 쌓이면 이 검사는 없는 것과 같아진다.
 */
const ALLOW = new Map([
  // ── 이 검사를 처음 켰을 때 이미 끊겨 있던 것들 ──
  //
  // **이 목록은 갚아야 할 빚이다.** 여기 있는 동안 그 판정은
  // "만들어 놓고 안 부르는" 상태이고, 화면에는 아무 영향도 없다.
  // 하나씩 배선하면서 지워 나가야 한다.

  // **막는 것이 무엇인지 정확히 적는다.** '언젠가 붙일 것'이라고만
  // 적으면 그 항목은 영원히 여기 남는다. 무엇이 있어야 붙일 수 있는지를
  // 적어야 그것이 다음 할 일이 된다.

  ['src/lib/strategies/wedomDiscipline.ts',
    '막는 것: 자리 점수(0~100)를 만드는 곳이 저장소에 없다. checkDiscipline은 '
    + 'score가 null이면 막으므로 지금 배선하면 모든 주문이 멎는다. '
    + '진입 신호에 점수를 매기는 스코어러가 먼저 필요하다 '
    + '(tradesToday·recentEntryMs는 risk/tradingHistory가 이미 만든다)'],
  // 챌린지 도메인 모듈의 면제는 **지웠다.** PR3의 스윕(paperChallengeSweep.ts)이
  // transitionAllowed·terminalStatusFor를 실제로 부르면서 배선됐다 —
  // 면제 목록이 낡으면 다음에 진짜로 끊긴 것을 덮는다.
  ['src/lib/markets/proxyAsset.ts',
    '막는 것: 해외주식 주문 경로(stock/order)가 이 판정을 받을 자리가 없다. '
    + '금·원유 ETF처럼 24시간 거래되지만 기초자산 시장은 닫혀 있는 종목의 '
    + '주문 시각 검사에 붙일 것'],

  // ── 한 번 갚았다가 **다시 생긴 빚** ──
  //
  // robustness.ts / costAnalysis.ts는 edgeSweep.ts(격자 실행기)가
  // 부르면서 한 번 여기서 빠졌다. 그런데 assumed-edge 연구 모듈 cleanup이
  // edgeSweep.ts를 삭제하면서 둘 다 다시 고아가 됐다.
  //
  // robustness.ts는 격자 과최적화 등급 전용이라 함께 제거했다.
  // costAnalysis.ts는 실행 비용 정본에 붙일 다음 단계 판정이라 남긴다.
  ['src/lib/strategies/costAnalysis.ts',
    '막는 것: 비용을 뺀 기대값과 빼기 전 기대값을 둘 다 내놓는 실행 경로가 아직 없다. '
    + '유일한 소비자였던 edgeSweep.ts는 assumed-edge 연구 cleanup에서 삭제됐다. '
    + '수수료·슬리피지·펀딩을 실행 계약에 반영하는 단계에서 실제 비용 전후 값을 '
    + '만들어 이 판정을 배선할 것 — 그 전까지는 실행 경로에 없는 연구값으로 거래를 막지 않는다'],

  // ── src/lib/backtest·src/lib/ai를 검사 대상에 넣자마자 나온 것 ──
  ['src/lib/ai/runtime.ts',
    '이건 새로 만든 것이 아니라 **원래 끊겨 있던 것을 이제야 찾은 것이다.** '
    + '파일 머리말에 "모든 AI 호출은 이 계층을 거쳐야 비용이 통제된다"고 '
    + '적혀 있는데 부르는 곳이 0곳이다 — 즉 할당량 확인·캐시 조회·사용량 '
    + '기록이 전부 안 돌고 있다. 429가 자주 나는 것과도 무관하지 않다. '
    + '세어 보니 AI를 직접 부르는 라우트가 13개다 (ai, ai/news/analyze, '
    + 'daily-briefing, hub, strategies/parse, translate, intel, '
    + 'briefing/analyze-news, news/analyze, diagnostics, asset-analysis …). '
    + '전부 이 계층을 지나가지 않는다. 표(ai_usage·ai_cache)는 011에 이미 있다. '
    + '막는 것은 기술이 아니라 **결정이다**: gateAiRequest는 할당량이 다 되면 '
    + 'proceed:false를 돌려주고 기본 plan이 free다. 그대로 배선하면 지금까지 '
    + '제한 없이 쓰이던 AI가 무료 할당량에서 막히기 시작한다 — 비용을 통제하는 '
    + '대신 기능이 멎는 것이라, 어느 쪽을 원하는지는 사용자가 정할 일이다. '
    + '덧붙여 getUsedCredits는 조회 실패 시 0을 돌려준다(= 항상 통과). '
    + '붙일 때 그것부터 고쳐야 한다 — 못 읽은 것은 안 쓴 것이 아니다'],
]);

const files = [];
for (const dir of WATCH_DIRS) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    if (!name.endsWith('.ts')) continue;          // .tsx는 화면이라 제외
    if (name.endsWith('.test.ts')) continue;      // 테스트 자체는 대상이 아니다
    if (name.endsWith('.d.ts')) continue;
    files.push(p);
  }
}

if (files.length === 0) {
  console.error('\n❌ 검사할 판정 모듈을 하나도 못 찾았습니다 — 디렉터리 구조가 바뀌었다면 이 스크립트도 같이 고쳐야 합니다\n');
  process.exit(1);
}

/** src·scripts 아래 모든 소스를 한 번만 읽는다 */
const sources = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
    sources.push({ path: p, text: readFileSync(p, 'utf8') });
  }
}
for (const d of SEARCH_DIRS) walk(d);

const orphans = [];
const stale = [];

for (const file of files) {
  const stem = basename(file).replace(/\.ts$/, '');
  // **정적·동적 import를 함께 본다.** 이 저장소는 라우트에서 동적
  // import를 많이 쓴다 — 그것만 빼먹으면 멀쩡한 모듈이 죽은 것으로
  // 보인다(내가 실제로 한 번 그렇게 틀렸다).
  //
  // 따옴표 안에서 이 파일 이름으로 끝나는 경로를 찾는다:
  //   from './foo'  ·  from '@/lib/engine/foo'  ·  import('./foo')
  const re = new RegExp(`['"\`][^'"\`]*/${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);

  let consumers = 0;
  for (const s of sources) {
    if (s.path === file) continue;                     // 자기 자신
    if (s.path === file.replace(/\.ts$/, '.test.ts')) continue;   // 자기 테스트
    // **이 스크립트 자신은 소비자가 아니다.**
    //
    // WATCH_DIRS에 'src/lib/runtime'을 넣자마자 `src/lib/ai/runtime.ts`가
    // "이미 배선됨"으로 뒤집혔다. 이 파일의 설정 문자열이 import 경로처럼
    // 보였기 때문이다. 검사기가 자기 설정을 근거로 통과시키면, 진짜로
    // 끊긴 모듈이 조용히 살아난다.
    if (s.path === 'scripts/check-wiring.mjs') continue;
    if (re.test(s.text)) consumers++;
  }

  const allowed = ALLOW.has(file);
  if (consumers === 0 && !allowed) orphans.push(file);
  if (consumers > 0 && allowed) stale.push(file);
}

let bad = false;

if (orphans.length > 0) {
  console.error('\n❌ 만들어 놓고 부르는 곳이 없는 판정 모듈:');
  for (const f of orphans) console.error(`   · ${f}`);
  console.error('\n   판정을 만들어 놓고 안 부르면, 그 검사는 켜져 있는 것처럼');
  console.error('   보이면서 아무것도 안 합니다. 이 저장소에서 가장 자주 난 고장입니다.');
  console.error('\n   셋 중 하나를 하세요:');
  console.error('     1. 실제로 부르는 곳에 배선한다');
  console.error('     2. 아직이면 scripts/check-wiring.mjs의 ALLOW에 사유와 함께 적는다');
  console.error('     3. 쓸 데가 없으면 지운다');
  bad = true;
}

if (stale.length > 0) {
  console.error('\n⚠ ALLOW에 적혀 있는데 이미 배선된 모듈:');
  for (const f of stale) console.error(`   · ${f} — ${ALLOW.get(f)}`);
  console.error('\n   ALLOW에서 지우세요. 면제 목록이 낡으면 다음에 진짜로 끊긴 것을 덮습니다.');
  bad = true;
}

/**
 * 주석을 지운 코드만 본다.
 *
 * **처음 쓴 규칙은 주석으로 만족됐다.** 라우트에
 * `// 판정은 judgeExecutor 한 곳에 있다`라고 적어 둔 것이 있어서,
 * `judgeExecutor`를 찾는 정규식이 **실제 호출이 아니라 그 문장에**
 * 걸렸다. 설명을 적었다는 것은 그렇게 했다는 증거가 아니다.
 *
 * 문자열 안의 `//`는 주석이 아니다(`https://`). 그래서 인용부호를
 * 보면서 지운다 — 안 그러면 URL 뒤의 진짜 코드가 같이 날아가고,
 * **있는 것을 없다고** 한다.
 */
function stripComments(text) {
  let out = '', i = 0;
  const n = text.length;
  let quote = null;      // ' " ` 중 지금 열려 있는 것
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// ── 청산 감시 응답에 워커 생존 증거가 실려 있는가 ──
//
// 위 검사는 "부르는 곳이 있는가"를 센다. 이 규칙은 그 다음 단계다 —
// **부르기는 하는데 그 결과가 사람에게 닿는 자리에 실리는가.**
//
// `judgeExecutor`는 배선돼 있었다(`/api/worker/status`가 부른다). 그런데
// 그 라우트는 인증이 필요하고 **아무 자동 회차도 부르지 않는다.** 그래서
// 워커가 죽어도 사람이 로그인해서 열어 보기 전에는 어디에도 안 적혔고,
// `CLAUDE.md`가 금지한 "fly logs를 열어 확인해 주세요"가 거기서 나왔다.
//
// 청산 감시 라우트는 워커가 5분마다, 백업 회차가 한 시간에 한 번 부르고
// **응답 본문이 Actions 로그에 그대로 남는다.** 거기 실리면 생존이 사람
// 손을 타지 않고 기록된다.
//
// 이 라우트에는 200 응답 경로가 **넷**이다. 한쪽에만 넣으면 그 경로로
// 끝난 회차의 로그에는 증거가 없다 — 상습 고장 ② "경로가 둘인데 한쪽만
// 고침"이다. 그래서 숫자를 세지 않고 **경로를 전수로** 본다.
//
// 왜 check-wiring에 넣는가: CI는 검사기를 **글롭이 아니라 명시 목록**으로
// 돌린다(`.github/workflows/ci.yml`). 새 파일을 만들면 CI가 안 돌리고,
// 워크플로는 사람 승인 사항이다. **CI가 안 돌리는 검사기는 없는
// 검사기다** — 그래서 이미 돌고 있는 이 파일에 붙인다.
const EXIT_MONITOR = 'src/app/api/autotrade/exit-monitor/route.ts';
const evidenceGaps = [];
const evidenceSeen = [];
{
  const raw = readFileSync(EXIT_MONITOR, 'utf8');
  const text = stripComments(raw);
  const NEEDLE = 'NextResponse.json(';
  for (let i = text.indexOf(NEEDLE); i !== -1; i = text.indexOf(NEEDLE, i + 1)) {
    // 괄호를 짝 맞춰 인자 전체를 뗀다. 정규식으로 `}`까지 긁으면
    // 중첩 객체에서 잘려 **있는 것을 없다고** 한다.
    let depth = 0, j = i + NEEDLE.length - 1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    const args = text.slice(i + NEEDLE.length, j);
    const line = text.slice(0, i).split('\n').length;
    // 4xx·5xx는 면제다. 인증 실패 응답에 운영 상태를 실으면
    // **인증 전에 상태가 샌다.**
    if (/status:\s*[45]\d\d/.test(args)) continue;
    evidenceSeen.push(line);
    if (!/\bexecutor\b/.test(args)) evidenceGaps.push(`${EXIT_MONITOR}:${line}`);
  }
  if (evidenceSeen.length === 0) {
    evidenceGaps.push(`${EXIT_MONITOR} — 200 응답을 하나도 찾지 못했습니다 (이 규칙이 헛돌고 있습니다)`);
  }
  // 임계값을 라우트가 따로 갖지 않는지. 두 곳에 있으면 화면은 '정상'인데
  // 주문은 막히는 상태가 생긴다.
  // 산문이 아니라 **import 문**을 본다.
  if (!/from\s+['"]@\/lib\/runtime\/executorEvidence['"]/.test(text)
      || !/\breadExecutorEvidence\s*\(/.test(text)) {
    evidenceGaps.push(`${EXIT_MONITOR} — 생존 판정을 executorEvidence에서 가져와 부르지 않았습니다`
      + ' (임계값을 라우트에 복제하면 화면과 주문 경로가 갈립니다)');
  }
}

if (evidenceGaps.length > 0) {
  console.error('\n❌ 청산 감시 응답에 워커 생존 증거가 빠진 경로:');
  for (const g of evidenceGaps) console.error(`   · ${g}`);
  console.error('\n   그 경로로 끝난 회차의 Actions 로그에는 워커 생존이 적히지 않습니다.');
  console.error('   `executor: await executorNow()`를 그 응답에도 넣으세요.');
  bad = true;
}

if (bad) process.exit(1);

console.log(`✅ 판정 모듈 ${files.length}개 · 배선 안 된 것 0개`
  + (ALLOW.size > 0 ? ` (면제 ${ALLOW.size}개)` : ''));
console.log(`✅ 청산 감시 200 응답 ${evidenceSeen.length}개 전부 워커 생존 증거를 싣는다`);
