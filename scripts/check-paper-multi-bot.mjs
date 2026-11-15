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
const app = read(APP);
const route = read(ROUTE);

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

if (bad > 0) {
  console.error(`\n모의 봇 다중화 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log('✅ 모의 봇 다중화 — 이름 규칙 일치 · 봇 단위 유일 인덱스 · 기본 봇 보존 · 화면 배선');
