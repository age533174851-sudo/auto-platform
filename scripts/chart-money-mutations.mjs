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
  ['모의 장부 권위 검사기', 'scripts/check-paper-authority.mjs'],
  ['게임머니 검사기', 'scripts/check-game-money.mjs'],
  ['정본 거래 화면 배선 검사기', 'scripts/check-canonical-trading.mjs'],
];

const FILES = [
  'src/components/terminal/MobileShell.tsx',
  'src/app/page.tsx',
  'src/components/trading/PriceChart.tsx',
  'src/components/trading/TradingWorkspace.tsx',
  'src/components/trading/SizingSlider.tsx',
  'src/lib/trading/candleSeries.ts',
  'src/lib/trading/gameMoney.ts',
  'src/lib/trading/paperTarget.ts',
  'src/lib/trading/stopPresets.ts',
  'src/lib/trading/chartLoadState.ts',
  'src/lib/trading/oneScreen.ts',
  'src/lib/trading/submitGate.ts',
  'src/lib/trading/useTradeForm.ts',
  'src/components/trading/OrderControls.tsx',
  'src/lib/trading/marketStats.ts',
  'src/lib/trading/positionSizing.ts',
  'src/lib/trading/streamEndpoints.ts',
  'src/app/api/market/candles/route.ts',
  'src/lib/markets/venueBars.ts',
  'src/lib/hooks/useBinanceStream.ts',
  'src/lib/engine/paperAvailable.ts',
  'src/app/api/paper/order/route.ts',
  'src/app/api/paper/positions/route.ts',
  'src/app/api/paper/account/route.ts',
  'src/components/trading/PositionRow.tsx',
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

  // ══ 차트 증발 (실측에서 잡힌 결함 셋) ══
  { name: '갱신이 실패하면 잘 보고 있던 봉을 지운다',
    file: 'src/lib/trading/chartLoadState.ts',
    cut: ['export function shouldClearBarsOnFailure(i: { isSwitch: boolean }): boolean {\n  return i.isSwitch;',
          'export function shouldClearBarsOnFailure(i: { isSwitch: boolean }): boolean {\n  void i; return true;'] },
  { name: '갱신 중에도 전체 오버레이로 캔들을 덮는다 — 30초마다 깜빡인다',
    file: 'src/lib/trading/chartLoadState.ts',
    cut: ["  return phase === 'FIRST_LOAD' || phase === 'ERROR';",
          "  return phase !== 'READY';"] },
  { name: '간격 전환 실패를 낡음으로 처리한다 — 다른 간격 봉이 현재로 남는다',
    file: 'src/lib/trading/chartLoadState.ts',
    cut: ["  if (i.isSwitch) return 'ERROR';", "  void 0;"] },
  { name: '캔들이 0개여도 지표선을 남긴다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['        if (off || undrawable) {', '        if (off) {'] },
  { name: '차트가 갱신과 전환을 구별하지 않는다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ['    const isSwitch = key !== barsKeyRef.current;', '    const isSwitch = true;'] },

  // ══ 한 화면이 다시 시트로 돌아간다 ══
  { name: '주문 조작부를 화면에서 떼어낸다 — 다시 여닫는 층이 된다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ['<OrderControls', '<HiddenOrderControls'] },
  { name: '상주 호가를 없앤다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ['data-testid="workspace-split"', 'data-testid="workspace-hidden"'] },
  { name: '열 비율을 50:50으로 박는다 — 320px에서 호가가 잘린다',
    file: 'src/lib/trading/oneScreen.ts',
    cut: ['export const BOOK_MIN_PX = 110;', 'export const BOOK_MIN_PX = 40;'] },
  { name: '폭을 못 읽어도 넓은 기기로 가정한다',
    file: 'src/lib/trading/oneScreen.ts',
    cut: ['  const w = Number.isFinite(raw) && raw > 0 ? raw : 320;',
          '  const w = Number.isFinite(raw) && raw > 0 ? raw : 1280;'] },

  // ══ 잠긴 버튼이 이유를 안 말한다 ══
  { name: '주문이 막혔는데 사유를 안 돌려준다',
    file: 'src/lib/trading/submitGate.ts',
    cut: ["      reason: i.blockedReason || '지금은 이 장부로 주문할 수 없습니다',",
          '      reason: null,'] },
  { name: '계획 거절 사유를 삼킨다',
    file: 'src/lib/trading/submitGate.ts',
    cut: ["      reason: i.planReason || '주문 계획이 거절됐습니다',", '      reason: null,'] },
  { name: '막힌 버튼이 주문할 것처럼 적힌다',
    file: 'src/lib/trading/submitGate.ts',
    cut: ["  if (gate.ready) return `${sideLabel} ${symbol}`;",
          '  return `${sideLabel} ${symbol}`;'] },
  { name: '화면이 잠금 사유를 안 그린다',
    file: 'src/components/trading/OrderControls.tsx',
    cut: ['data-testid="order-blocked-reason"', 'data-testid="order-blocked-hidden"'] },
  { name: '손절 프리셋을 주문 조작부에서 없앤다 — 선물 주문이 원천 봉쇄된다',
    file: 'src/components/trading/OrderControls.tsx',
    cut: ['STOP_PCTS.map', '[].map'] },

  // ══ 값을 잘라서 통과시킨다 ══
  { name: '좁으면 숫자를 …로 자른다',
    file: 'src/components/trading/SizingSlider.tsx',
    cut: ["        minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right',",
          "        minWidth: 0, textOverflow: 'ellipsis', overflow: 'hidden', textAlign: 'right',"] },

  // ══ 판정이 두 벌이 된다 ══
  { name: '주문 판정을 컨트롤러 밖에서 다시 만든다',
    file: 'src/lib/trading/useTradeForm.ts',
    cut: ['  const gate = submitGate({', '  const gate = { ready: true, block: "NONE", reason: null } as any; const _g = ({'] },

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
    file: 'src/lib/trading/submitGate.ts',
    cut: ['  if (!i.planOk) {', '  if (false) {'] },
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

  // ══ 거래 화면이 남의 차트로 돌아간다 ══
  { name: '거래 화면 기본 차트를 iframe으로 되돌린다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ['<PriceChart', '<InlineTVChart'] },

  // ══ 한 화면이 다시 무너진다 ══
  //
  // 아래 일곱은 전부 **화면이 멀줦해 보이는** 고장이다. 320×600에서만
  // 드러났고, 요소가 보인다는 검사로는 전부 통과했다.
  { name: 'LONG/SHORT 줄을 다시 화면 아래에 붙인다 — 슬라이더를 덮는다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["          flexShrink: 0,\n          display: 'flex', gap: 6, padding: '4px 8px',",
          "          position: 'sticky', bottom: 'var(--nav-h, 0px)', zIndex: 30,\n          display: 'flex', gap: 6, padding: '4px 8px',"] },
  { name: '통 높이를 무시하고 내용 높이대로 흐르게 둔다 — CTA가 밀려난다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["...(bounded ? { height: coreHeight, minHeight: 0, overflow: 'hidden' } : null),",
          "...(bounded ? { minHeight: 0 } : null),"] },
  { name: '시장정보 높이를 재지 않고 상수로 박는다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["const [headRef, headH] = useMeasuredHeight<HTMLDivElement>();",
          "const headRef = React.useRef<HTMLDivElement | null>(null); const headH = 74;"] },
  { name: '예상값을 다시 주문 칸 안으로 넣는다 — 스크롤에 딸려 사라진다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["          <OrderEstimate form={form} scope={scope}/>", "          {null}"] },
  { name: '넘치는 칸을 스크롤 대신 자른다 — 넘친 줄이 말없이 사라진다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["overflowY: 'auto', overscrollBehavior: 'contain'", "overflow: 'hidden'"],
    replaceAll: true },
  { name: '호가 바닥을 실측이 아니라 짐작으로 되돌린다 — 매수 3번째 줄이 잘린다',
    file: 'src/lib/trading/oneScreen.ts',
    cut: ["export const SPLIT_MIN_H = BOOK_H + SPLIT_PAD_H;",
          "export const SPLIT_MIN_H = 120;"] },
  { name: '차트 바닥을 격자선만 남는 높이로 내린다',
    file: 'src/lib/trading/oneScreen.ts',
    cut: ["export const CHART_MIN_H = 96;", "export const CHART_MIN_H = 52;"] },

  // ══ 포지션을 다른 계좌에서 읽는다 ══
  //
  // 챌린지 장부로 주문하고 기본 계좌 포지션을 보는 고장은 화면에
  // 오류를 남기지 않는다 — 그냥 "포지션이 없네"로 읽힌다.
  { name: '포지션 줄이 기본 계좌 라우트를 읽는다 — 챌린지에서 장부가 갈라진다',
    file: 'src/components/trading/PositionRow.tsx',
    cut: ["'/api/paper/close'", "'/api/paper/account'"] },
  { name: '포지션 줄이 스스로 장부를 다시 읽는다',
    file: 'src/components/trading/PositionRow.tsx',
    cut: ["  const [busyId, setBusyId] = useState<string | null>(null);",
          "  const [busyId, setBusyId] = useState<string | null>(null);\n  usePaperAccount(true);"] },
  { name: '화면이 주문 장부 대신 빈 목록을 넘긴다 — 포지션이 안 보인다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["  const openPositions = paperOrders && auth ? ledger.openPositions : [];",
          "  const openPositions: any[] = [];"] },
  { name: '청산 뒤에 장부를 다시 읽지 않는다',
    file: 'src/components/trading/TradingWorkspace.tsx',
    cut: ["          onClosed={ledger.reload}", "          onClosed={() => {}}"] },
  { name: '같은 사유를 슬라이더 안에도 다시 적는다',
    file: 'src/components/trading/SizingSlider.tsx',
    cut: ["      {locked ? null : plan.code === 'OK' ? (",
          "      {locked ? (<div data-testid=\"sizing-locked\">{'모름'}</div>) : plan.code === 'OK' ? ("] },
  { name: '손절거리 라벨을 다시 두 줄로 쪼개다',
    file: 'src/components/trading/OrderControls.tsx',
    cut: ["          }}>손절거리</span>", "          }}>손절<br/>거리</span>"] },

  // ══ 권위가 조용히 갈라진다 ══
  //
  // 이 여섯은 전부 기존 검사기가 **못 보던** 곳이다.
  // 시험 5,8xx건과 검사기 64종이 전부 초록인 채 돌고 있었다.
  { name: '현물 차트가 다시 선물 봉을 그린다 — market을 안 넘긴다',
    file: 'src/app/api/market/candles/route.ts',
    cut: ["      market: market as 'SPOT' | 'USDM',", ""] },
  { name: '봉 주소 판단이 시장을 무시한다 — 전부 선물로 간다',
    file: 'src/lib/markets/venueBars.ts',
    cut: ["  if (i.market === 'SPOT') {", "  if (false) {"] },
  { name: '차트가 호가 중간값을 다시 봉의 OHLC에 얇는다',
    file: 'src/components/trading/PriceChart.tsx',
    cut: ["  const candles = useMemo<Candle[]>(() => barsToCandles(bars), [bars]);",
          "  const candles = useMemo<Candle[]>(() => withLivePrice(barsToCandles(bars), stream.lastPrice), [bars, stream.lastPrice]);"] },
  { name: '주문 라우트가 포지션 조회 오류를 다시 버린다 — 가용 잔고가 부풀든다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ["    const { data: open, error: openErr } = await sb.from('paper_positions')",
          "    const { data: open } = await sb.from('paper_positions')"] },
  { name: '조회 라우트가 DB 오류를 "포지션 0건"으로 적는다',
    file: 'src/app/api/paper/positions/route.ts',
    cut: ["    const { data: open, error: openErr } = await sb.from('paper_positions')",
          "    const { data: open } = await sb.from('paper_positions')"] },
  { name: 'RESET이 열린 포지션을 세지 못했을 때도 장부를 초기화한다',
    file: 'src/app/api/paper/account/route.ts',
    cut: ["    if (countErr || typeof count !== 'number') {", "    if (false) {"] },
  { name: '목록을 못 받은 것을 다시 0건으로 센다',
    file: 'src/lib/engine/paperAvailable.ts',
    cut: ["  if (!Array.isArray(positions)) return { used: 0, unreadable: 1 };",
          "  if (!Array.isArray(positions)) return { used: 0, unreadable: 0 };"] },
  { name: '마진 모드 오타를 조용히 격리로 바꿈니다',
    file: 'src/app/api/paper/order/route.ts',
    cut: ["  if (marginModeGiven && marginMode !== 'ISOLATED' && marginMode !== 'CROSSED') {", "  if (false) {"] },

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
