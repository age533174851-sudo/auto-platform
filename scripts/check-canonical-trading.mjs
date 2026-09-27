#!/usr/bin/env node
// scripts/check-canonical-trading.mjs
//
// **TRAIGO 거래 화면 계약 — 시장마다 화면이 갈리고, 차트는 접혀 있다.**
//
// 계약이 두 번 바뀌었다. 무엇이 왜 바뀌었는지 적어 둔다
// ────────────────────────────────────────────────────────
//   v1 (원스크린)   차트·호가·주문·포지션을 **한 화면에** 강제했다.
//                   320×600에서 차트가 96px까지 밀리고 주문 버튼이
//                   슬라이더를 덮었다. 폐기.
//
//   v2 (Phase UI-IA) 반대로 강제했다 — **"주문 화면에 호가를 넣지 마라."**
//                   상세(보는 화면)와 주문(하는 화면)을 갈랐다. 배치는
//                   나아졌지만 제품이 틀렸다: 실제 거래소 화면은 호가를
//                   보며 주문한다. 주문할 때마다 뒤로 나가 호가를 보고
//                   다시 들어와야 했다.
//
//   v3 (지금)       바이낸스 모바일 골격. **호가 + 주문 + 포지션은 한
//                   거래 화면에 둔다.** 대신 **차트만** 접어서 뺀다 —
//                   화면을 밀어내던 것은 호가가 아니라 260px 차트였다.
//                   그리고 **시장마다 화면을 가른다.**
//
// ★ 이것은 검사기를 푸는 변경이 아니다
// ────────────────────────────────────
// v2가 막던 고장(원스크린 복귀 · 밀도별 엔진 · 계좌 갈림)은 전부 그대로
// 막는다. 그 위에 v2가 **아예 못 보던** 고장을 더 막는다:
//
//   · 현물 화면에 레버리지·청산가가 새어 들어간다
//   · 선물 화면에서 배율·청산가 칸이 사라진다
//   · 주식 화면에 선물 개념이 보인다
//   · COIN-M이 USDⓈ-M의 수량 계산을 물려받아 100배 틀린다
//   · 차트 서랍의 기본값이 '펴짐'으로 바뀌어 옛 배치가 이름만 바꿔 돌아온다
//
// ★ 낱말이 아니라 계약을 읽는다
// ─────────────────────────────
// 시장별 칸 목록을 이 파일에 손으로 적지 않는다. `marketScreenContract.ts`가
// 정본이고, 화면·검사기·브라우저 프로브가 **같은 상수**를 읽는다. 이름을
// 바꾸면 세 곳이 함께 움직인다 — 이 저장소는 "검사기가 낱말만 보다가
// 뮤테이션을 놓치는" 실수를 여러 번 했다.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PAGE    = 'src/app/page.tsx';
const DETAIL  = 'src/components/instrument/InstrumentDetail.tsx';
const ORDER   = 'src/components/trading/PaperOrderScreen.tsx';
const BBUY    = 'src/components/trading/BeginnerBuyScreen.tsx';
const BSELL   = 'src/components/trading/BeginnerSellScreen.tsx';
const SHEET   = 'src/components/trading/OrderControls.tsx';
const SLIDER  = 'src/components/trading/SizingSlider.tsx';
const FORM    = 'src/lib/trading/useTradeForm.ts';
const TARGET  = 'src/lib/trading/paperTarget.ts';
const POS     = 'src/components/trading/PositionsOrdersScreen.tsx';
const SHELL   = 'src/components/trading/markets/TradingScreenShell.tsx';
const DRAWER  = 'src/components/trading/markets/ChartDrawer.tsx';
const ROUTE   = 'src/lib/trading/tradingScreenRoute.ts';
const CONTRACT_SRC = 'src/lib/trading/marketScreenContract.ts';
const TABS_SRC = 'src/lib/trading/marketTabs.ts';
const TABS_UI  = 'src/components/trading/markets/MarketTabs.tsx';
const INSTR    = 'src/lib/trading/marketInstrument.ts';
const CATALOG  = 'src/lib/trading/instrumentCatalog.ts';
const IDENT    = 'src/lib/trading/tradeIdentity.ts';
const PICKER   = 'src/components/trading/markets/InstrumentPicker.tsx';
const CAT_API  = 'src/app/api/market/instruments/route.ts';
const FORMHOOK = 'src/lib/trading/useTradeForm.ts';
const SIZING   = 'src/lib/trading/positionSizing.ts';
const SIZEUI   = 'src/components/trading/markets/SpotSizeInput.tsx';
const CTAV     = 'src/lib/trading/ctaVerdict.ts';
const PLAN     = 'src/lib/engine/paperPlan.ts';
const PEXEC    = 'src/lib/engine/paperExecution.ts';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
/**
 * 주석은 규율이 아니다. 주석에 적힌 낱말로 검사가 **통과**해서도 안 되고,
 * 주석 때문에 **실패**해서도 안 된다.
 *
 * 줄 주석은 줄째로 버리고, 줄 안에 끼인 `/* … *\/`도 뗀다 — 실제로
 * `onPickPrice={() => { /* 지정가를 받지 않는다 *\/ }}`가 "지정가 UI가 있다"로
 * 잡힌 적이 있다. 코드는 계약을 지키고 있었고 주석만 걸린 것이다.
 *
 * `//`는 줄 안에서 떼지 않는다 — `https://`가 같이 잘린다.
 */
const code = (s) => s
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * 함수 본문을 자른다.
 *
 * ★ `/export function NAME\([\s\S]*?\n\}/` 로 자르면 **여러 줄 파라미터
 *   객체**의 닫는 괄호에서 끊긴다:
 *
 *       export function f(i: {
 *         a: number;
 *       }): R {            ← 여기 `\n}`에서 잘렸다
 *
 *   그러면 본문의 방어를 하나도 못 보고 "없다"고 적는다. 실제로 세 규칙이
 *   그렇게 틀렸다. 그래서 **다음 최상위 선언까지**를 본문으로 본다.
 */
function fnBody(src, name) {
  const at = src.search(new RegExp(`export function ${name}\\b`));
  if (at < 0) return null;
  const rest = src.slice(at + 1);
  const next = rest.search(/\nexport (function|const|interface|type) /);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

/**
 * JSX 여는 태그의 **속성 구간**만 잘라 온다.
 *
 * `{}` 안의 `>`(화살표 함수 `=>`, 비교식)에서 끊기면 안 되므로 중괄호
 * 깊이를 세면서 최상위 `>`까지 간다.
 */
function jsxTags(src, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    if (i >= src.length) continue;   // 닫히지 않았다 — 위에서 개수로 잡는다
    out.push(src.slice(m.index + m[0].length, i));
  }
  return out;
}

/** 속성 구간에서 **prop 이름만** 뽑는다 (값은 통째로 버린다) */
function jsxPropNames(attrs) {
  let s = attrs;
  for (let i = 0; i < 40; i += 1) {
    const n = s.replace(/\{[^{}]*\}/g, ' ');
    if (n === s) break;
    s = n;
  }
  s = s.replace(/"[^"]*"|'[^']*'/g, ' ').replace(/\/\s*$/, ' ');
  return (s.match(/[A-Za-z_$][\w$]*/g) || []);
}

/** 괄호·따옴표 깊이를 세며 최상위 `sep`로 자른다 */
function splitTop(src, sep) {
  const out = [];
  let depth = 0, q = null, start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (q) { if (ch === q && src[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === sep && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
  }
  out.push(src.slice(start));
  return out;
}

/** 여는 태그의 `name={…}` 값을 **중괄호 짝을 맞춰** 꺼낸다 */
function attrValue(attrs, name) {
  const m = new RegExp(`\\b${name}=\\{`).exec(attrs);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  const from = i;
  for (; i < attrs.length && depth > 0; i += 1) {
    if (attrs[i] === '{') depth += 1;
    else if (attrs[i] === '}') depth -= 1;
  }
  return depth === 0 ? attrs.slice(from, i - 1) : null;
}

/** `style={{ … }}` 안의 `prop: 값` 표 */
function styleEntries(attrs) {
  const inner = attrValue(attrs, 'style');
  if (inner == null) return {};
  const obj = inner.trim();
  if (!obj.startsWith('{') || !obj.endsWith('}')) return {};
  const out = {};
  for (const part of splitTop(obj.slice(1, -1), ',')) {
    const at = splitTop(part, ':');
    if (at.length < 2) continue;
    out[at[0].trim()] = at.slice(1).join(':').trim();
  }
  return out;
}

/** 최상위 삼항이면 **조건부**를 돌려준다 (`?.`·`??`는 삼항이 아니다) */
function ternaryCond(value) {
  let depth = 0, q = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (q) { if (ch === q && value[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === '?' && depth === 0) {
      if (value[i + 1] === '?' || value[i + 1] === '.') { i += 1; continue; }
      return value.slice(0, i);
    }
  }
  return null;
}

/**
 * 잠금 식이 **결국** "종목 없음"을 보는가.
 *
 * 이름 하나(`off`)로 적혀 있으면 한 단계 따라간다: 정본 판정의 `.off`여야
 * 하고, 그 판정이 `locked`를 인자로 받아야 한다. 이름만 보고 통과시키면
 * `const off = false`로 바꿔도 검사가 웃는다.
 */
function gateSeesLocked(src, expr) {
  const e = expr.trim();
  if (/\blocked\b/.test(e)) return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(e)) return false;
  const bind = new RegExp(`const\\s+${e}\\s*=\\s*([A-Za-z_$][\\w$]*)\\.off\\b`).exec(src);
  if (!bind) return false;
  const vm = new RegExp(`const\\s+${bind[1]}\\s*=\\s*ctaVerdict\\s*\\(`).exec(src);
  if (!vm) return false;
  let depth = 0, i = src.indexOf('(', vm.index + vm[0].length - 1);
  const from = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) break; }
  }
  return /\blocked:\s*!*\s*locked\b/.test(src.slice(from, i + 1));
}

/** 여는 태그들 중 속성에 `pat`이 들어 있는 것만 */
function jsxTagsWith(src, name, pat) {
  return jsxTags(src, name).filter(a => pat.test(a));
}

/** 시장 화면이 호가판에 넘길 수 있는 prop — **여기 없는 것은 전부 RED** */
const BOOK_PROPS_ALLOWED = ['symbolId', 'market', 'rows', 'dense', 'showFunding', 'enabled'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// ══════════════ 계약 정본을 **컴파일해서 부른다** ══════════════
//
// 목록을 이 파일에 복사하면 두 벌이 되고, 언젠가 화면만 늘고 검사는 안
// 는다. `gen-migration-manifest.mjs`의 `loadPlan()`이 같은 방식이다.
function loadContract() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-mkt-'));
  // 타입 전용 import 한 줄만 뗀다 — 파일 하나만 컴파일하므로 그 경로를
  // 풀 수 없고, 값은 하나도 오지 않는다(`import type`).
  const src = readFileSync(CONTRACT_SRC, 'utf8')
    .replace(/^import type \{ MarketType \}.*$/m, "type MarketType = string;");
  writeFileSync(join(dir, 'contract.ts'), src);
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`TypeScript를 찾을 수 없습니다: ${tsc} — 먼저 npm install`);
  execFileSync(process.execPath, [join(process.cwd(), tsc), 'contract.ts',
    '--module', 'es2020', '--target', 'es2019', '--skipLibCheck'],
    { cwd: dir, stdio: 'pipe' });
  return { file: join(dir, 'contract.js'), dir };
}

let CONTRACT = null;
try {
  const { file, dir } = loadContract();
  CONTRACT = await import(`file://${file}`);
  rmSync(dir, { recursive: true, force: true });
} catch (e) {
  err(`거래 화면 계약 정본을 부르지 못했습니다 (${CONTRACT_SRC}): ${e?.message || e}`
    + ' — 계약을 읽지 못하면 아무것도 통과시키지 않습니다');
}

/**
 * 우리 시세·호가 출처가 **아는** 시장.
 *
 * `null`은 "출처가 없다"는 뜻이고, 그 시장 화면은 호가·봉을 **빌려 오지
 * 않고 없다고 적는다.** 규칙 ⑦(있어야 한다)과 ⑳(빌려 오면 안 된다)이
 * 같은 표를 본다 — 두 벌로 두면 한쪽만 고쳐진다.
 */
const OWN_FEED = {
  SPOT: 'SPOT', USDT_FUTURES: 'USDM',
  COIN_FUTURES: null, STOCK: null,
};

const page   = code(read(PAGE));
const detail = code(read(DETAIL));
const order  = code(read(ORDER));
const sheet  = code(read(SHEET));
const slider = code(read(SLIDER));
const form   = code(read(FORM));
const target = code(read(TARGET));
const shell  = code(read(SHELL));
const drawer = code(read(DRAWER));

// ══════════════ ① 새 주문은 종목에서 시작한다 ══════════════
//
// 목록 → 상세 → 거래 화면. 이 사슬의 고리가 하나라도 끊기면 사용자는
// 종목을 고른 뒤 주문까지 못 간다. 예전에 정확히 그랬다.
{
  if (!/detailTargetOf\s*\(/.test(page)) {
    err(`${PAGE}가 종목에서 상세로 가는 판정을 쓰지 않습니다`);
  }
  if (!/<InstrumentDetail/.test(page)) {
    err(`${PAGE}가 종목 상세를 렌더하지 않습니다 — 탐색에서 상세로 가는 길이 없습니다`);
  }
  if (!/onOrder=\{[\s\S]{0,600}?readTradeContext\(/.test(page)) {
    err(`${PAGE}가 상세의 주문 요청을 문맥으로 바꾸지 않습니다`);
  }
  if (!/<PaperOrderScreen/.test(page)) {
    err(`${PAGE}가 거래 화면 host를 렌더하지 않습니다`);
  }
  if (!/onOrder\s*\(/.test(detail)) {
    err(`${DETAIL}에 거래 화면으로 가는 길이 없습니다`);
  }
}

// ══════════════ ② 종목 상세·거래 화면은 상주 목적지가 아니다 ══════════════
{
  const m = page.match(/const BTABS[\s\S]{0,900}?\n\];/);
  if (!m) err(`${PAGE}에서 하단 탭 목록을 찾지 못했습니다`);
  else {
    for (const banned of ['detail', 'instrument', 'order']) {
      if (new RegExp(`id:\\s*'${banned}'`).test(m[0])) {
        err(`하단 탭에 '${banned}'가 있습니다 — 종목 상세·거래는 고른 뒤에만 뜻이 있습니다`);
      }
    }
  }
  if (!/id:\s*'detail',\s*open:/.test(page) || !/id:\s*'order',\s*open:/.test(page)) {
    err(`${PAGE}에서 상세·거래가 겹 목록에 없습니다 — 뒤로가기가 닫지 못합니다`);
  }
}

// ══════════════ ③ 거래 화면 host는 하나 · 판정을 만드는 곳도 하나 ══════════════
{
  const files = walk('src');
  const hosts = files.filter(f => f !== ORDER && /<PaperOrderScreen/.test(code(read(f))));
  if (hosts.length !== 1) {
    err(`거래 화면 host를 렌더하는 곳이 ${hosts.length}곳입니다 — 하나여야 합니다`
      + (hosts.length ? ` (${hosts.join(', ')})` : ''));
  }
  for (const hook of ['useTradeForm', 'useSellForm']) {
    const makers = files.filter(f => new RegExp(`\\b${hook}\\s*\\(\\{`).test(code(read(f))));
    if (makers.length !== 1 || makers[0] !== ORDER) {
      err(`${hook}을 만드는 곳이 [${makers.join(', ') || '없음'}]입니다 — ${ORDER} 한 곳이어야 합니다`);
    }
  }
  // ★ 시장 → 화면 분기도 **한 곳뿐이다.** 두 곳에 있으면 언젠가 COIN-M이
  //   USDⓈ-M 화면을 받고, 그 화면은 계약 수를 코인 개수로 읽는다.
  const routers = files.filter(f =>
    f !== ROUTE && /\btradingScreenFor(Tab)?\s*\(/.test(code(read(f))));
  if (routers.length !== 1 || routers[0] !== ORDER) {
    err(`시장→화면 분기를 쓰는 곳이 [${routers.join(', ') || '없음'}]입니다`
      + ` — ${ORDER} 한 곳이어야 합니다`);
  }
  if (!/const ROUTE[\s\S]{0,400}?STOCK:/.test(code(read(ROUTE)))) {
    err(`${ROUTE}에 네 시장의 화면 표가 없습니다`);
  }
  // 모르는 시장에 **기본 화면을 주지 않는다.**
  //
  // ★ `throw`가 파일에 있는지만 보면 안 된다. 그 앞에 이른 return 한 줄을
  //   끼우면 던지는 줄은 그대로 남고 동작만 바뀐다 — 뮤테이션이 그 틈으로
  //   살아남았다. 그래서 **함수 본문에서 나가는 길을 전부 센다.**
  {
    const body = code(read(ROUTE)).match(
      /export function tradingScreenFor\([\s\S]*?\n\}/);
    if (!body) err(`${ROUTE}에서 시장→화면 함수를 찾지 못했습니다`);
    else {
      const returns = body[0].match(/return\s+[^;]+;/g) || [];
      // 나가는 길은 `return id;` 하나뿐이어야 한다. 화면 이름을 직접
      // 돌려주는 줄이 하나라도 있으면 그게 기본값이다.
      if (returns.length !== 1 || !/^return\s+id;$/.test(returns[0].trim())) {
        err(`${ROUTE}의 시장→화면 함수가 ${returns.length}가지로 빠져나갑니다`
          + ` [${returns.join(' ')}] — 모르는 시장에 기본 화면을 주면`
          + ' 선물 주문이 현물로 나갈 수 있습니다');
      }
      if (!/throw new Error/.test(body[0])) {
        err(`${ROUTE}가 모르는 시장에 대해 던지지 않습니다`);
      }
    }
  }
}

// ══════════════ ④ 종목 상세에 주문폼을 넣지 않는다 ══════════════
//
// 상세는 **보는 화면**이다. 여기에 주문폼을 얹으면 거래 화면이 둘이 된다.
{
  for (const banned of ['OrderControls', 'SizingSlider', 'BeginnerBuyScreen',
                        'OrderEstimate', 'TradingScreenShell']) {
    if (new RegExp(`<${banned}|\\b${banned}\\s*\\(`).test(detail)) {
      err(`${DETAIL}이 주문 부품을 상주시킵니다 (${banned}) — 거래 화면이 둘이 됩니다`);
    }
  }
  for (const hook of ['useTradeForm', 'useSellForm', 'submitGate']) {
    if (new RegExp(`\\b${hook}\\s*\\(`).test(detail)) {
      err(`${DETAIL}이 주문 판정을 직접 만듭니다 (${hook})`);
    }
  }
  if (/\.submit\s*\(/.test(detail)) {
    err(`${DETAIL}이 주문을 직접 제출합니다 — 상세는 보는 화면입니다`);
  }
  for (const gone of ['splitColumns', 'coreBudget', 'BOOK_MIN_PX', 'one-screen']) {
    if (detail.includes(gone) || order.includes(gone) || shell.includes(gone)) {
      err(`옛 원스크린 치수 계산이 되살아났습니다 (${gone})`);
    }
  }
}

// ══════════════ ⑤ ★ 거래 화면 본문에 차트를 **상주**시키지 않는다 ══════════════
//
//   금지: 종목 헤더 → 260px 차트 → 호가 → 주문 → 포지션
//
// 이 배치가 주문 버튼을 첫 화면 밖으로 밀어낸다. 호가를 뺀 것이 아니라
// **차트를 접은 것**이 해법이다.
{
  const screens = CONTRACT ? CONTRACT.MARKET_SCREENS : [];
  for (const s of screens) {
    const c = code(read(s.file));
    for (const banned of ['PriceChart', 'ChartPane', 'InlineTVChart', 'iframe']) {
      if (new RegExp(`<${banned}`).test(c)) {
        err(`${s.file}가 본문에 차트를 상주시킵니다 (${banned})`
          + ' — 차트는 ChartDrawer로만 들어갑니다');
      }
    }
  }
  if (/<PriceChart/.test(shell)) {
    err(`${SHELL}이 차트를 직접 그립니다 — 껍데기가 차트를 들면 네 화면 모두 상주가 됩니다`);
  }
  // 차트를 그리는 제품 경로는 **상세와 서랍 둘뿐이다.** 셋째가 생기면
  // 어딘가에서 다시 상주하기 시작한 것이다.
  const chartFiles = walk('src').filter(f => /<PriceChart/.test(code(read(f))));
  const expected = [DETAIL, DRAWER].sort().join(', ');
  if (chartFiles.sort().join(', ') !== expected) {
    err(`차트를 그리는 곳이 [${chartFiles.join(', ')}]입니다 — [${expected}]여야 합니다`);
  }
  // ★ TradingView iframe을 새로 들이지 않는다 (정본은 우리 봉이다)
  for (const f of (CONTRACT ? CONTRACT.MARKET_SCREENS.map(s => s.file) : []).concat([SHELL, DRAWER])) {
    if (/tradingview|s3\.tradingview/i.test(read(f))) {
      err(`${f}가 TradingView를 들입니다 — 차트 정본은 PriceChart입니다`);
    }
  }
}

// ══════════════ ⑥ ★ 차트 서랍의 기본은 **접힘**이다 ══════════════
//
// 이 초기값 하나가 v1 배치로 돌아가는 문이다. 펴짐이 기본이면 화면을
// 열자마자 차트가 높이를 다 먹고, 호가·주문·버튼이 밀린다.
{
  if (!/const \[open, setOpen\] = useState\(false\);/.test(drawer)) {
    err(`${DRAWER}의 차트 기본 상태가 '접힘'이 아닙니다`
      + " — `useState(false)`가 계약입니다");
  }
  // 열고 닫는 수단이 실제로 있는가 (만들어 놓고 안 붙이는 1번 고장)
  if (!/setOpen\(v => !v\)/.test(drawer)) {
    err(`${DRAWER}에 차트를 여닫는 수단이 없습니다`);
  }
  // 펼침은 **덮개**다. 본문 흐름에 끼워 넣으면 그게 상주 차트다.
  if (!/position: 'absolute', inset: 0/.test(drawer)) {
    err(`${DRAWER}의 펼친 차트가 덮개가 아닙니다 — 본문에 끼우면 상주 차트입니다`);
  }
  // 차트를 열었다고 주문 상태를 다시 만들지 않는다 — 서랍은 주문폼의
  // **형제**이고, 껍데기가 그 순서를 지킨다.
  if (!/<ChartDrawer/.test(shell)) {
    err(`${SHELL}이 차트 서랍을 붙이지 않습니다 — 만들어 놓고 배선하지 않은 상태입니다`);
  }
  if (/\{open \?[\s\S]{0,200}<TradingScreenShell/.test(shell)) {
    err(`${SHELL}이 차트 상태로 화면을 다시 만듭니다 — 주문 입력이 날아갑니다`);
  }
}

// ══════════════ ⑦ ★ 호가 · 포지션 · 미체결은 거래 화면에 **있어야 한다** ══════════════
//
// v2에서는 이것이 금지였다. 지금은 **없으면 실패다** — 계약이 뒤집혔다.
{
  if (!CONTRACT) { /* 위에서 이미 실패로 적었다 */ }
  else for (const s of CONTRACT.MARKET_SCREENS) {
    const c = code(read(s.file));
    const need = CONTRACT.mustFields(s);
    // ★ "호가 자리가 있는가"로는 부족하다. 출처가 있는 시장은 **진짜
    //   호가**를 그려야 한다 — 없음 안내만 남겨 두면 그 자리는 있고
    //   호가는 없다. 뮤테이션이 그 틈으로 살아남았다.
    if (need.includes('ORDER_BOOK')) {
      const own = OWN_FEED[s.market];
      if (own != null && !/<OrderBookView/.test(c)) {
        err(`${s.file}가 호가를 그리지 않습니다 — ${own} 호가 출처가 있는 시장입니다`);
      }
      if (own == null && !/book-no-instrument|stock-book-unavailable/.test(c)) {
        err(`${s.file}가 호가 출처 없음을 적지 않습니다 — 빈 칸은 "호가가 없는 종목"으로 읽힙니다`);
      }
    }
    for (const f of s.own) {
      const id = CONTRACT.fieldTestId(f);
      if (!c.includes(`fieldTestId('${f}')`)) {
        err(`${s.file}에 ${f}(${id}) 칸이 없습니다 — 이 시장의 화면에 반드시 있어야 합니다`);
      }
    }
    // 아래 탭이 실제로 붙어 있는가
    if (!/tabs=\{tabs\}/.test(c)) {
      err(`${s.file}가 포지션·미체결 탭을 껍데기에 넘기지 않습니다`);
    }
  }
}

// ══════════════ ⑧ ★ 시장 의미가 섞이지 않는다 ══════════════
//
// 이 파일에서 가장 중요한 규칙이다.
//
// 현물 화면에 청산가가 보이면 사용자는 그 값으로 위험을 계산한다. 답이
// 나온다 — 틀린 답이. 주식 화면에 레버리지가 보이면 레버리지가 있는 줄
// 안다. 둘 다 오류를 남기지 않고, 화면은 멀쩡해 보인다.
{
  if (CONTRACT) {
    // ⑴ 금지된 칸이 그 화면 소스에 **한 글자도** 없다
    for (const s of CONTRACT.MARKET_SCREENS) {
      const c = code(read(s.file));
      for (const f of s.never) {
        if (c.includes(`fieldTestId('${f}')`)) {
          err(`${s.file}에 ${f} 칸이 있습니다 — 이 시장에 없는 개념입니다`
            + ' (없는 것을 0·1배로 적으면 그 값으로 위험을 계산하게 됩니다)');
        }
      }
    }

    // ⑵ **순수 공용 껍데기**는 시장 전용 칸을 하나도 들지 않는다
    const specific = CONTRACT.marketSpecificFields();
    for (const f of CONTRACT.SHARED_NEUTRAL_COMPONENTS) {
      const c = code(read(f));
      for (const field of specific) {
        if (c.includes(`fieldTestId('${field}')`)) {
          err(`${f}가 시장 전용 칸을 들고 있습니다 (${field})`
            + ' — 공용 껍데기가 시장을 알면 네 화면의 의미가 한 파일에서 섞입니다');
        }
      }
    }

    // ⑶ **공용 능력표 부품**은 시장 전용 칸을 그려도 되지만 반드시 가린다.
    //
    //    "그리지 마라"로 두면 부품을 네 벌 만들게 되고, 그게 2번 고장이다.
    //    그래서 규칙은 **"능력표에 물어보고 그려라"**다.
    const GATE = /unsupported\(\s*form\.caps\.|!form\.spot|capability\(|unsupported\(\s*caps\./;
    for (const f of CONTRACT.SHARED_GATED_COMPONENTS) {
      const raw = read(f);
      const c = code(raw);
      for (const field of specific) {
        const needle = `fieldTestId('${field}')`;
        if (!c.includes(needle)) continue;
        // 그 표식이 붙은 줄 **앞쪽 8줄**에 능력표 판정이 있어야 한다.
        const lines = c.split('\n');
        let gated = false;
        lines.forEach((l, i) => {
          if (!l.includes(needle)) return;
          const near = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
          if (GATE.test(near)) gated = true;
        });
        if (!gated) {
          err(`${f}의 ${field} 칸이 능력표 판정 없이 그려집니다`
            + ' — 현물 화면에 선물 칸이 새어 들어갑니다');
        }
      }
    }

    // ⑷ COIN-M은 USDⓈ-M의 수량 계산을 **물려받지 않는다**
    //
    //    1계약 = 100 USD인데 코인 개수로 읽으면 100배 틀린다. 이 시장에서
    //    가장 흔한 사고이고, 화면을 봐서는 알 수 없다.
    const coinm = CONTRACT.MARKET_SCREENS.find(s => s.market === 'COIN_FUTURES');
    if (coinm) {
      const c = code(read(coinm.file));
      for (const hook of ['useTradeForm', 'useSellForm', 'buildPaperPlan', 'planSizing']) {
        if (new RegExp(`\\b${hook}\\b`).test(c)) {
          err(`${coinm.file}가 코인 개수 기준 수량 판정을 씁니다 (${hook})`
            + ' — COIN-M의 수량은 계약 수입니다');
        }
      }
      // 계약 크기를 모를 때 **추측하지 않는다**
      if (/TYPICAL_ALT_CONTRACT_USD/.test(c)) {
        err(`${coinm.file}가 '대개 10 USD'로 계약 크기를 추측합니다 — BTC에서 10배 틀립니다`);
      }
      if (!/resolveContractSize\s*\(/.test(c)) {
        err(`${coinm.file}가 계약 크기를 정본에 묻지 않습니다`);
      }
    }
  }
}

// ══════════════ ⑨ 정본 판정을 우회하지 않는다 ══════════════
{
  if (!/const gate = submitGate\(\{/.test(form)) {
    err(`${FORM}이 submitGate로 판정하지 않습니다 — 권한·수량·계획이 모두 필요합니다`);
  }
  if (!/buildPaperPlan\(/.test(form)) {
    err(`${FORM}이 서버와 같은 계획 함수를 쓰지 않습니다`);
  }
  if (/buildPaperPlan\(/.test(sheet)) {
    err(`${SHEET}가 계획을 직접 계산합니다 — 판정은 ${FORM} 한 곳입니다`);
  }
  if (/planSizing\(/.test(slider)) {
    err(`${SLIDER}가 수량을 다시 계산합니다 — 계산은 ${FORM} 한 곳입니다`);
  }
  if (!/stopRequestFields\s*\(/.test(form)) {
    err(`${FORM}이 손절 값을 stopPresets를 거치지 않고 만듭니다`);
  }
  if (!/routeFor\s*\(/.test(order) || !/openSideFor\s*\(/.test(order)) {
    err(`${ORDER}가 tradeContext 정본으로 경로·방향을 정하지 않습니다`);
  }
  if (!/scopeForTarget\s*\(/.test(order)) {
    err(`${ORDER}가 장부 범위를 정본으로 정하지 않습니다`);
  }
  if (!/return tradeMode === PAPER_TRADE_MODE;/.test(target)) {
    err(`${TARGET}의 모의 판정이 정본 상수 비교가 아닙니다 — 어휘가 갈리면 모드가 뒤바뀝니다`);
  }
  if (!/const PAPER_TRADE_MODE: TradeMode = 'PAPER';/.test(target)) {
    err(`${TARGET}의 모의 모드 이름이 TradeMode 타입에 묶여 있지 않습니다`);
  }
  for (const route of ['/api/binance/futures/order', '/api/binance/spot/order',
                       '/api/binance/coinm/order']) {
    if (sheet.includes(route)) err(`${SHEET}가 실거래 라우트를 직접 부릅니다 (${route})`);
  }
  // ★ 시장 화면이 실거래 라우트를 직접 부르지 않는다
  if (CONTRACT) for (const s of CONTRACT.MARKET_SCREENS) {
    const c = code(read(s.file));
    for (const route of ['/api/binance/', '/api/stock/order', '/api/paper/order']) {
      if (c.includes(route)) {
        err(`${s.file}가 주문 라우트를 직접 부릅니다 (${route}) — 주문은 정본 훅을 지납니다`);
      }
    }
  }
}

// ══════════════ ⑩ 상세의 칸은 출처가 정한다 ══════════════
{
  if (!/instrumentFieldPlan\s*\(/.test(detail)) {
    err(`${DETAIL}이 그려도 되는 칸을 정본에 묻지 않습니다`);
  }
  if (/(marketCap|dividendYield|peRatio)\s*(\|\||\?\?)\s*0/.test(detail)) {
    err(`${DETAIL}이 없는 값을 0으로 적습니다`);
  }
  const pos = code(read(POS));
  const locks = (pos.match(/<Locked\b/g) || []).length;
  if (!/function Locked\b/.test(pos)) {
    err(`${POS}에 잠긴 칸 부품이 없습니다`);
  }
  if (locks < 2) {
    err(`${POS}가 출처 없는 칸을 ${locks}곳만 잠급니다 — 미체결·내역 둘 다 출처가 없습니다`);
  }
  // ★ 거래 화면도 같다. **"0건"으로 채우지 않는다.**
  if (CONTRACT) for (const s of CONTRACT.MARKET_SCREENS) {
    const c = code(read(s.file));
    if (!s.own.includes('OPEN_ORDERS')) continue;
    // 미체결 칸은 잠근 칸이거나 실제 출처가 있어야 한다
    // ★ 주변에 잠긴 칸이 "있는가"를 보면 안 된다. 옆에 `0건` div를 하나
    //   더 만들어도 주변 검사는 통과한다 — 뮤테이션이 그 틈으로 살아남았다.
    //   그래서 **그 표식이 붙은 자리를 전부** 세고, 하나하나가 잠긴 칸인지 본다.
    const needle = `testid={fieldTestId('OPEN_ORDERS')}`;
    const all = c.split(needle).length - 1;
    const locked = (c.match(
      /<LockedField\s+testid=\{fieldTestId\('OPEN_ORDERS'\)\}/g) || []).length;
    if (all === 0) continue;
    if (locked !== all) {
      err(`${s.file}의 미체결 칸 ${all}곳 중 ${locked}곳만 잠겨 있습니다`
        + ' — 모의 장부에 대기 주문이라는 개념이 없습니다.'
        + ' "0건"이라고 적으면 기능이 있는데 비어 있는 것으로 읽힙니다');
    }
  }
}

// ══════════════ ⑪ 능력 없는 제품에 주문 버튼을 열지 않는다 ══════════════
{
  if (!/paperOrderUiWiring\s*\(/.test(order)) {
    err(`${ORDER}가 제품 능력표를 보지 않습니다 — 안 되는 제품에 주문 버튼이 열립니다`);
  }
  if (!/canOrder:\s*wiring\.canOrder/.test(order)) {
    err(`${ORDER}가 능력표 판정을 주문 판정에 넘기지 않습니다`);
  }
  // ★ 모의 경로가 없는 시장(COIN-M · 주식)은 실행 버튼이 **잠겨** 있어야 한다.
  //   열어 두면 눌러서 아무 일도 안 일어나거나 다른 시장으로 나간다.
  if (CONTRACT) for (const m of ['COIN_FUTURES', 'STOCK']) {
    const s = CONTRACT.MARKET_SCREENS.find(x => x.market === m);
    if (!s) { err(`${m} 화면 계약이 없습니다`); continue; }
    const c = code(read(s.file));
    const ctas = (c.match(/data-testid=\{?["'`][^"'`]*cta[^"'`]*["'`]\}?/g) || []).length;
    const disabled = (c.match(/\bdisabled\b/g) || []).length;
    if (ctas === 0) err(`${s.file}에 실행 버튼이 없습니다`);
    if (disabled === 0) {
      err(`${s.file}의 실행 버튼이 잠겨 있지 않습니다 — 모의 주문 경로가 없는 시장입니다`);
    }
    if (!/wiring\.reason|blocked|brokerReason/.test(c)) {
      err(`${s.file}가 왜 주문할 수 없는지 적지 않습니다 — 회색 버튼만 두지 않습니다`);
    }
  }
  // 잔고를 못 읽으면 닫힌다. 못 읽은 것을 0으로 접으면 "돈이 없다"로 읽힌다.
  if (!/const balanceUnknown = availableBalance == null;/.test(slider)) {
    err(`${SLIDER}가 잔고 못 읽음을 판정하지 않습니다`);
  }
  if (!/const locked = !!disabled \|\| balanceUnknown;/.test(slider)) {
    err(`${SLIDER}가 잔고를 못 읽어도 잠기지 않습니다`);
  }
  if (/availableBalance \|\| 0|Number\(availableBalance\) \|\| 0/.test(slider)) {
    err(`${SLIDER}가 못 읽은 잔고를 0으로 접습니다`);
  }
}

// ══════════════ ⑫ ★ 간편과 프로는 같은 판정을 쓴다 ══════════════
//
// 밀도는 표현이다. 밀도마다 주문 엔진을 따로 만들면 "프로에서만 수량이
// 다르게 나가는" 고장이 나고, 두 화면 다 정상으로 보인다.
{
  const iForm  = order.search(/\buseTradeForm\s*\(\{/);
  const iSell  = order.search(/\buseSellForm\s*\(\{/);
  const iLevel = order.search(/level === 'PRO'/);
  if (iForm < 0 || iSell < 0 || iLevel < 0) {
    err(`${ORDER}에서 판정 생성 또는 밀도 분기를 찾지 못했습니다`);
  } else if (iForm > iLevel || iSell > iLevel) {
    err(`${ORDER}가 밀도 분기 **뒤에서** 판정을 만듭니다 — 밀도마다 다른 엔진이 생깁니다`);
  }
  for (const hook of ['useTradeForm', 'useSellForm']) {
    const m = order.match(new RegExp(`\\b${hook}\\s*\\(\\{[\\s\\S]{0,700}?\\n  \\}\\)`));
    if (!m) { err(`${ORDER}의 ${hook} 인자를 읽지 못했습니다`); continue; }
    if (/\blevel\b|uiLevel|BEGINNER|PRO/.test(m[0])) {
      err(`${ORDER}의 ${hook}에 밀도가 들어갑니다 — 표현이 판정을 바꿉니다`);
    }
  }
  // 표현 컴포넌트는 판정을 **만들지 않고 받는다**
  const presenters = [BBUY, BSELL].concat(CONTRACT ? CONTRACT.MARKET_SCREENS.map(s => s.file) : []);
  for (const f of presenters) {
    const c = code(read(f));
    for (const hook of ['useTradeForm', 'useSellForm', 'submitGate', 'planSizing',
                        'usePaperLedger', 'buildPaperPlan']) {
      if (new RegExp(`\\b${hook}\\s*\\(`).test(c)) {
        err(`${f}가 판정을 직접 만듭니다 (${hook}) — 밀도별·시장별 엔진이 생깁니다`);
      }
    }
  }
  // ★ **개수로 본다.** 한 갈래만 `form={form}`이어도 정규식은 통과한다 —
  //   실제로 한쪽에만 복사본을 넘기는 뮤테이션이 그 틈으로 살아남았다.
  {
    const takers = (order.match(/<(SpotTradingScreen|UsdtFuturesTradingScreen|BeginnerBuyScreen)\b/g) || []).length;
    const sameForm = (order.match(/form=\{form\}/g) || []).length;
    if (takers === 0) err(`${ORDER}가 주문 판정을 받는 화면을 렌더하지 않습니다`);
    if (sameForm !== takers) {
      err(`${ORDER}의 주문 표현 ${takers}곳 중 ${sameForm}곳만 같은 판정을 받습니다`
        + ' — 한쪽에 복사본이 가면 두 화면이 다른 주문을 냅니다');
    }
    const sellTakers = (order.match(/<(SpotTradingScreen|UsdtFuturesTradingScreen|BeginnerSellScreen)\b/g) || []).length;
    const sameSell = (order.match(/sell=\{sell\}/g) || []).length;
    if (sameSell !== sellTakers) {
      err(`${ORDER}의 매도 표현 ${sellTakers}곳 중 ${sameSell}곳만 같은 판정을 받습니다`);
    }
  }
  // 격자(venue precision)는 화면에서 다시 맞추지 않는다
  for (const f of presenters) {
    const c = code(read(f));
    if (/normalizeForVenue|quantizeOrder|roundSpotQty|fetchVenueSpec/.test(c)) {
      err(`${f}가 거래소 격자를 화면에서 다시 맞춥니다 — 격자는 서버 정본입니다`);
    }
  }
}

// ══════════════ ⑬ 거래 화면이 주문할 수단을 잃지 않는다 ══════════════
//
// 화면을 넷으로 가른 뒤 생기는 새 고장: 한 시장의 화면만 비는 것.
{
  if (CONTRACT) {
    for (const m of ['SPOT', 'USDT_FUTURES']) {
      const s = CONTRACT.MARKET_SCREENS.find(x => x.market === m);
      const c = code(read(s.file));
      if (!/<OrderControls/.test(c)) {
        err(`${s.file}에 주문 조작부가 없습니다 — 주문할 수단을 잃습니다`);
      }
      if (!/<OrderEstimate/.test(c)) {
        err(`${s.file}가 증거금·수수료·청산가를 그리지 않습니다`);
      }
    }
  }
  // 예상값은 **스크롤 칸 밖**에 있어야 한다. 안에 넣으면 스크롤에 딸려
  // 사라지고, 얼마가 잠기는지 모른 채 누르게 된다.
  //
  // ★ 주석 표식으로 재지 않는다 — 옛 검사는 주석만 바꾸는 변경에 조용히
  //   통과했다(fail-open). 여는 div부터 짝이 맞는 닫는 태그까지 세어
  //   실제 바깥인지 본다.
  {
    const open = shell.indexOf('data-testid="trading-order-col"');
    const est = shell.indexOf('{p.estimate ?');
    if (open < 0) err(`${SHELL}의 주문 칸 표식을 찾지 못했습니다 — 구조를 확인할 수 없습니다`);
    else if (est < 0) err(`${SHELL}이 예상값 자리를 그리지 않습니다`);
    else {
      const from = shell.lastIndexOf('<div', open);
      let depth = 0, close = -1;
      const re = /<div\b|<\/div>/g;
      re.lastIndex = from;
      let m;
      while ((m = re.exec(shell))) {
        depth += m[0] === '</div>' ? -1 : 1;
        if (depth === 0) { close = m.index; break; }
      }
      if (close < 0) err(`${SHELL}의 주문 칸이 닫히지 않습니다`);
      else if (est < close) {
        err(`${SHELL}의 예상값이 스크롤 칸 안에 있습니다 — 스크롤에 딸려 사라집니다`);
      }
    }
  }
  // 실행 버튼 줄을 **붙이지 않는다.** 실측에서 붙인 줄이 슬라이더를 덮어
  // 보이는데 눌리지 않는 상태가 됐다.
  const cta = shell.match(/data-testid="trading-cta"[\s\S]{0,260}?\}\}/);
  if (!cta) err(`${SHELL}에 실행 버튼 줄이 없습니다`);
  else if (/position:\s*'sticky'|position:\s*'fixed'/.test(cta[0])) {
    err(`${SHELL}의 실행 버튼 줄이 다시 붙었습니다 — 슬라이더를 덮습니다`);
  }
  // 넘치면 자르지 않고 **스크롤한다.**
  //
  // ★ 파일에 `overflowY: 'auto'`가 있는지만 보면 안 된다. 바깥 통에도
  //   하나 있어서, **주문 칸만** 잘라도 검사가 통과했다 — 뮤테이션이
  //   그 틈으로 살아남았다. 칸마다 따로 본다.
  //
  //   주문 칸이 잘리면 넘친 줄이 그냥 사라진다. 이 저장소에서 실제로
  //   경고 한 줄이 늘자 [숏 진입]이 잘려 나가고 [롱 진입]만 남았다.
  //   화면은 아무 문제도 없어 보인다 — **숏을 치려던 사람이 눈앞의
  //   유일한 버튼을 누르면 롱이 나간다.**
  for (const [label, anchor] of [
    ['바깥 통', 'data-region="tradingScreen"'],
    ['주문 칸', 'data-testid="trading-order-col"'],
  ]) {
    const at = shell.indexOf(anchor);
    if (at < 0) { err(`${SHELL}에서 ${label} 표식을 찾지 못했습니다`); continue; }
    // 그 표식이 붙은 태그의 style 블록(다음 `}}` 까지)만 본다
    const seg = shell.slice(at, shell.indexOf('}}', at) + 2);
    if (!/overflowY: 'auto'/.test(seg)) {
      err(`${SHELL}의 ${label}이 넘칠 때 스크롤하지 않습니다`
        + ' — 넘친 줄이 말없이 사라지고, 그게 주문 버튼일 수 있습니다');
    }
  }
  // 첫 화면 높이를 **재서** 쓴다. 상수로 박으면 종목 이름이 길어지거나
  // 경고 한 줄이 늘어난 날 주문 버튼이 조용히 화면 밖으로 밀린다.
  //
  // ★ 이름이 아니라 **파생**을 본다. `useMeasuredHeight`가 파일 어딘가에
  //   있는지만 보면, 본문 높이를 상수로 바꿔도 통과한다.
  {
    const m = shell.match(/const bodyH = [^;]+;/);
    if (!m) err(`${SHELL}에서 첫 화면 본문 높이 계산을 찾지 못했습니다`);
    // ★ `botH`(예상값+실행버튼)를 안 빼면 실행 버튼이 첫 화면 **밖으로**
    //   밀린다. 360×660 실측에서 638~697px에 놓였다 — 요소는 DOM에 있고
    //   크기도 0이 아니라, 있는지만 보는 검사로는 전부 통과했다.
    else if (!/boxH/.test(m[0]) || !/topH/.test(m[0]) || !/botH/.test(m[0])) {
      err(`${SHELL}의 첫 화면 높이가 잰 값 셋(boxH·topH·botH)에서 나오지 않습니다`
        + ` (${m[0].trim()}) — 하나라도 빼먹으면 실행 버튼이 화면 밖으로 밀립니다`);
    }
    for (const v of ['boxH', 'topH', 'botH']) {
      if (!new RegExp(`\\[\\w+Ref, ${v}\\] = useMeasuredHeight`).test(shell)) {
        err(`${SHELL}의 ${v}가 useMeasuredHeight에서 나오지 않습니다`);
      }
    }
  }
}

// ══════════════ ⑭ 포지션은 주문이 간 장부에서 읽는다 ══════════════
{
  const row = code(read('src/components/trading/PositionRow.tsx'));
  const pos = code(read(POS));
  if (!row) err('포지션 줄이 없습니다 — 주문한 포지션을 확인할 곳이 없습니다');

  if (/\/api\/paper\/account/.test(row)) {
    err('포지션 줄이 /api/paper/account를 읽습니다 — 그 라우트는 늘 기본 계좌입니다');
  }
  if (/\/api\/paper\/positions/.test(row)) {
    err('포지션 줄이 포지션을 다시 조회합니다 — 화면이 이미 가진 장부를 써야 합니다');
  }
  for (const hook of ['usePaperAccount', 'useBinanceStream', 'usePaperLedger', 'usePaperTarget']) {
    if (new RegExp(`${hook}\\s*\\(`).test(row)) {
      err(`포지션 줄이 스스로 장부를 읽습니다 (${hook}) — props로 받은 정본만 씁니다`);
    }
  }
  if (!/'\/api\/paper\/close'/.test(row)) {
    err('포지션 줄이 기존 청산 경로를 쓰지 않습니다');
  }
  for (const banned of [/paper_account_id/, /accountId/, /fillPrice:/, /realizedPnl/, /unrealized/]) {
    if (banned.test(row)) {
      err(`포지션 줄이 계좌·손익을 스스로 다룹니다 (${banned}) — 정본에 없는 값을 만들지 않습니다`);
    }
  }

  // 거래 탭과 거래 화면 **둘 다** 자기 장부를 넘기는가
  for (const [file, src] of [[POS, pos],
    ...(CONTRACT ? CONTRACT.MARKET_SCREENS
      .filter(s => s.own.includes('POSITIONS') && s.market === 'USDT_FUTURES')
      .map(s => [s.file, code(read(s.file))]) : [])]) {
    const rows = (src.match(/<PositionRow/g) || []).length;
    const fed = (src.match(/positions=\{positions\}/g) || []).length;
    const reloads = (src.match(/onClosed=\{(ledger|p\.ledger)\.reload\}/g) || []).length;
    if (rows === 0) { err(`${file}가 포지션 줄을 그리지 않습니다`); continue; }
    if (fed !== rows) err(`${file}의 포지션 줄 ${rows}곳 중 ${fed}곳만 자기 장부를 받습니다`);
    if (reloads !== rows) {
      err(`${file}의 포지션 줄 ${rows}곳 중 ${reloads}곳만 청산 뒤 장부를 다시 읽습니다`);
    }
  }
  if (!/const positions = auth \? ledger\.openPositions : \[\]/.test(pos)) {
    err(`${POS}의 포지션 출처가 usePaperLedger가 아닙니다 — 계좌가 갈립니다`);
  }
}

// ══════════════ ⑮ 사유는 한 곳에서, 값은 자르지 않는다 ══════════════
{
  for (const dup of ['sizing-locked', 'sizing-reason']) {
    if (slider.includes(dup)) {
      err(`${SLIDER}가 사유를 다시 그립니다 (${dup}) — 같은 문장이 두 번 보입니다`);
    }
  }
  const spots = (sheet.match(/data-testid="order-blocked-reason"/g) || []).length;
  if (spots !== 1) err(`잠금 사유를 그리는 곳이 ${spots}곳입니다 — 정확히 한 곳이어야 합니다`);

  for (const [name, body] of [['OrderControls', sheet], ['SizingSlider', slider]]) {
    if (/textOverflow: 'ellipsis'/.test(body)) {
      err(`${name}이 값을 …로 잘라 통과시킵니다 — 잘린 숫자는 자릿수를 잘못 세게 합니다`);
    }
    if (!/overflowWrap: 'anywhere'/.test(body)) {
      err(`${name}이 좁을 때 줄을 나누지 않습니다 — 값이 잘립니다`);
    }
  }
  if (!/<SizingSlider/.test(sheet)) err(`${SHEET}에 사이징 슬라이더가 없습니다`);
  if (/손절<br\s*\/?>거리/.test(sheet)) {
    err('손절거리 라벨에 강제 줄바꿈이 있습니다 — 두 칸 이름으로 읽힙니다');
  }
  if (!/STOP_PCTS\.map\s*\(/.test(sheet)) {
    err(`${SHEET}가 손절 거리 프리셋을 그리지 않습니다 — 선물은 손절이 필수라 주문이 막힙니다`);
  }
  for (const legacy of ['setByRisk', '위험 0.5', '[0.5, 1, 2]']) {
    if (sheet.includes(legacy)) err(`주문 조작부에 옛 위험 역산 사이징이 따라왔습니다 (${legacy})`);
  }
  if (/\[25,\s*50,\s*75,\s*100\]/.test(sheet)) {
    err('주문 조작부가 사이징 퍼센트 줄을 슬라이더와 별도로 또 그립니다');
  }
  for (const banned of [/>\s*지정가\s*</, /['"]LIMIT['"]/, /\bBBO\b/, /orderType/]) {
    if (banned.test(sheet)) {
      err(`주문 조작부에 대기 주문 UI가 있습니다 (${banned}) — 모의 백엔드에 그 개념이 없습니다`);
    }
  }
}

// ══════════════ ⑯ 도달할 수 없는 화면을 되살리지 않는다 ══════════════
{
  const tp = code(read('src/components/pages/TradingPage.tsx'));
  if (/<PaperOrderScreen|<InstrumentDetail|<TradingScreenShell|PriceChart|SizingSlider/.test(tp)) {
    err('도달할 수 없는 TradingPage에 정본 부품이 붙었습니다 — 거기서는 아무도 볼 수 없습니다');
  }
  // 옛 원스크린 통합 대시보드를 이름만 바꿔 되살리지 않는다
  for (const gone of ['TradingWorkspace', 'oneScreen']) {
    for (const f of walk('src')) {
      if (new RegExp(`from '@/[^']*${gone}'|<${gone}\\b`).test(read(f))) {
        err(`${f}가 옛 통합 거래 화면을 되살립니다 (${gone})`);
      }
    }
  }
}


// ══════════════ ⑰ ★ 시장 탭 — 넷이 있고, 넷 다 실제로 들어가진다 ══════════════
//
// 탭만 만들고 화면을 안 붙이면 사용자는 누를 수 있는데 아무 일도 안 일어난다.
// 이 저장소의 1번 고장이고, 화면을 봐서는 "준비 중인가 보다"로 읽힌다.
{
  const tabs = code(read(TABS_SRC));
  const tabsUi = code(read(TABS_UI));

  // ⑴ 넷이 정본 순서로 있다
  const m = tabs.match(/export const MARKET_TABS[\s\S]{0,600}?\n\];/);
  if (!m) err(`${TABS_SRC}에서 시장 탭 목록을 찾지 못했습니다`);
  else {
    const ids = [...m[0].matchAll(/id:\s*'([A-Z]+)'/g)].map(x => x[1]);
    const want = ['SPOT', 'USDM', 'COINM', 'STOCK'];
    if (ids.join(',') !== want.join(',')) {
      err(`시장 탭이 [${ids.join(', ') || '없음'}]입니다 — [${want.join(', ')}] 순서여야 합니다`);
    }
  }

  // ⑵ 탭 줄이 **목록을 그린다**. 손으로 적으면 목록과 화면이 갈린다.
  if (!/MARKET_TABS\.map\s*\(/.test(tabsUi)) {
    err(`${TABS_UI}가 시장 탭 정본 목록을 그리지 않습니다 — 손으로 적으면 탭과 화면이 갈립니다`);
  }
  // 좁아도 숨기지 않는다 — 가로 스크롤이고 줄바꿈·드롭다운이 아니다
  if (!/overflowX: 'auto'/.test(tabsUi)) {
    err(`${TABS_UI}가 좁을 때 가로로 스크롤하지 않습니다`);
  }
  if (/flexWrap: 'wrap'/.test(tabsUi)) {
    err(`${TABS_UI}가 탭을 두 줄로 접습니다 — 접으면 그 시장이 없는 것으로 읽힙니다`);
  }
  for (const banned of ['<select', 'Dropdown', 'BottomSheet']) {
    if (tabsUi.includes(banned)) {
      err(`${TABS_UI}가 시장을 ${banned}에 숨깁니다 — 네 시장은 늘 보여야 합니다`);
    }
  }
  // 고른 시장이 보인다
  if (!/data-active=/.test(tabsUi) || !/aria-selected=/.test(tabsUi)) {
    err(`${TABS_UI}가 지금 고른 시장을 표시하지 않습니다`);
  }

  // ⑶ 탭이 **실제 화면까지 간다** (UI만 있고 도달 불가 → 실패)
  const route = code(read(ROUTE));
  if (!/export function tradingScreenForTab/.test(route)) {
    err(`${ROUTE}에 탭→화면 경로가 없습니다`);
  }
  if (!/<MarketTabs/.test(shell)) {
    err(`${SHELL}이 시장 탭을 붙이지 않습니다 — 만들어 놓고 배선하지 않은 상태입니다`);
  }
  if (!/onMarket=\{p\.onMarket\}/.test(shell)) {
    err(`${SHELL}이 탭 선택을 위로 올리지 않습니다 — 눌러도 화면이 안 바뀝니다`);
  }
  // host가 네 화면을 **전부** 렌더하는가
  if (CONTRACT) for (const sc of CONTRACT.MARKET_SCREENS) {
    const comp = sc.file.split('/').pop().replace('.tsx', '');
    if (!new RegExp(`<${comp}\\b`).test(order)) {
      err(`${ORDER}가 ${comp}을 렌더하지 않습니다 — 그 탭은 눌러도 도달할 수 없습니다`);
    }
  }
  // 탭 상태가 밀도 분기보다 **위**에 있는가 (아래면 밀도마다 다른 탭이 생긴다)
  {
    const iTab = order.search(/useState<TradingMarketId>/);
    const iLevel = order.search(/level === 'PRO'/);
    if (iTab < 0) err(`${ORDER}에 시장 탭 상태가 없습니다`);
    else if (iTab > iLevel) {
      err(`${ORDER}가 밀도 분기 뒤에서 시장 탭 상태를 만듭니다`);
    }
  }

  // ⑷ 모르는 시장에 **기본값을 주지 않는다**
  //
  // ★ `throw`가 파일에 있는지만 보면 안 된다. 그 앞에 이른 return 한 줄을
  //   끼우면 던지는 줄은 그대로 남고 동작만 바뀐다 — `tradingScreenFor`에서
  //   똑같은 뮤테이션이 그 틈으로 살아남았고, 여기서도 살아남았다.
  {
    const body = tabs.match(/export function marketTypeOfTab\([\s\S]*?\n\}/);
    if (!body) err(`${TABS_SRC}에서 탭→시장유형 함수를 찾지 못했습니다`);
    else {
      const returns = body[0].match(/return\s+[^;]+;/g) || [];
      if (returns.length !== 1 || !/^return\s+t;$/.test(returns[0].trim())) {
        err(`${TABS_SRC}의 탭→시장유형 함수가 ${returns.length}가지로 빠져나갑니다`
          + ` [${returns.join(' ')}] — 모르는 시장에 기본 시장을 주면`
          + ' 선물 주문이 현물로 나갈 수 있습니다');
      }
      if (!/throw new Error/.test(body[0])) {
        err(`${TABS_SRC}가 모르는 탭에 대해 던지지 않습니다`);
      }
    }
  }
  // 이름도 지어 주지 않는다. 모르는 시장이 '현물'로 보이면 그게 더 나쁘다.
  {
    const body = tabs.match(/export function marketTabLabel\([\s\S]*?\n\}/);
    if (!body) err(`${TABS_SRC}에서 탭 이름 함수를 찾지 못했습니다`);
    else {
      const returns = body[0].match(/return\s+[^;]+;/g) || [];
      if (returns.length !== 1 || !/^return\s+t\.label;$/.test(returns[0].trim())) {
        err(`${TABS_SRC}의 탭 이름 함수가 ${returns.length}가지로 빠져나갑니다`
          + ` [${returns.join(' ')}] — 모르는 시장에 이름을 지어 주면 배선 누락이 숨습니다`);
      }
    }
  }
  // 밖에서 온 값도 모르면 null이다 (기본 시장으로 떨어뜨리지 않는다)
  if (!/export function readMarketTab[\s\S]{0,700}?\n  return null;\n\}/.test(tabs)) {
    err(`${TABS_SRC}의 탭 읽기가 모르는 값을 null로 돌려주지 않습니다`);
  }

  // ⑸ COINM·STOCK을 **정체성 단계에서 버리지 않는다**
  //
  //   예전에는 `readTradeContext`가 두 시장을 통째로 null로 버려서 탭에
  //   들어가는 것 자체가 불가능했다. 정체성(어느 시장인가)과 가용성(종목이
  //   있는가)은 다른 사실이다.
  const instr = code(read(INSTR));
  for (const mk of ['COINM', 'STOCK']) {
    if (new RegExp(`market === '${mk}'[\\s\\S]{0,80}return null`).test(instr)) {
      err(`${INSTR}가 ${mk}를 시장 정체성 단계에서 버립니다 — 탭 진입 자체가 막힙니다`);
    }
  }
  if (!/export function instrumentForMarket/.test(instr)) {
    err(`${INSTR}에 종목 가용성 판정이 없습니다`);
  }
  // 가용성은 **세 값**을 따로 들고 다닌다 (없는 것을 0으로 적지 않기 위해)
  for (const field of ['instrument:', 'tradable:', 'reason:']) {
    if (!instr.includes(field)) err(`${INSTR}에 ${field} 칸이 없습니다`);
  }
}

// ══════════════ ⑱ ★ 시장을 바꿀 때 심볼을 지어내지 않는다 ══════════════
//
// 탭을 누르면 가장 하고 싶어지는 일이 "들고 있던 심볼을 그 시장 것으로
// 바꾸기"다. 전부 금지다 — 특히 `BTCUSDT(현물) → BTCUSDT(USDⓈ-M)`가
// 위험하다. **그럴듯해서 아무도 의심하지 않는다.**
{
  const instr = code(read(INSTR));

  // ⑴ 종목이 생기는 **모든** 자리가 확인된 출처를 그대로 복사한다
  //
  // ★ 예전 규칙은 "자리가 정확히 한 곳"이었다. 출처가 ENTRY 하나뿐일 때는
  //   맞았지만, 목록(CATALOG)이 생기면서 자리가 둘이 됐다. 개수를 세는
  //   규칙은 **출처가 늘면 못 쓰게 되고**, 늘릴 때 규칙을 지우고 싶어진다.
  //
  //   그래서 개수가 아니라 **무엇을 넣는지**를 본다. 확인된 출처의 값을
  //   그대로 복사하는 것만 통과하고, 문자열·템플릿·이어붙이기는 전부
  //   실패한다. 출처가 늘어도 규칙은 그대로 강하다.
  const ALLOWED_SYMBOL_SRC = [
    /^entry\.symbol$/,   // 사용자가 들고 온 종목
    /^row\.symbol$/,     // 거래소 상장 목록의 한 줄
  ];
  const makes = (instr.match(/symbol:\s*[^,\n]+/g) || [])
    .filter(x => !/symbol:\s*string/.test(x))
    .map(x => x.replace(/^symbol:\s*/, '').trim().replace(/,$/, ''));
  if (makes.length === 0) {
    err(`${INSTR}에서 종목을 만드는 자리를 찾지 못했습니다 — 구조를 확인할 수 없습니다`);
  }
  for (const m of makes) {
    if (!ALLOWED_SYMBOL_SRC.some(re => re.test(m))) {
      err(`${INSTR}가 확인되지 않은 값으로 종목을 만듭니다 (symbol: ${m})`
        + ' — 확인된 출처(들고 온 종목 · 거래소 목록)를 그대로 복사해야 합니다');
    }
  }
  // ★ **그 한 곳이 시장 일치를 확인하는가.** 값을 그대로 쓰는 것만으로는
  //   부족하다 — 조건에서 `entry.market === market`을 빼면 현물 종목이
  //   선물 화면의 종목이 된다. 그게 "이름이 같다고 같은 상품 취급"이다.
  //   뮤테이션이 정확히 그 틈으로 살아남았다.
  if (!/entry\.market === market/.test(instr)) {
    err(`${INSTR}가 종목을 쓰기 전에 시장 일치를 확인하지 않습니다`
      + ' — 현물 종목이 선물 화면의 종목이 됩니다');
  }
  // ★ 저장할 때와 꺼내 쓸 때 **둘 다** 시장을 확인한다.
  //   한쪽만 보면 다른 쪽으로 새고, 조건문을 `if (false)`로 바꾸는 것만으로
  //   방어가 사라진다 — 조건식 자체를 본다.
  if (!/if \(next && next\.market !== market\)/.test(instr)) {
    err(`${INSTR}가 다른 시장의 종목을 그 시장 칸에 저장하는 것을 막지 않습니다`
      + ' — 탭을 옮기면 심볼이 따라옵니다');
  }
  if (!/if \(picked\.market !== market\)/.test(instr)) {
    err(`${INSTR}가 저장된 종목의 시장을 확인하지 않고 씁니다`);
  }

  // ⑵ 계약 심볼을 **조립하지 않는다**
  const forge = [/USD_PERP['"`]/, /\+\s*['"`]USDT['"`]/, /\$\{[^}]*\}USDT/,
                 /\$\{[^}]*\}USD_/, /replace\([^)]*\)\s*\+\s*['"`]/];
  const screens = CONTRACT ? CONTRACT.MARKET_SCREENS.map(x => x.file) : [];
  for (const f of [INSTR, ORDER, ...screens]) {
    const c = code(read(f));
    for (const re of forge) {
      if (re.test(c)) {
        err(`${f}가 시장 전환용 심볼을 조립합니다 (${re}) — 이름이 같다고 같은 상품이 아닙니다`);
      }
    }
  }

  // ⑶ 화면은 종목을 **받기만** 한다. 없으면 null이다.
  for (const f of screens) {
    const c = code(read(f));
    if (!/const sym = p\.instrument\?\.symbol \?\? null;/.test(c)) {
      err(`${f}가 종목을 가용성 판정에서 받지 않습니다`);
    }
    if (/\bp\.symbol\b/.test(c)) {
      err(`${f}가 종목을 props로 직접 들고 있습니다 — 없을 수 있는 값을 문자열로 다루면`
        + ' 빈 심볼로 조회를 보내게 됩니다');
    }
  }
}

// ══════════════ ⑲ ★ 종목이 없으면 주문이 잠긴다 (REACHABLE != TRADABLE) ══════════════
{
  const screens = CONTRACT ? CONTRACT.MARKET_SCREENS.map(x => x.file) : [];
  for (const f of screens) {
    const c = code(read(f));
    // 시장마다 못 누르는 사유가 더 있을 수 있다(모의 경로 없음 · 증권사
    // 미연결 · 휴장). 그것들을 **한 값으로 접는 것**은 옳다 — 접어야
    // 버튼마다 빠뜨리지 않는다. 다만 그 값이 "종목 없음"을 반드시 포함해야 한다.
    const lock = c.match(/const locked = [^;]+;/);
    if (!lock) err(`${f}가 "종목 없음"을 잠금으로 바꾸지 않습니다`);
    else if (!/sym == null/.test(lock[0])) {
      err(`${f}의 잠금 판정에 "종목 없음"이 빠졌습니다 (${lock[0].trim()})`);
    }
    // 실행 버튼마다 그 잠금을 본다. **하나라도 빠지면 그 버튼이 열린다.**
    const ctas = [...c.matchAll(/data-testid=(?:\{`|")[^"`]*cta[^"`]*(?:`\}|")([\s\S]{0,420}?)>/g)];
    if (ctas.length === 0) err(`${f}에 실행 버튼이 없습니다`);
    // ★ `disabled`가 있는지만 보면 안 된다. `locked ||`만 떼면 버튼은
    //   여전히 `disabled`를 갖고 있고 검사는 통과한다 — 뮤테이션이 그
    //   틈으로 살아남았다. **`locked`라는 판정 자체**를 본다.
    for (const [i, cta] of ctas.entries()) {
      // ★ 버튼 어딘가에 `locked`가 있는지만 보면 안 된다. `title`에 사유를
      //   적어 두면 `disabled`에서 빼도 통과한다 — 뮤테이션이 그 틈으로
      //   살아남았다. **누를 수 있는가를 정하는 식**만 본다.
      const gate = /(?:disabled|locked)=\{([^}]*)\}/.exec(cta[1]);
      if (!gate) {
        err(`${f}의 실행 버튼 ${i + 1}번에 잠금 식이 없습니다`);
      } else if (!gateSeesLocked(c, gate[1])) {
        err(`${f}의 실행 버튼 ${i + 1}번이 "종목 없음"(locked)을 보지 않습니다`
          + ` (${gate[0]}) — 종목이 없는데 눌리면 아무 일도 안 일어나거나`
          + ' 엉뚱한 종목으로 나갑니다');
      }
    }
    // 왜 못 하는지 적는다 — 회색 버튼만 두지 않는다
    if (!/instrumentReason/.test(c)) {
      err(`${f}가 종목이 없는 이유를 화면에 적지 않습니다`);
    }
  }
  // ★ 버튼 글자가 **이 화면의 시장**에서 나오는가.
  //
  //   `form.sideLabel`은 사용자가 들어올 때의 시장에 묶여 있다. 현물로
  //   들어와 USDⓈ-M 탭을 누르면 선물 화면에 `BUY`/`SELL`이 찍힌다 —
  //   실기 스크린샷에서 실제로 그렇게 나왔다. 시장 의미가 탭 전환으로
  //   새는 경로이고, 칸 검사로는 안 잡힌다(글자이지 칸이 아니라서).
  if (CONTRACT) for (const sc of CONTRACT.MARKET_SCREENS) {
    const c = code(read(sc.file));
    if (/form\.sideLabel\s*\(/.test(c)) {
      err(`${sc.file}가 버튼 글자를 진입 시장 훅에서 가져옵니다 (form.sideLabel)`
        + ' — 탭을 바꾸면 그 시장의 말이 아닌 글자가 찍힙니다');
    }
  }

  // 껍데기가 그 사유를 실제로 그리는가
  if (!/data-testid="instrument-unavailable"/.test(shell)) {
    err(`${SHELL}이 "종목 없음" 사유를 그리지 않습니다 — 빈 칸은 0으로 읽힙니다`);
  }
}

// ══════════════ ⑳ ★ 다른 시장의 시세·봉·호가를 빌려 쓰지 않는다 ══════════════
//
// COIN-M 화면에 USDⓈ-M 호가를 놓으면 사용자는 그것을 이 계약의 호가로 읽고
// 그 값으로 주문을 정한다. 실제로 그렇게 짜여 있었고 여기서 걷어냈다.
{
  if (CONTRACT) for (const sc of CONTRACT.MARKET_SCREENS) {
    const c = code(read(sc.file));
    const own = OWN_FEED[sc.market];

    for (const call of (c.match(/<OrderBookView[\s\S]{0,200}?\/>/g) || [])) {
      const mk = /market="([A-Z]+)"/.exec(call);
      if (own == null) {
        err(`${sc.file}가 다른 시장의 호가를 빌려 씁니다 — 이 시장의 호가 출처가 없습니다`);
      } else if (!mk || mk[1] !== own) {
        err(`${sc.file}의 호가가 ${mk ? mk[1] : '기본값'} 시장입니다 — ${own}이어야 합니다`);
      }
    }
    for (const src of (c.match(/chartSource=\{[\s\S]{0,160}?\}\}/g) || [])) {
      const mk = /market: '([A-Z]+)'/.exec(src);
      if (own == null && mk) {
        err(`${sc.file}가 다른 시장의 봉을 빌려 그립니다 (${mk[1]})`);
      } else if (own != null && mk && mk[1] !== own) {
        err(`${sc.file}의 봉이 ${mk[1]} 시장입니다 — ${own}이어야 합니다`);
      }
    }
    // 출처가 없는 시장은 **없다고 적는다** (빈 칸으로 두지 않는다)
    if (own == null && !/chartSource=\{null\}/.test(c)) {
      err(`${sc.file}가 봉 출처 없음을 명시하지 않습니다`);
    }
  }
}

// ══════════════ ㉑ ★ 화면과 주문이 **같은 종목**을 본다 ══════════════
//
// Phase 1에 남아 있던 구멍이다. `stream`·`form`·`sell`·`wiring`이 전부
// **들어올 때의 문맥**(`ctx`)에 묶여 있었고, 시장 탭이 잠겨 있어서 드러나지
// 않았다. 종목 선택을 여는 순간 이렇게 된다:
//
//     화면 헤더    USDⓈ-M · ETHUSDT
//     실제 주문    SPOT · BTCUSDT      ← 사용자는 알 수 없다
//
// 오류도 경고도 없다. 이 저장소에서 가장 비싼 종류의 고장이다.
{
  const hook = code(read(FORMHOOK));
  const ident = code(read(IDENT));

  // ⑴ 시세·판정·능력표가 **활성 정체성**에서 온다 — `ctx`에서 오지 않는다
  for (const [what, re] of [
    ['시세', /useBinanceStream\(\s*activeSymbol/],
    ['매수 판정', /useTradeForm\(\{[\s\S]{0,200}?symbol:\s*activeSymbol/],
    ['매도 판정', /useSellForm\(\{[\s\S]{0,200}?symbol:\s*activeSymbol/],
    ['능력표', /paperOrderUiWiring\(\s*\n?\s*activeMarket/],
  ]) {
    if (!re.test(order)) {
      err(`${ORDER}의 ${what}이 활성 정체성에서 오지 않습니다`
        + ' — 화면과 주문이 다른 종목을 보게 됩니다');
    }
  }
  // ⑵ 들어올 때의 문맥을 **시세·판정에 다시 쓰지 않는다**
  for (const re of [
    /useBinanceStream\([^)]*ctx\.symbol/,
    /useTradeForm\(\{[\s\S]{0,300}?symbol:\s*ctx\.symbol/,
    /useSellForm\(\{[\s\S]{0,300}?symbol:\s*ctx\.symbol/,
    /paperOrderUiWiring\(\s*ctx\.market\s*\)/,
  ]) {
    if (re.test(order)) {
      err(`${ORDER}가 시장 전환 뒤에도 최초 문맥을 씁니다 (${re})`
        + ' — 탭을 바꿔도 예전 종목으로 주문이 나갑니다');
    }
  }
  // ⑶ 폼이 **자기 정체성을 값으로 내보낸다** (화면이 비교할 수 있어야 한다)
  if (!/symbol:\s*i\.symbol,\s*market:\s*i\.market,/.test(hook)) {
    err(`${FORMHOOK}이 자기 정체성을 값으로 내보내지 않습니다`
      + ' — 화면과 같은 종목인지 확인할 방법이 없습니다');
  }
  // 주문 본문도 같은 정체성이어야 한다.
  //
  // ★ 파일 전체에서 찾으면 안 된다. 같은 모양이 미리보기 계산에도 있어서,
  //   **전송 본문만 바꿔도** 다른 쪽이 조건을 대신 만족시킨다 — 뮤테이션이
  //   그 틈으로 살아남았다. 실제로 나가는 본문 구간만 잘라서 본다.
  {
    const from = hook.indexOf('const body: any = {');
    const to = hook.indexOf("fetch('/api/paper/order'");
    if (from < 0 || to < 0 || to < from) {
      err(`${FORMHOOK}에서 주문 전송 본문을 찾지 못했습니다 — 구조를 확인할 수 없습니다`);
    } else {
      const body = hook.slice(from, to);
      if (!/symbol:\s*i\.symbol\b/.test(body) || !/market:\s*i\.market\b/.test(body)) {
        err(`${FORMHOOK}의 주문 전송 본문이 폼 정체성과 다른 값을 씁니다`
          + ' — 화면이 보여준 종목과 다른 종목이 나갑니다');
      }
    }
  }
  // ⑷ 화면이 그 값을 실제로 드러낸다 (프로브가 눈으로 비교한다)
  for (const attr of ['data-active-symbol', 'data-form-symbol', 'data-form-market']) {
    if (!order.includes(attr)) {
      err(`${ORDER}가 ${attr}를 드러내지 않습니다 — 정체성 일치를 확인할 수 없습니다`);
    }
  }
  // ⑸ 정체성이 어긋나면 **활성으로 만들지 않는다**
  if (!/if \(instrument\.market !== market\) return null;/.test(ident)) {
    err(`${IDENT}가 시장이 어긋난 종목을 활성으로 만듭니다`);
  }
}

// ══════════════ ㉒ ★ 상장 목록은 거래소가 말한 것만 ══════════════
{
  const cat = code(read(CATALOG));
  const api = code(read(CAT_API));

  // ⑴ 목록 파서가 **심볼을 만들지 않는다**
  for (const re of [/\+\s*['"`]USDT['"`]/, /\$\{[^}]*\}USDT/, /USD_PERP/,
                    /baseAsset:\s*['"`]/, /symbol:\s*['"`][A-Z]/]) {
    if (re.test(cat)) {
      err(`${CATALOG}가 종목을 만들어냅니다 (${re}) — 응답에 있는 줄만 종목입니다`);
    }
  }
  // ⑵ 거래 가능 조건을 **파서마다** 본다
  //
  // ★ 파일 전체에서 찾으면 한쪽 파서에서 조건을 떼어도 다른 파서가 대신
  //   만족시킨다 — 뮤테이션이 그 틈으로 살아남았다.
  for (const [fn, needs] of [
    ['parseSpotCatalog', [
      ['거래중', /str\(r\?\.status\) !== 'TRADING'/],
      ['결제통화', /quoteAsset !== CATALOG_QUOTE/],
    ]],
    ['parseUsdmCatalog', [
      ['거래중', /str\(r\?\.status\) !== 'TRADING'/],
      ['무기한 계약', /str\(r\?\.contractType\) !== 'PERPETUAL'/],
      ['결제통화', /quoteAsset !== CATALOG_QUOTE/],
    ]],
  ]) {
    const m = cat.match(new RegExp(`export function ${fn}\\([\\s\\S]*?\\n\\}`));
    if (!m) { err(`${CATALOG}에서 ${fn}을 찾지 못했습니다`); continue; }
    for (const [what, re] of needs) {
      if (!re.test(m[0])) err(`${CATALOG}의 ${fn}이 ${what} 조건을 확인하지 않습니다`);
    }
  }
  // ⑶ COIN-M·주식 목록 권위를 열지 않는다
  {
    // ★ `TradingMarketId[]`의 `]` 때문에 배열에 닿기 전에 끊기던 정규식을
    //   고쳤다. **대입식 뒤의 배열 리터럴만** 잘라서 본다.
    const lit = cat.match(/CATALOG_MARKETS[^=]*=\s*\[([^\]]*)\]/);
    if (!lit) err(`${CATALOG}에서 목록 권위 시장 배열을 찾지 못했습니다`);
    else for (const m of ['COINM', 'STOCK']) {
      if (lit[1].includes(`'${m}'`)) {
        err(`${CATALOG}가 ${m} 목록 권위를 엽니다 (${lit[1].trim()}) — 아직 출처가 없습니다`);
      }
    }
  }
  // ★ 열림 판정도 **두 시장만** 명시해야 한다. `!== 'COINM'` 같은 부정으로
  //   쓰면 주식이 조용히 열린다.
  {
    const fn = cat.match(/export function catalogOpenFor\([\s\S]*?\n\}/);
    if (!fn) err(`${CATALOG}에서 목록 열림 판정을 찾지 못했습니다`);
    else if (!/market === 'SPOT' \|\| market === 'USDM'/.test(fn[0])) {
      err(`${CATALOG}의 목록 열림 판정이 두 시장을 명시하지 않습니다`
        + ' — 출처 없는 시장이 조용히 열립니다');
    }
  }
  // ★ 주식 mock을 근거로 쓰지 않는다는 사실을 값에 적어 둔다
  if (!/mock/.test(read(CATALOG))) {
    err(`${CATALOG}가 주식 시세의 mock fallback을 사유에 적지 않습니다`
      + ' — 목록이 보이는 것과 거래할 수 있는 것은 다른 사실입니다');
  }
  // ⑷ 서버가 COIN-M·주식 조회 주소를 갖지 않는다
  for (const m of ['COINM', 'STOCK']) {
    if (new RegExp(`${m}:\\s*['"\`]https`).test(api)) {
      err(`${CAT_API}가 ${m} 조회 주소를 갖고 있습니다 — 목록 권위가 없는 시장입니다`);
    }
  }
  // ⑸ 실패를 **빈 목록으로** 돌려주지 않는다
  if (!/error: 'empty_catalog'/.test(api)) {
    err(`${CAT_API}가 "0건"과 "못 읽음"을 구별하지 않습니다`
      + ' — 0건은 화면에 "이 시장에 종목이 없다"로 그려집니다');
  }
  if (/ok:\s*true[\s\S]{0,80}instruments:\s*\[\]/.test(api)) {
    err(`${CAT_API}가 실패를 빈 목록으로 성공 처리합니다`);
  }
  // ⑹ 화면도 못 읽음과 0건을 다른 문장으로 적는다
  const pick = code(read(PICKER));
  for (const t of ['catalog-unavailable', 'catalog-no-match', 'catalog-retry']) {
    if (!pick.includes(t)) err(`${PICKER}에 ${t} 상태가 없습니다`);
  }
  // 타이핑마다 조회하지 않는다
  if (/fetch\(/.test(pick)) {
    err(`${PICKER}가 직접 조회합니다 — 검색은 받아 둔 목록 안에서 합니다`);
  }
}

// ══════════════ ㉓ ★ 주문이 날아가는 중에는 바꾸지 않는다 ══════════════
{
  const tabs = code(read(TABS_UI));
  if (!/const orderInFlight = form\.busy \|\| sell\.busy;/.test(order)) {
    err(`${ORDER}가 주문 진행 상태를 판정하지 않습니다`);
  }
  for (const [what, re] of [
    ['시장 전환', /setMarketTab = React\.useCallback\(\(m: TradingMarketId\) => \{\s*\n\s*if \(orderInFlight\) return;/],
    ['종목 고르기', /openPicker = React\.useCallback\(\(\) => \{\s*\n\s*if \(orderInFlight\) return;/],
    ['종목 선택', /pickInstrument = React\.useCallback\(\([\s\S]{0,40}?\) => \{\s*\n\s*if \(orderInFlight\) return;/],
  ]) {
    if (!re.test(order)) {
      err(`${ORDER}가 주문 진행 중에 ${what}을 막지 않습니다`
        + ' — 보낸 주문의 결과가 다른 종목 화면에 뜹니다');
    }
  }
  // 탭 줄이 그 사유를 실제로 받는가 (숨기지 않고 끈다)
  if (!/blockedReason=\{p\.switchBlockedReason \?\? null\}/.test(shell)) {
    err(`${SHELL}이 전환 차단 사유를 탭 줄에 넘기지 않습니다`);
  }
  if (!/disabled=\{blocked && !on\}/.test(tabs)) {
    err(`${TABS_UI}가 주문 진행 중에도 다른 시장 탭을 누를 수 있게 둡니다`);
  }
}

// ══════════════ ㉔ ★ 정체성이 바뀌면 주문 입력을 물려주지 않는다 ══════════════
{
  const hook = code(read(FORMHOOK));
  // ★ 이름이 있는지만 보면 안 된다. 효과 안에 `if (true) return;` 한 줄을
  //   끼우면 이름은 그대로 남고 초기화만 사라진다 — 뮤테이션 둘이 그 틈으로
  //   살아남았다. **효과 본문을 잘라서 나가는 길을 센다.**
  {
    const eff = hook.match(/useEffect\(\(\) => \{\s*\n\s*if \(lastIdKey[\s\S]*?\n  \}, \[idKey\]\);/);
    if (!eff) {
      err(`${FORMHOOK}이 정체성 변경을 감지하지 않습니다`
        + ' — 현물 50%·손절이 선물 화면으로 따라갑니다');
    } else {
      const body = eff[0];
      const returns = body.match(/return\s*;/g) || [];
      if (returns.length !== 1) {
        err(`${FORMHOOK}의 초기화가 ${returns.length}가지로 빠져나갑니다`
          + ' — 정체성이 같을 때 한 번만 빠져나가야 합니다');
      }
      if (!/if \(lastIdKey\.current === idKey\) return;/.test(body)) {
        err(`${FORMHOOK}의 초기화 조건이 정체성 비교가 아닙니다`);
      }
      if (!/identityResetState\(/.test(body)) {
        err(`${FORMHOOK}의 초기화가 정본 규칙을 쓰지 않습니다`);
      }
      for (const setter of ['setSideChosen', 'setPercent', 'setTp', 'setSl',
                            'setSlPct', 'setLeverage', 'setMarginMode']) {
        if (!new RegExp(`${setter}\\(`).test(body)) {
          err(`${FORMHOOK}의 초기화가 ${setter}를 되돌리지 않습니다`);
        }
      }
    }
  }
  // 초기화 규칙을 화면이 따로 갖지 않는다 (두 벌이면 한쪽만 고쳐진다)
  if (CONTRACT) for (const sc of CONTRACT.MARKET_SCREENS) {
    if (/identityResetState\(/.test(code(read(sc.file)))) {
      err(`${sc.file}가 초기화 규칙을 따로 갖습니다 — 정본은 ${IDENT} 한 곳입니다`);
    }
  }
}

// ══════════════ ㉕ ★ 시장가 전용인데 지정가 UI를 만들지 않는다 ══════════════
//
// `OrderBookView`에 `onPickPrice`가 **이미 있다.** 그래서 호가 줄을 눌러
// 주문 가격에 넣고 싶어진다. 그런데 지금 모의 장부는:
//
//     TYPE_LIMIT   미지원
//     PRICE_INPUT  미지원   (`/api/paper/order`가 서버 시세로 즉시 체결한다)
//
// 이 상태에서 가격 칸을 만들면 **눌리는데 시장가로 나가는** 화면이 된다.
// 사용자는 자기가 정한 가격에 걸린 줄 안다. 지정가 장부가 실제로 생긴 뒤에
// 붙인다.
{
  if (CONTRACT) for (const sc of CONTRACT.MARKET_SCREENS) {
    // 모의 경로가 있는 시장만 해당한다 (COIN-M·주식은 애초에 잠겨 있다)
    if (sc.market !== 'SPOT' && sc.market !== 'USDT_FUTURES') continue;
    const c = code(read(sc.file));
    // ★ **이름을 막지 않는다. 넘길 수 있는 것을 적는다.**
    //
    //   `onPickPrice`라는 낱말만 막으면 세 가지로 되돌아온다:
    //     ⑴ `onPickPrice={() => {}}`  — 아무것도 안 하는 함수를 넘긴다.
    //        `OrderBookView`는 **callback이 있는지**만 보고 눌림
    //        표시(cursor·밑줄·title·중앙가 버튼 활성)를 켠다. 눌리는데
    //        아무 일도 없는 칸이 된다 — 실기에서 실제로 그랬다.
    //     ⑵ 이름만 바꾼다 (`onRowPrice`, `onRowClick` …).
    //     ⑶ `{...props}`로 통째로 넘긴다 — 화면에서 무엇이 가는지 안 보인다.
    //
    //   그래서 허용 목록을 고정한다: 시장 화면이 호가판에 넘기는 것은
    //   **무엇을 그릴지**뿐이고, **누르면 무엇을 한다**는 하나도 없다.
    const bookTags = jsxTags(c, 'OrderBookView');
    if (/<OrderBookView\b/.test(c) && bookTags.length === 0) {
      err(`${sc.file}의 호가판 태그를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`);
    }
    for (const attrs of bookTags) {
      if (/\{\s*\.\.\./.test(attrs)) {
        err(`${sc.file}가 호가판에 prop을 통째로(스프레드) 넘깁니다`
          + ' — 무엇이 가는지 화면에서 안 보입니다');
        continue;
      }
      for (const name of jsxPropNames(attrs)) {
        if (!BOOK_PROPS_ALLOWED.includes(name)) {
          err(`${sc.file}가 호가판에 \`${name}\`을 넘깁니다`
            + ` — 허용은 ${BOOK_PROPS_ALLOWED.join('·')}뿐입니다.`
            + ' 호가를 누르는 동작은 지정가 장부가 생긴 뒤에 붙입니다 (PRICE_INPUT 미지원)');
        }
      }
    }
    for (const re of [/setLimitPrice/, /limitPrice/, /['"]LIMIT['"]/, /지정가/]) {
      if (re.test(c)) {
        err(`${sc.file}에 지정가 UI가 있습니다 (${re}) — 모의 장부에 대기 주문이 없습니다`);
      }
    }
  }
}

// ══════════════ ㉖ ★ 수량이든 총액이든 주문 계산은 하나다 ══════════════
//
// 입력 모드는 **표현**이다. 모드마다 수량을 따로 계산하면 같은 주문이
// 칸에 따라 다른 수량으로 나가고, 그 차이는 체결된 뒤에야 보인다.
{
  const ui = code(read(SIZEUI));
  const sizing = code(read(SIZING));

  // ⑴ 입력 부품이 **수량을 스스로 만들지 않는다**
  //
  // ★ 연산 기호를 나열해 막으면 안 된다. `/ price`를 막으면 `* price`로,
  //   `* leverage`를 막으면 `/ leverage`로 돌아온다 — 뮤테이션이 정확히
  //   그 틈으로 살아남았다. 그래서 **가격·배율이 쓰이는 자리 자체**를 본다:
  //   정본 판정에 인자로 넘기는 것 말고는 손대지 않는다.
  if (/planSizing\s*\(/.test(ui)) {
    err(`${SIZEUI}가 계획을 직접 계산합니다 — 계산 정본은 useTradeForm 하나입니다`);
  }
  for (const [name, prop] of [['price', 'price'], ['leverage', 'leverage']]) {
    const uses = (ui.match(new RegExp(`p\\.${name}\\b`, 'g')) || []).length;
    const asArg = (ui.match(new RegExp(`${prop}:\\s*p\\.${name}\\b`, 'g')) || []).length;
    if (uses !== asArg) {
      err(`${SIZEUI}가 ${name}을 판정에 넘기는 것 말고 ${uses - asArg}곳에서 직접 씁니다`
        + ' — 수량 계산이 두 벌이 되면 모드마다 다른 주문이 나갑니다');
    }
  }
  // ⑵ 나가는 길이 **하나**다 — 어느 모드든 같은 출구로 간다
  {
    const outs = (ui.match(/p\.onPercent\(/g) || []).length;
    if (outs === 0) err(`${SIZEUI}가 비율을 위로 올리지 않습니다`);
    for (const banned of ['onQuantity', 'onNotional', 'setQuantity']) {
      if (ui.includes(banned)) {
        err(`${SIZEUI}에 두 번째 출구가 있습니다 (${banned}) — 모드마다 다른 주문이 나갑니다`);
      }
    }
  }
  // ⑶ 직접 입력은 정본 판정을 쓴다
  for (const fn of ['quantityInputToPercent', 'notionalInputToPercent', 'maxAllocationPercent']) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(ui)) {
      err(`${SIZEUI}가 ${fn}을 쓰지 않습니다 — 판정을 화면에서 다시 만듭니다`);
    }
  }
  // ⑷ ★ 직접 입력은 **조용히 자르지 않는다**
  for (const fn of ['quantityInputToPercent', 'notionalInputToPercent']) {
    const body = fnBody(sizing, fn);
    if (!body) { err(`${SIZING}에서 ${fn}을 찾지 못했습니다`); continue; }
    if (/Math\.min\(\s*100/.test(body)) {
      err(`${SIZING}의 ${fn}이 100%로 잘라서 통과시킵니다`
        + ' — 사용자가 적은 것과 나가는 것이 달라집니다');
    }
    if (!/OVER_BUDGET/.test(body)) {
      err(`${SIZING}의 ${fn}이 초과를 사실로 돌려주지 않습니다`);
    }
  }
  // 넘쳤을 때 화면이 **반영하지 않고 적는다**
  if (!/if \(r\.code === 'OK' && r\.percent != null\) p\.onPercent\(r\.percent\);/.test(ui)) {
    err(`${SIZEUI}가 초과 입력을 그대로 반영합니다`);
  }
  if (!/data-testid="size-input-reason"/.test(ui)) {
    err(`${SIZEUI}가 초과 사유를 화면에 적지 않습니다`);
  }
}

// ══════════════ ㉗ ★ MAX는 수수료 정본을 본다 (여유분을 지어내지 않는다) ══════════════
//
// `MAX = 100%`로 두면 `buildPaperPlan`이 증거금 **위에** 수수료를 더 요구해
// 주문이 막힌다. 임의 여유분(0.1% 같은 것)을 두면 그 숫자가 실제 수수료와
// 어긋나는 날 다시 막히고, 왜 막히는지 아무도 모른다.
{
  const ui = code(read(SIZEUI));
  const sizing = code(read(SIZING));
  const plan = code(read(PLAN));
  const pexec = code(read(PEXEC));

  // ⑴ 화면이 수수료 숫자를 **베껴 적지 않는다**
  if (!/paperFeeRate\s*\(/.test(ui)) {
    err(`${SIZEUI}가 수수료 정본을 부르지 않습니다`);
  }
  // ★ 숫자를 통째로 금지하면 안 된다 — `0.001 BTC` 같은 **입력 예시**까지
  //   걸린다(실제로 걸렸다). 수수료율이 **어디서 오는가**를 본다.
  {
    const assigns = ui.match(/const\s+feeRate\s*=\s*[^;]+;/g) || [];
    if (assigns.length !== 1 || !/paperFeeRate\(/.test(assigns[0])) {
      err(`${SIZEUI}의 수수료율이 정본에서 오지 않습니다 [${assigns.join(' / ') || '없음'}]`);
    }
    if (/buffer|여유분/i.test(ui)) {
      err(`${SIZEUI}가 임의 여유분을 둡니다 — 정본과 어긋나는 날 주문이 막힙니다`);
    }
  }
  // ⑵ 계획과 체결이 **같은 수수료**를 본다
  // ★ `slippagePct ?? 0.05`는 수수료가 아니다. **수수료 기본값만** 본다.
  for (const [f, c] of [[PLAN, plan], [PEXEC, pexec]]) {
    if (/feeRatePct\s*\?\?\s*0?\.\d/.test(c)
      || /Number\(i\.feeRatePct\)\s*:\s*0?\.\d/.test(c)) {
      err(`${f}가 수수료 기본값을 직접 적습니다 — 정본은 PAPER_FEE_RATE_PCT 하나입니다`);
    }
    if (!/paperFeeRate\(/.test(c)) {
      err(`${f}가 수수료 정본을 쓰지 않습니다`);
    }
  }
  if (!/export const PAPER_FEE_RATE_PCT/.test(plan)) {
    err(`${PLAN}에 수수료 정본 상수가 없습니다`);
  }
  // 안 준 값을 **0으로 접지 않는다** (수수료가 사라진다)
  if (!/if \(feeRatePct == null\) return PAPER_FEE_RATE_PCT \/ 100;/.test(plan)) {
    err(`${PLAN}의 수수료 판정이 "안 줬다"를 0%로 읽습니다`);
  }
  // ⑶ MAX 계산이 배율과 수수료를 **함께** 센다
  {
    const body = fnBody(sizing, 'maxAllocationPercent');
    if (!body) err(`${SIZING}에서 MAX 계산을 찾지 못했습니다`);
    else {
      if (!/1 \+ lev \* fee/.test(body)) {
        err(`${SIZING}의 MAX가 배율×수수료를 세지 않습니다 — 100%가 되어 주문이 막힙니다`);
      }
      if (/0\.999|0\.99\b/.test(body)) {
        err(`${SIZING}의 MAX가 임의 여유분을 씁니다`);
      }
    }
  }
}

// ══════════════ ㉘ ★ 실행 버튼 — 색 · DOM · 클릭이 **같은 판정 하나**를 본다 ══════════════
//
// 무엇이 있었나
// ─────────────
// USDⓈ-M 화면의 `Cta`가 판정을 **세 벌** 갖고 있었다:
//
//     const off = disabled || !!unavailable || locked;   ← 색만 이걸 봤다
//     <button disabled={!!unavailable || locked}          ← DOM은 이걸 봤다
//       onClick={() => { if (unavailable || locked) return; … }}  ← 클릭은 이걸
//
// 그래서 호출부가 넘긴 `disabled`(= `form.busy` · `!form.gate.ready` ·
// `intent !== 'OPEN'`)는 **색에만** 반영됐다. 회색으로 보이는 버튼이 실제로
// 눌렸고, `form.submit()`은 화면의 intent를 모르므로 **청산 탭에서 진입
// 주문이 나갈 수 있었다.**
//
// 무엇을 검사하나
// ───────────────
// ⑴ (모든 시장 화면) 실행 버튼의 `disabled` 식과 **눈에 보이는 꺼짐**
//    (`background` · `color`의 조건)이 **글자 그대로 같은 식**이어야 한다.
//    위 고장의 모양이 바로 "둘이 다르다"였다.
// ⑵ (USDⓈ-M `Cta`) 판정 입력(`form.busy` · `form.gate.ready` ·
//    `intentOpen` · `locked` · `unavailable` · `form.sideChosen`)을
//    **정본 판정에 넘기는 자리 밖에서 읽지 않는다.**
// ⑶ `disabled`에 쓰인 이름이 그 판정의 `.off`에서 와야 한다.
// ⑷ 클릭은 판정이 정한 `action`으로만 갈린다 — `form.submit()`은
//    `action === 'SUBMIT'`일 때만 불린다.
//
// ★ "색이 회색이다"를 검사하지 않는다. 실제 `disabled` 속성과 클릭
//   처리기가 **같은 값**을 보는지를 본다.
{
  // ⑴ 모든 시장 화면: DOM 꺼짐 == 보이는 꺼짐
  if (CONTRACT) for (const sc of CONTRACT.MARKET_SCREENS) {
    const c = code(read(sc.file));
    const btns = jsxTagsWith(c, 'button', /cta/i);
    if (/data-testid=[^\n]*cta/i.test(c) && btns.length === 0) {
      err(`${sc.file}의 실행 버튼 태그를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`);
    }
    for (const [i, attrs] of btns.entries()) {
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      const dexpr = attrValue(attrs, 'disabled');
      if (dexpr == null) {
        err(`${sc.file}의 실행 버튼 ${i + 1}번에 DOM \`disabled\`가 없습니다`
          + ' — 회색으로만 보이고 실제로는 눌립니다');
        continue;
      }
      const st = styleEntries(attrs);
      let conds = 0;
      for (const prop of ['background', 'color', 'cursor']) {
        if (st[prop] == null) continue;
        const cond = ternaryCond(st[prop]);
        if (cond == null) continue;   // 늘 같은 값이면 어긋날 수가 없다
        conds += 1;
        if (norm(cond) !== norm(dexpr)) {
          err(`${sc.file}의 실행 버튼 ${i + 1}번은 색과 DOM이 다른 식을 봅니다`
            + ` — \`${prop}\`은 \`${norm(cond)}\`, DOM은 \`${norm(dexpr)}\`.`
            + ' 회색인데 눌리는 버튼이 됩니다');
        }
      }
      if (conds === 0) {
        err(`${sc.file}의 실행 버튼 ${i + 1}번은 꺼짐을 눈으로 보여주지 않습니다`
          + ' — 색·커서 어느 것도 잠금 식을 보지 않습니다');
      }
    }
  }

  // ⑵⑶⑷ USDⓈ-M `Cta` — 판정 하나
  const usdm = CONTRACT
    ? (CONTRACT.MARKET_SCREENS.find(s => s.market === 'USDT_FUTURES') || {}).file
    : null;
  if (!usdm) err('계약에서 USDⓈ-M 화면을 찾지 못했습니다');
  else {
    const c = code(read(usdm));
    if (!/from '@\/lib\/trading\/ctaVerdict'/.test(c)) {
      err(`${usdm}가 실행 버튼 판정 정본을 쓰지 않습니다 (${CTAV})`);
    }
    const whole = fnBody(c, 'Cta');
    if (!whole) err(`${usdm}에서 실행 버튼(Cta)을 찾지 못했습니다`);
    else {
      // 시그니처(파라미터 구조분해·타입)는 본문이 아니다 — 떼고 본다
      const at = whole.indexOf('}) {');
      const body = at < 0 ? whole : whole.slice(at + 4);

      const calls = (body.match(/ctaVerdict\s*\(/g) || []).length;
      if (calls !== 1) {
        err(`${usdm}의 실행 버튼이 판정을 ${calls}번 부릅니다 — 정확히 한 번이어야 합니다`);
      }
      // 판정에 넘기는 인자 구간
      const ci = body.indexOf('ctaVerdict');
      let arg = '';
      if (ci >= 0) {
        let depth = 0, i = body.indexOf('(', ci);
        const from = i;
        for (; i < body.length; i += 1) {
          if (body[i] === '(') depth += 1;
          else if (body[i] === ')') { depth -= 1; if (depth === 0) break; }
        }
        arg = body.slice(from, i + 1);
      }
      // ⑵ 입력은 판정에 넘기는 자리에서만 읽는다
      for (const [label, re] of [
        ['form.busy', /\bform\.busy\b/g],
        ['form.gate.ready', /\bform\.gate\.ready\b/g],
        ['intentOpen', /\bintentOpen\b/g],
        ['locked', /\blocked\b/g],
        ['unavailable', /\bunavailable\b/g],
        ['form.sideChosen', /\bform\.sideChosen\b/g],
      ]) {
        const all = (body.match(re) || []).length;
        const inArg = (arg.match(re) || []).length;
        if (all !== inArg) {
          err(`${usdm}의 실행 버튼이 \`${label}\`을 판정 밖 ${all - inArg}곳에서 직접 읽습니다`
            + ' — 판정이 두 벌이 되면 색과 동작이 갈립니다');
        }
      }
      // ⑶ DOM 꺼짐이 판정의 `.off`에서 온다
      const dm = body.match(/\bdisabled=\{([A-Za-z_$][\w$.]*)\}/);
      if (!dm) {
        err(`${usdm}의 실행 버튼 DOM \`disabled\`가 이름 하나가 아닙니다`
          + ' — 식을 다시 쓰면 판정이 두 벌이 됩니다');
      } else {
        const n = dm[1];
        const bound = n.endsWith('.off')
          || new RegExp(`const\\s+${n.replace(/\$/g, '\\$')}\\s*=\\s*[A-Za-z_$][\\w$]*\\.off\\b`).test(body);
        if (!bound) {
          err(`${usdm}의 실행 버튼 DOM \`disabled={${n}}\`가 판정의 .off가 아닙니다`);
        }
      }
      // ⑷ 클릭은 판정이 정한 action으로만 갈린다
      const om = body.match(/onClick=\{\(\) => \{([\s\S]*?)\n      \}\}/);
      if (!om) err(`${usdm}의 실행 버튼 클릭 처리기를 읽지 못했습니다`);
      else {
        const click = om[1];
        if (!/\.action === 'CHOOSE_SIDE'/.test(click)) {
          err(`${usdm}의 실행 버튼 클릭이 방향 고르기를 판정에서 받지 않습니다`);
        }
        if (/form\.submit\s*\(/.test(click)
            && !/\.action === 'SUBMIT'\)[^;]*form\.submit\s*\(/.test(click)) {
          err(`${usdm}의 실행 버튼이 판정 없이 주문을 보냅니다`
            + " — `action === 'SUBMIT'`일 때만 보내야 합니다"
            + ' (청산 탭에서 진입 주문이 나갑니다)');
        }
        for (const re of [/\blocked\b/, /\bunavailable\b/, /\bbusy\b/, /\bgate\b/, /\bintentOpen\b/]) {
          if (re.test(click)) {
            err(`${usdm}의 실행 버튼 클릭이 판정을 다시 계산합니다 (${re})`);
          }
        }
      }
    }
  }

  // ⑸ 판정은 한 곳에만 산다
  {
    const defs = walk('src').filter(f => /export function ctaVerdict\b/.test(read(f)));
    if (defs.length !== 1 || defs[0].replace(/\\/g, '/') !== CTAV) {
      err(`실행 버튼 판정이 ${defs.length}곳에 있습니다 (${defs.join(', ')}) — 정본은 ${CTAV} 하나입니다`);
    }
  }
}

if (bad > 0) {
  console.error(`\nTRAIGO 거래 화면 계약 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ TRAIGO 거래 화면 계약 — 탐색→상세→거래 사슬 · host 1곳 · 시장→화면 분기 1곳 ·'
  + ' 상세에 주문폼 없음 · ★차트 비상주 · ★서랍 기본 접힘 · 호가/포지션 상주 ·'
  + ' ★시장 의미 비혼합(현물·USDⓈ-M·COIN-M·주식) · 정본 판정 비우회 · 칸 출처 ·'
  + ' 능력 게이트 · ★간편/프로 동일 판정 · 주문수단 보존 · 포지션 장부 일치 ·'
  + ' 사유 1곳 · 원스크린 비복귀 ·'
  + ' ★시장 탭 4개 도달 · ★심볼 비조립 · ★종목없음=주문잠금 · ★타시장 데이터 비차용 ·'
  + ' ★화면=주문 정체성 일치 · ★상장목록 거래소 출처 · ★주문중 전환차단 ·'
  + ' ★정체성 변경시 입력 초기화 · ★시장가 전용인데 지정가 UI 없음 ·'
  + ' ★수량/총액 단일 계산 · ★직접입력 비클램프 · ★MAX 수수료 정본 ·'
  + ' ★호가판 prop 허용목록(누름 동작 없음) · ★실행버튼 색=DOM=클릭 단일 판정');
