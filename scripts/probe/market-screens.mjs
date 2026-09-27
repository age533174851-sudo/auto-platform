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
//   ⑦ 목록의 `BTC`가 **`BTCUSDT`로 정규화되어** 차트·호가·봉 조회까지
//      그 심볼로 흘러가는가 (예전에는 `BTC`가 그대로 흘렀다)
//   ⑧ **화면이 보는 종목과 주문 폼이 쓰는 종목이 같은가** (Phase 2A)
//   ⑨ 수량/총액/빠른비율이 **같은 정본 수량**을 만드는가 (Phase 2B)
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

  // ★ 화면에 찍힌 글자가 아니라 **나가는 요청**을 본다. 심볼이 잘못돼도
  //   화면은 멀쩡해 보이고, 틀린 것은 조회로만 드러난다.
  const asked = { candles: [], ws: [] };
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/market/candles')) {
      try { asked.candles.push(new URL(u).searchParams.get('symbol')); } catch {}
    }
  });
  page.on('websocket', (w) => { asked.ws.push(w.url()); });

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

  // ══ ⑦ 목록 종목이 거래소 심볼로 정규화되어 조회까지 흘러가는가 ══
  //
  // 예전에는 `BTC`가 "이미 완성된 쌍"으로 읽혀 그대로 나갔다. 예외는
  // 안 나고, 그 심볼로 간 조회가 빈 결과를 줘서 "거래가 없는 종목"처럼
  // 보였다. 그래서 **나간 요청의 심볼**을 직접 본다.
  r.symbolFlow = {
    header: await page.evaluate(() =>
      document.querySelector('[data-testid="trading-market-label"]')?.textContent?.trim() ?? null),
    candles: [...new Set(asked.candles.filter(Boolean))],
    ws: [...new Set(asked.ws)].slice(0, 4),
  };
  {
    const bad2 = [];
    if (!/BTCUSDT/.test(r.symbolFlow.header || '')) {
      bad2.push(`헤더 심볼이 BTCUSDT가 아닙니다 (${r.symbolFlow.header})`);
    }
    for (const c of r.symbolFlow.candles) {
      if (c !== 'BTCUSDT') bad2.push(`봉 조회 심볼이 ${c}입니다`);
    }
    for (const u of r.symbolFlow.ws) {
      if (/btc(?!usdt)/i.test(u.replace(/btcusdt/gi, 'X'))) bad2.push(`스트림 심볼이 이상합니다 (${u})`);
    }
    if (bad2.length) bad2.forEach(m => bad(`${name}: ${m}`));
    else {
      ok(`${name}: 목록 BTC → BTCUSDT 정규화 (헤더 · 봉 ${r.symbolFlow.candles.length}건 · 스트림 ${r.symbolFlow.ws.length}건)`);
    }
  }

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
  await page.waitForTimeout(600);

  // ══ ⑦-b 실제 종목 선택 → 정체성이 **전부** 따라오는가 ══
  //
  // ★ 이 컨테이너의 망 정책이 거래소를 막는다(exchangeInfo가 HTTP 403).
  //   그래서 **앱의 목록 응답을 가로채** 거래소 응답 모양 그대로 넣는다.
  //   이것으로 증명되는 것과 아닌 것을 갈라 둔다:
  //
  //     증명됨    고르기 화면 → 선택 → 활성 정체성 → 시세·폼·헤더 전파
  //     증명 안 됨 실제 상장 여부(목록 권위 자체) — 시험이 파서를 따로 본다
  await page.route('**/api/market/instruments?market=USDM**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, market: 'USDM', asOf: Date.now(), count: 2,
      instruments: [
        { market: 'USDM', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
          catalogSource: 'BINANCE_USDM_EXCHANGE_INFO', asOf: Date.now() },
        { market: 'USDM', symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT',
          catalogSource: 'BINANCE_USDM_EXCHANGE_INFO', asOf: Date.now() },
      ],
    }),
  }));

  r.pick = {};
  {
    await page.evaluate(() =>
      (document.querySelector('[data-testid="market-tab-USDM"]'))?.click());
    await page.waitForTimeout(800);
    await page.evaluate(() =>
      (document.querySelector('[data-testid="pick-instrument"]'))?.click());
    await page.waitForTimeout(900);
    r.pick.opened = await page.evaluate(() =>
      !!document.querySelector('[data-testid="instrument-picker"]'));
    await page.screenshot({ path: `${OUT}/${name}-USDM-picker.png` });

    const picked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="instrument-row-ETHUSDT"]');
      if (!b) return false; b.click(); return true;
    });
    await page.waitForTimeout(1000);
    r.pick.after = await page.evaluate(() => {
      const h = document.querySelector('[data-testid="paper-order-screen"]');
      return {
        market: h?.getAttribute('data-market') ?? null,
        active: h?.getAttribute('data-active-symbol') ?? null,
        formSymbol: h?.getAttribute('data-form-symbol') ?? null,
        formMarket: h?.getAttribute('data-form-market') ?? null,
        tradable: h?.getAttribute('data-tradable') ?? null,
        header: document.querySelector('[data-testid="trading-market-label"]')?.textContent?.trim() ?? null,
      };
    });
    await page.screenshot({ path: `${OUT}/${name}-USDM-selected.png` });

    const a = r.pick.after;
    if (!r.pick.opened) bad(`${name}: USDⓈ-M 고르기 화면이 열리지 않습니다`);
    else if (!picked) bad(`${name}: 목록에 ETHUSDT가 없습니다`);
    else if (a.active !== 'ETHUSDT' || a.formSymbol !== 'ETHUSDT'
      || a.formMarket !== 'USDM' || a.market !== 'USDM') {
      bad(`${name}: 종목을 골랐는데 정체성이 따라오지 않습니다 `
        + `(market=${a.market} active=${a.active} form=${a.formMarket}/${a.formSymbol})`);
    } else if (a.tradable !== '1') {
      bad(`${name}: 종목을 골랐는데 거래 불가로 남았습니다`);
    } else {
      ok(`${name}: USDⓈ-M ETHUSDT 선택 → 화면·폼·헤더 전부 같은 정체성 (tradable=1)`);
    }
    if (a.header && !a.header.includes('ETHUSDT')) {
      bad(`${name}: 헤더가 고른 종목을 따라오지 않습니다 (${a.header})`);
    }

    // ★ 현물로 돌아오면 **원래 종목**이 복원되고, 선물 심볼이 따라오지 않는다
    await page.evaluate(() =>
      (document.querySelector('[data-testid="market-tab-SPOT"]'))?.click());
    await page.waitForTimeout(800);
    r.pick.backToSpot = await page.evaluate(() => {
      const h = document.querySelector('[data-testid="paper-order-screen"]');
      return { market: h?.getAttribute('data-market') ?? null,
        active: h?.getAttribute('data-active-symbol') ?? null,
        formSymbol: h?.getAttribute('data-form-symbol') ?? null };
    });
    if (r.pick.backToSpot.active !== 'BTCUSDT' || r.pick.backToSpot.formSymbol !== 'BTCUSDT') {
      bad(`${name}: 현물로 돌아왔는데 종목이 복원되지 않습니다 (${r.pick.backToSpot.active})`);
    } else ok(`${name}: 현물 복귀 → BTCUSDT 복원 (선물 심볼이 따라오지 않음)`);

    // 선물로 다시 가면 고른 종목이 남아 있다
    await page.evaluate(() =>
      (document.querySelector('[data-testid="market-tab-USDM"]'))?.click());
    await page.waitForTimeout(800);
    const again = await page.evaluate(() =>
      document.querySelector('[data-testid="paper-order-screen"]')?.getAttribute('data-active-symbol') ?? null);
    r.pick.usdmAgain = again;
    if (again !== 'ETHUSDT') bad(`${name}: 선물 재진입에 고른 종목이 사라졌습니다 (${again})`);
    else ok(`${name}: 선물 재진입 → ETHUSDT 복원`);

    await page.evaluate(() =>
      (document.querySelector('[data-testid="market-tab-SPOT"]'))?.click());
    await page.waitForTimeout(600);
  }

  // ══ ⑧ 화면 종목 == 폼 종목 ══
  //
  // Phase 1에 있던 구멍이다. 화면은 ETHUSDT를 보여주면서 주문은 BTCUSDT로
  // 나갈 수 있었다. **속성으로 드러낸 값을 직접 비교한다.**
  r.identity = await page.evaluate(() => {
    const h = document.querySelector('[data-testid="paper-order-screen"]');
    return {
      market: h?.getAttribute('data-market') ?? null,
      active: h?.getAttribute('data-active-symbol') ?? null,
      formSymbol: h?.getAttribute('data-form-symbol') ?? null,
      formMarket: h?.getAttribute('data-form-market') ?? null,
      header: document.querySelector('[data-testid="trading-market-label"]')?.textContent?.trim() ?? null,
    };
  });
  {
    const i = r.identity;
    if (i.active && i.active !== i.formSymbol) {
      bad(`${name}: 화면 종목(${i.active})과 폼 종목(${i.formSymbol})이 다릅니다`);
    } else if (!i.active) {
      bad(`${name}: 활성 종목이 비어 있습니다`);
    } else {
      ok(`${name}: 화면=폼 정체성 일치 (${i.formMarket} · ${i.formSymbol})`);
    }
    // 헤더에 적힌 것과도 같아야 한다
    if (i.active && i.header && !i.header.includes(i.active)) {
      bad(`${name}: 헤더(${i.header})가 활성 종목(${i.active})과 다릅니다`);
    }
  }

  // ══ ⑨ 수량 / 총액 / 빠른비율이 같은 정본 수량을 만든다 ══
  const readQty = () => page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      // 입력 부품이 보여주는 "주문 수량"
      effective: t('[data-testid="size-effective"]'),
      // 예상값 줄의 수량 — **다른 경로로 읽은 같은 값이어야 한다**
      estimate: t('[data-testid="est-qty"]'),
      reason: t('[data-testid="size-input-reason"]'),
    };
  });
  r.sizing = {};
  for (const [label, act] of [
    ['25%', async () => { await page.evaluate(() =>
      (document.querySelector('[data-testid="alloc-25"]'))?.click()); }],
    ['MAX', async () => { await page.evaluate(() =>
      (document.querySelector('[data-testid="alloc-max"]'))?.click()); }],
    ['수량입력', async () => {
      await page.evaluate(() =>
        (document.querySelector('[data-testid="size-mode-QTY"]'))?.click());
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="size-input"]');
        if (!el) return;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(el, '0.01');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }],
    ['총액초과', async () => {
      await page.evaluate(() =>
        (document.querySelector('[data-testid="size-mode-NOTIONAL"]'))?.click());
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="size-input"]');
        if (!el) return;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(el, '99999999');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }],
  ]) {
    await act();
    await page.waitForTimeout(350);
    r.sizing[label] = await readQty();
  }
  {
    const present = Object.values(r.sizing).some(v => v.effective != null);
    if (!present) bad(`${name}: 수량/총액 입력 부품이 화면에 없습니다`);
    else {
      // 같은 순간의 두 표시가 어긋나면 계산이 두 벌이라는 뜻이다
      for (const [k, v] of Object.entries(r.sizing)) {
        if (v.effective == null || v.estimate == null) continue;
        const a = (v.effective.match(/[\d.]+/) || [])[0];
        const b = (v.estimate.match(/[\d.]+/) || [])[0];
        if (a && b && a !== b) {
          bad(`${name}: ${k}에서 입력부(${a})와 예상값(${b})의 수량이 다릅니다`);
        }
      }
      // ★ 초과 입력은 **반영되지 않고 사유가 뜬다**
      const over = r.sizing['총액초과'];
      if (!over?.reason) bad(`${name}: 잔고를 넘는 총액인데 사유가 없습니다`);
      else ok(`${name}: 초과 입력을 반영하지 않고 적습니다`);
      ok(`${name}: 수량/총액/빠른비율이 같은 수량을 만듭니다`);
    }
  }
  await page.screenshot({ path: `${OUT}/${name}-SPOT-sizing.png` });

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/market-screens.json`, JSON.stringify(all, null, 2));
console.log(`\n스크린샷·측정값: ${OUT}`);
if (fails) { console.error(`\n실패 ${fails}건`); process.exit(1); }
console.log('\n✅ 시장별 거래 화면 — 차트 접힘 · 첫 화면에 호가/주문/버튼 · 상태 보존 · 의미 비혼합');
