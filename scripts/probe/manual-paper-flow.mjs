// Browser regression for the real UI → PAPER request boundary.
// Run a local dev server with NEXT_PUBLIC_SUPABASE_URL=https://paper-test.supabase.co
// and NEXT_PUBLIC_SUPABASE_ANON_KEY=paper-test-public-key, then:
// node scripts/probe/manual-paper-flow.mjs 3001
// All API and exchange traffic is intercepted. No venue or database is touched.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { probeSession } from './lib/auth.mjs';

const port = process.argv[2] || '3001';
const origin = `http://localhost:${port}`;
const out = process.env.PROBE_OUT || '/tmp/manual-paper-flow';
mkdirSync(out, { recursive: true });
const orders = [], sells = [], starts = [];
let ledgerReads = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await ctx.addInitScript(({ session }) => {
  localStorage.setItem('tg_ob', JSON.stringify('1'));
  localStorage.setItem('tg_seen_login_v1', '1');
  localStorage.setItem('tg_prefs_v1', JSON.stringify({ uiLevel: 'BEGINNER' }));
  localStorage.setItem('sb-paper-test-auth-token', JSON.stringify(session));
  const Real = window.WebSocket;
  window.WebSocket = class extends EventTarget {
    static OPEN = 1; static CLOSED = 3;
    constructor(url) {
      super();
      if (!/binance/.test(String(url))) return new Real(url);
      this.readyState = 0;
      this.timer = setInterval(() => {
        this.readyState = 1;
        this.onopen?.({});
        const sym = (String(url).match(/streams=([a-z0-9]+)@/) || [])[1] || 'btcusdt';
        for (const [stream, data] of [
          ['@bookTicker', { b: '2999', a: '3001' }],
          ['@depth20@100ms', { a: [['3001','2']], b: [['2999','2']] }],
        ]) this.onmessage?.({ data: JSON.stringify({ stream: sym + stream, data }) });
      }, 200);
    }
    close() { this.readyState = 3; clearInterval(this.timer); }
    send() {}
  };
}, { session: probeSession() });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let started = false;
await page.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname.startsWith('/_next/') || url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
  let body = { ok: true };
  const path = url.pathname;
  if (url.hostname.endsWith('.supabase.co')) {
    if (path.endsWith('/user')) body = probeSession().user;
    else if (path.includes('/profiles')) body = [];
    else return route.abort();
  } else if (path === '/api/paper/account') {
    if (req.method() === 'POST') { starts.push(req.postDataJSON()); started = true; }
    body = { ok: true, started, account: { balance: started ? 10000 : null, available: started ? 10000 : null }, positions: [],
      equity: { state: started ? 'READY' : 'NOT_STARTED', totalEquity: started ? 10000 : null, cash: started ? 10000 : null, usedMargin: 0, unrealizedPnl: 0, realizedPnl: 0, returnPct: 0, currency: 'USDT' } };
  } else if (path === '/api/paper/positions') { ledgerReads++; body = { ok: true, account: { balance: 10000, available: 10000 }, openPositions: [], recentClosed: [] }; }
  else if (path === '/api/paper/holdings') body = { ok: true, holdings: [{ symbol: 'BTCUSDT', market: 'SPOT', quantity: 2, avgPrice: 2500, totalNotional: 5000, entryFeeBasis: 2.5, lots: 1 }] };
  else if (path === '/api/paper/order') { orders.push(req.postDataJSON()); body = { ok: true, message: '시험 모의 체결' }; }
  else if (path === '/api/paper/sell') { sells.push(req.postDataJSON()); body = { ok: true, message: '시험 모의 매도' }; }
  else if (path === '/api/paper/challenge') body = { ok: true, challenges: [] };
  else if (path === '/api/prices') body = { results: [{ id: 'BTC', symbol: 'BTC', nameKr: '비트코인', price: 3000, change24h: 1, source: 'probe' }], source: 'probe' };
  else if (path === '/api/news') body = { ok: true, news: [], data: [] };
  else if (path === '/api/exchange/connections') body = { ok: true, connections: [] };
  else if (path.endsWith('/ticker/24hr')) body = { priceChangePercent: '1', highPrice: '3100', lowPrice: '2900', volume: '100', quoteVolume: '300000' };
  else if (path.endsWith('/premiumIndex')) body = { markPrice: '3000', lastFundingRate: '0.0001', nextFundingTime: Date.now()+3600000 };
  else if (url.origin !== origin) return route.abort();
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

async function go(tab) {
  await page.goto(`${origin}/?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.getByRole('button', { name: '모의 매수', exact: true }).first().waitFor({ timeout: 60000 });
}
async function back() { await page.locator('[data-testid="paper-order-host"]').getByRole('button', { name: '뒤로', exact: true }).click(); }
async function buyReady() {
  await page.locator('[data-testid="buy-pct-25"]').click();
  await page.locator('[data-testid="buy-cta"]:enabled').waitFor({ timeout: 10000 });
}
try {
  await go('paper');
  // Creating an account must use the existing server action, never a local ledger.
  await page.getByRole('button', { name: '모의투자 시작하기', exact: true }).click();
  await page.getByRole('button', { name: /10,000/ }).first().click();
  assert.deepEqual(starts[0], { action: 'reset', seed: 10000 });
  console.log('PASS: 모의 계좌 생성 → 서버 계좌 요청');

  await page.getByRole('button', { name: '모의 매수', exact: true }).click();
  await buyReady();
  assert.equal(await page.locator('[data-testid="sl-2"]').count(), 0, '현물에는 손절 입력이 없어야 함');
  await page.locator('[data-testid="buy-cta"]').click();
  assert.equal(orders.length, 0, '확인 전에는 주문이 없어야 함');
  const beforeFillReads = ledgerReads;
  await page.locator('[data-testid="buy-confirm"]').click();
  await page.getByText('시험 모의 체결', { exact: true }).waitFor();
  assert.equal(orders.at(-1).side, 'LONG'); assert.equal(orders.at(-1).market, 'SPOT');
  assert.equal(orders.at(-1).leverage, undefined);
  assert.ok(ledgerReads > beforeFillReads, '체결 뒤 모의 잔고를 다시 읽어야 함');
  console.log('PASS: 현물 매수 → 서버 PAPER LONG (배율 없음)');
  await back();

  await page.getByRole('button', { name: '보유분 매도', exact: true }).click();
  // A spot sell must go to the holdings endpoint, never a new SHORT position.
  assert.equal(await page.locator('[data-testid="beginner-sell"]').count(), 1);
  await page.locator('[data-testid="sell-pct-100"]').click();
  await page.locator('[data-testid="sell-cta"]').click();
  const beforeSellOrders = orders.length;
  assert.equal(sells.length, 0);
  await page.locator('[data-testid="sell-confirm"]').click();
  await page.getByText('시험 모의 매도', { exact: true }).waitFor();
  assert.equal(sells[0].symbol, 'BTCUSDT'); assert.equal(sells[0].percent, 100);
  assert.equal(orders.length, beforeSellOrders, '현물 매도가 새 SHORT 진입을 만들면 안 됨');
  await page.screenshot({ path: `${out}/spot-sell.png`, fullPage: true });
  console.log('PASS: 현물 전량 매도 → 보유분 매도 API (신규 SHORT 없음)');
  await back();

  await page.getByLabel('모의 시장').selectOption('USDM');
  await page.getByRole('button', { name: '모의 숏', exact: true }).click();
  await page.locator('[data-testid="buy-pct-25"]').click();
  assert.equal(await page.locator('[data-testid="buy-cta"]').isDisabled(), true, '손절 없이는 선물 주문이 잠겨야 함');
  await page.locator('[data-testid="sl-2"]').click();
  await page.locator('[data-testid="buy-cta"]:enabled').waitFor();
  await page.locator('[data-testid="buy-cta"]').click();
  await page.locator('[data-testid="buy-confirm"]').click();
  await page.getByText('시험 모의 체결', { exact: true }).waitFor();
  assert.equal(orders.at(-1).side, 'SHORT', '숏 선택을 LONG으로 덮어쓰면 안 됨');
  assert.equal(orders.at(-1).market, 'USDM'); assert.equal(orders.at(-1).stopLossPct, 2);
  console.log('PASS: 간편 선물 SHORT + 필수 손절 → 실제 요청 방향 보존');
  await back();

  await page.getByRole('button', { name: '모의 롱', exact: true }).click();
  await page.locator('[data-testid="buy-pct-25"]').click();
  await page.locator('[data-testid="sl-2"]').click();
  await page.locator('[data-testid="buy-cta"]').click();
  const beforeCancelOrders = orders.length;
  await page.locator('[data-testid="buy-cancel"]').click();
  assert.equal(orders.length, beforeCancelOrders, '확인 취소는 주문을 보내면 안 됨');
  await page.locator('[data-testid="buy-cta"]').click();
  await page.locator('[data-testid="buy-confirm"]').click();
  await page.getByText('시험 모의 체결', { exact: true }).waitFor();
  assert.equal(orders.at(-1).side, 'LONG'); assert.equal(orders.at(-1).stopLossPct, 2);
  console.log('PASS: 간편 선물 LONG · 확인 취소 시 요청 0건');
  await back();

  await go('trading');
  await page.getByLabel('모의 시장').selectOption('USDM');
  await page.getByRole('button', { name: '모의 숏', exact: true }).click();
  await page.locator('[data-testid="beginner-buy"]').waitFor();
  assert.match(await page.locator('[data-testid="paper-order-host"]').innerText(), /숏 진입/);
  assert.equal(await page.evaluate(() => localStorage.getItem('tg_orders_v1')), null);
  await page.screenshot({ path: `${out}/trading-short.png`, fullPage: true });
  console.log('PASS: 매매 탭 → 같은 서버 주문 화면 · 가짜 로컬 체결 없음');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
