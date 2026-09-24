#!/usr/bin/env node
// scripts/canonical-trading-mutations.mjs
//
// **분리 화면 계약을 하나씩 무너뜨리고, 그때 검사기가 빨개지는지 본다.**
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
// 아래 케이스는 계약 ①~⑪에 하나씩 대응한다. 특히 ⑨(간편/프로 동일 판정)는
// 무너뜨리는 길이 여럿이라 여러 각도에서 넣는다 — 그게 이번 PR에서
// 새로 박은 규칙이기 때문이다.
//
// 대조군은 반드시 GREEN이어야 한다. "무엇을 해도 빨개지는" 검사기가
// 만점을 받는 일을 막는다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PAGE   = 'src/app/page.tsx';
const DETAIL = 'src/components/instrument/InstrumentDetail.tsx';
const ORDER  = 'src/components/trading/PaperOrderScreen.tsx';
const PRO    = 'src/components/trading/ProOrderPanel.tsx';
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
  // ── ① 탐색 → 상세 → 주문 사슬 ──

  ['MUT-N1 목록에서 상세로 가는 판정을 끊는다 (종목을 눌러도 안 열린다)', PAGE, 'RED',
   [[`const detailTarget=useMemo(()=>detailTargetOf(detailAsset),[detailAsset]);`,
     `const detailTarget=useMemo(()=>null as any,[detailAsset]);`]]],

  ['MUT-N2 상세의 주문 요청을 문맥 없이 흘린다 (무엇을 사는지 모르고 연다)', PAGE, 'RED',
   [[`              const ctx = readTradeContext({`, `              const ctx = ({`]]],

  ['MUT-N3 전용 주문 화면을 떼어낸다 (주문할 길이 사라진다)', PAGE, 'RED',
   [[`          <PaperOrderScreen`, `          <LegacyOrderScreen`]]],

  // ── ② 상세는 상주 목적지가 아니다 ──

  ['MUT-N4 종목 상세를 하단 탭으로 올린다 (고른 것 없이 열면 답이 없다)', PAGE, 'RED',
   [[`  {id:'market',   label:'시장', Icon: BarChart3},`,
     `  {id:'market',   label:'시장', Icon: BarChart3},\n  {id:'detail',   label:'종목', Icon: BarChart3},`]]],

  ['MUT-N5 주문을 겹 목록에서 빼낸다 (뒤로가기가 못 닫는다)', PAGE, 'RED',
   [[`    { id:'order',   open:!!orderCtx,      close:()=>setOrderCtx(null) },`,
     `    { id:'legacy',  open:false,           close:()=>{} },`]]],

  // ── ③ host는 하나다 ──

  ['MUT-N6 두 번째 주문 화면 host를 만든다 (두 판이 다른 props로 갈린다)', DETAIL, 'RED',
   [[`export interface OrderIntent {`,
     `export function SecondOrderHost(){ return <PaperOrderScreen/>; }\nexport interface OrderIntent {`]]],

  ['MUT-N7 두 번째 주문 판정을 만든다 (같은 주문이 두 수량으로 나간다)', POS, 'RED',
   [[`  const ledger = usePaperLedger(target, !!auth);`,
     `  const ledger = usePaperLedger(target, !!auth);\n  const _f = useTradeForm({ symbol: 'BTCUSDT' } as any);`]]],

  // ── ④ 상세에 주문폼을 넣지 않는다 (원스크린 복귀 ①) ──

  ['MUT-N8 상세에 주문 조작부를 상주시킨다 (차트와 주문이 화면을 나눈다)', DETAIL, 'RED',
   [[`  return (`, `  const _oc = <OrderControls/>;\n  return (`]]],

  ['MUT-N9 상세가 주문 판정을 직접 만든다 (상세가 곧 주문 화면이 된다)', DETAIL, 'RED',
   [[`export interface OrderIntent {`,
     `const _x = useTradeForm({} as any);\nexport interface OrderIntent {`]]],

  ['MUT-N10 상세가 주문을 직접 제출한다 (보는 화면이 체결한다)', DETAIL, 'RED',
   [[`export interface OrderIntent {`,
     `const _s = () => (window as any).form.submit();\nexport interface OrderIntent {`]]],

  ['MUT-N11 옛 원스크린 치수를 되살린다', PRO, 'RED',
   [[`export interface ProOrderPanelProps {`,
     `const BOOK_MIN_PX = 120;\nexport interface ProOrderPanelProps {`]]],

  // ── ⑤ 주문 화면에 차트·호가를 넣지 않는다 (원스크린 복귀 ②) ──

  ['MUT-N12 주문 화면에 분석용 차트를 얹는다 (주문 화면이 터미널이 된다)', PRO, 'RED',
   [[`        <OrderControls`, `        <PriceChart symbol={symbol}/>\n        <OrderControls`]]],

  ['MUT-N13 주문 화면에 호가를 상주시킨다 (주문│호가 분할이 되살아난다)', PRO, 'RED',
   [[`        <OrderControls`, `        <OrderBookView symbolId={symbol}/>\n        <OrderControls`]]],

  // ── ⑥ 정본 판정 비우회 ──

  ['MUT-N14 주문 화면이 경로 판정을 직접 한다', ORDER, 'RED',
   [[`  const route = routeFor(ctx);`, `  const route = ctx.direction === 'SELL' ? 'SELL_HOLDING' : null;`]]],

  ['MUT-N15 장부 범위를 손으로 적는다 (챌린지 표기가 한쪽만 바뀐다)', ORDER, 'RED',
   [[`  const scope = scopeForTarget(target);`, `  const scope = 'GAME' as any;`]]],

  // ── ⑦ 칸은 출처가 정한다 ──

  ['MUT-N16 상세가 그려도 되는 칸을 정본에 묻지 않는다', DETAIL, 'RED',
   [[`instrumentFieldPlan(`, `legacyFieldPlan(`]]],

  ['MUT-N17 출처 없는 칸을 "0건"으로 채운다', POS, 'RED',
   [[`function Locked({ title, reason }`, `function Unused({ title, reason }`]]],

  // ── ⑧ 능력 없는 제품에 버튼을 열지 않는다 ──

  ['MUT-N18 제품 능력표를 안 본다 (안 되는 제품에 주문 버튼이 열린다)', ORDER, 'RED',
   [[`  const wiring = paperOrderUiWiring(ctx.market);`,
     `  const wiring = { canOrder: true, reason: null } as any;`]]],

  ['MUT-N19 프로 CTA를 판정과 무관하게 연다', PRO, 'RED',
   [[`        <Cta form={form} side="LONG" disabled={!form.gate.ready || form.busy}/>`,
     `        <Cta form={form} side="LONG" disabled={false}/>`]]],

  // ── ⑨ ★ 간편과 프로가 같은 판정을 쓴다 ──

  ['MUT-N20 ★ 밀도 분기 뒤에서 판정을 만든다 (밀도마다 엔진이 생긴다)', ORDER, 'RED',
   [[`  const sell = useSellForm({`,
     `  if (level === 'PRO') { /* 분기를 위로 끌어올린다 */ }\n  const sell = useSellForm({`]]],

  ['MUT-N21 ★ 주문 판정에 밀도를 넣는다 (표현이 판정을 바꾼다)', ORDER, 'RED',
   [[`    canOrder: wiring.canOrder,`, `    canOrder: wiring.canOrder && level === 'PRO',`]]],

  ['MUT-N22 ★ 프로 패널이 자기 판정을 만든다', PRO, 'RED',
   [[`export function ProOrderPanel({`,
     `const _own = () => submitGate({} as any);\nexport function ProOrderPanel({`]]],

  ['MUT-N23 ★ 간편 화면이 자기 장부를 읽는다', BBUY, 'RED',
   [[`export function BeginnerBuyScreen(`,
     `const _led = () => usePaperLedger(null as any, true);\nexport function BeginnerBuyScreen(`]]],

  ['MUT-N24 ★ 프로에만 다른 판정 인스턴스를 넘긴다', ORDER, 'RED',
   [[`          form={form} sell={sell}`, `          form={{ ...form } as any} sell={sell}`]]],

  ['MUT-N25 ★ 화면이 거래소 격자를 다시 맞춘다 (격자 정본이 둘이 된다)', PRO, 'RED',
   [[`export function ProOrderPanel({`,
     `const _q = () => normalizeForVenue({} as any);\nexport function ProOrderPanel({`]]],

  // ── ⑩ 프로가 주문할 수단을 잃지 않는다 ──

  ['MUT-N26 프로 패널에서 주문 조작부를 떼어낸다', PRO, 'RED',
   [[`        <OrderControls`, `        <HiddenControls`]]],

  // 주석만 바꾸는 것은 결함이 아니다. **정말로 옮긴다** — 처음에 표식만
  // 건드리는 뮤테이션을 썼다가, 결함을 안 만들어 놓고 "검사기가 못 잡는다"고
  // 읽을 뻔했다.
  ['MUT-N27 예상값을 스크롤 칸 안으로 넣는다 (스크롤에 딸려 사라진다)', PRO, 'RED',
   [[`      <div style={{ flexShrink: 0 }}>
        <OrderEstimate form={form} scope={scope}/>
      </div>`, `      {null}`],
    [`        <OrderControls`, `        <OrderEstimate form={form} scope={scope}/>\n        <OrderControls`]]],

  ['MUT-N28 LONG/SHORT 줄을 다시 붙인다 (슬라이더를 덮는다)', PRO, 'RED',
   [[`        flexShrink: 0, display: 'flex', gap: 6, padding: '6px 10px',`,
     `        position: 'sticky', bottom: 0, display: 'flex', gap: 6, padding: '6px 10px',`]]],

  // ── ⑪ 포지션은 주문이 간 장부에서 ──

  ['MUT-N29 포지션 줄이 스스로 장부를 읽는다 (계좌가 갈린다)', ROW, 'RED',
   [[`export function PositionRow({ positions, auth, onClosed }: PositionRowProps) {`,
     `export function PositionRow({ positions, auth, onClosed }: PositionRowProps) {\n  usePaperTarget();`]]],

  ['MUT-N30 화면이 주문 장부 대신 빈 목록을 넘긴다', POS, 'RED',
   [[`  const positions = auth ? ledger.openPositions : [];`, `  const positions: any[] = [];`]]],

  ['MUT-N31 청산 뒤에 장부를 다시 읽지 않는다', POS, 'RED',
   [[`onClosed={ledger.reload}`, `onClosed={() => {}}`]]],

  // ── ⑫ 원스크린 자체가 되살아나지 않는다 ──

  ['MUT-N32 한 화면에 차트·주문폼·호가를 다시 모은다', POS, 'RED',
   [[`      <header style={{ display: 'grid', gap: 3 }}>`,
     `      <PriceChart/><OrderControls/><OrderBookView/>\n      <header style={{ display: 'grid', gap: 3 }}>`]]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK-N1 주문 화면에 주석 한 줄 추가', ORDER, 'GREEN',
   [[`export interface PaperOrderScreenProps {`, `// 대조군\nexport interface PaperOrderScreenProps {`]]],
  ['OK-N2 프로 패널에 주석 한 줄 추가', PRO, 'GREEN',
   [[`export interface ProOrderPanelProps {`, `// 대조군\nexport interface ProOrderPanelProps {`]]],
  ['OK-N3 상세에 주석 한 줄 추가', DETAIL, 'GREEN',
   [[`export interface OrderIntent {`, `// 대조군\nexport interface OrderIntent {`]]],
  ['OK-N4 포지션 화면에 주석 한 줄 추가', POS, 'GREEN',
   [[`export interface PositionsOrdersScreenProps {`,
     `// 대조군\nexport interface PositionsOrdersScreenProps {`]]],
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
