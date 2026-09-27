// scripts/probe/separated-flow.mjs
//
// **화면이 정말 나뉘었는지 브라우저로 확인한다 (Phase UI-IA).**
//
// 소스 계약은 `check-canonical-trading.mjs`가 CI에서 지킨다. 그런데 그
// 검사는 원문을 읽을 뿐이고, **사용자가 실제로 그 길을 걸을 수 있는지**는
// 렌더해 봐야 안다. 이 저장소에서 정확히 그 차이로 고장이 난 적이 있다 —
// 거래소형 화면을 만들어 놓고 사람이 가는 길에 안 붙였는데 CI는 전부
// 초록이었다.
//
// 무엇을 증명하는가
// ─────────────────
//   ① 시장 → 종목 상세 → 주문 → 뒤로 = 다시 종목 상세
//   ② 하단 거래 탭 → 포지션·주문 (시장 탐색이 아니다)
//   ③ 도달 가능한 기본 화면 어디에도 **차트가 상주하지 않는다**
//
// ★ ③이 바뀌었다 (v3 계약)
// ────────────────────────
// 예전에는 "차트+주문폼+호가+포지션 중 셋 이상이면 실패"였다. 지금은
// 호가·주문폼·포지션이 **한 거래 화면에 있는 것이 정본**이다(바이낸스
// 골격). 화면을 밀어내던 것은 호가가 아니라 260px 차트였다.
//
// 그래서 세는 방식을 바꾼다: 셋이 같이 있는 것은 통과, **차트가 접히지
// 않고 상주하면 실패.** 느슨해진 것이 아니라 겨누는 곳이 바뀐 것이다 —
// 실제 고장(주문 버튼이 화면 밖으로 밀림)은 `market-screens.mjs`가
// 첫 화면 좌표로 직접 잰다.
//
// CI에는 넣지 않는다 — Playwright는 이 저장소의 의존성이 아니다.
// (`scripts/probe/README.md`의 규약을 그대로 따른다.)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.argv[2], OUT = process.argv[3] || '/tmp/flow';
const B = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [['390x844', 390, 844], ['360x800', 360, 800], ['430x932', 430, 932]];
/** 밀도 정본의 저장 키. 프로 갈래도 실제로 열어 본다 */
const PREF_KEY = 'tg_prefs_v1';

/** 원스크린인가 — 한 화면에 몇 가지가 동시에 있는가 */
const DENSITY = `
window.__density = () => {
  const has = (sel) => !!document.querySelector(sel);
  const chart = has('[data-testid="price-chart"], canvas');
  const orderForm = has('[data-testid="order-controls"]');
  const book = has('[data-testid="mkt-order-book"], [data-testid="orderbook"]');
  const positions = has('[data-testid="mkt-positions"], [data-testid="position-row"]');
  // 거래 화면 안에 **상주하는** 차트만 센다. 접힌 막대는 차트가 아니고,
  // 펼친 덮개는 사용자가 연 것이다.
  const residentChart = has('[data-region="tradingScreen"] canvas')
    && !has('[data-testid="chart-drawer-overlay"]');
  const n = [chart, orderForm, book, positions].filter(Boolean).length;
  return { chart, residentChart, orderForm, book, positions, n };
};
`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const all = {};
let fails = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); fails += 1; };
const ok = (m) => console.log(`  ✓ ${m}`);

for (const [name, w, h] of VIEWPORTS) {
  console.log(`\n── ${name} ──`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('tg_onboarded_v1', '1');
    localStorage.setItem('tg_lang', 'ko');
  });
  await ctx.addInitScript(DENSITY);
  const page = await ctx.newPage();
  await page.route('**/api/news**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, source: 'mock', news: [] }),
  }));
  await page.goto(B, { waitUntil: 'networkidle' });
  // 온보딩을 넘긴다
  for (let i = 0; i < 4; i++) {
    const s = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,div,span')]
        .find(e => (e.innerText || '').trim() === '건너뛰기');
      if (b) { b.click(); return true; } return false;
    });
    await page.waitForTimeout(250);
    if (!s) break;
  }

  const r = all[name] = {};

  // ══ ② 하단 거래 탭 → 포지션·주문 ══
  await page.goto(`${B}/?tab=trading`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  r.tradingTab = await page.evaluate(() => ({
    positionsScreen: !!document.querySelector('[data-testid="positions-orders-screen"]'),
    workspace: !!document.querySelector('[data-testid="trading-workspace"]'),
    density: window.__density(),
  }));
  await page.screenshot({ path: `${OUT}/${name}-trading-tab.png` });
  if (!r.tradingTab.positionsScreen) bad(`${name}: 거래 탭이 포지션·주문 화면이 아닙니다`);
  else ok(`${name}: 거래 탭 → 포지션·주문`);
  if (r.tradingTab.workspace) bad(`${name}: 거래 탭에 원스크린 거래 화면이 남아 있습니다`);
  if (r.tradingTab.density.n >= 3) {
    bad(`${name}: 거래 탭이 ${r.tradingTab.density.n}가지를 한 화면에 들고 있습니다`);
  } else ok(`${name}: 거래 탭 동시 표시 ${r.tradingTab.density.n}가지 (3 미만)`);

  // ══ ① 시장 → 상세 → 주문 → 뒤로 ══
  await page.goto(`${B}/?tab=market`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  r.market = { density: await page.evaluate(() => window.__density()) };
  await page.screenshot({ path: `${OUT}/${name}-market.png` });
  if (r.market.density.n >= 3) bad(`${name}: 시장 탭이 원스크린입니다`);
  else ok(`${name}: 시장 탭 동시 표시 ${r.market.density.n}가지`);

  // 첫 코인 행을 누른다
  const opened = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('div,button,li')]
      .filter(e => /BTC|ETH|SOL/.test(e.innerText || '') && e.getBoundingClientRect().height > 28
        && e.getBoundingClientRect().height < 140);
    const t = rows[0];
    if (!t) return false;
    t.click(); return true;
  });
  await page.waitForTimeout(1400);
  r.detail = await page.evaluate(() => ({
    open: !!document.querySelector('[data-testid="instrument-detail-host"]'),
    density: window.__density(),
    hasOrderForm: !!document.querySelector('[data-testid="order-controls"]'),
  }));
  await page.screenshot({ path: `${OUT}/${name}-detail.png` });
  if (!opened || !r.detail.open) {
    bad(`${name}: 종목을 눌러도 상세가 열리지 않습니다`);
  } else {
    ok(`${name}: 시장 → 종목 상세`);
    if (r.detail.hasOrderForm) bad(`${name}: 상세에 주문 조작부가 상주합니다`);
    else ok(`${name}: 상세에 주문폼 없음`);
    if (r.detail.density.n >= 3) bad(`${name}: 상세가 원스크린입니다`);
    else ok(`${name}: 상세 동시 표시 ${r.detail.density.n}가지`);

    // 상세 → 주문
    const pressed = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find(e => /^(구매|매수|판매|매도|LONG|SHORT)$/.test((e.innerText || '').trim()));
      if (!b) return false; b.click(); return true;
    });
    await page.waitForTimeout(1400);
    r.order = await page.evaluate(() => ({
      open: !!document.querySelector('[data-testid="paper-order-screen"]'),
      level: document.querySelector('[data-testid="paper-order-screen"]')?.getAttribute('data-level'),
      hasChart: !!document.querySelector('[data-testid="paper-order-screen"] canvas'),
      density: window.__density(),
    }));
    await page.screenshot({ path: `${OUT}/${name}-order.png` });
    if (!pressed || !r.order.open) bad(`${name}: 상세에서 주문 화면으로 가지 못했습니다`);
    else {
      ok(`${name}: 상세 → 주문 화면 (${r.order.level})`);
      if (r.order.hasChart) bad(`${name}: 주문 화면에 분석용 차트가 있습니다`);
      else ok(`${name}: 주문 화면에 차트 없음`);
      // 호가·주문폼·포지션이 같이 있는 것은 **정본이다.** 차트가
      // 상주하는지만 본다.
      if (r.order.density.residentChart) {
        bad(`${name}: 거래 화면에 차트가 상주합니다 — 접혀 있어야 합니다`);
      } else ok(`${name}: 거래 화면에 차트 비상주`);

      // 주문 → 뒤로 = 다시 상세
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1000);
      r.back = await page.evaluate(() => ({
        detail: !!document.querySelector('[data-testid="instrument-detail-host"]'),
        order: !!document.querySelector('[data-testid="paper-order-screen"]'),
      }));
      await page.screenshot({ path: `${OUT}/${name}-back.png` });
      if (r.back.detail && !r.back.order) ok(`${name}: 주문 → 뒤로 = 종목 상세`);
      else bad(`${name}: 뒤로가기가 상세로 돌아오지 않습니다 `
        + `(detail=${r.back.detail} order=${r.back.order})`);

      // ══ 프로 밀도도 주문 화면 **안**에 있는가 ══
      //
      // 예전에는 프로를 누르면 원스크린 거래 화면으로 차 냈다. 그 길이
      // 정말로 없어졌는지 본다 — 프로 패널이 주문 화면 안에 떠야 한다.
      await page.evaluate((k) => {
        let p = {}; try { p = JSON.parse(localStorage.getItem(k) || '{}'); } catch {}
        p.uiLevel = 'PRO'; localStorage.setItem(k, JSON.stringify(p));
      }, PREF_KEY);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('div,button,li')]
          .filter(e => /BTC|ETH|SOL/.test(e.innerText || '')
            && e.getBoundingClientRect().height > 28 && e.getBoundingClientRect().height < 140);
        if (b[0]) b[0].click();
      });
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')]
          .find(e => /^(구매|매수|판매|매도|LONG|SHORT)$/.test((e.innerText || '').trim()));
        if (b) b.click();
      });
      await page.waitForTimeout(1300);
      r.pro = await page.evaluate(() => ({
        screen: !!document.querySelector('[data-testid="paper-order-screen"]'),
        level: document.querySelector('[data-testid="paper-order-screen"]')?.getAttribute('data-level'),
        // v3에서 프로 표현은 **시장별 화면**으로 갈렸다
        panel: !!document.querySelector('[data-region="tradingScreen"]'),
        cta: !!document.querySelector('[data-testid="trading-cta"]'),
        kicked: !!document.querySelector('[data-testid="pro-open-workspace"]'),
        hasChart: !!document.querySelector('[data-testid="paper-order-screen"] canvas'),
        density: window.__density(),
      }));
      await page.screenshot({ path: `${OUT}/${name}-order-pro.png` });
      if (r.pro.level === 'PRO' && r.pro.panel && r.pro.cta) {
        ok(`${name}: 프로 주문이 주문 화면 안에 있습니다`);
      } else {
        bad(`${name}: 프로 갈래가 주문 화면 안에 없습니다 `
          + `(level=${r.pro.level} panel=${r.pro.panel} cta=${r.pro.cta})`);
      }
      if (r.pro.kicked) bad(`${name}: 프로가 아직 원스크린으로 차 냅니다`);
      if (r.pro.hasChart) bad(`${name}: 프로 주문 화면에 차트가 있습니다`);
      if (r.pro.density.residentChart) {
        bad(`${name}: 시장별 거래 화면에 차트가 상주합니다`);
      }
      else ok(`${name}: 프로 동시 표시 ${r.pro.density.n}가지`);
    }
  }

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/separated-flow.json`, JSON.stringify(all, null, 2));
console.log(`\n결과: ${OUT}/separated-flow.json`);
if (fails > 0) { console.error(`\n실측 실패 ${fails}건`); process.exit(1); }
console.log('✅ 분리 흐름 실측 통과 — 탐색→상세→거래→뒤로 · 거래탭=포지션 · 차트 비상주');
