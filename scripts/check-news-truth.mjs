#!/usr/bin/env node
// 뉴스 분석이 **관측한 것만** 말하는가.
//
// 이 검사기가 지키는 것
// ────────────────────
// 뉴스 분석 경로가 둘이었다. 크론이 원문만 근거로 분석해 news_articles에
// 저장하는 정본과, 화면을 열 때마다 브라우저가 만들던 두 번째 경로.
//
// 두 번째 경로는 OpenAI 호출이 실패하거나 키가 없으면 mockAnalyze()로
// 값을 채웠다. 그 값은 관측이 아니라 키워드 개수와 id 해시로 만든 것이다:
//
//     confidence = 50 + diff*8 + min(15, signals*2) + (hash(id) % 11 - 5)
//
// 그렇게 만든 confidence가 영향도 점수에 들어가 브라우저 알림 문턱을
// 넘겼고, 결과는 sessionStorage에 24시간 저장됐다. 캐시에서 다시 읽을 때
// source가 'cache'로 덮여 **지어낸 값이라는 표시까지 사라졌다.**
//
// 그래서 여기서 막는 것이 넷이다:
//
//   ① 지어낸 분석이 production으로 돌아오는 것
//   ② 관측하지 못한 값을 숫자로 만드는 것 (confidence → 0, ?? 50)
//   ③ 관측하지 못한 값으로 사람을 깨우는 것 (알림)
//   ④ 모델이 스스로 매긴 값을 확률처럼 %로 그리는 것
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsComments } from './lib/strip-comments.mjs';

const SCHEMA  = 'src/lib/news/schema.ts';
const SOURCES = 'src/lib/news/sources.ts';
const MATCHER = 'src/lib/news/matcher.ts';
const VERDICT = 'src/components/news/AiVerdict.tsx';
const NEWSPG  = 'src/components/pages/NewsPage.tsx';
const NEWSAPI = 'src/app/api/news/route.ts';
const FIXTURE = 'src/lib/news/__fixtures__/mockAnalyzer.ts';

let bad = 0;
const err = m => { console.error(`❌ ${m}`); bad++; };
const read = f => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const code = f => stripJsComments(read(f));

/** src 아래 모든 소스 파일 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}
const ALL = existsSync('src') ? walk('src') : [];
/** 시험도 fixture도 아닌 파일 = production */
const isProduction = f => !/\.test\.tsx?$/.test(f) && !f.includes('__fixtures__');

/* ── ① 지어낸 분석이 production으로 돌아오지 않는다 ── */
if (!existsSync(FIXTURE)) {
  err(`${FIXTURE}: 격리된 fixture가 없습니다 — 옮기지 않고 지웠거나 경로가 다릅니다`);
}
for (const f of ALL) {
  if (!isProduction(f)) continue;
  const src = code(f);
  // **import 문만 보지 않는다.** 경로 문자열로 부르는 동적 import도 막는다.
  if (/mockAnalyz/i.test(src)) {
    err(`${f}: mockAnalyze를 참조합니다 — 지어낸 분석은 production에 들어오지 않습니다`);
  }
  if (/__fixtures__/.test(src)) {
    err(`${f}: 시험 fixture를 참조합니다 — production 코드가 fixture에 기대면 안 됩니다`);
  }
}
// 없앤 두 경로가 되살아나지 않았는가
for (const gone of ['src/lib/news/analyzer.ts', 'src/app/api/news/analyze/route.ts']) {
  if (existsSync(gone)) {
    err(`${gone}: 두 번째 분석 경로가 다시 생겼습니다 — 정본은 analyzeOne/news_articles 하나입니다`);
  }
}
for (const f of ALL) {
  if (!isProduction(f)) continue;
  if (/['"`]\/api\/news\/analyze/.test(code(f))) {
    err(`${f}: /api/news/analyze를 부릅니다 — 화면에서 AI를 부르지 않습니다`);
  }
}

/* ── ② 관측하지 못한 값을 숫자로 만들지 않는다 ── */
{
  const s = code(SCHEMA);
  if (!s) err(`${SCHEMA}: 분석 검증 정본이 없습니다`);
  // 타입이 null을 허용해야 아래 규칙이 의미가 있다
  if (!/confidence:\s*number\s*\|\s*null/.test(s)) {
    err(`${SCHEMA}: confidence가 null을 허용하지 않습니다 — 없는 값을 숫자로 만들게 됩니다`);
  }
  // **문자열이 아니라 대입을 본다.** 문구만 바꾸고 0을 넣으면 통과하면 안 된다.
  if (/confidence\s*==?=?\s*null[\s\S]{0,120}?confidence\s*=\s*\d/.test(s)) {
    err(`${SCHEMA}: confidence가 없을 때 숫자를 대입합니다 — null로 남기세요`);
  }
  if (/parseConfidence\([\s\S]{0,80}?\)\s*\?\?\s*\d/.test(s)) {
    err(`${SCHEMA}: parseConfidence 결과에 기본 숫자를 붙입니다`);
  }
}
{
  const s = code(SOURCES);
  if (/confidence\s*\?\?\s*\d/.test(s)) {
    err(`${SOURCES}: confidence가 없을 때 숫자를 가정합니다 — 그 값이 알림 문턱을 넘깁니다`);
  }
  if (!/confidence\?:\s*number\s*\|\s*null/.test(s)) {
    err(`${SOURCES}: 영향도 입력의 confidence가 null을 허용하지 않습니다`);
  }
}

/* ── ③ 관측하지 못한 값으로 사람을 깨우지 않는다 ── */
{
  const s = code(MATCHER);
  if (/from\s+'\.\/types'/.test(s)) {
    err(`${MATCHER}: legacy 분석 타입을 다시 씁니다 — 정본 모양 하나만 받습니다`);
  }
  const m = /const shouldNotify\s*=([\s\S]{0,400}?);/.exec(s);
  if (!m) err(`${MATCHER}: 알림 조건을 찾지 못했습니다`);
  else {
    const cond = m[1];
    if (!/observedDirection/.test(cond)) {
      err(`${MATCHER}: 알림이 '방향을 실제로 말했는가'를 보지 않습니다 — 판단 보류로 사람을 깨웁니다`);
    }
    if (!/observedConfidence/.test(cond)) {
      err(`${MATCHER}: 알림이 '확신도를 관측했는가'를 보지 않습니다`
        + ' — 출처 신뢰도와 최신성만으로 60점을 넘길 수 있습니다');
    }
    if (!/hasSeen\(/.test(cond)) err(`${MATCHER}: 이미 본 뉴스를 다시 알립니다`);
  }
  // 관측 여부가 **실제 값 검사**여야 한다. 상수 true면 조건이 죽은 것이다.
  if (!/const observedConfidence\s*=\s*typeof analysis\.confidence === 'number'/.test(s)) {
    err(`${MATCHER}: 확신도 관측 여부가 실제 값 검사가 아닙니다`);
  }
  if (!/const observedDirection\s*=\s*prediction === 'up'\s*\|\|\s*prediction === 'down'/.test(s)) {
    err(`${MATCHER}: 방향 관측 여부가 실제 값 검사가 아닙니다`);
  }
}

/* ── ④ 모델이 스스로 매긴 값을 확률처럼 그리지 않는다 ── */
for (const [f, label] of [[VERDICT, 'AI 판정 띠'], [NEWSPG, '뉴스 화면']]) {
  const s = code(f);
  if (!s) { err(`${f}: 파일이 없습니다`); continue; }
  if (/confidence\s*\}\s*%/.test(s) || /신뢰도\s*\{/.test(s)) {
    err(`${f}: ${label}이 확신도를 %로 그립니다 — 모델이 스스로 매긴 값은 확률이 아닙니다`);
  }
}

/* ── ⑤ 예시 뉴스가 분석·알림으로 흘러가지 않는다 ── */
{
  const s = code(NEWSPG);
  if (!/provenanceOf\(/.test(s)) {
    err(`${NEWSPG}: 목록의 출처를 읽지 않습니다 — 예시 기사를 실물처럼 다룹니다`);
  }
  const m = /useEffect\(\(\) => \{([\s\S]{0,900}?)batchMatchNews/.exec(s);
  if (!m) err(`${NEWSPG}: 알림 경로를 찾지 못했습니다`);
  else if (!/provenance !== 'LIVE'/.test(m[1])) {
    err(`${NEWSPG}: 알림이 예시(SAMPLE) 목록에서도 나갑니다`);
  }
}
{
  const s = code(NEWSAPI);
  // 응답마다 출처를 붙인다. 안 붙이면 받는 쪽이 판정할 값 자체가 없다.
  const returns = s.match(/NextResponse\.json\(\{[\s\S]{0,300}?\}/g) || [];
  for (const r of returns) {
    if (/\bnews:/.test(r) && !/\bsource:/.test(r)) {
      err(`${NEWSAPI}: 뉴스를 돌려주면서 출처를 붙이지 않는 응답이 있습니다`);
    }
  }
}

console.log(bad === 0
  ? '✅ 뉴스 분석 — 정본 하나 · 지어낸 값 없음 · 관측한 것으로만 알림'
  : '\n분석이 관측하지 않은 값을 만들거나, 그 값으로 사람을 깨우고 있습니다.');
process.exit(bad === 0 ? 0 : 1);
