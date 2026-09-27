#!/usr/bin/env node
// scripts/probe/order-review.mjs
//
// **USDⓈ-M 모의 진입 — 확인 창을 실기에서 눌러 본다.**
//
// 무엇을 증명하는가
// ─────────────────
// 시험은 순수 함수(`reviewReduce` · `confirmVerdict`)를 본다. 그 판정이
// 화면에 **실제로 배선됐는지**는 다른 사실이다. 이 저장소가 이름 붙인
// 1번 고장이 정확히 그것이다 — 만들어 놓고 배선을 안 함.
//
// 그래서 여기서는 세는 것만 본다:
//
//   첫 클릭          창이 안 열린다
//   두 번째 클릭     창이 열린다 · **/api/paper/order 0건**
//   창에 적힌 값     주문폼의 예상값과 같은 숫자인가
//   창이 열린 동안   시장 탭 · 종목 고르기가 실제로 disabled인가
//   취소             주문 0건
//   확인             주문 **정확히 1건**
//   청산 탭          창이 안 열리고 주문 0건
//
// 이 컨테이너에서 어떻게 거기까지 가는가
// ──────────────────────────────────────
// 셋을 프로브가 대신 준다. **제품 코드에는 분기가 없다** — 전부 환경이다:
//
//   ⑴ 로그인   `lib/auth.mjs`의 프로브 세션 (PROBE_ENV 빌드 필요)
//   ⑵ 장부     `/api/paper/positions`를 가로채 잔고를 준다
//   ⑶ 시세     거래소 WebSocket이 망 정책에 막히므로 `window.WebSocket`을
//              프로브가 바꿔 `depth` · `bookTicker` 프레임을 그대로 흘린다
//
// ⑶ 덕분에 **호가 사다리도 실제로 그려진다** — 지난 판에서 "확인 못 함"으로
// 남겼던 호가 눌림 표시를 여기서 잰다.
//
// 사용법:
//   NEXT_PUBLIC_SUPABASE_URL/ANON을 PROBE_ENV로 주고 빌드한 서버에
//   node scripts/probe/order-review.mjs <port> [out]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { seedAuthScript, blockAuthHost, assertProbeSignedIn } from './lib/auth.mjs';

const PORT = process.argv[2], OUT = process.argv[3] || '/tmp/order-review';
const B = `http://localhost:${PORT}`;
if (!PORT) { console.error('사용법: node scripts/probe/order-review.mjs <port> [out]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [['360x660', 360, 660], ['390x844', 390, 844], ['430x932', 430, 932]];

const PRICE = 3000;
const ETH_ROWS = { bid: PRICE - 0.5, ask: PRICE + 0.5 };

/**
 * 거래소 WebSocket을 프로브가 대신한다.
 *
 * 값을 **지어내는 것**이 맞는가: 여기서 증명하려는 것은 "가격이 얼마인가"가
 * 아니라 "가격이 있을 때 화면이 무엇을 하는가"다. 가격의 출처는 시험
 * (`streamEndpoints` · `paperPlan`)이 따로 본다. 그래서 여기서는 값이 있는
 * 상태를 만들고, 그 값이 **화면 · 확인 창 · 주문에 같게 흐르는지**만 센다.
 */
const fakeStreamScript = (bid, ask) => ({
  content: `(() => {
    const Real = window.WebSocket;
    function Fake(url) {
      this.url = String(url);
      this.readyState = 0;
      const sym = (this.url.match(/streams=([a-z0-9]+)@/) || [])[1] || 'ethusdt';
      const send = (obj) => { try { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); } catch {} };
      setTimeout(() => {
        this.readyState = 1;
        try { this.onopen && this.onopen({}); } catch {}
        const mk = (n) => Array.from({ length: 7 }, (_, i) => [String(n + i * 0.5), '1.5']);
        const tick = () => {
          if (this.readyState !== 1) return;
          send({ stream: sym + '@depth20@100ms', data: { a: mk(${ask}), b: mk(${bid}).reverse() } });
          send({ stream: sym + '@bookTicker', data: { b: '${bid}', a: '${ask}' } });
        };
        tick();
        this._t = setInterval(tick, 1000);
      }, 30);
    }
    Fake.prototype.close = function () {
      this.readyState = 3; clearInterval(this._t);
      try { this.onclose && this.onclose({}); } catch {}
    };
    Fake.prototype.send = function () {};
    Fake.OPEN = 1; Fake.CLOSED = 3; Fake.CONNECTING = 0; Fake.CLOSING = 2;
    window.WebSocket = Fake;
    window.__realWebSocket = Real;
  })();`,
});

/**
 * 로그인 모달이 떠 있으면 닫는다.
 *
 * 프로브 세션이 심어져 있어도 이 모달이 뜨는 경로가 있다 — 이 컨테이너는
 * Supabase 호스트로 나가는 요청을 전부 막으므로(`blockAuthHost`) 사용자
 * 조회가 끝나기 전에 [구매]를 누르면 "로그인 안 됨"으로 한 번 잡힌다.
 * 제품 동작이고 이 작업과 무관하지만, **덮인 채로 배치를 재면 "화면 안에
 * 있다"가 거짓이 된다** — JS로 부르는 클릭은 덮개를 통과하므로 동작은
 * 초록인데 사람은 못 누르는 상태가 그대로 남는다.
 *
 * 닫는 것이지 우회하는 것이 아니다. 아래 화면은 그대로다.
 */
async function dismissLogin(page) {
  for (let i = 0; i < 4; i += 1) {
    const found = await page.evaluate(() => {
      const m = [...document.querySelectorAll('div')]
        .find(e => getComputedStyle(e).zIndex === '10070'
          && getComputedStyle(e).position === 'fixed');
      if (!m) return false;
      const x = [...m.querySelectorAll('button')]
        .find(b => (b.getAttribute('aria-label') || '') === '닫기');
      if (x) x.click(); else m.click();
      return true;
    });
    await page.waitForTimeout(400);
    if (!found) return true;
  }
  return false;
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const all = {};
let fails = 0;
let unknowns = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); fails += 1; };
const ok = (m) => console.log(`  ✓ ${m}`);
/** 확인하지 못한 것 — **통과가 아니다** */
const note = (m) => { console.log(`  · ${m}`); unknowns += 1; };

const num = (s) => {
  const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

for (const [name, w, h] of VIEWPORTS) {
  console.log(`\n── ${name} ──`);
  const r = all[name] = {};
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('tg_onboarded_v1', '1');
    localStorage.setItem('tg_lang', 'ko');
    let p = {}; try { p = JSON.parse(localStorage.getItem('tg_prefs_v1') || '{}'); } catch {}
    p.uiLevel = 'PRO'; localStorage.setItem('tg_prefs_v1', JSON.stringify(p));
  });
  await ctx.addInitScript(seedAuthScript());
  await ctx.addInitScript(fakeStreamScript(ETH_ROWS.bid, ETH_ROWS.ask));
  const page = await ctx.newPage();
  await blockAuthHost(page);

  // ── 주문 요청을 **센다.** 화면 글자가 아니라 나가는 요청이 사실이다 ──
  const orders = [];
  await page.route('**/api/paper/order', async (route) => {
    orders.push(route.request().postData() || '');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, message: '모의 주문이 체결됐습니다' }),
    });
  });

  await page.route('**/api/news**', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, source: 'mock', news: [] }),
  }));
  await page.route('**/api/paper/positions**', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      account: { balance: 10000, available: 10000, availableUnknownReason: null },
      openPositions: [],
    }),
  }));
  await page.route('**/api/market/instruments?market=USDM**', rt => rt.fulfill({
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

  // ── 거래 화면까지 ──
  await page.goto(`${B}/?tab=market`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await assertProbeSignedIn(page);
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

  await dismissLogin(page);

  const screen = await page.evaluate(() =>
    !!document.querySelector('[data-testid="paper-order-screen"]'));
  if (!screen) { bad(`${name}: 거래 화면까지 가지 못했습니다`); await ctx.close(); continue; }

  // ── USDⓈ-M · ETHUSDT ──
  await page.evaluate(() =>
    (document.querySelector('[data-testid="market-tab-USDM"]'))?.click());
  await page.waitForTimeout(800);
  await page.evaluate(() =>
    (document.querySelector('[data-testid="pick-instrument"]'))?.click());
  await page.waitForTimeout(900);
  const picked = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="instrument-row-ETHUSDT"]');
    if (!b) return false; b.click(); return true;
  });
  await page.waitForTimeout(1200);
  if (!picked) { bad(`${name}: 목록에서 ETHUSDT를 고르지 못했습니다`); await ctx.close(); continue; }

  // 손절거리(선물 필수) · 비중을 넣어 **보낼 수 있는 상태**로 만든다
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="sl-2"]')
      || document.querySelector('[data-testid="sl-1"]')
      || [...document.querySelectorAll('[data-testid^="sl-"]')][0];
    if (b) b.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="sizing-slider-input"]');
    if (!el) return;
    const set = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '10');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(700);

  // ── ⓐ 호가 사다리가 실제로 그려졌는가 + 눌림 표시가 없는가 ──
  {
    const book = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="mkt-order-book"]');
      if (!box) return null;
      const rows = [...box.querySelectorAll('[data-book-row]')];
      return {
        rows: rows.length,
        pointer: [...box.querySelectorAll('*')]
          .filter(e => getComputedStyle(e).cursor === 'pointer').length,
        underline: [...box.querySelectorAll('*')]
          .filter(e => getComputedStyle(e).textDecorationLine === 'underline').length,
        limitTitle: [...box.querySelectorAll('[title]')]
          .filter(e => (e.getAttribute('title') || '').includes('지정가')).length,
        liveButtons: [...box.querySelectorAll('button')].filter(x => !x.disabled).length,
      };
    });
    r.book = book;
    if (!book) bad(`${name}: 호가판을 찾지 못했습니다`);
    else if (book.rows === 0) {
      note(`${name}: 호가 사다리가 그려지지 않아 눌림 표시를 확인하지 못했습니다`);
    } else if (book.pointer || book.underline || book.limitTitle || book.liveButtons) {
      bad(`${name}: 호가에 눌림 표시가 켜져 있습니다`
        + ` (줄 ${book.rows} · 커서 ${book.pointer} · 밑줄 ${book.underline}`
        + ` · 지정가 title ${book.limitTitle} · 살아 있는 버튼 ${book.liveButtons})`);
    } else {
      ok(`${name}: 호가 ${book.rows}줄이 실제로 그려졌고 눌림 표시가 없다`);
    }
  }

  const read = () => page.evaluate(() => {
    const host = document.querySelector('[data-testid="paper-order-screen"]');
    const sheet = document.querySelector('[data-testid="paper-order-review-sheet"]');
    const cta = document.querySelector('[data-testid="pro-order-cta-LONG"]');
    const txt = (t) => document.querySelector(`[data-testid="${t}"]`)?.textContent?.trim() ?? null;
    return {
      reviewPhase: host?.getAttribute('data-review-phase') ?? null,
      switchLock: host?.getAttribute('data-switch-lock') ?? null,
      ctaAction: cta?.getAttribute('data-cta-action') ?? null,
      ctaDisabled: cta ? cta.disabled === true : null,
      sheet: !!sheet,
      sheetMarket: sheet?.getAttribute('data-review-market') ?? null,
      sheetSymbol: sheet?.getAttribute('data-review-symbol') ?? null,
      sheetSide: sheet?.getAttribute('data-review-side') ?? null,
      usdmIntent: host?.getAttribute('data-usdm-intent') ?? null,
      shellInert: (() => {
        const sh = document.querySelector('[data-region="tradingScreen"]');
        return sh ? (sh.inert === true || sh.getAttribute('data-inert') === '1') : null;
      })(),
      dialog: sheet ? {
        role: sheet.getAttribute('role'),
        modal: sheet.getAttribute('aria-modal'),
        label: sheet.getAttribute('aria-label'),
      } : null,
      stripLiq: txt('mkt-liquidation-distance-value'),
      tabDisabled: document.querySelector('[data-testid="market-tab-SPOT"]')?.disabled ?? null,
      pickDisabled: document.querySelector('[data-testid="pick-instrument"]')?.disabled ?? null,
      confirmDisabled: document.querySelector('[data-testid="review-confirm"]')?.disabled ?? null,
      confirmAction: document.querySelector('[data-testid="review-confirm"]')
        ?.getAttribute('data-confirm-action') ?? null,
      recalc: txt('review-recalc-note'),
      sheetVals: {
        SYMBOL: txt('review-value-SYMBOL'), SIDE: txt('review-value-SIDE'),
        ORDER_TYPE: txt('review-value-ORDER_TYPE'),
        QUANTITY: txt('review-value-QUANTITY'), NOTIONAL: txt('review-value-NOTIONAL'),
        REQUIRED_MARGIN: txt('review-value-REQUIRED_MARGIN'),
        ENTRY_FEE: txt('review-value-ENTRY_FEE'),
        LIQUIDATION_PRICE: txt('review-value-LIQUIDATION_PRICE'),
        LIQUIDATION_DISTANCE: txt('review-value-LIQUIDATION_DISTANCE'),
        REFERENCE_PRICE: txt('review-value-REFERENCE_PRICE'),
      },
      est: {
        qty: txt('est-qty'), margin: txt('est-margin'),
        fee: txt('est-fee'), liq: txt('est-liq'),
      },
      confirmBottom: (() => {
        const f = document.querySelector('[data-testid="review-confirm"]');
        if (!f) return null;
        const b = f.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: window.innerHeight };
      })(),
    };
  });

  const clickCta = async () => {
    await page.evaluate(() =>
      document.querySelector('[data-testid="pro-order-cta-LONG"]')?.click());
    await page.waitForTimeout(600);
  };

  // ── ⓑ 첫 클릭은 방향만 ──
  const before = await read();
  r.before = before;
  await clickCta();
  const first = await read();
  r.first = first;
  if (first.sheet) bad(`${name}: 첫 클릭에 확인 창이 열렸습니다`);
  else if (orders.length) bad(`${name}: 첫 클릭에 주문이 나갔습니다 (${orders.length}건)`);
  else ok(`${name}: 첫 클릭 — 방향만 고른다 (창 없음 · 주문 0건)`);

  // ── ⓒ 두 번째 클릭은 확인 창 ──
  if (first.ctaAction !== 'OPEN_REVIEW') {
    bad(`${name}: 두 번째 클릭의 할 일이 OPEN_REVIEW가 아닙니다`
      + ` (${first.ctaAction} · disabled=${first.ctaDisabled}`
      + ` · 사유=${await page.evaluate(() => document.querySelector('[data-testid="order-blocked-reason"]')?.textContent?.trim() ?? '')})`);
    await page.screenshot({ path: `${OUT}/${name}-cta-not-ready.png` });
    await ctx.close();
    continue;
  }
  await clickCta();
  const cleared = await dismissLogin(page);
  if (!cleared) {
    bad(`${name}: 로그인 모달을 닫지 못했습니다 — 아래 배치 측정은 믿을 수 없습니다`);
  }
  const open = await read();
  r.open = open;
  await page.screenshot({ path: `${OUT}/${name}-review-open.png` });

  if (!open.sheet) bad(`${name}: 두 번째 클릭에 확인 창이 열리지 않았습니다`);
  else if (orders.length) bad(`${name}: ★ 확인 창을 여는데 주문이 나갔습니다 (${orders.length}건)`);
  else ok(`${name}: 두 번째 클릭 — 확인 창이 열리고 주문은 0건`);

  // ── ⓓ 창이 보여 주는 주문 == 화면이 다루는 주문 ──
  if (open.sheetMarket !== 'USDM' || open.sheetSymbol !== 'ETHUSDT' || open.sheetSide !== 'LONG') {
    bad(`${name}: 창이 다른 주문을 보여 줍니다`
      + ` (${open.sheetMarket}/${open.sheetSymbol}/${open.sheetSide})`);
  } else ok(`${name}: 창의 정체성 = USDM · ETHUSDT · LONG`);

  for (const [k, est] of [['QUANTITY', 'qty'], ['REQUIRED_MARGIN', 'margin'],
                          ['ENTRY_FEE', 'fee'], ['LIQUIDATION_PRICE', 'liq']]) {
    const a = num(open.sheetVals[k]), b = num(open.est[est]);
    if (a == null || b == null) {
      note(`${name}: ${k}를 비교하지 못했습니다 (창 ${open.sheetVals[k]} / 예상값 ${open.est[est]})`);
    } else if (Math.abs(a - b) > Math.max(1e-6, Math.abs(b) * 1e-6)) {
      bad(`${name}: ★ 창과 주문폼의 ${k}가 다릅니다 (${a} vs ${b})`);
    } else ok(`${name}: ${k} 일치 (${open.sheetVals[k]})`);
  }
  if (open.sheetVals.ORDER_TYPE !== '시장가') {
    bad(`${name}: 주문 방식이 '시장가'가 아닙니다 (${open.sheetVals.ORDER_TYPE})`);
  }
  if (!/서버가 다시 계산/.test(open.recalc || '')) {
    bad(`${name}: 서버 재계산 문구가 없습니다 (${open.recalc})`);
  } else {
    // ★ **스크롤하지 않고 보이는가.** 본문 안에 접혀 있으면 화면 숫자가
    //   확정 체결가로 읽힌다 — 360×660에서 실제로 접혀 있었다.
    const vis = await page.evaluate(() => {
      const e = document.querySelector('[data-testid="review-recalc-note"]');
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: window.innerHeight };
    });
    if (!vis || vis.bottom > vis.h + 1 || vis.top < 0) {
      bad(`${name}: 서버 재계산 문구가 첫 화면 밖입니다 (${JSON.stringify(vis)})`);
    } else ok(`${name}: 서버 재계산 문구가 스크롤 없이 보인다 (${vis.top}~${vis.bottom})`);
  }

  // 확인 버튼이 첫 화면 안에 있는가 (본문이 길어도 밀려나지 않는다)
  const cb = open.confirmBottom;
  if (!cb) bad(`${name}: 확인 버튼을 찾지 못했습니다`);
  else if (cb.bottom > cb.h + 1) {
    bad(`${name}: 확인 버튼이 화면 밖입니다 (${cb.top}~${cb.bottom} / ${cb.h})`);
  } else ok(`${name}: 확인 버튼이 화면 안 (${cb.top}~${cb.bottom} / ${cb.h})`);

  // ★ **그 자리에 정말 확인 버튼이 있는가.**
  //   JS로 부르는 클릭은 덮개를 무시하고 통과한다 — 동작은 초록인데 사람은
  //   못 누르는 상태가 생긴다. 좌표를 찍어 맨 위에 무엇이 있는지 본다.
  const hit = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="review-confirm"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const cs = el ? getComputedStyle(el) : null;
    return { same: el === b || b.contains(el), tag: el?.tagName ?? null,
      testid: el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      z: cs?.zIndex ?? null, pos: cs?.position ?? null,
      txt: (el?.textContent || '').slice(0, 40) };
  });
  r.hit = hit;
  if (!hit) bad(`${name}: 확인 버튼 좌표를 재지 못했습니다`);
  else if (!hit.same) {
    bad(`${name}: 확인 버튼 자리를 다른 것이 덮고 있습니다`
      + ` (${hit.tag} · ${hit.testid}) — 눌리는 것처럼 보이지만 사람은 못 누릅니다`);
  } else ok(`${name}: 확인 버튼이 실제로 맨 위에 있다 (좌표 히트)`);

  // ── ⓔ 창이 열린 동안 시장·종목을 못 바꾼다 ──
  if (open.switchLock !== 'ORDER_REVIEW') {
    bad(`${name}: 확인 중인데 전환 잠금이 ${open.switchLock}입니다`);
  } else if (open.tabDisabled !== true || open.pickDisabled !== true) {
    bad(`${name}: 확인 중인데 시장 탭(${open.tabDisabled}) · 종목 고르기(${open.pickDisabled})가 열려 있습니다`);
  } else ok(`${name}: 확인 중 — 시장 탭 · 종목 고르기 모두 DOM에서 꺼짐`);

  // ── ⓔ-2 ★ 상단 "청산까지"와 창의 청산거리가 **같은 숫자**인가 ──
  //
  //   예전에는 상단이 `leverageMath.liquidationDistancePct(lev)`(MMR 0.4% ·
  //   배율만)였고 창은 정본 계획(MMR 0.5% · 교차는 잔고까지)이었다. 같은
  //   주문인데 창을 열기 전과 연 뒤의 숫자가 달랐다.
  {
    const a = num(open.stripLiq), b = num(open.sheetVals.LIQUIDATION_DISTANCE);
    if (a == null || b == null) {
      note(`${name}: 청산거리를 비교하지 못했습니다 (상단 ${open.stripLiq} / 창 ${open.sheetVals.LIQUIDATION_DISTANCE})`);
    } else if (Math.abs(a - b) > 1e-6) {
      bad(`${name}: ★ 상단과 창의 청산거리가 다릅니다 (${a}% vs ${b}%)`);
    } else ok(`${name}: 청산거리 일치 (상단 == 창 == ${b}%)`);
  }

  // ── ⓔ-3 ★ 창이 떠 있는 동안 **키보드로 뒤로 나갈 수 없다** ──
  //
  //   덮개는 포인터만 막는다. 뒤의 진입/청산·배율·비중에 Tab으로 닿으면
  //   거기서 청산 탭으로 바꾼 채 확인을 누를 수 있다.
  if (!open.dialog || open.dialog.role !== 'dialog' || open.dialog.modal !== 'true'
      || !open.dialog.label) {
    bad(`${name}: 확인 창에 modal 의미가 없습니다 (${JSON.stringify(open.dialog)})`);
  } else ok(`${name}: 확인 창이 dialog/aria-modal + 이름을 갖는다`);

  if (open.shellInert !== true) {
    bad(`${name}: 창이 떠 있는데 뒤 화면이 키보드에 살아 있습니다 (inert=${open.shellInert})`);
  } else ok(`${name}: 창이 떠 있는 동안 뒤 화면이 inert`);

  {
    // 실제로 Tab을 눌러 본다. 어느 한 번이라도 포커스가 창 밖으로 나가면 FAIL.
    const escaped = [];
    for (const shift of [false, true]) {
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
        const where = await page.evaluate(() => {
          const a = document.activeElement;
          const sheet = document.querySelector('[data-testid="paper-order-review-sheet"]');
          if (!a || a === document.body) return 'BODY';
          return sheet && sheet.contains(a) ? 'IN'
            : (a.closest('[data-testid]')?.getAttribute('data-testid') || a.tagName);
        });
        if (where !== 'IN') escaped.push(`${shift ? 'S' : ''}Tab#${i}:${where}`);
      }
    }
    r.tabEscapes = escaped;
    if (escaped.length) {
      bad(`${name}: ★ Tab으로 확인 창 밖에 포커스가 갔습니다 (${escaped.slice(0, 4).join(' ')})`);
    } else ok(`${name}: Tab / Shift+Tab 28회 — 포커스가 창 안에 갇힌다`);
  }

  // ── ⓔ-4 ★ 창이 열린 채 **뒤의 청산 탭을 강제로 눌러도** 진입이 안 나간다 ──
  {
    const beforeForce = orders.length;
    // 덮개·inert를 무시하고 프로그램으로 직접 누른다 — 가장 나쁜 경우다.
    await page.evaluate(() =>
      document.querySelector('[data-testid="intent-CLOSE"]')?.click());
    await page.waitForTimeout(600);
    const forced = await read();
    // 창이 닫히거나(전이) 확인이 막혀야(판정) 한다 — 둘 중 하나로 충분하다
    const stillSendable = forced.sheet && forced.confirmDisabled === false;
    if (stillSendable) {
      bad(`${name}: ★ 청산으로 바뀌었는데 확인 버튼이 살아 있습니다`);
    }
    await page.evaluate(() =>
      document.querySelector('[data-testid="review-confirm"]')?.click());
    await page.waitForTimeout(800);
    if (orders.length !== beforeForce) {
      bad(`${name}: ★ 청산 화면인데 진입 주문이 나갔습니다`);
    } else {
      ok(`${name}: 창 열린 채 청산 강제 전환 → 확인 불가 · 주문 0건`
        + ` (창=${forced.sheet ? '유지' : '닫힘'} · intent=${forced.usdmIntent})`);
    }
    // 원래대로
    await page.evaluate(() =>
      document.querySelector('[data-testid="intent-OPEN"]')?.click());
    await page.waitForTimeout(400);
    if (!(await read()).sheet) { await clickCta(); await page.waitForTimeout(400); }
  }

  // ── ⓕ 취소하면 주문 0건 ──
  await page.evaluate(() =>
    document.querySelector('[data-testid="review-cancel"]')?.click());
  await page.waitForTimeout(600);
  const cancelled = await read();
  r.cancelled = cancelled;
  if (cancelled.sheet) bad(`${name}: 취소했는데 창이 남아 있습니다`);
  else if (orders.length) bad(`${name}: ★ 취소했는데 주문이 나갔습니다 (${orders.length}건)`);
  else if (cancelled.switchLock !== 'NONE') {
    bad(`${name}: 창을 닫았는데 전환 잠금이 ${cancelled.switchLock}입니다`);
  } else ok(`${name}: 취소 — 창이 닫히고 주문 0건, 전환 잠금 해제`);

  // ── ⓖ 다시 열고 확인하면 주문 정확히 1건 ──
  await clickCta();
  await page.waitForTimeout(400);
  const reopened = await read();
  if (!reopened.sheet) { bad(`${name}: 다시 열리지 않았습니다`); await ctx.close(); continue; }
  if (reopened.confirmDisabled !== false || reopened.confirmAction !== 'SUBMIT') {
    bad(`${name}: 확인 버튼이 눌리는 상태가 아닙니다`
      + ` (disabled=${reopened.confirmDisabled} · ${reopened.confirmAction})`);
  }
  // 연타해도 한 번이어야 한다
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="review-confirm"]');
    b?.click(); b?.click(); b?.click();
  });
  await page.waitForTimeout(1500);
  r.orders = orders.length;
  await page.screenshot({ path: `${OUT}/${name}-review-after-confirm.png` });
  if (orders.length !== 1) {
    bad(`${name}: ★ 확인 연타에 주문이 ${orders.length}건 나갔습니다 — 정확히 1건이어야 합니다`);
  } else ok(`${name}: 확인 — 연타해도 주문 정확히 1건`);

  // 보낸 주문이 창에 적힌 주문과 같은가
  try {
    const body = JSON.parse(orders[0] || '{}');
    if (body.symbol !== 'ETHUSDT' || body.market !== 'USDM' || body.side !== 'LONG') {
      bad(`${name}: ★ 창에 적힌 주문과 나간 주문이 다릅니다`
        + ` (${body.market}/${body.symbol}/${body.side})`);
    } else ok(`${name}: 나간 주문 = 창에 적힌 주문 (USDM · ETHUSDT · LONG)`);
  } catch { note(`${name}: 주문 본문을 읽지 못했습니다`); }

  // ── ⓗ 청산 탭에서는 창이 열리지 않는다 ──
  const beforeClose = orders.length;
  await page.evaluate(() =>
    document.querySelector('[data-testid="intent-CLOSE"]')?.click());
  await page.waitForTimeout(500);
  await clickCta();
  const closed = await read();
  r.closed = closed;
  await page.screenshot({ path: `${OUT}/${name}-close-tab.png` });
  if (closed.sheet) bad(`${name}: ★ 청산 탭에서 확인 창이 열렸습니다`);
  else if (orders.length !== beforeClose) {
    bad(`${name}: ★ 청산 탭에서 주문이 나갔습니다`);
  } else if (closed.ctaDisabled !== true || closed.ctaAction !== 'NONE') {
    bad(`${name}: 청산 탭에서 진입 버튼이 살아 있습니다`
      + ` (disabled=${closed.ctaDisabled} · ${closed.ctaAction})`);
  } else ok(`${name}: 청산 탭 — 창 없음 · 주문 0건 · 버튼 DOM 꺼짐`);

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/order-review.json`, JSON.stringify(all, null, 2));
console.log(`\n스크린샷·측정값: ${OUT}`);
if (fails) { console.error(`\n실패 ${fails}건`); process.exit(1); }
if (unknowns) console.log(`\n확인 못 한 항목 ${unknowns}건 (위 · 표시 — 통과가 아닙니다)`);
console.log('\n✅ 확인 창 — 첫 클릭 방향만 · 두 번째 클릭 창 · 여는데 주문 0건 ·'
  + ' 값 일치 · 전환 잠금 · 취소 0건 · 확인 1건(연타 포함) · 청산 탭 차단');
