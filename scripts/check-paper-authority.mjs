#!/usr/bin/env node
// scripts/check-paper-authority.mjs
//
// **"거래 가능한 모의투자"가 서버 장부 하나만 쓰는지 배선으로 확인한다.**
//
// 무엇이 있었나
// ─────────────
// "모의투자"라고 적힌 화면이 셋인데 장부가 서로 달랐다:
//
//   서버 `paper_accounts`/`paper_positions`   ← 정본 (PR2~PR4 · 챌린지)
//   localStorage `tg_paper_account_v1`        ← `/` 모의 탭
//   localStorage `tg_paper_balance_v1`        ← `/` 매매 탭
//
// 사용자는 어느 화면에 들어갔는지에 따라 다른 잔고로 연습했고, 챌린지는
// 서버 장부에만 있으므로 옛 화면에서는 한 칸도 움직이지 않았다.
//
// 시험으로는 부족하다
// ───────────────────
// 시험은 **지금 있는 호출부**만 본다. 누군가 화면 한 곳에서 `paperBuy`를
// 다시 부르면 시험은 전부 초록인 채로 장부가 다시 셋이 된다. 그래서
// **코드의 모양**으로 막는다.
//
// 무엇을 보는가
// ─────────────
//   ① 옛 장부의 **쓰기** 호출이 전부 거래 가능 여부 뒤에 있다
//   ② 옛 장부를 서버로 **옮기거나 합치는** 함수가 없다
//   ③ 화면이 요청에 **계좌 id를 싣지 않는다** (challengeId만)
//   ④ 챌린지를 못 찾았을 때 기본 계좌로 내려가는 폴백이 없다
//   ⑤ 미지원 기능이 실행 가능한 것처럼 열려 있지 않다
//   ⑥ 호가 판단이 두 벌로 갈라져 있지 않다
//   ⑦ 두 legacy 목록이 겹치지 않는다
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** src 아래 .ts/.tsx 전부 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = walk('src');

// ══ ① 옛 장부 쓰기는 전부 관문 뒤에 있다 ══
//
// **이름으로 찾지 않는다.** `closePaperPosition`은 옛 로컬 장부에도 있고
// 서버 정본(`lib/engine/paperStore.ts`)에도 있다 — 이름만 보면 정본 청산
// 경로가 전부 걸린다(처음에 실제로 그랬다). 그래서 **어디서 가져왔는가**로
// 가른다.
//
// 읽기(`loadPaperBalance`·`getOpenPositions`·`calcMetrics`)는 그대로 둔다 —
// 지우지 않고 읽기만 한다는 것이 계약이다.
const LEGACY_MODULES = ['@/lib/autotrade/store', '@/lib/paper/engine'];
const LEGACY_WRITES = [
  'paperBuy', 'paperSell', 'closePaperPosition', 'reversePaperPosition',
  'savePaperBalance', 'resetPaperBalance', 'placeOrder', 'resetAccount',
];
const LEGACY_OWNERS = [
  'src/components/pages/TradingPage.tsx',
  'src/components/pages/PaperTradingPage.tsx',
];
for (const f of FILES) {
  const raw = read(f);
  const body = code(raw);

  // 이 파일이 옛 장부 모듈에서 가져온 이름들
  const imported = new Set();
  for (const mod of LEGACY_MODULES) {
    const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${mod.replace(/[/@]/g, m => '\\' + m)}'`, 'g');
    for (const m of raw.matchAll(re)) {
      for (const n of m[1].split(',')) {
        const name = n.replace(/\s+as\s+\w+/, '').trim();
        if (name) imported.add(name);
      }
    }
  }
  const writes = LEGACY_WRITES.filter(w => imported.has(w) && new RegExp(`\\b${w}\\(`).test(body));
  if (!writes.length) continue;

  if (!LEGACY_OWNERS.includes(f)) {
    err(`${f}가 옛 로컬 장부에 씁니다 (${writes.join(' · ')})`
      + ' — 거래 가능한 모의투자는 서버 장부 하나뿐입니다');
    continue;
  }
  if (!/isTradableLedger\(/.test(body)) {
    err(`${f}가 옛 장부에 쓰면서 거래 가능 여부를 확인하지 않습니다`);
  }
}

// ══ ② 옮기거나 합치는 함수가 없다 ══
{
  const legacy = read('src/lib/trading/legacyLedger.ts');
  for (const m of code(legacy).matchAll(/export (?:function|const) ([A-Za-z_]+)/g)) {
    if (/migrate|merge|transfer|adopt|copyTo|importTo/i.test(m[1])) {
      err(`legacyLedger에 이전·병합 함수가 생겼습니다: ${m[1]}`
        + ' — 옮기면 없던 돈이 생깁니다');
    }
  }
  for (const k of ['migrate: false', 'merge: false', 'erase: false']) {
    if (!legacy.includes(k)) err(`legacyLedger의 정책에서 ${k}가 사라졌습니다`);
  }
}

// ══ ③ 화면이 계좌 id를 싣지 않는다 ══
for (const f of FILES) {
  if (!/^src\/(components|app)\//.test(f)) continue;
  const body = code(read(f));
  // 요청 본문에 계좌 id를 넣는 자리
  if (/(paperAccountId|paper_account_id)\s*:/.test(body) && !/route\.ts$/.test(f)) {
    err(`${f}가 요청에 계좌 id를 싣습니다 — 장부는 challengeId로만 가리킵니다`);
  }
}
// 선택값 자체에도 계좌 칸이 없어야 한다
{
  const t = code(read('src/lib/trading/paperTarget.ts'));
  if (/paperAccountId|accountId/.test(t)) {
    err('paperTarget이 계좌 id를 들고 다닙니다 — 화면에 노출되면 되보내집니다');
  }
  if (!/kind: PaperTargetKind;\s*\n\s*\/\*\*[\s\S]*?\*\/\s*\n\s*challengeId: string \| null;/.test(read('src/lib/trading/paperTarget.ts'))) {
    err('paperTarget의 칸이 kind·challengeId 둘이 아닙니다');
  }
}

// ══ ④ 챌린지 폴백 금지 ══
for (const f of FILES) {
  const body = code(read(f));
  if (!/challengeId|ChallengeScope/.test(body)) continue;
  if (/challengeScopeFailed\([^)]*\)\s*\?\s*[^:]*resolvePaperScope/.test(body)
      || /resolveChallengeScope\([^)]*\)\s*\|\|/.test(body)
      || /catch\s*\{[^}]*selectDefault\(\)/.test(body)) {
    err(`${f}에 챌린지 실패 시 기본 계좌로 내려가는 폴백이 있습니다`);
  }
}

// ══ ⑤ 미지원 기능이 열려 있지 않다 ══
{
  const cap = code(read('src/lib/trading/capability.ts'));
  // 서버가 못 하는 것을 지원으로 적지 않았는가
  for (const f of ['TYPE_LIMIT', 'PRICE_INPUT', 'REDUCE_ONLY', 'PARTIAL_CLOSE']) {
    const re = new RegExp(`case '${f}':[\\s\\S]{0,400}?return (yes|no)\\(`);
    const m = re.exec(cap);
    if (!m) err(`capability에서 ${f}를 찾지 못했습니다`);
    else if (m[1] === 'yes') err(`capability가 ${f}를 지원으로 적었습니다 — 서버에 그 경로가 없습니다`);
  }
  // 주문 가능 상태가 하나뿐인가
  if (!/state: 'WIRED', canOrder: true/.test(cap)) err('capability에 주문 가능 상태가 없습니다');
  if (/'SERVER_READY_UI_PENDING', canOrder: true/.test(cap)) {
    err('capability가 화면 없는 시장을 주문 가능으로 적었습니다');
  }
  // 배선 판정을 손으로 적지 않았는가 —
  // PR5에서 선물을 "화면 없음"이라고 손으로 적었다가 틀렸다. 문자열 검색으로
  // 배선을 판단했기 때문이다. 이제 라우팅 정본에게 물어봐야 한다.
  if (!/orderEndpointFor\('PAPER', market\)/.test(cap)) {
    err('capability가 배선 여부를 라우팅 정본(orderEndpointFor)에 묻지 않습니다');
  }
  if (!/endpoint !== PAPER_ORDER_ENDPOINT/.test(cap)) {
    err('capability가 라우트 불일치를 주문 불가로 닫지 않습니다');
  }
  // 대기 주문 탭에 가짜 백엔드를 붙이지 않았는가
  if (!/case 'ORDERS':[\s\S]{0,300}?return no\(/.test(cap)) {
    err('capability가 주문 탭에 정본 백엔드가 있다고 적었습니다 — 대기 주문 표가 없습니다');
  }
}

// ══ ⑥ 호가 판단이 한 벌이다 ══
{
  const shared = 'src/lib/trading/orderBook.ts';
  if (!read(shared)) err('공용 호가 판단 모듈이 없습니다');
  const users = ['src/components/trading/OrderBookView.tsx', 'src/components/pages/TradingPage.tsx'];
  for (const f of users) {
    if (!/orderBookLadder\(/.test(code(read(f)))) {
      err(`${f}가 공용 호가 판단을 쓰지 않습니다 — 두 화면이 갈립니다`);
    }
  }
  // 각자 다시 자르고 뒤집던 자리가 되살아나지 않았는가
  for (const f of users) {
    const body = code(read(f));
    if (/\.asks\.slice\([^)]*\)\.reverse\(\)/.test(body) || /stream\.bids\.slice\(/.test(body)) {
      err(`${f}가 호가를 다시 자릅니다 — 판단은 orderBook 한 곳입니다`);
    }
  }
}

// ══ ⑦ 두 legacy 목록이 겹치지 않는다 ══
{
  const a = [...code(read('src/lib/portfolio/legacyPaper.ts'))
    .matchAll(/'(tg_[a-z0-9_]+)'/g)].map(m => m[1]);
  const b = [...code(read('src/lib/trading/legacyLedger.ts'))
    .matchAll(/storageKey: '(tg_[a-z0-9_]+)'/g)].map(m => m[1]);
  if (!a.length || !b.length) err('legacy 키 목록을 읽지 못했습니다');
  const dup = a.filter(k => b.includes(k));
  if (dup.length) err(`두 legacy 모듈이 같은 키를 다룹니다 (${dup.join(', ')}) — 판단이 둘이 됩니다`);
}

if (bad > 0) {
  console.error(`\n모의 장부 권위 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 모의 장부 권위 — 옛 장부 쓰기 차단 · 이전·병합 함수 없음 ·'
  + ' 계좌 id 비노출 · 챌린지 폴백 없음 · 미지원 기능 비활성 · 호가 판단 1벌');
