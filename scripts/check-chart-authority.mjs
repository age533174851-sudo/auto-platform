#!/usr/bin/env node
// scripts/check-chart-authority.mjs
//
// **차트가 값을 만들지 않는지 배선으로 확인한다.**
//
// 무엇이 걱정인가
// ───────────────
// 렌더링 엔진(lightweight-charts)을 들이면 가장 쉬운 유혹이 "빈 자리를
// 채우는 것"이다. 봉이 모자라면 보간하고, 아직 안 온 시간대는 미리 그리고,
// 값이 안 오면 랜덤으로 흔들어 살아 있는 것처럼 보이게 한다.
//
// 그런 화면은 **거짓말을 하는데 아무도 모른다.** 축이 그럴듯하고 모양도
// 자연스러워서, 그 위에서 내린 판단이 틀렸다는 것은 체결된 뒤에야 안다.
//
// 이미 전례가 있다: 호가창이 `Math.random()`으로 수량을 만들어 보여 줬다.
//
// 무엇을 보는가
// ─────────────
//   ① 차트가 난수·보간으로 봉을 만들지 않는다
//   ② 봉의 출처는 `/api/market/candles` 하나다 (거래소를 직접 두드리지 않는다)
//   ③ 진행 중 봉 갱신은 `candleSeries`의 함수만 쓴다 (배열을 늘리지 않는다)
//   ④ timeframe을 바꿀 때 낡은 응답을 버린다 (요청 세대)
//   ⑤ 주입 데이터(fixture)는 **제품 경로의 대체재가 아니다**
//   ⑥ 거래 화면의 기본 차트가 iframe이 아니다
//   ⑦ 씨앗 난수로 그리는 `AreaChart`가 거래 화면에 들어오지 않는다
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHART   = 'src/components/trading/PriceChart.tsx';
const SERIES  = 'src/lib/trading/candleSeries.ts';
const ROUTE   = 'src/app/api/market/candles/route.ts';
const WORKSPACE = 'src/components/trading/TradingWorkspace.tsx';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
/** 주석을 뺀 본문. 규칙을 주석으로 만족시키지 못하게 한다. */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const chart = code(read(CHART));
const series = code(read(SERIES));
const route = code(read(ROUTE));
const workspace = code(read(WORKSPACE));

// ── ① 값을 만들지 않는다 ──
for (const [name, body] of [[CHART, chart], [SERIES, series]]) {
  if (/Math\.random/.test(body)) {
    err(`${name}이 난수로 값을 만듭니다 — 호가창이 그랬다가 실제 시장과 무관한 화면이 됐습니다`);
  }
  for (const word of ['interpolate', 'synthesize', 'fabricate', 'fillGap', 'fillMissing']) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(body)) {
      err(`${name}에 봉을 지어내는 이름이 있습니다 (${word})`);
    }
  }
}

// ── ② 봉의 출처가 하나다 ──
// **부르는지**를 본다. 이름이 어딘가 적혀 있는 것으로는 부족하다 —
// 주석이나 import에만 남아 있어도 `includes`는 통과한다.
if (!/fetch\(\s*[`'"][^`'"]*\/api\/market\/candles/.test(chart)) {
  err(`${CHART}가 정본 봉 라우트를 fetch하지 않습니다`);
}
for (const direct of ['binance.com', 'fapi.binance', 'api.binance', 'klines']) {
  if (chart.includes(direct)) {
    err(`${CHART}가 거래소를 직접 두드립니다 (${direct}) — 봉 권위는 fetchVenueBars 하나입니다`);
  }
}
if (!/fetchVenueBars\s*\(/.test(route)) {
  err(`${ROUTE}가 fetchVenueBars를 호출하지 않습니다 — 새 가격 권위가 생겼습니다`);
}
// 모르는 간격을 기본값으로 때우면 사용자가 고른 적 없는 봉이 그려진다
if (!/interval.*(거절|reject|400)/s.test(read(ROUTE))) {
  err(`${ROUTE}가 모르는 간격을 거절하는지 확인할 수 없습니다`);
}

// ── ③ 진행 중 봉은 관측된 값으로만 움직인다 ──
// import 줄에 이름만 남아 있어도 `includes`는 통과한다. **호출**을 본다.
if (!/withLivePrice\s*\(/.test(chart)) {
  err(`${CHART}가 candleSeries.withLivePrice를 호출하지 않습니다 — 진행 중 봉 갱신 규칙이 두 벌이 됩니다`);
}
if (!/never|늘리지|push\(/.test(series) && !series.includes('slice')) {
  err(`${SERIES}가 배열 길이를 지키는지 확인할 수 없습니다`);
}

// ── ④ 낡은 응답을 버린다 ──
//
// **한 번만 세면 안 된다.** 성공 경로와 실패 경로가 각각 상태를 쓴다.
// 하나만 지키면 나머지 한쪽으로 낡은 응답이 그대로 들어온다 —
// 가드를 하나 지웠는데 다른 가드가 검사를 통과시켜 주는 상태다.
const guards = (chart.match(/isFreshResponse\s*\(/g) || []).length;
const consumers = (chart.match(/setBars\s*\(/g) || []).length;
if (guards < 2) {
  err(`${CHART}의 요청 세대 확인이 ${guards}곳뿐입니다 — 성공·실패 경로 둘 다 지켜야 합니다`);
}
if (consumers > 0 && guards < 2) {
  err(`${CHART}가 응답을 ${consumers}곳에서 쓰는데 세대 확인은 ${guards}곳입니다`);
}

// ── ★ 빈 차트를 READY라고 적지 않는다 ──
//
// 실측에서 잡았다. 응답이 `ok: true`여도 봉의 모양이 우리가 아는 모양이
// 아니면 캔들이 0개가 되고, 화면은 **하얗고 빈 차트**를 정상으로 띄웠다.
// 빈 차트는 "거래가 없었다"로 읽힌다.
// 규칙이 **조건의 모양**을 봐야 한다. `candles.length`가 어딘가 적혀 있는
// 것으로는 부족하다 — `> 0`을 `>= 0`으로 한 글자만 바꿔도 통과했다.
if (!/candles\.length > 0\)\s*return;/.test(chart)) {
  err(`${CHART}가 캔들 0개일 때만 빠져나가는 가드를 갖고 있지 않습니다`);
}
if (!/setState\('ERROR'\);[\s\S]{0,200}그릴 수 있는 캔들이 없습니다/.test(read(CHART))) {
  err(`${CHART}가 빈 차트를 오류로 적지 않습니다 — 빈 차트는 "거래가 없었다"로 읽힙니다`);
}

// ── ★ 차트를 만들어 놓고 데이터를 안 밀어넣지 않는다 ──
//
// 이것도 실측에서 잡았다. 차트 생성은 `await import(...)`라 비동기인데
// 데이터 이펙트는 `if (!seriesRef.current) return`으로 시작했고, ref는
// 바뀌어도 이펙트를 다시 돌리지 않는다. 봉이 차트보다 먼저 오면 그 이펙트는
// **한 번 빠져나간 뒤 다시 실행되지 않았다** — 만들어 놓고 배선을 안 한 상태다.
// 선언(`const [chartEpoch, setChartEpoch] = ...`)만 남아 있어도 통과하면
// 안 된다. **부르는지**를 본다.
if (!/setChartEpoch\s*\(/.test(chart)) {
  err(`${CHART}가 차트 준비를 상태로 알리지 않습니다 — ref는 이펙트를 다시 돌리지 않습니다`);
}
{
  const dataEffect = (chart.match(/seriesRef\.current\.setData[\s\S]{0,400}?\}, \[[^\]]*\]\);/) || [''])[0];
  if (!/chartEpoch/.test(dataEffect)) {
    err(`${CHART}의 데이터 이펙트가 chartEpoch를 보지 않습니다 — 봉이 먼저 오면 영영 안 그려집니다`);
  }
}

// ── ⑤ 주입 데이터가 제품 경로의 대체재가 아니다 ──
//
// 네트워크가 막혔을 때 fixture로 떨어지면 화면은 초록인데 아무도 실제
// 시장을 못 본다. 스크린샷 증거도 그때부터 거짓이 된다.
if (/catch[\s\S]{0,200}fixtureBars/.test(chart)) {
  err(`${CHART}가 실패했을 때 주입 데이터로 떨어집니다 — fixture는 제품 폴백이 아닙니다`);
}
if (!/fixtureBars[\s\S]{0,400}(시험|스토리|test|story)/i.test(read(CHART))) {
  err(`${CHART}의 fixtureBars가 시험 전용이라고 적혀 있지 않습니다`);
}

// ── ⑥⑦ 거래 화면의 기본 차트 ──
if (workspace) {
  if (!workspace.includes('PriceChart')) {
    err(`${WORKSPACE}의 기본 차트가 PriceChart가 아닙니다`);
  }
  for (const banned of ['InlineTVChart', 'iframe', 'AreaChart']) {
    if (workspace.includes(banned)) {
      err(`${WORKSPACE}가 ${banned}를 씁니다 — 거래 화면의 기본 차트는 우리 차트입니다`);
    }
  }
}

// 거래·모의 화면 전체에서 씨앗 난수 AreaChart를 막는다
const TRADING_DIRS = ['src/components/trading'];
const walk = (dir) => {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
};
for (const dir of TRADING_DIRS) {
  for (const f of walk(dir)) {
    const body = code(read(f));
    if (/\bAreaChart\b/.test(body)) {
      err(`${f}가 AreaChart를 씁니다 — 그 컴포넌트는 씨앗 난수로 선을 그립니다`);
    }
    if (/Math\.random/.test(body)) {
      err(`${f}가 난수를 씁니다 — 거래 화면에 지어낸 값이 들어갑니다`);
    }
  }
}

if (bad > 0) {
  console.error(`\n차트 권위 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 차트 권위 — 값 생성 없음 · 봉 출처 1곳 · 진행 중 봉 규칙 공유 ·'
  + ' 낡은 응답 폐기 · 빈 차트 비정상 표기 · 데이터 배선 확인 ·'
  + ' fixture 비폴백 · 거래 화면 기본 차트는 우리 것');
