#!/usr/bin/env node
// scripts/check-fabricated-data.mjs
//
// **화면이 지어낸 값을 사실처럼 보여주고 있었다.**
//
// 매매일지에 이런 상자가 붙었다:
//
//   ┌──────────────────────────────┐
//   │ AI 리뷰                      │
//   │ 손절 규칙을 잘 지켰습니다.   │
//   └──────────────────────────────┘
//
// 그 문장은 고정 목록 여덟 개 중 하나를 난수로 고른 것이었고, 사용자가
// 입력한 종목·방향·가격·손익 중 **어느 것도 보지 않았다.** 손절을 놓쳐
// 크게 잃은 거래에 "손절 규칙을 잘 지켰습니다"가 뜰 수 있었다.
//
// 조언처럼 생겼고, 개인화된 것처럼 보이고, 내용은 무작위다. 그리고
// **사람이 그걸 근거로 다음 거래를 바꾼다.**
//
// 무엇을 막고 무엇을 막지 않나
// ────────────────────────────
// 난수 자체가 나쁜 게 아니다. id를 만들거나 몬테카를로를 돌리는 데는
// 필요하다. 막는 것은 **사용자에게 보여줄 값을 난수로 만드는 것**이다.
//
// 그래서 화면 파일(`src/components/**`)의 `Math.random()`만 본다.
// 정당한 쓰임은 이유와 함께 적어 둔다 — 목록이 길어지면 그때 다시 본다.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'src/components';

/**
 * 난수를 써도 되는 곳. **왜 괜찮은지를 같이 적는다.**
 *
 * 여기 새로 추가할 때는 "사용자에게 보여줄 값인가"를 먼저 묻는다.
 * 값이면 안 된다.
 */
const ALLOW = {
  'src/components/StrategyProfilesPanel.tsx':
    '몬테카를로 시뮬레이터다. 화면에도 시뮬이라고 적혀 있고 PaperTradingPage에만 붙는다',
  'src/components/MockAutoTrade.tsx':
    '모의 자동매매다. 거래소에 닿지 않고 이름부터 Mock이다',
  'src/components/pages/ChartTab.tsx':
    'TradingView 위젯 컨테이너 id를 만든다 — 보여주는 값이 아니다',
  'src/components/pages/AnalysisHubPage.tsx':
    '드로잉 객체 id를 만든다 — 보여주는 값이 아니다',
  'src/components/pages/JournalReviewPage.tsx':
    '기록에 id가 없을 때 임시 키를 만든다 — 보여주는 값이 아니다',
};

/**
 * 주석을 걷어낸다. **줄 번호는 유지한다.**
 *
 * 줄 단위로 `//`만 보면 JSX 블록 주석을 못 본다 —
 * `{/* 예전에는 Math.random()으로 그렸다 * /}` 같은 줄이 실제 코드로
 * 잡히고, 그러면 **고쳤다는 기록을 남긴 것이 벌을 받는다.** 검사가
 * 틀리면 사람들은 검사를 끈다.
 *
 * `migrationPlan.ts`의 `stripNoise()`와 같은 이유로 같은 일을 한다.
 */
function stripComments(src) {
  // 블록 주석: 내용만 지우고 줄바꿈은 남긴다.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  // 줄 주석
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  return out;
}

function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

const files = walk(ROOT);
const problems = [];
let scanned = 0;
const used = new Set();

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  scanned++;
  // **주석은 코드가 아니다.** "예전에는 Math.random()으로 그렸다"는
  // 고쳤다는 기록이고, 그걸 벌하면 사람들이 기록을 안 남긴다.
  const code = stripComments(raw).split('\n');
  const shown = raw.split('\n');
  code.forEach((line, i) => {
    if (!line.includes('Math.random()')) return;
    if (ALLOW[f]) { used.add(f); return; }
    problems.push({ f, n: i + 1, line: (shown[i] || '').trim() });
  });
}

// 이제 안 쓰는 면제가 남아 있으면 검사가 헐거워진다.
const stale = Object.keys(ALLOW).filter(k => !used.has(k));

if (problems.length > 0) {
  console.error('❌ 화면이 보여줄 값을 난수로 만들고 있습니다\n');
  for (const p of problems) {
    console.error(`  ${p.f}:${p.n}`);
    console.error(`    ${p.line.slice(0, 110)}\n`);
  }
  console.error('왜 막는가');
  console.error('  매매일지가 고정 문장 여덟 개 중 하나를 난수로 골라 "AI 리뷰"라고 붙였습니다.');
  console.error('  사용자가 입력한 값 중 아무것도 보지 않았고, 손절을 놓친 거래에');
  console.error('  "손절 규칙을 잘 지켰습니다"가 뜰 수 있었습니다.');
  console.error('\n어떻게 고치나');
  console.error('  입력·조회한 값에서 실제로 따라 나오는 것만 적으십시오 (예: journalNoteOf).');
  console.error('  모르면 모른다고 적으십시오 — 지어낸 문장보다 낫습니다.');
  console.error('  id 생성이나 시뮬레이터라면 이 파일의 ALLOW에 이유와 함께 적으십시오.');
  process.exit(1);
}

if (stale.length > 0) {
  console.error('❌ 면제 목록에 이제 필요 없는 항목이 있습니다 — 면제가 쌓이면 검사가 헐거워집니다\n');
  for (const s of stale) console.error(`  ${s}`);
  process.exit(1);
}

console.log(`✅ 화면 파일 ${scanned}개 · 지어낸 값 0건 (사유 기록된 면제 ${Object.keys(ALLOW).length}개)`);
