#!/usr/bin/env node
// scripts/paper-authority-mutations.mjs
//
// **장부 권위 규칙을 하나씩 깨고, 그때 검사가 빨개지는지 본다.**
//
// 이 PR이 없앤 고장은 "모의투자 화면마다 다른 장부"였다. 그런데 그런
// 고장은 조용하다 — 화면은 멀쩡히 돌고, 숫자도 그럴듯하다. 통과하는 검사만
// 보고는 "이 규칙을 아무도 안 지켜본다"를 구별할 수 없다.
//
// 무엇이 빨개져야 통과인가
// ────────────────────────
// 장부 권위 검사기 · 가격 출처 검사기 · 챌린지 배선 검사기 · 시험
// 넷 중 하나라도 실패하면 RED다. 넷을 다 보는 이유: 폴백처럼 **코드의
// 모양**으로만 잡히는 것과, 판정처럼 **값**으로만 잡히는 것이 섞여 있다.
//
// 파일을 고쳤다가 반드시 되돌린다. DB에 닿지 않는다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHECKS = [
  ['장부 권위 검사기', 'scripts/check-paper-authority.mjs'],
  ['가격 출처 검사기', 'scripts/check-paper-price-source.mjs'],
  ['챌린지 배선 검사기', 'scripts/check-paper-challenge-wiring.mjs'],
];

const FILES = [
  'src/lib/trading/paperTarget.ts',
  'src/lib/trading/capability.ts',
  'src/lib/trading/legacyLedger.ts',
  'src/lib/trading/orderBook.ts',
  'src/lib/trading/challengeDisplay.ts',
  'src/lib/engine/paperPriceSource.ts',
  'src/app/api/paper/close/route.ts',
  'src/app/api/paper/order/route.ts',
  'src/components/pages/TradingPage.tsx',
  'src/components/pages/PaperTradingPage.tsx',
  'src/components/terminal/SpotOrderPanel.tsx',
  'src/components/trading/OrderBookView.tsx',
];
const canonical = new Map(FILES.map(f => [f, readFileSync(f, 'utf8')]));
const restore = () => { for (const [f, s] of canonical) writeFileSync(f, s); };

function checkerRed() {
  for (const [name, path] of CHECKS) {
    try { execFileSync(process.execPath, [path], { stdio: 'pipe' }); }
    catch { return `RED (${name})`; }
  }
  return null;
}
function testsGreen() {
  try { execFileSync('npm', ['test'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// ── 무엇을 깨 보는가 ──
const MUTATIONS = [
  // ══ 옛 장부가 거래에 되살아난다 ══
  { name: '매매 탭의 거래 가능 확인을 전부 없앤다',
    file: 'src/components/pages/TradingPage.tsx',
    cut: ['isTradableLedger(PRACTICE_LEDGER)', 'false'], replaceAll: true },
  { name: '모의 탭의 거래 가능 확인을 없앤다',
    file: 'src/components/pages/PaperTradingPage.tsx',
    cut: ['isTradableLedger(LEDGER)', 'false'], replaceAll: true },
  { name: '옛 장부가 거래 가능해진다 — 한 줄로 셋이 다시 갈린다',
    file: 'src/lib/trading/legacyLedger.ts',
    cut: ['export function isTradableLedger(_id: LegacyLedgerId): boolean {\n  return false;\n}',
          'export function isTradableLedger(_id: LegacyLedgerId): boolean {\n  return true;\n}'] },
  { name: '옛 장부를 서버로 옮기는 함수가 생긴다 — 없던 돈이 생긴다',
    file: 'src/lib/trading/legacyLedger.ts',
    cut: ['export function legacyLedgerInfo(',
          'export function migrateLegacyToServer(): void { /* 옮긴다 */ }\nexport function legacyLedgerInfo('] },
  { name: '이전 금지 정책이 사라진다',
    file: 'src/lib/trading/legacyLedger.ts',
    cut: ['  migrate: false,', '  migrate: true,'] },

  // ══ 계좌 id가 화면으로 샌다 ══
  { name: '선택값이 계좌 id를 들고 다닌다 — 되보내는 통로가 생긴다',
    file: 'src/lib/trading/paperTarget.ts',
    cut: ['  challengeId: string | null;\n}', '  challengeId: string | null;\n  paperAccountId?: string;\n}'] },
  { name: '현물 주문이 계좌 id를 싣는다',
    file: 'src/components/terminal/SpotOrderPanel.tsx',
    cut: ['              ...targetRequestFields(paperTarget),',
          '              paperAccountId: (paperTarget as any).challengeId,'] },

  // ══ 챌린지 폴백 ══
  { name: '챌린지를 못 찾으면 기본 계좌로 내려간다',
    file: 'src/lib/trading/paperTarget.ts',
    cut: ['  if (!isChallengeId(raw)) return null;',
          '  if (!isChallengeId(raw)) return selectDefault();'] },

  // ══ 미지원 기능이 열린다 ══
  { name: '지정가를 지원한다고 적는다 — 대기 주문 표가 없는데 버튼이 열린다',
    file: 'src/lib/trading/capability.ts',
    cut: ["      return no('모의 장부에 대기 주문이 없습니다 — 지정가는 아직 지원하지 않습니다');",
          "      return yes('지정가');"] },
  { name: '화면이 체결가를 정할 수 있게 한다',
    file: 'src/lib/trading/capability.ts',
    cut: ["      return no('체결가는 서버가 읽습니다 — 화면이 정하면 성적표가 의미를 잃습니다');",
          "      return yes('가격 입력');"] },
  { name: '라우트가 끊겨도 주문 가능으로 적는다',
    file: 'src/lib/trading/capability.ts',
    cut: ["      state: 'SERVER_READY_UI_PENDING', canOrder: false,",
          "      state: 'SERVER_READY_UI_PENDING', canOrder: true,"] },
  { name: '배선 판정을 라우팅 정본에 묻지 않고 손으로 적는다',
    file: 'src/lib/trading/capability.ts',
    cut: ["  const endpoint = orderEndpointFor('PAPER', market);",
          "  const endpoint = '/api/paper/order';"] },
  { name: '대기 주문 탭에 정본 백엔드가 있다고 적는다 — 가짜 주문 내역이 생긴다',
    file: 'src/lib/trading/capability.ts',
    cut: ["      return no('모의 장부에 대기 주문이 없습니다 — 낼 수 있는 주문은 즉시 체결됩니다');",
          "      return yes('paper_positions');"] },

  // ══ 호가 판단이 다시 두 벌 ══
  { name: '매매 탭이 호가를 다시 자른다 — 두 화면이 갈린다',
    file: 'src/components/pages/TradingPage.tsx',
    cut: ['                  const showAsks = ladder.asks;   // 높은 가격이 위로',
          '                  const showAsks = stream.asks.slice(0, 7).reverse();'] },
  { name: '공용 호가판이 스스로 다시 자른다',
    file: 'src/components/trading/OrderBookView.tsx',
    cut: ['  const { asks, bids, maxQty, mid } = ladder;',
          '  const { maxQty, mid } = ladder;\n  const asks = stream.asks.slice(0, rows).reverse();\n  const bids = stream.bids.slice(0, rows);'] },

  // ══ 가격 출처가 다시 갈린다 ══
  { name: '청산이 포지션의 시장을 안 읽는다 — 현물이 선물 가격으로 닫힌다',
    file: 'src/app/api/paper/close/route.ts',
    cut: ['readPaperMarkPrice(pos.market, String(pos.symbol))',
          "readPaperMarkPrice('USDM', String(pos.symbol))"] },
  { name: '청산이 선물 출처를 직접 부른다',
    file: 'src/app/api/paper/close/route.ts',
    cut: ["  const { readPaperMarkPrice, paperPriceFailed } =\n    await import('@/lib/engine/paperPriceSource');",
          "  const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');\n"
        + "  const { readPaperMarkPrice, paperPriceFailed } =\n    await import('@/lib/engine/paperPriceSource');"] },
  { name: '진입이 현물 출처를 직접 부른다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ["  const { readPaperMarkPrice, paperPriceFailed } =\n    await import('@/lib/engine/paperPriceSource');",
          "  const { fetchSpotPriceMap } = await import('@/lib/markets/pricing');\n"
        + "  const { readPaperMarkPrice, paperPriceFailed } =\n    await import('@/lib/engine/paperPriceSource');"] },
  { name: '두 시장이 같은 출처를 쓴다 — 고장이 그대로 돌아온다',
    file: 'src/lib/engine/paperPriceSource.ts',
    cut: ["  if (market === 'SPOT') return 'BINANCE_SPOT_TICKER';",
          "  if (market === 'SPOT') return 'BINANCE_USDM_MARK';"] },
  { name: '모르는 시장이 선물로 흘러간다',
    file: 'src/lib/engine/paperPriceSource.ts',
    cut: ["  if (v === 'USDM') return 'USDM';\n  return null;",
          "  if (v === 'USDM') return 'USDM';\n  return 'USDM';"] },
  { name: '청산이 모르는 시장을 따로 거부하지 않는다',
    file: 'src/app/api/paper/close/route.ts',
    cut: ["    if (px.code === 'UNSUPPORTED_MARKET') {", '    if (false) {'] },

  // ══ 동결된 사유를 UI가 뒤집는다 ══
  { name: '달성을 잔고로 다시 판단한다 — 달성한 챌린지가 실패로 보인다',
    file: 'src/lib/trading/challengeDisplay.ts',
    cut: ["  if (intent === 'TARGET_REACHED') return 'WIN';",
          "  if (intent === 'TARGET_REACHED') return 'LOSS';"] },
  { name: '못 읽은 진행률을 0%로 적는다',
    file: 'src/lib/trading/challengeDisplay.ts',
    cut: ["  const num = (v: any): number => (v == null || v === '' ? NaN : Number(v));",
          '  const num = (v: any): number => Number(v);'] },
  { name: '모르는 상태에서 주문을 연다',
    file: 'src/lib/trading/challengeDisplay.ts',
    cut: ["  const ordersAllowed = status === 'RUNNING';",
          "  const ordersAllowed = status !== 'CLOSED';"] },

  // ══ 호가 판단 자체 ══
  { name: '가운데 값이 최우선 매도 폴백을 잃는다 — 두 화면이 갈리던 그 자리',
    file: 'src/lib/trading/orderBook.ts',
    cut: ['    : Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk\n', ''] },
  { name: '실시간 판정이 stale을 보지 않는다',
    file: 'src/lib/trading/orderBook.ts',
    cut: ["  return !!s && s.status === 'live' && s.stale !== true;",
          "  return !!s && s.status === 'live';"] },
];

let survivors = 0, anchorFails = 0;

console.log('── 정본 기준선 ──');
restore();
if (checkerRed()) { console.log('  ✗ 정본에서 검사기가 빨갛다'); process.exit(1); }
if (!testsGreen()) { console.log('  ✗ 정본에서 시험이 빨갛다'); process.exit(1); }
console.log('  ✓ 정본 GREEN (검사기 3종 · 시험)');

console.log('\n── 뮤테이션 ──');
for (const m of MUTATIONS) {
  const base = canonical.get(m.file);
  const [oldText, newText] = m.cut;
  if (!base.includes(oldText)) {
    console.log(`  ‼ ${m.name}\n      앵커가 낡았습니다: ${JSON.stringify(oldText.slice(0, 64))}`);
    anchorFails += 1;
    continue;
  }
  writeFileSync(m.file, m.replaceAll ? base.split(oldText).join(newText) : base.replace(oldText, newText));

  let why = checkerRed();
  if (!why && !testsGreen()) why = 'RED (시험)';

  console.log(why ? `  ✓ ${m.name}\n      ${why}`
                  : `  ✗ ${m.name}\n      초록이다 — 이 규칙을 지켜보는 것이 없다`);
  if (!why) survivors += 1;
  restore();
}

console.log('\n── 주석만 바꾼 대조군 ──');
{
  const f = 'src/lib/trading/paperTarget.ts';
  const base = canonical.get(f);
  const ctrl = base.replace('// **"지금 어느 모의 장부로 거래하는가" — 화면 전체가 이 값 하나를 쓴다.**',
    '// **"지금 어느 모의 장부로 거래하는가" — 화면 전체가 이 값 하나를 쓴다.** (대조군)');
  if (ctrl === base) { console.log('  ‼ 대조군 앵커가 낡았습니다'); anchorFails += 1; }
  else {
    writeFileSync(f, ctrl);
    const green = !checkerRed() && testsGreen();
    console.log(green ? '  ✓ 주석만 바꾼 판은 GREEN — 검사가 글자에 반응하지 않는다'
                      : '  ✗ 주석만 바꿨는데 빨갛다 — 검사가 조건이 아니라 글자를 보고 있다');
    if (!green) survivors += 1;
    restore();
  }
}

restore();
console.log('');
const n = MUTATIONS.length;
if (survivors || anchorFails) {
  console.log(`장부 권위 뮤테이션 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${n}건 전부 RED · 주석 대조군 GREEN`);
