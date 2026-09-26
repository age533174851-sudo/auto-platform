#!/usr/bin/env node
// scripts/canonical-trading-mutations.mjs
//
// **TRAIGO 거래 화면 계약을 하나씩 무너뜨리고, 그때 검사기가 빨개지는지 본다.**
//
// 왜 필요한가
// ───────────
// 검사기를 새로 쓰면 가장 흔한 실패는 **아무것도 안 잡는 검사기**다.
// 정규식 하나가 늘 참이거나, 파일을 못 읽어 조용히 통과하거나, 낱말만
// 맞춰 놓고 모양을 안 보거나 — 전부 초록으로 보인다.
//
// 이 저장소에서 실제로 그런 일이 있었다. 그래서 새 계약은 반드시
// **깨 보고** 확인한다.
//
// 아래 케이스는 새 계약 ①~⑯에 대응한다. 특히 이번에 바뀐 세 가지를
// 여러 각도에서 깬다 — 새로 박은 규칙일수록 헐겁기 쉽다:
//
//   ★ 차트는 접혀 있다 (기본값 · 비상주 · 덮개)
//   ★ 시장 의미가 섞이지 않는다 (현물에 레버리지 / 주식에 선물 / 선물에서 누락)
//   ★ 공용 부품은 능력표에 물어보고 그린다
//
// 대조군은 반드시 GREEN이어야 한다. "무엇을 해도 빨개지는" 검사기가
// 만점을 받는 일을 막는다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PAGE   = 'src/app/page.tsx';
const DETAIL = 'src/components/instrument/InstrumentDetail.tsx';
const ORDER  = 'src/components/trading/PaperOrderScreen.tsx';
const SHELL  = 'src/components/trading/markets/TradingScreenShell.tsx';
const DRAWER = 'src/components/trading/markets/ChartDrawer.tsx';
const SPOT   = 'src/components/trading/markets/SpotTradingScreen.tsx';
const USDM   = 'src/components/trading/markets/UsdtFuturesTradingScreen.tsx';
const COINM  = 'src/components/trading/markets/CoinMFuturesTradingScreen.tsx';
const STOCK  = 'src/components/trading/markets/StockTradingScreen.tsx';
const SHEET  = 'src/components/trading/OrderControls.tsx';
const ROUTE  = 'src/lib/trading/tradingScreenRoute.ts';
const BBUY   = 'src/components/trading/BeginnerBuyScreen.tsx';
const POS    = 'src/components/trading/PositionsOrdersScreen.tsx';
const ROW    = 'src/components/trading/PositionRow.tsx';
const CHECK  = 'scripts/check-canonical-trading.mjs';

const ONLY = process.argv.slice(2);

/** 이 스위트가 지키는 것은 **이 검사기 하나**다. 다른 게이트는 섞지 않는다 */
function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  return { red: c.status !== 0 };
}

const CASES = [
  // ── ① 탐색 → 상세 → 거래 사슬 ──

  ['MUT-N1 목록에서 상세로 가는 판정을 끊는다 (종목을 눌러도 안 열린다)', PAGE, 'RED',
   [[`const detailTarget=useMemo(()=>detailTargetOf(detailAsset),[detailAsset]);`,
     `const detailTarget=useMemo(()=>null as any,[detailAsset]);`]]],

  ['MUT-N2 상세의 주문 요청을 문맥 없이 흘린다 (무엇을 사는지 모르고 연다)', PAGE, 'RED',
   [[`              const ctx = readTradeContext({`, `              const ctx = ({`]]],

  ['MUT-N3 거래 화면 host를 떼어낸다 (주문할 길이 사라진다)', PAGE, 'RED',
   [[`          <PaperOrderScreen`, `          <LegacyOrderScreen`]]],

  // ── ② 상세·거래는 상주 목적지가 아니다 ──

  ['MUT-N4 종목 상세를 하단 탭으로 올린다 (고른 것 없이 열면 답이 없다)', PAGE, 'RED',
   [[`  {id:'market',   label:'시장', Icon: BarChart3},`,
     `  {id:'market',   label:'시장', Icon: BarChart3},\n  {id:'detail',   label:'종목', Icon: BarChart3},`]]],

  ['MUT-N5 거래 화면을 겹 목록에서 빼낸다 (뒤로가기가 못 닫는다)', PAGE, 'RED',
   [[`    { id:'order',   open:!!orderCtx,      close:()=>setOrderCtx(null) },`,
     `    { id:'legacy',  open:false,           close:()=>{} },`]]],

  // ── ③ host 하나 · 시장→화면 분기 한 곳 ──

  ['MUT-N6 두 번째 거래 화면 host를 만든다 (두 판이 다른 props로 갈린다)', DETAIL, 'RED',
   [[`export interface OrderIntent {`,
     `export function SecondOrderHost(){ return <PaperOrderScreen/>; }\nexport interface OrderIntent {`]]],

  ['MUT-N7 두 번째 주문 판정을 만든다 (같은 주문이 두 수량으로 나간다)', POS, 'RED',
   [[`  const ledger = usePaperLedger(target, !!auth);`,
     `  const ledger = usePaperLedger(target, !!auth);\n  const _f = useTradeForm({ symbol: 'BTCUSDT' } as any);`]]],

  ['MUT-N8 ★ 시장→화면 분기를 두 번째 자리에 복제한다 (COIN-M이 USDⓈ-M 화면을 받는다)', POS, 'RED',
   [[`export function PositionsOrdersScreen({ auth }: PositionsOrdersScreenProps) {`,
     `const _r = () => tradingScreenFor('SPOT' as any);\nexport function PositionsOrdersScreen({ auth }: PositionsOrdersScreenProps) {`]]],

  ['MUT-N9 ★ 모르는 시장에 기본 화면을 준다 (선물 주문이 현물로 나간다)', ROUTE, 'RED',
   [["  if (!id) throw new Error(", "  if (!id) return 'SPOT_SCREEN';\n  if (false) throw new Error("]]],

  // ── ④ 상세에 주문폼을 넣지 않는다 ──

  ['MUT-N10 상세에 주문 조작부를 상주시킨다 (거래 화면이 둘이 된다)', DETAIL, 'RED',
   [[`  return (`, `  const _oc = <OrderControls/>;\n  return (`]]],

  ['MUT-N11 상세가 주문 판정을 직접 만든다', DETAIL, 'RED',
   [[`export interface OrderIntent {`,
     `const _x = useTradeForm({} as any);\nexport interface OrderIntent {`]]],

  ['MUT-N12 상세가 주문을 직접 제출한다 (보는 화면이 체결한다)', DETAIL, 'RED',
   [[`export interface OrderIntent {`,
     `const _s = () => (window as any).form.submit();\nexport interface OrderIntent {`]]],

  ['MUT-N13 옛 원스크린 치수를 되살린다', SHELL, 'RED',
   [[`export interface ShellTab {`, `const BOOK_MIN_PX = 120;\nexport interface ShellTab {`]]],

  ['MUT-N14 옛 통합 거래 화면을 이름만 바꿔 되살린다', POS, 'RED',
   [[`      <header style={{ display: 'grid', gap: 3 }}>`,
     `      <TradingWorkspace/>\n      <header style={{ display: 'grid', gap: 3 }}>`]]],

  // ── ⑤ ★ 거래 화면 본문에 차트를 상주시키지 않는다 (사용자 규칙 1·2) ──

  ['MUT-N15 ★ 선물 화면 본문에 차트를 상주시킨다 (260px가 주문 버튼을 밀어낸다)', USDM, 'RED',
   [[`          <OrderControls form={p.form}`,
     `          <PriceChart symbol={p.symbol} interval="15m" height={260}/>\n          <OrderControls form={p.form}`]]],

  ['MUT-N16 ★ 현물 화면 본문에 차트를 상주시킨다', SPOT, 'RED',
   [[`        <OrderControls form={p.form}`,
     `        <PriceChart symbol={p.symbol} interval="15m" height={260}/>\n        <OrderControls form={p.form}`]]],

  ['MUT-N17 ★ 공용 껍데기가 차트를 직접 그린다 (네 화면 모두 상주가 된다)', SHELL, 'RED',
   [[`        <ChartDrawer`, `        <PriceChart symbol={p.symbol} interval="15m"/>\n        <ChartDrawer`]]],

  ['MUT-N18 ★ 차트 서랍을 화면에 안 붙인다 (만들어 놓고 배선 안 함)', SHELL, 'RED',
   [[`        <ChartDrawer`, `        <UnwiredChartDrawer`]]],

  ['MUT-N19 TradingView iframe을 새로 들인다 (차트 정본이 둘이 된다)', USDM, 'RED',
   [[`export function UsdtFuturesTradingScreen(p: FuturesScreenProps) {`,
     `const TV = 'https://s3.tradingview.com/tv.js';\nexport function UsdtFuturesTradingScreen(p: FuturesScreenProps) {`]]],

  // ── ⑥ ★ 차트 서랍의 기본은 접힘 (사용자 규칙 8) ──

  ['MUT-N20 ★ 차트 서랍의 기본을 펴짐으로 바꾼다 (옛 배치가 이름만 바꿔 돌아온다)', DRAWER, 'RED',
   [[`  const [open, setOpen] = useState(false);`, `  const [open, setOpen] = useState(true);`]]],

  ['MUT-N21 ★ 차트를 여닫는 수단을 없앤다 (막대만 있고 안 열린다)', DRAWER, 'RED',
   [[`onClick={() => setOpen(v => !v)}`, `onClick={() => {}}`]]],

  ['MUT-N22 ★ 펼친 차트를 덮개가 아니라 본문에 끼운다 (그게 상주 차트다)', DRAWER, 'RED',
   [[`            position: 'absolute', inset: 0, zIndex: 20,`, `            zIndex: 20,`]]],

  // ── ⑦ ★ 호가·포지션·미체결은 거래 화면에 있어야 한다 (사용자 규칙 3·4·6) ──

  ['MUT-N23 ★ 선물 화면에서 호가를 뺀다 (호가를 보며 주문하는 화면이 아니게 된다)', USDM, 'RED',
   [[`          <OrderBookView symbolId={p.symbol} market="USDM" rows={7} dense`,
     `          <NoBook symbolId={p.symbol} rows={7} dense`]]],

  ['MUT-N24 ★ 선물 화면에서 펀딩 칸을 없앤다 (선물 필수 정보 누락)', USDM, 'RED',
   [[`      <InfoStat testid={fieldTestId('FUNDING')} label="펀딩"`,
     `      <InfoStat testid={'legacy-funding'} label="펀딩"`]]],

  ['MUT-N25 ★ 선물 화면에서 청산까지 거리를 없앤다', USDM, 'RED',
   [[`      <InfoStat testid={fieldTestId('LIQUIDATION_DISTANCE')} label="청산까지"`,
     `      <InfoStat testid={'legacy-liq-dist'} label="청산까지"`]]],

  ['MUT-N26 ★ 현물 화면에서 보유 Base 칸을 없앤다', SPOT, 'RED',
   [[`      <InfoStat testid={fieldTestId('BASE_HOLDING')}`,
     `      <InfoStat testid={'legacy-base'}`]]],

  ['MUT-N27 ★ 주식 화면에서 주문가능금액을 없앤다', STOCK, 'RED',
   [[`      <InfoStat testid={fieldTestId('ORDERABLE_CASH')} label="주문가능금액"`,
     `      <InfoStat testid={'legacy-cash'} label="주문가능금액"`]]],

  ['MUT-N28 ★ 아래 탭을 껍데기에 안 넘긴다 (포지션·미체결이 사라진다)', USDM, 'RED',
   [[`      tabs={tabs}`, `      tabs={[]}`]]],

  ['MUT-N29 미체결을 "0건"으로 채운다 (없는 개념을 비어 있는 것으로 읽게 한다)', USDM, 'RED',
   [[`        <LockedField testid={fieldTestId('OPEN_ORDERS')} title="미체결"`,
     `        <div data-testid={fieldTestId('OPEN_ORDERS')}>0건</div>;const _u = (
        <LockedField testid={'x'} title="미체결"`]]],

  // ── ⑧ ★ 시장 의미가 섞이지 않는다 (사용자 규칙 5·7·10) ──

  ['MUT-N30 ★ 현물 화면에 레버리지를 넣는다 (현물에 1배 레버리지가 있는 것처럼 읽힌다)', SPOT, 'RED',
   [[`      <InfoStat testid={fieldTestId('QUOTE_AVAILABLE')} label="가용"`,
     `      <InfoStat testid={fieldTestId('LEVERAGE')} label="배율" value="10x"/>\n      <InfoStat testid={fieldTestId('QUOTE_AVAILABLE')} label="가용"`]]],

  ['MUT-N31 ★ 현물 화면에 청산가를 넣는다', SPOT, 'RED',
   [[`      <InfoStat testid={fieldTestId('QUOTE_AVAILABLE')} label="가용"`,
     `      <InfoStat testid={fieldTestId('LIQUIDATION_PRICE')} label="청산가" value="0"/>\n      <InfoStat testid={fieldTestId('QUOTE_AVAILABLE')} label="가용"`]]],

  ['MUT-N32 ★ 주식 화면에 레버리지를 넣는다 (주식에 레버리지가 있는 줄 안다)', STOCK, 'RED',
   [[`      <InfoStat testid={fieldTestId('HELD_QTY')} label="보유수량"`,
     `      <InfoStat testid={fieldTestId('LEVERAGE')} label="배율" value="3x"/>\n      <InfoStat testid={fieldTestId('HELD_QTY')} label="보유수량"`]]],

  ['MUT-N33 ★ 주식 화면에 펀딩을 넣는다', STOCK, 'RED',
   [[`      <InfoStat testid={fieldTestId('HELD_QTY')} label="보유수량"`,
     `      <InfoStat testid={fieldTestId('FUNDING')} label="펀딩" value="0%"/>\n      <InfoStat testid={fieldTestId('HELD_QTY')} label="보유수량"`]]],

  ['MUT-N34 ★ USDⓈ-M 화면에 계약 수를 넣는다 (COIN-M의 말이 섞인다)', USDM, 'RED',
   [[`      <InfoStat testid={fieldTestId('MARK_PRICE')} label="마크가"`,
     `      <InfoStat testid={fieldTestId('CONTRACT_COUNT')} label="계약 수" value="1"/>\n      <InfoStat testid={fieldTestId('MARK_PRICE')} label="마크가"`]]],

  ['MUT-N35 ★ 공용 껍데기가 시장 전용 칸을 든다 (네 화면 의미가 한 파일에서 섞인다)', SHELL, 'RED',
   [[`export function TradingScreenShell(p: TradingScreenShellProps) {`,
     `const _leak = () => fieldTestId('LEVERAGE');\nexport function TradingScreenShell(p: TradingScreenShellProps) {`]]],

  ['MUT-N36 ★ 차트 서랍이 시장 전용 칸을 든다', DRAWER, 'RED',
   [[`export function ChartDrawer({ label, source, unavailableReason }: ChartDrawerProps) {`,
     `const _leak = () => fieldTestId('FUNDING');\nexport function ChartDrawer({ label, source, unavailableReason }: ChartDrawerProps) {`]]],

  ['MUT-N37 ★ 공용 부품이 능력표 없이 레버리지를 그린다 (현물에 선물 칸이 샌다)', SHEET, 'RED',
   [[`          {!unsupported(form.caps.leverage) ? (
            <span data-testid={fieldTestId('LEVERAGE')} style={{ display: 'contents' }}>`,
     `          {true ? (
            <span data-testid={fieldTestId('LEVERAGE')} style={{ display: 'contents' }}>`]]],

  ['MUT-N38 ★ 공용 부품이 능력표 없이 청산가를 그린다', SHEET, 'RED',
   [[`        {!form.spot ? (
          <span data-testid={fieldTestId('LIQUIDATION_PRICE')} style={{ display: 'contents' }}>`,
     `        {true ? (
          <span data-testid={fieldTestId('LIQUIDATION_PRICE')} style={{ display: 'contents' }}>`]]],

  ['MUT-N39 ★ COIN-M이 코인 개수 기준 수량 판정을 물려받는다 (1계약=100USD를 1개로 읽는다)', COINM, 'RED',
   [[`export function CoinMFuturesTradingScreen(p: CoinMScreenProps) {`,
     `const _mix = () => useTradeForm({} as any);\nexport function CoinMFuturesTradingScreen(p: CoinMScreenProps) {`]]],

  ['MUT-N40 ★ COIN-M이 계약 크기를 "대개 10 USD"로 추측한다 (BTC에서 10배 틀린다)', COINM, 'RED',
   [[`  const spec = resolveContractSize(p.symbol, p.contractUsdFromExchange ?? null);`,
     `  const spec = { contractUsd: TYPICAL_ALT_CONTRACT_USD, source: 'known' as const };`]]],

  // ── ⑨ 정본 판정 비우회 ──

  ['MUT-N41 거래 화면이 경로 판정을 직접 한다', ORDER, 'RED',
   [[`  const route = routeFor(ctx);`, `  const route = ctx.direction === 'SELL' ? 'SELL_HOLDING' : null;`]]],

  ['MUT-N42 장부 범위를 손으로 적는다 (챌린지 표기가 한쪽만 바뀐다)', ORDER, 'RED',
   [[`  const scope = scopeForTarget(target);`, `  const scope = 'GAME' as any;`]]],

  ['MUT-N43 시장 화면이 주문 라우트를 직접 부른다 (정본 훅을 건너뛴다)', SPOT, 'RED',
   [[`export function SpotTradingScreen(p: SpotScreenProps) {`,
     `const POST = '/api/paper/order';\nexport function SpotTradingScreen(p: SpotScreenProps) {`]]],

  // ── ⑩ 칸은 출처가 정한다 ──

  ['MUT-N44 상세가 그려도 되는 칸을 정본에 묻지 않는다', DETAIL, 'RED',
   [[`instrumentFieldPlan(`, `legacyFieldPlan(`]]],

  ['MUT-N45 출처 없는 칸을 "0건"으로 채운다', POS, 'RED',
   [[`function Locked({ title, reason }`, `function Unused({ title, reason }`]]],

  // ── ⑪ 능력 없는 제품에 버튼을 열지 않는다 ──

  ['MUT-N46 제품 능력표를 안 본다 (안 되는 제품에 주문 버튼이 열린다)', ORDER, 'RED',
   [[`  const wiring = paperOrderUiWiring(ctx.market);`,
     `  const wiring = { canOrder: true, reason: null } as any;`]]],

  ['MUT-N47 ★ COIN-M 실행 버튼을 열어 둔다 (눌러도 아무 일도 안 일어난다)', COINM, 'RED',
   [[`              disabled title={wiring.reason}`, `              title={wiring.reason}`]]],

  ['MUT-N48 ★ 주식 실행 버튼을 열어 둔다', STOCK, 'RED',
   [[`        <button type="button" data-testid="stock-cta" disabled title={blocked}`,
     `        <button type="button" data-testid="stock-cta" title={blocked}`]]],

  // ── ⑫ ★ 간편과 프로가 같은 판정을 쓴다 (사용자 규칙 9) ──

  ['MUT-N49 ★ 밀도 분기 뒤에서 판정을 만든다 (밀도마다 엔진이 생긴다)', ORDER, 'RED',
   [[`  const sell = useSellForm({`,
     `  if (level === 'PRO') { /* 분기를 위로 끌어올린다 */ }\n  const sell = useSellForm({`]]],

  ['MUT-N50 ★ 주문 판정에 밀도를 넣는다 (표현이 판정을 바꾼다)', ORDER, 'RED',
   [[`    canOrder: wiring.canOrder,`, `    canOrder: wiring.canOrder && level === 'PRO',`]]],

  ['MUT-N51 ★ 시장 화면이 자기 판정을 만든다', USDM, 'RED',
   [[`export function UsdtFuturesTradingScreen(p: FuturesScreenProps) {`,
     `const _own = () => submitGate({} as any);\nexport function UsdtFuturesTradingScreen(p: FuturesScreenProps) {`]]],

  ['MUT-N52 ★ 간편 화면이 자기 장부를 읽는다', BBUY, 'RED',
   [[`export function BeginnerBuyScreen(`,
     `const _led = () => usePaperLedger(null as any, true);\nexport function BeginnerBuyScreen(`]]],

  ['MUT-N53 ★ 한 갈래에만 다른 판정 인스턴스를 넘긴다', ORDER, 'RED',
   [[`            form={form} sell={sell} ledger={ledger} auth={auth}`,
     `            form={{ ...form } as any} sell={sell} ledger={ledger} auth={auth}`]]],

  ['MUT-N54 ★ 시장 화면이 거래소 격자를 다시 맞춘다 (격자 정본이 둘이 된다)', SPOT, 'RED',
   [[`export function SpotTradingScreen(p: SpotScreenProps) {`,
     `const _q = () => normalizeForVenue({} as any);\nexport function SpotTradingScreen(p: SpotScreenProps) {`]]],

  // ── ⑬ 주문할 수단을 잃지 않는다 ──

  ['MUT-N55 현물 화면에서 주문 조작부를 떼어낸다', SPOT, 'RED',
   [[`        <OrderControls form={p.form}`, `        <HiddenControls form={p.form}`]]],

  ['MUT-N56 선물 화면에서 예상값을 떼어낸다 (얼마 잠기는지 모르고 누른다)', USDM, 'RED',
   [[`      estimate={<OrderEstimate form={p.form} scope={p.scope}/>}`, `      estimate={null}`]]],

  // 주석만 바꾸는 것은 결함이 아니다. **정말로 옮긴다.**
  ['MUT-N57 예상값을 스크롤 칸 안으로 넣는다 (스크롤에 딸려 사라진다)', SHELL, 'RED',
   [[`      {p.estimate ? <div style={{ flexShrink: 0 }}>{p.estimate}</div> : null}`, `      {null}`],
    [`        }}>{p.orderForm}</div>`, `        }}>{p.orderForm}{p.estimate}</div>`]]],

  // ★ 실기 프로브가 잡은 결함을 뮤테이션으로 고정한다.
  //   360×660에서 실행 버튼이 638~697px에 놓였다 — 화면 밖 37px.
  //   아래 블록 높이를 안 빼면 그 상태로 돌아간다.
  ['MUT-N58b 아래 블록(예상값+버튼) 높이를 안 뺀다 (실행 버튼이 화면 밖으로 밀린다)', SHELL, 'RED',
   [[`  const bodyH = Math.max(140, boxH - topH - botH - TAB_PEEK);`,
     `  const bodyH = Math.max(140, boxH - topH - TAB_PEEK);`]]],

  ['MUT-N58 실행 버튼 줄을 다시 붙인다 (슬라이더를 덮는다)', SHELL, 'RED',
   [[`        flexShrink: 0, padding: '6px 10px',`,
     `        position: 'sticky', bottom: 0, padding: '6px 10px',`]]],

  // ★ import 한 줄을 지우는 뮤테이션은 **결함을 안 만든다** — 본문은
  //   그대로라 이름 검사가 통과하고, 그러면 "검사기가 못 잡는다"가 아니라
  //   "깨지 않았다"가 된다. 실제 방어점(잰 값에서 나오는 높이)을 끈다.
  ['MUT-N59 첫 화면 높이를 상수로 박는다 (경고 한 줄이 늘면 버튼이 밀린다)', SHELL, 'RED',
   [[`  const bodyH = Math.max(140, boxH - topH - botH - TAB_PEEK);`,
     `  const bodyH = 420;`]]],

  // ── ⑭ 포지션은 주문이 간 장부에서 ──

  ['MUT-N60 포지션 줄이 스스로 장부를 읽는다 (계좌가 갈린다)', ROW, 'RED',
   [[`export function PositionRow({ positions, auth, onClosed }: PositionRowProps) {`,
     `export function PositionRow({ positions, auth, onClosed }: PositionRowProps) {\n  usePaperTarget();`]]],

  ['MUT-N61 거래 화면이 주문 장부 대신 빈 목록을 넘긴다', USDM, 'RED',
   [[`          <PositionRow positions={positions} auth={p.auth} onClosed={p.ledger.reload}/>`,
     `          <PositionRow positions={[]} auth={p.auth} onClosed={p.ledger.reload}/>`]]],

  ['MUT-N62 청산 뒤에 장부를 다시 읽지 않는다', USDM, 'RED',
   [[`onClosed={p.ledger.reload}`, `onClosed={() => {}}`]]],

  ['MUT-N63 거래 탭이 청산 뒤에 장부를 다시 읽지 않는다', POS, 'RED',
   [[`onClosed={ledger.reload}`, `onClosed={() => {}}`]]],

  // ── ⑮ 계약 정본을 못 읽으면 통과시키지 않는다 ──
  //
  // 검사기가 계약을 못 읽고도 초록이면, 목록을 늘려도 검사가 안 는다.

  ['MUT-N64 ★ 계약 정본을 깨뜨린다 (검사기가 조용히 통과하면 안 된다)',
   'src/lib/trading/marketScreenContract.ts', 'RED',
   [[`export function screenContract(m: MarketType): MarketScreenContract {`,
     `syntax error here\nexport function screenContract(m: MarketType): MarketScreenContract {`]]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK-N1 거래 화면 host에 주석 한 줄 추가', ORDER, 'GREEN',
   [[`export interface PaperOrderScreenProps {`, `// 대조군\nexport interface PaperOrderScreenProps {`]]],
  ['OK-N2 공용 껍데기에 주석 한 줄 추가', SHELL, 'GREEN',
   [[`export interface ShellTab {`, `// 대조군\nexport interface ShellTab {`]]],
  ['OK-N3 상세에 주석 한 줄 추가', DETAIL, 'GREEN',
   [[`export interface OrderIntent {`, `// 대조군\nexport interface OrderIntent {`]]],
  ['OK-N4 차트 서랍에 주석 한 줄 추가', DRAWER, 'GREEN',
   [[`export interface ChartDrawerProps {`, `// 대조군\nexport interface ChartDrawerProps {`]]],
  // ★ 사용자 규칙 3·4 — **호가와 포지션은 거래 화면에 있어도 된다.**
  //   v2 계약에서는 이것이 실패였다. 지금은 통과여야 하고, 그 사실을
  //   대조군으로 못 박는다 — 옛 규칙이 실수로 되살아나면 여기서 잡힌다.
  ['OK-N5 ★ 현물 화면에 호가를 한 벌 더 붙인다 (허용이어야 한다)', SPOT, 'GREEN',
   [[`          <OrderBookView symbolId={p.symbol} market="SPOT" rows={7} dense/>`,
     `          <OrderBookView symbolId={p.symbol} market="SPOT" rows={7} dense/>\n          <OrderBookView symbolId={p.symbol} market="SPOT" rows={3} dense/>`]]],
  ['OK-N6 ★ 선물 화면 포지션 칸에 설명 한 줄 추가 (허용이어야 한다)', USDM, 'GREEN',
   [[`          {positions.length === 0 ? (`,
     `          <span>내 포지션</span>\n          {positions.length === 0 ? (`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 분리 화면 계약 검사기\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(file, 'utf8');
  let after = before, missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
    // ★ 함수로 넘긴다. 문자열 치환은 `$'`를 "매치 뒤 전체"로 해석한다.
    after = after.replace(from, () => to);
  }
  if (missing || after === before) {
    console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
    noop += 1; continue;
  }

  writeFileSync(file, after);
  let res;
  try { res = gate(); } finally { writeFileSync(file, before); }

  if (kind === 'RED') {
    if (res.red) { console.log(`  ●  ${name} — RED (검출)`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
  } else {
    if (!res.red) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — RED (과도 검출)`); greenBad += 1; }
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed > 0 || greenBad > 0 || noop > 0 ? 1 : 0);
