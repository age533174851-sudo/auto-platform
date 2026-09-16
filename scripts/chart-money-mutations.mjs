#!/usr/bin/env node
// scripts/chart-money-mutations.mjs
//
// **차트 권위·게임머니 규칙을 하나씩 깨고, 그때 검사가 빨개지는지 본다.**
//
// 왜 필요한가
// ───────────
// 이 두 규칙이 깨지는 방식은 전부 **조용하다.**
//
//   · 봉을 보간해 채우면 축이 더 매끄러워 보인다
//   · 낡은 응답을 안 버리면 1분 봉이 1시간 차트에 자연스럽게 박힌다
//   · 표시 단위에 배수를 넣으면 화면 숫자가 더 커 보인다
//   · LIVE에 `P`를 붙이면 "모의처럼 보여서" 오히려 편해 보인다
//
// 넷 다 화면은 멀쩡하고 오류도 안 난다. 통과하는 검사만 봐서는 "이 규칙을
// 아무도 지켜보지 않는다"를 구별할 수 없다.
//
// 파일을 고쳤다가 반드시 되돌린다. 네트워크·DB에 닿지 않는다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHECKS = [
  ['차트 권위 검사기', 'scripts/check-chart-authority.mjs'],
  ['게임머니 검사기', 'scripts/check-game-money.mjs'],
  ['정본 거래 화면 배선 검사기', 'scripts/check-canonical-trading.mjs'],
];

const FILES = [
  'src/components/terminal/MobileShell.tsx',
  'src/app/page.tsx',
  'src/components/trading/PriceChart.tsx',
  'src/components/trading/TradingWorkspace.tsx',
  'src/components/trading/TradeSheet.tsx',
  'src/components/trading/SizingSlider.tsx',
  'src/lib/trading/candleSeries.ts',
  'src/lib/trading/gameMoney.ts',
  'src/lib/trading/paperTarget.ts',
  'src/lib/trading/stopPresets.ts',
  'src/lib/trading/marketStats.ts',
  'src/lib/trading/positionSizing.ts',
  'src/lib/trading/streamEndpoints.ts',
  'src/app/api/market/candles/route.ts',
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

const MUTATIONS = [
  // ══ 차트가 값을 만든다 ══
  { name: '차트가 난수로 봉을 흔든다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['const stream = useBinanceStream(symbol, !fixtureBars, market);',
          'const stream = useBinanceStream(symbol, !fixtureBars, market); const _n = Math.random();'] },
  { name: '진행 중 봉 갱신 규칙을 화면이 다시 적는다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['withLivePrice(', 'localLivePrice('] },
  { name: '거래소를 직접 두드려 봉을 받는다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['/api/market/candles', 'https://fapi.binance.com/fapi/v1/klines'], replaceAll: true },
  { name: 'timeframe을 바꾼 뒤 낡은 응답을 그대로 그린다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['isFreshResponse(', 'alwaysFresh('] },
  { name: '봉 라우트가 fetchVenueBars 대신 제 손으로 받는다',
    file: 'src/app/api/market/candles/route.ts',
    cut: ['fetchVenueBars', 'fetchRawKlines'], replaceAll: true },

  // ══ 만들어 놓고 배선을 안 한다 (실측에서 잡힌 결함) ══
  { name: '차트 준비를 상태로 안 알린다 — 봉이 먼저 오면 영영 안 그려진다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['      if (!disposed) setChartEpoch(n => n + 1);', '      void disposed;'] },
  { name: '데이터 이펙트가 차트 준비를 안 본다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['  }, [candles, volumes, chartEpoch]);', '  }, [candles, volumes]);'] },
  { name: '캔들 0개인 빈 차트를 정상으로 적는다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ["    if (candles.length > 0) return;", "    if (candles.length >= 0) return;"] },

  // ══ 진행 중 봉이 미래로 자란다 ══
  { name: '현재가로 다음 봉을 새로 만든다',
    file: 'src/lib/trading/candleSeries.ts',
    cut: ['export function withLivePrice', 'export function synthesizeNextBar'] },

  // ══ 비로그인인데 열려 있다 ══
  { name: '잔고를 못 읽어도 슬라이더를 열어 둔다',
    file: 'src/components/trading/SizingSlider.tsx',
    cut: ['  const locked = !!disabled || balanceUnknown;', '  const locked = !!disabled;'] },
  { name: '못 읽은 잔고를 0으로 접는다 — "돈이 없다"로 읽힌다',
    file: 'src/components/trading/SizingSlider.tsx',
    cut: ['  const balanceUnknown = availableBalance == null;',
          '  const balanceUnknown = false; const _b = availableBalance || 0;'] },
  { name: '주문 버튼을 계획 없이 연다',
    file: 'src/components/trading/TradeSheet.tsx',
    cut: ['  const ready = canOrder && quantity != null && quantity > 0 && preview.ok;',
          '  const ready = quantity != null && quantity > 0;'] },
  { name: '빠른 퍼센트 상수를 되살린다 — 비율을 정하는 곳이 둘이 된다',
    file: 'src/lib/trading/positionSizing.ts',
    cut: ['export interface SizingInput {',
          'export const QUICK_PERCENTS: number[] = [25, 50, 75, 100];\nexport interface SizingInput {'] },

  // ══ 사람이 다니는 길에서 떨어진다 (실측에서 잡힌 결함) ══
  { name: '정본 거래 화면을 매매 탭에서 떼어낸다',
    file: 'src/components/terminal/MobileShell.tsx',
    cut: ['<TradingWorkspace', '<LegacyWorkspace'], replaceAll: true },
  { name: '세로에만 붙이고 가로는 옛 주문판으로 남긴다',
    file: 'src/components/terminal/MobileShell.tsx',
    cut: ["          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>\n            <TradingWorkspace",
          "          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>\n            <LegacyLandscapePane"] },
  { name: '정본 화면 위에 TradingView 차트를 하나 더 둔다',
    file: 'src/components/terminal/MobileShell.tsx',
    cut: ['{canonMarket ? null : <ChartDrawer/>}', '<ChartDrawer/>'] },
  { name: '실거래 모드에서도 모의 시트가 주문을 맡는다',
    file: 'src/lib/trading/paperTarget.ts',
    cut: ['  return tradeMode === PAPER_TRADE_MODE;', "  return tradeMode !== 'LIVE';"] },
  { name: '손절 거리 프리셋을 사이징이라 보고 지운다',
    file: 'src/components/trading/TradeSheet.tsx',
    cut: ['STOP_PCTS.map', '[].map'] },

  // ══ 거래 화면이 남의 차트로 돌아간다 ══
  { name: '거래 화면 기본 차트를 iframe으로 되돌린다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ['<PriceChart', '<InlineTVChart'] },

  // ══ 게임머니가 화폐가 된다 ══
  { name: '표시 단위에 배수를 붙인다',
    file: 'src/lib/trading/gameMoney.ts',
    cut: ["export const GAME_MONEY_UNIT = 'P';",
          "export const GAME_MONEY_UNIT = 'P';\nexport const GAME_MONEY_RATE = 1000;"] },
  { name: '글자를 숫자로 되돌리는 함수를 만든다',
    file: 'src/lib/trading/gameMoney.ts',
    cut: ["export const GAME_MONEY_UNIT = 'P';",
          "export const GAME_MONEY_UNIT = 'P';\nexport function parseGameMoney(s: string) { return Number(s); }"] },
  { name: 'LIVE만 아니면 게임머니로 적는다 — 모르는 장부가 게임머니가 된다',
    file: 'src/lib/trading/gameMoney.ts',
    cut: ["return scope === 'PAPER' || scope === 'CHALLENGE';",
          "return scope !== 'LIVE';"] },
];

let survivors = 0;
let anchorFails = 0;

console.log('── 차트 권위 · 게임머니 뮤테이션 ──\n');
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
  const f = 'src/lib/trading/gameMoney.ts';
  const base = canonical.get(f);
  const ctrl = base.replace('/** 모의 금액의 표시명. **바꿔도 회계에 영향이 없다.** */',
    '/** 모의 금액의 표시명. **바꿔도 회계에 영향이 없다.** (대조군) */');
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
  console.log(`차트·게임머니 뮤테이션 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${n}건 전부 RED · 주석 대조군 GREEN`);
