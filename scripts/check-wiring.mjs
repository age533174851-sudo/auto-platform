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
import { join, basename, dirname } from 'node:path';

/**
 * 판정 모듈이 사는 곳 — **목록을 손으로 적지 않는다.**
 *
 * 예전에는 디렉터리를 하나씩 적어 둔 배열이었다. 그래서 `src/lib`의
 * 55개 중 **13개만** 보고 있었고, 밖에 있던 것 중에는 이런 것들이 있었다:
 *
 *   src/lib/autotrade  33개  ← 예약 평가·진입 창·강제 진입 판정
 *   src/lib/trading    32개
 *   src/lib/ops        14개
 *   src/lib/safety      5개  ← 이름이 safety인데 검사 밖이었다
 *
 * 즉 "만들어 놓고 배선을 안 함"을 잡는 검사가 **그 고장이 가장 비싼
 * 자리들을 보지 않고 있었다.** 그리고 목록을 손으로 적는 방식 자체가
 * 이 저장소에서 반복된 고장이다(#571 "손으로 적은 모듈 목록 드리프트").
 *
 * 그래서 항목을 더 채우지 않고 **목록을 없앴다.** 새 디렉터리를 만들면
 * 아무것도 안 해도 감시에 들어온다 — 사람이 기억해야 하는 단계가
 * 사라지는 것이 항목을 늘리는 것보다 낫다.
 */
const WATCH_DIRS = readdirSync('src/lib', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join('src/lib', e.name))
  .sort();

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
 * **시험 파일인가** — 이 저장소의 시험 파일 이름은 한 모양이 아니다.
 *
 *   src/lib/risk/killSwitchTruth.test.ts     ← `.test.ts`
 *   src/components/Foo.test.tsx              ← `.test.tsx`
 *   scripts/ten-slot-pg.test.mjs             ← `.test.mjs`   (6개)
 *   scripts/test-kill-retry.mjs              ← `test-` 접두어 (6개)
 *
 * 아래 소비자 판정은 `.test.ts`·`.test.tsx`만 뺐다. 그래서 뒤의 두 모양은
 * **여전히 소비자로 세어진다.** 그리고 이 검사기가 확장자 붙은 경로까지
 * 보게 된 뒤부터는(`'src/lib/risk/killRetry.ts'` 같은 문자열) 그 구멍이
 * 실제로 열렸다 — `scripts/test-*.mjs`가 TS를 tsc 인자로 넘기려고 적어 둔
 * 경로 문자열이 **배선으로 세어진다.**
 *
 * 전수 측정(다섯 PR을 한 트리에 모은 상태): 두 모양을 함께 빼면 새로
 * orphan이 되는 모듈은 **1개뿐이고 그게 의도한 모듈이다** —
 * `src/lib/risk/killRetry.ts`(제품 소비자 0곳, ALLOW에 사유가 적혀 있다).
 * 다른 544개는 판정이 바뀌지 않는다. 즉 이 변경은 검사기를 **느슨하게
 * 만드는 것이 아니라** 놓치던 것을 잡게 한다.
 */
function isTestSource(path) {
  if (/\.test\.(ts|tsx|mjs|js)$/.test(path)) return true;
  if (/^scripts\/test-[^/]+\.mjs$/.test(path)) return true;
  return false;
}

// 이 판정이 틀리면 검사 전체가 조용히 뒤집힌다 — 끊긴 모듈이 "배선됨"이
// 된다. 그래서 **CI가 평소에 돌리는 경로에서** 바로 확인한다. 별도
// `--self-test` 모드로 두면 CI가 안 돌리고, 이 저장소의 규칙대로
// **CI가 안 돌리는 검사기는 없는 검사기다.**
for (const [p, want] of [
  ['src/lib/risk/killSwitchTruth.test.ts', true],
  ['src/components/terminal/PaperWallet.test.tsx', true],
  ['scripts/ten-slot-pg.test.mjs', true],
  ['scripts/test-kill-retry.mjs', true],
  ['scripts/test-pr-facts.mjs', true],
  // ── 시험이 **아닌데** 이름에 test가 들어간 것들 (전부 실재한다) ──
  ['scripts/check-test-registry.mjs', false],
  ['scripts/check-testnet-diagnose.mjs', false],
  ['scripts/run-tests.mjs', false],
  ['scripts/testnet-diagnose-mutations.mjs', false],
  ['src/lib/engine/testnetDiagnoseVerdict.ts', false],
  ['src/lib/risk/killRetry.ts', false],
]) {
  if (isTestSource(p) !== want) {
    console.error(
      `\n❌ 검사기 자기 점검 실패: isTestSource('${p}') 가 ${want} 여야 하는데 ${!want} 입니다.`,
    );
    console.error('   시험 파일을 소비자로 세면 끊긴 모듈이 "배선됨"으로 통과합니다.');
    process.exit(1);
  }
}

// **판단이 두 곳에 있으면 언젠가 갈린다.** 위 점검은 `isTestSource()`가
// 맞는지만 본다 — 소비자 루프가 그 함수를 **안 쓰고** 제 손으로 정규식을
// 다시 적으면, 점검은 통과하면서 실제 판정은 옛 규칙으로 돌아간다.
// (실제로 변이로 확인했다: 루프만 `.test.ts` 규칙으로 되돌려도 이 저장소의
// 현재 상태로는 결과가 똑같아서 **아무도 모른다.**)
//
// 그래서 이 파일 안에 `.test.` 정규식이 **한 개뿐**임을 자기 소스로 고정한다.
{
  const own = stripComments(readFileSync('scripts/check-wiring.mjs', 'utf8'));
  const dup = (own.match(/\\\.test\\\./g) || []).length;
  if (dup !== 1) {
    console.error(
      `\n❌ 검사기 자기 점검 실패: \`\\.test\\.\` 정규식이 ${dup}곳에 있습니다 (1곳이어야 합니다).`,
    );
    console.error('   시험 파일 판정은 isTestSource() 한 곳에만 둡니다 — 두 곳이면 갈립니다.');
    process.exit(1);
  }
  // **문자열을 통째로 적으면 이 줄 자신이 그 문자열이다.** 처음에 그렇게
  // 적었고, 그래서 루프에서 호출을 지워도 이 점검이 통과했다 — 점검이
  // 자기 자신을 근거로 통과하는 것이 이 저장소에서 반복된 고장이다
  // (`check-wiring.mjs`를 소비자에서 빼는 이유와 같다). 쪼개서 적는다.
  if (!own.includes('isTestSource' + '(s.path)')) {
    console.error('\n❌ 검사기 자기 점검 실패: 소비자 루프가 isTestSource() 를 쓰지 않습니다.');
    process.exit(1);
  }
}

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

  // ── 기준을 조인 순간 드러난 셋 ────────────────────────────────
  //
  // 예전 기준은 **자기 테스트만** 소비자에서 뺐다. 그래서 *다른 모듈의*
  // 시험이 import하면 "배선됨"이 됐고, 아래 셋이 그 구멍으로 지나갔다.
  // 셋 다 제품 코드 소비자가 **0곳**이다 — 지금 적는 것은 숨기는 것이
  // 아니라 **빚을 장부에 올리는 것**이다. 비어 있는 것이 목표다.
  ['src/lib/strategies/profileMonteCarlo.ts',
    '프로필 숫자를 몬테카를로 입력으로 번역한다. 제품 소비자 0곳 — '
    + 'import하는 것은 costAnalysis.test.ts와 roundLedger.test.ts뿐이다. '
    + '이 파일의 머리말이 스스로 적고 있다: "엔진은 있는데 화면에 안 붙어 '
    + '있었다 … 엔진이 있다는 것과 그 엔진이 도는 것은 다른 이야기다 — '
    + '이 저장소에서 가장 자주 나는 고장이 이것이다." **그 문장을 쓴 파일이 '
    + '그 상태다.** 붙일 자리는 전략 프로필 화면이고, 붙이면 그 화면이 '
    + '한 경로의 끝 잔고 대신 분포를 적게 된다 — 즉 화면에 나가는 숫자가 '
    + '바뀌는 변경이라 사람 확인이 필요하다'],
  ['src/lib/strategies/roundRunner.ts',
    '회차 종료를 한 곳으로 모은 함수(장부 한 줄 · 계좌 되돌리기 · 회차 '
    + '번호 올리기). 제품 소비자 0곳 — roundLedger.test.ts만 import한다. '
    + '머리말은 "화면은 이 함수만 부른다"고 적었는데 **부르는 화면이 없다.** '
    + '즉 회차 종료가 여전히 화면 안에 흩어져 있을 가능성이 있고, 그것은 '
    + '이 파일이 막으려던 바로 그 고장이다. 붙이려면 회차 종료 경로가 '
    + '지금 어디에 몇 개 있는지부터 세어야 한다'],
  ['src/lib/strategies/simFormat.ts',
    '모의 성적표 표시 서식(기간·금액). 제품 소비자 0곳 — '
    + 'profileSim.test.ts만 import한다. 이 파일은 화면에 실제로 나갔던 두 줄'
    + '("표본 기간: 시작과 끝이 같은 시각", "누적손익 +238,790,…e+36")을 '
    + '고치려고 썼다. 붙지 않은 동안 그 화면은 고쳐지지 않았을 수 있다 — '
    + '어느 화면이 그 두 줄을 그리는지 확인하고 거기에 붙여야 한다'],

  // ── 목록을 없애고 `src/lib` 전부를 보게 한 뒤 남은 넷 ──────────
  //
  // 처음에는 16건이 잡혔다. 그중 **12건은 이 검사기 자신의 오탐**이었다 —
  // 확장자 붙은 경로(`'src/lib/ci/autoMergeGate.ts'`)를 못 봤기 때문이다.
  // 정규식을 고치자 12건이 사라졌다. 남은 넷은 하나씩 확인했다.
  ['src/lib/ops/opsQueue.ts',
    '**배선돼 있다 — 정규식으로 볼 수 없는 모양이다.** '
    + "scripts/ops-runner.mjs:80이 join(ROOT,'src','lib','ops','opsQueue.ts')로 "
    + '경로를 조립해 복사·컴파일하고 opsQueue.js를 동적 import한다. '
    + '인용된 경로 문자열이 아니라 **조각으로 조립**하므로 어떤 정규식도 '
    + '보지 못한다. 이것을 정규식으로 쫓으면 오탐이 다시 늘어난다 — '
    + '그래서 쫓지 않고 여기 적는다. **이 항목은 빚이 아니라 한계다**'],
  ['src/lib/jobs/queueGuard.ts',
    '진짜 미배선이다. 그리고 그보다 중요한 것: '
    + 'src/app/api/binance/futures/order/route.ts:525의 주석이 '
    + '"큐는 남겨 둔다 — 웹훅(signal·tradingview)이 아직 쓴다. 다만 그쪽도 '
    + '실행자가 없으면 적재하지 않는다(queueGuard)"라고 적고 있는데, '
    + '**웹훅 라우트 셋 다 이 모듈을 부르지 않는다.** 다만 그 셋은 '
    + 'enqueueJob도 from(\'jobs\')도 쓰지 않아서 **막을 적재 자체가 없다** — '
    + '즉 지금 새고 있는 것은 아니다. 고칠 것은 둘 중 하나다: 웹훅이 다시 '
    + '적재하게 되면 이 가드를 붙이거나, 적재 경로가 없어진 사실을 그 주석에 '
    + '반영하는 것. **2026-11-08에 그 주석을 고쳤고**, 약속은 주석이 아니라 '
    + 'scripts/check-order-guards.mjs로 옮겼다 — 제품 코드에 적재가 다시 '
    + '생기면 그 검사기가 실행자 확인을 요구한다. 이 모듈은 그때 쓰인다'],
  ['src/lib/autotrade/decision.ts',
    '진짜 미배선이다 — 참조가 **모든 모양에서 0건**이다(인용 경로 · 확장자 '
    + '붙은 경로 · join 조립 전부 확인). export 6개. 머리말은 '
    + '"설명가능한(XAI) 판단 엔진 … 아무것도 안 하는 이유(대기 사유)까지 '
    + '투명하게 설명한다"고 적었다. 그 설명이 화면에 나가지 않고 있다. '
    + '붙일지 지울지는 결정이 필요하다 — 자동매매 판정 경로에 두 번째 '
    + '엔진을 붙이는 일이라 사람 확인 없이 할 수 없다'],
  ['src/lib/fx/rate.ts',
    '진짜 미배선이다 — 참조 0건, export 2개(getUsdKrw 계열). '
    + '**실패 시 fallback 1375를 쓰는 환율 모듈**이다. 이 저장소에는 '
    + '환율로 1,000배가 틀어진 기록이 있다(walletMoney.ts: 공용 cvt()가 '
    + '입력을 KRW로 가정). 그래서 이것을 붙이는 일은 "환율이 없으면 원화로 '
    + '바꾸지 않는다"는 기존 규칙과 충돌하지 않는지 먼저 봐야 한다 — '
    + '고정 fallback은 **환율을 모르는데 아는 척하는 값**이다'],

  // ── 그림자 배럴: 쌍둥이에 가려 아무도 닿지 못하는 모듈 ──
  ['src/lib/fees/index.ts',
    '**형제 파일에 가려져 아무도 닿지 못한다.** `src/lib/fees.ts`와 '
    + '`src/lib/fees/index.ts`가 함께 있고, 파일이 디렉터리보다 먼저 '
    + '해석된다. `tsc --traceResolution`으로 확인했다 — '
    + '`src/lib/backtest/index.ts:10`의 `from \'../fees\'`는 '
    + '`src/lib/fees.ts`로 간다. `fees/index`를 명시한 경로는 저장소에 '
    + '0곳이다. 즉 이 158줄은 **죽은 코드이면서 살아 있는 것처럼 보인다.** '
    + '지우지 않는 이유: 두 파일이 같은 질문에 다른 답을 하고, 어느 쪽이 '
    + '정본인지는 **수수료 숫자를 고르는 결정**이다. '
    + '`fees.ts`는 거래소별 단일 요율이고 Binance를 maker 0.001 / '
    + 'taker 0.001로 적는다(현물 VIP0). `fees/index.ts`는 **현물과 선물을 '
    + '나누고** VIP 구간을 담아 Binance 선물 VIP0을 maker 0.0002 / '
    + 'taker 0.0005로 적는다. 이 플랫폼은 선물을 거래한다. '
    + '그리고 **부르는 쪽은 죽은 모듈에 맞춰 쓰여 있다** — '
    + '`backtest/index.ts:81`과 `safety/index.ts:271`이 '
    + '`getDefaultConfig(exchange, \'futures\')`로 인자를 둘 넘기는데, '
    + '실제로 닿는 `fees.ts`의 그 함수는 인자가 하나다. tsc가 **이미 '
    + '그것을 적고 있다** — 기준선 73건 안에 '
    + '`backtest/index.ts(81,49) TS2554: Expected 0-1 arguments, but got 2`와 '
    + '`safety/index.ts(271,68)` 같은 오류로 들어 있다. 기준선을 **개수로만** '
    + '보면 이 두 줄이 보이지 않는다. '
    + '실제 체결 수수료는 다른 곳에서 온다(`paperExecution.ts`의 '
    + '`paperFeeRate` · `paper/engine.ts`의 `FEE_RATE`) — 즉 **실주문 손익이 '
    + '틀어지는 문제는 아니다.** 영향은 백테스트 수수료와 '
    + '`validatePreOrder`의 왕복 수수료 추정이고, 둘 다 수수료를 '
    + '**과대**하게 잡는 방향(보수적)이다. 어느 표를 정본으로 할지는 '
    + '사이징·백테스트 숫자를 바꾸는 결정이라 사람 승인 사항이다'],
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
    // ── **주석은 소비자가 아니다** ─────────────────────────────
    //
    // 이 검사기가 2026-11-08에 제 변경을 잡았다. 제가 다른 검사기의
    // 주석에 `src/lib/jobs/queueGuard.ts`라고 적었더니 그 줄이 소비자로
    // 세어져서, **진짜로 끊긴 모듈이 "이미 배선됨"으로 뒤집혔다.**
    //
    // 이 파일의 머리말이 이미 같은 함정을 적어 두었다 — "주석에 이름이
    // 적혀 있다는 이유로 통과가 난다. 이 저장소에서 이미 두 번 일어난
    // 일이다." 그런데 소비자 판정 자체는 원문을 보고 있었다.
    //
    // 주석으로 배선을 증명할 수는 없다. 지우고 본다. (전수 측정:
    // 이 변경으로 새로 끊기는 모듈 0건.)
    sources.push({ path: p, text: stripComments(readFileSync(p, 'utf8')) });
  }
}
for (const d of SEARCH_DIRS) walk(d);

// ── **새 그림자 배럴을 만들지 않는다** ─────────────────────────
//
// `X.ts`와 `X/index.ts`가 함께 있으면 `'…/X'`는 **파일**로 간다. 그래서
// 배럴은 명시 경로가 없는 한 아무도 닿지 못하고, 두 파일이 같은 이름의
// export를 갖고 있으면 **어느 쪽을 고쳤는지 모르는 상태**가 된다.
// 이 저장소에 실제로 하나 있고(`fees`), 그 하나가 지금 죽어 있다.
//
// 아는 짝만 통과시킨다. 새로 생기면 막는다 — 고친 뒤에 발견하는 것보다
// 만들 때 막는 것이 싸다.
const KNOWN_SHADOWS = new Set(['src/lib/fees/index.ts']);
{
  const found = [];
  for (const f of files) {
    if (basename(f) !== 'index.ts') continue;
    const d = dirname(f);
    const sibling = join(dirname(d), `${basename(d)}.ts`);
    if (existsSync(sibling)) found.push({ barrel: f.replaceAll('\\', '/'), sibling: sibling.replaceAll('\\', '/') });
  }
  const fresh = found.filter((x) => !KNOWN_SHADOWS.has(x.barrel));
  if (fresh.length > 0) {
    console.error('\n❌ 같은 이름의 파일과 디렉터리가 함께 있습니다 (그림자 배럴):');
    for (const x of fresh) console.error(`   · ${x.sibling}  ↔  ${x.barrel}`);
    console.error('\n   `\'…/이름\'` import는 **파일로 갑니다** — 배럴은 아무도 못 부릅니다.');
    console.error('   둘 중 하나로 합치거나, 배럴 쪽 이름을 바꾸세요.');
    process.exit(1);
  }
  const goneStale = [...KNOWN_SHADOWS].filter((b) => !found.some((x) => x.barrel === b));
  if (goneStale.length > 0) {
    console.error('\n❌ KNOWN_SHADOWS에 적혀 있는데 더는 그림자가 아닌 것:');
    for (const b of goneStale) console.error(`   · ${b}`);
    console.error('   해결됐으면 목록에서 지우세요. 낡은 면제는 다음 짝을 덮습니다.');
    process.exit(1);
  }
}

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
  //
  // **확장자가 붙은 모양도 본다.** 이 저장소의 스크립트들은 판정을
  // 복제하지 않으려고 TS 파일을 **tsc 인자로 넘겨 컴파일한 뒤** 산출물을
  // 동적 import한다:
  //
  //   scripts/auto-merge.mjs:47   tsc, 'src/lib/ci/autoMergeGate.ts', …
  //   scripts/auto-merge.mjs:156  await import(`…/autoMergeGate.js`)
  //
  // 확장자 없는 모양만 보면 그 셋(`autoMergeGate` · `autoRebase` ·
  // `deployDispatch`)이 **멀쩡히 배선됐는데 끊긴 것으로** 잡힌다. 그러면
  // 사람은 ALLOW에 적어 넣고, 그 순간 이 검사는 믿을 수 없는 것이 된다.
  // 못 잡는 것과 **없는 것을 잡는 것**은 둘 다 검사기를 무용하게 만든다.
  //
  // ── **`index.ts`는 스템으로 찾을 수 없다** ────────────────────
  //
  // 여기까지는 파일 이름(스템)으로 경로를 찾았다. `index.ts`에서는 그
  // 스템이 `index`라서, 저장소 안의 **아무 `/index` 경로**나 소비자로
  // 세어진다. 실측했다 — `src/lib/*/index.ts` 배럴 12개가 전부 **같은
  // 22개**를 소비자로 받고 있었다:
  //
  //   scripts/check-100x-contract.mjs …  'worker/src/index.ts'        (7개)
  //   scripts/probe/auto-targets.mjs …   '…/playwright/index.mjs'     (13개)
  //
  // 22개 중 **단 하나도** 그 배럴에 관한 증거가 아니다. 즉 이 검사는
  // "배선 안 된 것 0개"라고 적으면서 **12개를 아예 안 보고 있었다.**
  //
  // 그래서 배럴은 **디렉터리 이름**으로 찾는다. Node/TS가 디렉터리
  // import를 그 안의 `index`로 푸는 것과 같은 규칙이다.
  //
  // ── 그림자 배럴 ───────────────────────────────────────────────
  //
  // 단, 같은 이름의 **형제 파일**이 있으면 디렉터리 import는 그 파일로
  // 간다. 파일이 디렉터리보다 먼저다. 이 저장소에 실제로 하나 있다:
  //
  //   src/lib/fees.ts  ↔  src/lib/fees/index.ts
  //
  // `tsc --traceResolution`으로 확인했다 —
  // `'../fees'`는 `src/lib/fees.ts`로 해석된다. 그러니 그 경우 배럴은
  // **명시적인 `/fees/index` 경로로만** 닿을 수 있다.
  const stemEsc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isBarrel = stem === 'index';
  const dirName = basename(dirname(file));
  const dirEsc = dirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shadowedBy = isBarrel ? join(dirname(dirname(file)), `${dirName}.ts`) : null;
  const shadowed = shadowedBy != null && existsSync(shadowedBy);
  const re = !isBarrel
    ? new RegExp(`['"\`][^'"\`]*/${stemEsc}(\\.(ts|tsx|js|mjs))?['"\`]`)
    : shadowed
      // 형제 파일에 가려졌다 — 디렉터리 경로는 그 파일로 간다
      ? new RegExp(`['"\`][^'"\`]*/${dirEsc}/index(\\.(ts|tsx|js|mjs))?['"\`]`)
      : new RegExp(`['"\`][^'"\`]*/${dirEsc}(/index(\\.(ts|tsx|js|mjs))?)?['"\`]`);
  // 같은 디렉터리 안에서 `'./index'`로 부르는 것도 배선이다
  // (`src/lib/safety/auditStore.ts:61`이 그렇게 한다). 경로에 디렉터리
  // 이름이 없으므로 위 정규식으로는 보이지 않는다.
  const sameDirRe = /['"`]\.\/index(\.(ts|tsx|js|mjs))?['"`]/;
  const ownDir = dirname(file);

  let consumers = 0;
  for (const s of sources) {
    if (s.path === file) continue;                     // 자기 자신
    // ── **시험 파일은 소비자가 아니다** ─────────────────────────
    //
    // 예전에는 **자기 테스트만** 뺐다. 그러면 *다른 모듈의* 시험이
    // import하는 것으로 "배선됨"이 된다. 그 구멍으로 셋이 지나갔다:
    //
    //   profileMonteCarlo.ts ← costAnalysis.test.ts · roundLedger.test.ts
    //   roundRunner.ts       ← roundLedger.test.ts
    //   simFormat.ts         ← profileSim.test.ts
    //
    // 셋 다 제품 코드에서 부르는 곳이 **0곳**인데 이 검사는 "배선 안 된
    // 것 0개"라고 적었다. 그리고 하필 그 셋이 **이 고장을 고치려고 쓴
    // 파일들**이다 — `profileMonteCarlo.ts`의 머리말이 직접 적고 있다:
    //
    //   "엔진은 있는데 화면에 안 붙어 있었다 … 엔진이 있다는 것과 그
    //    엔진이 도는 것은 다른 이야기다 — 이 저장소에서 가장 자주
    //    나는 고장이 이것이다"
    //
    // 시험이 소비자로 세어지면 이 검사는 **자기 목적을 잃는다.** 시험은
    // 판정이 맞는지 보는 것이고, 그 판정이 **쓰이는지**는 보지 않는다.
    //
    // **이름 모양이 두 가지다.** `.test.ts`만 보면 `scripts/ten-slot-*.test.mjs`
    // 여섯 개와 `scripts/test-*.mjs` 여섯 개가 여전히 소비자로 세어진다.
    // 판정은 `isTestSource()` 한 곳에 있고 자기 점검이 붙어 있다 (위).
    if (isTestSource(s.path)) continue;
    // **이 스크립트 자신은 소비자가 아니다.**
    //
    // WATCH_DIRS에 'src/lib/runtime'을 넣자마자 `src/lib/ai/runtime.ts`가
    // "이미 배선됨"으로 뒤집혔다. 이 파일의 설정 문자열이 import 경로처럼
    // 보였기 때문이다. 검사기가 자기 설정을 근거로 통과시키면, 진짜로
    // 끊긴 모듈이 조용히 살아난다.
    if (s.path === 'scripts/check-wiring.mjs') continue;
    if (re.test(s.text)) { consumers++; continue; }
    if (isBarrel && dirname(s.path) === ownDir && sameDirRe.test(s.text)) consumers++;
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

// ── 회차가 왜 실패했는지 **한 곳에서만** 정하는가 ──
//
// 위 두 규칙은 판정을 부르는지, 그 결과가 사람에게 닿는지를 본다.
// 이 규칙은 그 다음이다 — **같은 판정을 두 곳에서 하지 않는가.**
//
// 무엇이 있었나
// ─────────────
// 무인 회차의 실패 원인은 `scripts/claude-exec-category.mjs`가 범주로
// 정한다. 그런데 같은 워크플로의 `실패 원인 기록` 단계가 그 아래에서
// **스스로 원인을 또 추측**했다:
//
//   echo "인증 단계에서 멈췄다면 시크릿이 없는 것입니다."
//
// 회차 41264530329(main `4f6ee8c6`)은 진단기가 `credit_or_billing`으로
// 분류했는데 그 줄은 인증을 가리켰다. 갈릴 수 있는 것이 아니라 **갈렸다.**
// 상습 고장 ② "경로가 둘인데 한쪽만 고침"이다.
//
// 이 규칙은 그 두 번째 경로가 돌아오는 것을 막는다. 처방을 YAML에 적지
// 말고 표에 올린다 — 그래야 범주와 처방이 같이 움직인다.
const HOURLY = [
  '.github/workflows/claude-hourly-dev.yml',
  '.github/workflows/claude-hourly-trading.yml',
];
// `"…에서 멈췄다면 …입니다"` 모양. 조건부 원인 추측의 서명이다.
const CAUSE_GUESS = /에서 멈췄다면/;
const causeGaps = [];
for (const wf of HOURLY) {
  const text = readFileSync(wf, 'utf8');
  // 진단기가 **항상** 돌아야 한다. 실패한 회차에만 돌면 `cancelled`·
  // `timed_out`으로 끝난 회차에는 범주가 없다.
  if (!/node scripts\/claude-exec-category\.mjs/.test(text)) {
    causeGaps.push(`${wf} — 진단기(claude-exec-category)를 부르지 않습니다`);
  }
  const at = text.indexOf('- name: 실패 원인 기록');
  if (at === -1) {
    // 단계 이름이 바뀌면 아래 검사가 **조용히 통과한다.** 못 찾은 것을
    // 통과로 적지 않는다.
    causeGaps.push(`${wf} — '실패 원인 기록' 단계를 찾지 못했습니다 (이 규칙이 헛돌고 있습니다)`);
    continue;
  }
  const rest = text.slice(at + 1);
  const end = rest.search(/\n {6}- name:/);
  const step = end === -1 ? rest : rest.slice(0, end);
  const firstLine = text.slice(0, at).split('\n').length;
  for (const [i, l] of step.split('\n').entries()) {
    if (CAUSE_GUESS.test(l)) causeGaps.push(`${wf}:${firstLine + i} — ${l.trim()}`);
  }
}

if (causeGaps.length > 0) {
  console.error('\n❌ 실패 원인을 진단기 밖에서 또 정하는 자리:');
  for (const g of causeGaps) console.error(`   · ${g}`);
  console.error('\n   범주는 scripts/claude-exec-category.mjs가 정합니다.');
  console.error('   처방을 YAML에 적지 말고 그 파일의 NEXT_ACTION 표에 올리세요.');
  bad = true;
}

if (bad) process.exit(1);

console.log(`✅ 판정 모듈 ${files.length}개 · 배선 안 된 것 0개`
  + (ALLOW.size > 0 ? ` (면제 ${ALLOW.size}개)` : ''));
console.log(`✅ 청산 감시 200 응답 ${evidenceSeen.length}개 전부 워커 생존 증거를 싣는다`);
console.log(`✅ 무인 회차 워크플로 ${HOURLY.length}개 전부 실패 원인을 진단기 한 곳에서만 정한다`);
