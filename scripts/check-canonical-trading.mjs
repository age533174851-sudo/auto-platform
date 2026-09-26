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

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
/** 주석은 규율이 아니다. 주석에 적힌 낱말로 검사가 통과하면 안 된다 */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

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
  const routers = files.filter(f => f !== ROUTE && /\btradingScreenFor\s*\(/.test(code(read(f))));
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
    if (need.includes('ORDER_BOOK') && !/<OrderBookView|stock-book-unavailable/.test(c)) {
      err(`${s.file}에 호가 칸이 없습니다 — 호가를 보며 주문하는 화면이 아닙니다`);
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
    else if (!/boxH/.test(m[0]) || !/topH/.test(m[0])) {
      err(`${SHELL}의 첫 화면 높이가 잰 값에서 나오지 않습니다 (${m[0].trim()})`
        + ' — 상수로 박으면 주문 버튼이 밀립니다');
    }
    for (const v of ['boxH', 'topH']) {
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

if (bad > 0) {
  console.error(`\nTRAIGO 거래 화면 계약 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ TRAIGO 거래 화면 계약 — 탐색→상세→거래 사슬 · host 1곳 · 시장→화면 분기 1곳 ·'
  + ' 상세에 주문폼 없음 · ★차트 비상주 · ★서랍 기본 접힘 · 호가/포지션 상주 ·'
  + ' ★시장 의미 비혼합(현물·USDⓈ-M·COIN-M·주식) · 정본 판정 비우회 · 칸 출처 ·'
  + ' 능력 게이트 · ★간편/프로 동일 판정 · 주문수단 보존 · 포지션 장부 일치 ·'
  + ' 사유 1곳 · 원스크린 비복귀');
