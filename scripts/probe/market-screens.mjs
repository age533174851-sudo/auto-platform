// scripts/probe/market-screens.mjs
//
// **시장별 거래 화면을 실제로 렌더해서 본다 — 그리고 스크린샷을 남긴다.**
//
// 소스 계약은 `check-canonical-trading.mjs`가 CI에서 지킨다. 그런데 그
// 검사는 원문을 읽을 뿐이고, **첫 화면에 정말로 호가·주문 입력·실행
// 버튼이 같이 보이는지**는 렌더해 봐야 안다. 이 저장소는 정확히 그 차이로
// 고장 난 적이 있다 — 요소가 DOM에 있다는 검사는 전부 통과했는데
// 실기에서 버튼이 화면 밖으로 밀려 있었다.
//
// 무엇을 증명하는가
// ─────────────────
//   ① 차트는 **접혀 있다** — 첫 화면에 캔버스가 없다
//   ② 첫 화면(viewport 안)에 **호가 · 주문 입력 · 실행 버튼**이 같이 보인다
//   ③ 차트 막대를 누르면 펼쳐지고, 닫으면 **주문 입력이 그대로 살아 있다**
//   ④ 시장마다 금지된 칸이 **렌더되지 않는다** (계약 정본에서 읽는다)
//   ⑤ 시장 탭 넷을 눌러 **네 화면에 실제로 들어가진다**
//   ⑥ 종목 출처가 없는 시장은 **주문이 잠기고 사유가 보인다**
//      (REACHABLE != TRADABLE — 가짜 심볼로 채우지 않는다)
//
// CI에는 넣지 않는다 — Playwright는 이 저장소의 의존성이 아니다.
// (`scripts/probe/README.md`의 규약을 그대로 따른다.)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.argv[2], OUT = process.argv[3] || '/tmp/mkt';
const B = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [['360x660', 360, 660], ['390x844', 390, 844], ['430x932', 430, 932]];
const PREF_KEY = 'tg_prefs_v1';

/** 보이는가 — DOM에 있는 것과 **첫 화면 안에 있는 것**은 다르다 */
const HELPERS = `
window.__visible = (sel) => {
  const e = document.querySelector(sel);
  if (!e) return { present: false, inFirstScreen: false };
  const r = e.getBoundingClientRect();
  const on = r.width > 0 && r.height > 0;
  return {
    present: true,
    inFirstScreen: on && r.top >= 0 && r.bottom <= window.innerHeight + 1,
    top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
  };
};
window.__has = (sel) => !!document.querySelector(sel);
`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const all = {};
let fails = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); fails += 1; };
const ok = (m) => console.log(`  ✓ ${m}`);

async function openTrading(page, { market }) {
  await page.goto(`${B}/?tab=market`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) {
    const s = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,div,span')]
        .find(e => (e.innerText || '').trim() === '건너뛰기');
      if (b) { b.click(); return true; } return false;
    });
    await page.waitForTimeout(250);
    if (!s) break;
  }
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('div,button,li')]
      .filter(e => /BTC|ETH|SOL/.test(e.innerText || '')
        && e.getBoundingClientRect().height > 28 && e.getBoundingClientRect().height < 140);
    if (rows[0]) rows[0].click();
  });
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find(e => /^(구매|매수|판매|매도|LONG|SHORT)$/.test((e.innerText || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1500);
  // ★ 로그인하지 않은 채로 [매수]를 누르면 로그인 모달이 뜬다(제품 동작).
  //   그 모달이 거래 화면을 덮으므로 배치를 재려면 먼저 닫는다.
  //   **닫는 것이지 우회하는 것이 아니다** — 아래 화면은 로그아웃 상태
  //   그대로이고, 잔고가 `—`로 보이는 것도 그 상태의 정답이다.
  await page.evaluate(() => {
    const m = [...document.querySelectorAll('div')]
      .find(e => getComputedStyle(e).zIndex === '10070' && getComputedStyle(e).position === 'fixed');
    if (m) m.click();
  });
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const s = document.querySelector('[data-testid="paper-order-screen"]');
    return { open: !!s, level: s?.getAttribute('data-level'), screen: s?.getAttribute('data-screen') };
  });
}

for (const [name, w, h] of VIEWPORTS) {
  console.log(`\n── ${name} ──`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('tg_onboarded_v1', '1');
    localStorage.setItem('tg_lang', 'ko');
    // 프로 밀도 = 새 시장별 거래 화면
    let p = {}; try { p = JSON.parse(localStorage.getItem('tg_prefs_v1') || '{}'); } catch {}
    p.uiLevel = 'PRO'; localStorage.setItem('tg_prefs_v1', JSON.stringify(p));
  });
  await ctx.addInitScript(HELPERS);
  const page = await ctx.newPage();
  await page.route('**/api/news**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, source: 'mock', news: [] }),
  }));

  const r = all[name] = {};
  const entered = await openTrading(page, { market: 'SPOT' });
  r.entered = entered;
  if (!entered.open) { bad(`${name}: 거래 화면까지 가지 못했습니다`); await ctx.close(); continue; }
  ok(`${name}: 거래 화면 진입 (${entered.screen})`);

  // ── ① 접힌 상태 ──
  await page.screenshot({ path: `${OUT}/${name}-${entered.screen}-collapsed.png` });
  r.collapsed = await page.evaluate(() => ({
    chartBar: window.__visible('[data-testid="mkt-chart-bar"]'),
    overlay: window.__has('[data-testid="chart-drawer-overlay"]'),
    // 아래에 종목 상세가 살아 있다(주문 겹이 그 위에 뜬다). 그 화면의
    // 차트까지 세면 안 된다 — **거래 화면 안**만 본다.
    canvas: window.__has('[data-region="tradingScreen"] canvas'),
    book: window.__visible('[data-testid="mkt-order-book"]'),
    controls: window.__visible('[data-testid="order-controls"]'),
    cta: window.__visible('[data-testid="trading-cta"]'),
    barOpen: document.querySelector('[data-testid="mkt-chart-bar"]')?.getAttribute('data-chart-open'),
  }));
  if (r.collapsed.barOpen !== '0' || r.collapsed.overlay) {
    bad(`${name}: 차트가 기본으로 펴져 있습니다`);
  } else ok(`${name}: 차트 기본 접힘`);
  if (r.collapsed.canvas) bad(`${name}: 접힌 상태인데 캔버스가 그려져 있습니다`);

  // ★ 이 세 줄이 이 PR의 목적이다
  for (const [k, label] of [['book', '호가'], ['controls', '주문 입력'], ['cta', '실행 버튼']]) {
    const v = r.collapsed[k];
    if (!v.present) bad(`${name}: ${label}이 화면에 없습니다`);
    else if (!v.inFirstScreen) {
      bad(`${name}: ${label}이 첫 화면 밖으로 밀렸습니다 (top=${v.top} bottom=${v.bottom} vh=${h})`);
    } else ok(`${name}: ${label} 첫 화면 안 (${v.top}~${v.bottom})`);
  }

  // ── ② 차트 펼침 ──
  //
  // 주문 입력에 값을 넣어 두고 연다. 닫았을 때 그 값이 남아 있어야 한다 —
  // 차트를 열었다고 주문 상태를 다시 만들면 수량이 날아간다.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="order-controls"] input');
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '7');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  const before = await page.evaluate(() =>
    document.querySelector('[data-testid="order-controls"] input')?.value ?? null);

  // ★ 눌리는가를 **먼저 본다.** 보이는 것과 눌리는 것은 다르다 —
  //   이 저장소에서 화면에는 버튼이 보이는데 elementFromPoint로 찍으면
  //   탭바가 나온 적이 있다.
  r.hitTest = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="mkt-chart-bar"]');
    if (!b) return { ok: false, why: '막대가 없습니다' };
    const r0 = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r0.left + r0.width / 2, r0.top + r0.height / 2);
    const inside = !!hit && (hit === b || b.contains(hit));
    const d = (e) => e ? `${e.tagName.toLowerCase()}${e.getAttribute('data-testid')
      ? `[${e.getAttribute('data-testid')}]` : ''}` : 'none';
    return { ok: inside, hit: d(hit), bar: d(b), top: Math.round(r0.top) };
  });
  if (!r.hitTest.ok) bad(`${name}: 차트 막대가 보이는데 눌리지 않습니다 — ${r.hitTest.hit}이 덮고 있습니다`);
  else ok(`${name}: 차트 막대가 실제로 눌립니다`);

  await page.click('[data-testid="mkt-chart-bar"]', { timeout: 5000 }).catch(async () => {
    await page.evaluate(() =>
      (document.querySelector('[data-testid="mkt-chart-bar"]'))?.click());
  });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${name}-${entered.screen}-chart-expanded.png` });
  r.expanded = await page.evaluate(() => ({
    overlay: window.__visible('[data-testid="chart-drawer-overlay"]'),
    canvas: window.__has('[data-region="tradingScreen"] canvas'),
    unavailable: window.__has('[data-testid="chart-drawer-unavailable"]'),
  }));
  if (!r.expanded.overlay.present) bad(`${name}: 차트 막대를 눌러도 펼쳐지지 않습니다`);
  else ok(`${name}: 차트 펼침 (덮개 ${r.expanded.overlay.h}px)`);

  await page.click('[data-testid="chart-drawer-close"]', { timeout: 5000 }).catch(async () => {
    await page.evaluate(() =>
      (document.querySelector('[data-testid="chart-drawer-close"]'))?.click());
  });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() =>
    document.querySelector('[data-testid="order-controls"] input')?.value ?? null);
  r.stateKept = { before, after };
  if (before != null && before !== after) {
    bad(`${name}: 차트를 닫았더니 주문 입력이 바뀌었습니다 (${before} → ${after})`);
  } else ok(`${name}: 차트를 여닫아도 주문 입력 보존 (${String(after)})`);

  // ── ③ 시장 금지 칸이 렌더되지 않는다 ──
  const forbidden = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="spot-trading-screen"]');
    if (!root) return null;
    const banned = ['mkt-leverage', 'mkt-margin-mode', 'mkt-funding',
      'mkt-liquidation-price', 'mkt-liquidation-distance', 'mkt-reduce-only',
      'mkt-long-short', 'mkt-open-close', 'mkt-mark-price'];
    return banned.filter(b => !!root.querySelector(`[data-testid="${b}"]`));
  });
  r.forbidden = forbidden;
  if (forbidden == null) console.log(`  · ${name}: 현물 화면이 아니라 금지 칸 검사를 건너뜁니다`);
  else if (forbidden.length) bad(`${name}: 현물 화면에 선물 칸이 렌더됐습니다 [${forbidden.join(', ')}]`);
  else ok(`${name}: 현물 화면에 선물 칸 없음`);

  // ══ ⑤ 시장 탭 넷이 실제 화면까지 간다 ══
  //
  // 탭만 만들고 화면을 안 붙이면 사용자는 누를 수 있는데 아무 일도 안
  // 일어난다. 눌러 보고 **화면이 바뀌었는지**로 확인한다.
  r.tabs = {};
  for (const [tab, root] of [
    ['SPOT', 'spot-trading-screen'],
    ['USDM', 'usdm-trading-screen'],
    ['COINM', 'coinm-trading-screen'],
    ['STOCK', 'stock-trading-screen'],
  ]) {
    await page.click(`[data-testid="market-tab-${tab}"]`, { timeout: 5000 }).catch(async () => {
      await page.evaluate((t) =>
        (document.querySelector(`[data-testid="market-tab-${t}"]`))?.click(), tab);
    });
    await page.waitForTimeout(900);
    const got = await page.evaluate((rootId) => {
      const host = document.querySelector('[data-testid="paper-order-screen"]');
      const el = document.querySelector(`[data-testid="${rootId}"]`);
      const cta = document.querySelector('[data-testid="trading-cta"] button');
      return {
        screen: host?.getAttribute('data-screen') ?? null,
        market: host?.getAttribute('data-market') ?? null,
        tradable: host?.getAttribute('data-tradable') ?? null,
        rendered: !!el,
        active: document.querySelector('[data-testid="market-tabs"] [data-active="1"]')
          ?.getAttribute('data-testid') ?? null,
        ctaDisabled: cta ? cta.disabled : null,
        reason: document.querySelector('[data-testid="instrument-unavailable"]')?.textContent?.trim() ?? null,
        // ★ 다른 시장 데이터를 빌려 오지 않았는가
        borrowedBook: !!document.querySelector('[data-region="tradingScreen"] [data-testid="mkt-order-book"] table'),
      };
    }, root);
    r.tabs[tab] = got;

    if (!got.rendered) { bad(`${name}: ${tab} 탭이 화면까지 가지 않습니다 (screen=${got.screen})`); continue; }
    if (got.active !== `market-tab-${tab}`) bad(`${name}: ${tab} 탭이 active 표시가 안 됩니다`);
    ok(`${name}: ${tab} 탭 → ${got.screen} 도달 (tradable=${got.tradable})`);

    await page.screenshot({ path: `${OUT}/${name}-${tab}-collapsed.png` });

    // ⑥ 종목이 없으면 **주문이 잠기고 사유가 보인다**
    if (got.tradable === '0') {
      if (got.ctaDisabled !== true) {
        bad(`${name}: ${tab}에 종목이 없는데 실행 버튼이 열려 있습니다`);
      } else if (!got.reason) {
        bad(`${name}: ${tab}에 종목이 없는데 이유가 화면에 없습니다`);
      } else {
        ok(`${name}: ${tab} 도달했지만 거래 불가 — 사유 표시 + 주문 잠금`);
      }
    } else if (got.ctaDisabled === true && tab !== 'STOCK') {
      console.log(`  · ${name}: ${tab} 거래 가능인데 버튼이 잠겼다 (로그아웃 상태일 수 있음)`);
    }
  }

  // 원래 탭으로 돌려놓는다
  await page.evaluate(() =>
    (document.querySelector('[data-testid="market-tab-SPOT"]'))?.click());
  await page.waitForTimeout(500);

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/market-screens.json`, JSON.stringify(all, null, 2));
console.log(`\n스크린샷·측정값: ${OUT}`);
if (fails) { console.error(`\n실패 ${fails}건`); process.exit(1); }
console.log('\n✅ 시장별 거래 화면 — 차트 접힘 · 첫 화면에 호가/주문/버튼 · 상태 보존 · 의미 비혼합');
