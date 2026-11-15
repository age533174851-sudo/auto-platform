#!/usr/bin/env node
// scripts/check-paper-multi-bot.mjs
//
// **봇 이름 규칙이 앱과 DB 두 곳에 있다. 갈리면 안 된다.**
//
// 앱(`parsePaperAutomationControl`)이 통과시킨 이름을 DB가 거부하면 봇이
// 조용히 안 켜진다 — 화면은 "켰다"고 적고 러너는 그 봇을 못 본다. 반대로
// DB가 받는 것을 앱이 막으면 쓸 수 있는 이름을 못 쓴다.
//
// 시험으로는 못 잡는다. `run-tests.mjs`는 임시 디렉터리에서 돌아
// `supabase/migrations`를 읽을 수 없다(paperChallenge.test.ts가 같은 이유를
// 적어 뒀다). 그래서 저장소 루트에서 도는 이 검사기가 센다.
//
// 그리고 다중화의 **핵심 한 줄**도 함께 본다 — 099의 사용자 단위 유일
// 인덱스를 지우지 않으면, 봇 하나가 도는 동안 나머지가 영원히 막힌다.
import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

const MIG = 'supabase/migrations/102_paper_multi_bot.sql';
const APP = 'src/lib/engine/paperAutomation.ts';
const ROUTE = 'src/app/api/paper/automation/route.ts';

let bad = 0;
const fail = (m) => { console.error(`❌ ${m}`); bad++; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};

const sql = read(MIG);
// **주석을 지운 뒤에 본다.**
//
// 주석에도 코드와 같은 문자열이 적혀 있으면, 코드에서 그 줄을 지워도
// 규칙이 계속 만족된다 — 실제로 `bots.error`를 설명하는 주석 때문에
// `bots.error` 가드를 지운 변이가 안 잡혔다. 주석으로 만족되는 검사기는
// 검사기가 아니다. 규칙 하나를 고치는 대신 그 종류를 없앤다.
const app = stripJsComments(read(APP));
const route = stripJsComments(read(ROUTE));

// ── ① 봇 이름 규칙이 같은가 ──
const dbRe = /CHECK \(bot_id ~ '([^']+)'\)/.exec(sql);
const appRe = /export const PAPER_BOT_ID = \/([^/]+)\/;/.exec(app);
if (!dbRe) fail(`${MIG}: bot_id CHECK를 찾지 못했습니다`);
if (!appRe) fail(`${APP}: PAPER_BOT_ID를 찾지 못했습니다`);
if (dbRe && appRe && dbRe[1] !== appRe[1]) {
  fail(`봇 이름 규칙이 다릅니다 — DB \`${dbRe[1]}\` · 앱 \`${appRe[1]}\``
    + ' (앱이 통과시킨 이름을 DB가 거부하면 봇이 조용히 안 켜집니다)');
}

// ── ② 사용자 단위 유일 인덱스를 지웠는가 ──
if (sql && !/DROP INDEX IF EXISTS public\.paper_automation_one_claim;/.test(sql)) {
  fail(`${MIG}: 099의 사용자 단위 유일 인덱스를 지우지 않았습니다`
    + ' — 봇 하나가 도는 동안 나머지가 영원히 막힙니다');
}
if (sql && !/CREATE UNIQUE INDEX IF NOT EXISTS paper_automation_one_claim_bot[\s\S]{0,160}\(user_id, ?bot_id\)/.test(sql)) {
  fail(`${MIG}: 봇 단위 유일 인덱스가 없습니다 — 같은 봇이 회차를 둘 잡을 수 있습니다`);
}

// ── ③ 기본 봇 이름이 옛 봇과 같은가 ──
//
// 다르면 예전 화면이 보내던 요청이 새 봇을 만들고, 지금 돌던 봇은 멈춘
// 것처럼 보인다. 운영에서 돌고 있는 봇이 그 이름이다.
const appDefault = /export const DEFAULT_PAPER_BOT = '([^']+)';/.exec(app);
if (!appDefault) fail(`${APP}: DEFAULT_PAPER_BOT을 찾지 못했습니다`);
else if (appDefault[1] !== 'paper-auto-v1') {
  fail(`${APP}: 기본 봇이 'paper-auto-v1'이 아닙니다(${appDefault[1]})`
    + ' — 운영에서 돌고 있는 봇의 이름이어야 합니다');
}
if (sql && !/DEFAULT 'paper-auto-v1'/.test(sql)) {
  fail(`${MIG}: bot_id 기본값이 'paper-auto-v1'이 아닙니다 — 기존 행이 다른 봇이 됩니다`);
}

// ── ④ 화면이 봇 하나에만 묶여 있지 않은가 ──
//
// 설정 조회가 `maybeSingle()`인데 봇으로 좁히지 않으면, 두 번째 봇이
// 생기는 순간 "여러 행" 오류로 화면 전체가 503이 된다.
if (route && /paper_automation_settings[\s\S]{0,400}?maybeSingle\(\)/.test(route)
    && !/paper_automation_settings[\s\S]{0,400}?bot_id[\s\S]{0,200}?maybeSingle\(\)/.test(route)) {
  fail(`${ROUTE}: 설정을 maybeSingle()로 읽으면서 봇을 가리지 않습니다`
    + ' — 두 번째 봇이 생기면 여러 행 오류로 화면이 죽습니다');
}
// 체결 이력이 옛 봇에만 묶여 있으면 새 봇의 거래가 화면에도 점수판에도 안 잡힌다.
if (route && /\.eq\('strategy_id','paper-auto-v1'\)/.test(route)) {
  fail(`${ROUTE}: 체결 이력을 'paper-auto-v1'로만 거릅니다`
    + ' — 새 봇이 낸 거래가 보이지 않습니다');
}

// ── ⑤ 봇마다 다른 전략으로 도는가 ──
//
// 이 저장소에서 가장 자주 나는 고장이 **만들어 놓고 배선을 안 함**이다.
// `entrySignals.ts`에 역추세·돌파가 있어도 러너가 그것을 안 고르면
// 봇을 몇 개 만들든 전부 같은 전략으로 돈다 — 그러면 비교할 것이 없다.
if (app && !/signal\s*:\s*bot\.signal/.test(app)) {
  fail(`${APP}: planEntry에 봇의 전략을 넘기지 않습니다`
    + ' — 봇을 여러 개 만들어도 전부 같은 전략으로 돕니다');
}
// 관측값을 안 넘기면 역추세·돌파는 방향을 내지 못하고 영원히 쉰다.
if (app && !/view\s*:\s*verdict\.regime\?\.dataOk/.test(app)) {
  fail(`${APP}: planEntry에 국면 관측값(view)을 넘기지 않습니다`
    + ' — 역추세·돌파가 재료 없이 영원히 쉽니다');
}
// 모르는 전략을 기본값으로 돌리면 그 체결이 그 봇의 성적표에 적힌다.
if (app && !/SIGNAL_UNKNOWN/.test(app)) {
  fail(`${APP}: 저장된 전략 이름이 모르는 값일 때 회차를 멈추지 않습니다`
    + ' — 기본 전략으로 돌면 그 체결이 다른 봇의 기록이 됩니다');
}
// 시간 청산은 이 러너만 본다. 기본 봇으로 묶여 있으면 새 봇은 영원히 못 받는다.
if (app && /strategy_id === 'paper-auto-v1'/.test(app)) {
  fail(`${APP}: 자기 포지션을 'paper-auto-v1'로 거릅니다`
    + ' — 새 봇의 포지션이 시간 청산을 영원히 못 받습니다');
}
// 저장하지 않으면 다음 회차에 전략이 사라진다.
// 축약 표기(`signal`)도 저장이다. 콜론만 찾으면 멀쩡한 코드를 오탐한다.
if (route && !/p_config\s*:\s*\{[^}]*\bsignal\b/.test(route)) {
  fail(`${ROUTE}: 전략을 config에 저장하지 않습니다 — 다음 회차에 사라집니다`);
}
// 화면이 따로 해석하면 러너와 다른 답을 낼 수 있다 — 같은 함수를 쓴다.
if (route && /config[\s\S]{0,40}\.signal/.test(route) && !/readBotSignal/.test(route)) {
  fail(`${ROUTE}: config.signal을 직접 해석합니다`
    + ' — 러너와 같은 readBotSignal을 써야 판정이 갈리지 않습니다');
}

// ── ⑥ 전략을 안 적은 요청이 봇의 전략을 되돌리지 않는가 ──
//
// `paper_auto_control`의 `ON CONFLICT`는 `config=p_config`로 config를
// **통째로 교체**한다. 그래서 요청에 전략이 없을 때 기본값을 채워 보내면,
// 전략을 안 보내는 옛 화면이 봇을 다시 켤 때마다 그 봇이 조용히 추세
// 추종으로 바뀐다 — 이름은 그대로인 채 한 strategy_id 아래 두 전략의
// 기록이 섞이고, 봇을 나눈 이유가 그때 사라진다.
if (app && !/signal:\s*EntrySignalId\s*\|\s*null/.test(app)) {
  fail(`${APP}: 요청의 전략이 "안 적음"과 "추세 추종"을 구분하지 않습니다`
    + ' — 구분하지 않으면 옛 화면이 켤 때마다 봇의 전략이 되돌아갑니다');
}
if (route && !/paper_automation_settings[\s\S]{0,200}?select\('config'\)/.test(route)) {
  fail(`${ROUTE}: 전략을 안 적은 요청에서 이미 저장된 전략을 읽지 않습니다`
    + ' — RPC가 config를 통째로 교체하므로 그 봇의 전략이 기본값으로 되돌아갑니다');
}
// `[]`는 미지정이 아니다. String([])가 빈 문자열이라 느슨하게 보면 통과한다.
if (app && !/function signalOmitted/.test(app)) {
  fail(`${APP}: "안 적음" 판정이 한 곳에 없습니다`
    + " — String([])가 빈 문자열이라 signal:[] 같은 잘못된 값이 미지정으로 샙니다");
}

// ── ⑦ 봇 목록을 못 읽은 것을 "봇 없음"으로 적지 않는가 ──
//
// `bots.error`를 보지 않으면 `bots.data`가 null이 되고, 포지션 질의가
// 기본 봇으로만 좁혀져 **다른 봇의 거래가 조용히 사라진다.** 오류도 안 난다.
if (route && !/bots\.error/.test(route)) {
  fail(`${ROUTE}: bots 질의 오류를 보지 않습니다`
    + ' — 목록을 못 읽으면 다른 봇의 거래가 조용히 사라집니다(없음으로 적힙니다)');
}

if (bad > 0) {
  console.error(`\n모의 봇 다중화 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log('✅ 모의 봇 다중화 — 이름 규칙 일치 · 봇 단위 유일 인덱스 · 기본 봇 보존 · 화면 배선 · 봇별 전략 배선 · 전략 되돌림 방지 · 목록 실패 fail-closed');
