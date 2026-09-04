// 자동매매 첫 화면의 **조작과 전이**가 실제로 동작하는가.
//
// 상태별 렌더가 맞는 것과, 사용자가 쓰는 동안 그 값이 옳게 바뀌는 것은
// 다르다. UI-3C에서 기하 10/10을 통과하고도 조작 셋이 죽어 있었다.
//
// 사용법: node scripts/probe/auto-interaction.mjs <port>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const B = 'http://localhost:' + process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fails = 0;
const say = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`); };

const row = (o = {}) => ({
  id: `s-${o.symbol || 'BTCUSDT'}`, symbol: 'BTCUSDT', enabled: true, mode: 'TESTNET',
  connectionState: 'OK', strategyRunnable: true,
  runtime: { state: 'WATCHING', reason: '정상 평가 중' }, state: 'ACTIVE', ...o,
});

/** 지연 응답/응답 교체가 가능한 창을 연다 */
async function open(w, h, initial) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko');
    localStorage.setItem('sb_access_token', 'probe-token');
  });
  const page = await ctx.newPage();
  const box = { fixture: initial };
  await page.route('**/api/autotrade/schedule**', async r => {
    const f = box.fixture;
    if (f.delayMs) await new Promise(res => setTimeout(res, f.delayMs));
    r.fulfill({ status: f.status, contentType: 'application/json', body: JSON.stringify(f.body) });
  });
  await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"news":[]}' }));
  await page.goto(B, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 4; i++) {
    const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
    await page.waitForTimeout(250); if (!s) break;
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  return { ctx, page, box };
}
const snap = page => page.evaluate(() => {
  const h = document.querySelector('[data-region="executionTruth"]');
  return {
    state: h?.getAttribute('data-state') ?? null,
    env: h?.getAttribute('data-env') || null,
    text: h ? (h.innerText || '').replace(/\s+/g, ' ').slice(0, 90) : '',
  };
});

/* ── ① 로딩 중에는 꺼졌다고 말하지 않는다 ──
   응답이 늦는 동안 화면이 "켜져 있는 자동매매가 없습니다"라고 적으면
   사용자는 돌고 있는 자동매매를 멈춘 줄 안다. */
{
  const { ctx, page } = await open(1440, 900, { status: 200, delayMs: 3500, body: { ok: true, schedules: [row({ mode: 'LIVE' })] } });
  await page.waitForTimeout(1200);
  const during = await snap(page);
  await page.waitForTimeout(5200);
  const after = await snap(page);
  say(during.state !== 'OFF' && after.state === 'ARMED' && after.env === 'LIVE',
    '로딩 중 → 로딩 후 (UNKNOWN이 OFF로 새지 않는가)',
    `로딩중 ${during.state} → 완료 ${after.state}/${after.env}`);
  await ctx.close();
}

/* ── ② 실전 예약이 섞이면 첫 줄이 실전으로 바뀐다 ── */
{
  const { ctx, page, box } = await open(1440, 900, { status: 200, body: { ok: true, schedules: [row()] } });
  await page.waitForTimeout(2600);
  const before = await snap(page);
  box.fixture = { status: 200, body: { ok: true, schedules: [row(), row({ symbol: 'ETHUSDT', mode: 'LIVE_LIMITED' })] } };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  await page.waitForTimeout(2600);
  const after = await snap(page);
  say(before.env === 'TESTNET' && after.env === 'LIVE' && /실전/.test(after.text),
    '테스트넷 → 실전 예약 추가', `${before.env} → ${after.env} · "${after.text.slice(0, 40)}"`);
  await ctx.close();
}

/* ── ③ 로컬 모드 토글이 첫 줄을 덮지 못한다 ──
   이 화면의 원래 고장이다. 토글을 '모의'로 두어도 실전 예약이 켜져 있으면
   첫 줄은 실전이어야 한다. */
{
  const { ctx, page } = await open(1440, 900, { status: 200, body: { ok: true, schedules: [row({ mode: 'LIVE' })] } });
  await page.waitForTimeout(2600);
  const before = await snap(page);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-region="autoPage"] button')].find(e => (e.innerText || '').trim() === '모의');
    if (!b) return false; b.click(); return true;
  });
  await page.waitForTimeout(800);
  const after = await snap(page);
  const noFalseClaim = await page.evaluate(() =>
    !/실제 자금 이동 없음/.test(document.querySelector('[data-region="autoPage"]')?.innerText || ''));
  say(clicked && before.env === 'LIVE' && after.env === 'LIVE' && after.state === 'ARMED' && noFalseClaim,
    '로컬 "모의" 토글이 실전 첫 줄을 덮지 않는가',
    `토글 클릭=${clicked} · ${before.env} → ${after.env} · "실제 자금 이동 없음" 문구 없음=${noFalseClaim}`);
  await ctx.close();
}

/* ── ④ 막힌 이유가 실제로 보인다 ── */
{
  const { ctx, page } = await open(390, 844, { status: 200, body: { ok: true, schedules: [row({ runtime: { state: 'STALE', reason: '주 실행기가 12분째 응답이 없습니다' } })] } });
  await page.waitForTimeout(2600);
  const s = await snap(page);
  say(s.state === 'BLOCKED' && /12분/.test(s.text) && !/실행중|실행 중/.test(s.text),
    '막힌 예약 — 사유가 보이고 "실행중"이라 쓰지 않는가', `${s.state} · "${s.text.slice(0, 60)}"`);
  await ctx.close();
}

/* ── ⑤ 읽기 실패는 꺼짐이 아니다 ── */
{
  const { ctx, page } = await open(390, 844, { status: 500, body: { ok: false, message: '서버 오류' } });
  await page.waitForTimeout(2600);
  const s = await snap(page);
  const hasZero = await page.evaluate(() => /켜져 있는 자동매매가 없습니다/.test(
    document.querySelector('[data-region="executionTruth"]')?.innerText || ''));
  say(s.state === 'UNKNOWN' && !hasZero, '읽기 실패 — UNKNOWN이고 꺼짐이라 하지 않는가',
    `${s.state} · "${s.text.slice(0, 50)}"`);
  await ctx.close();
}

/* ── ⑥ 모바일에서 첫 줄이 엄지 영역 위에 스크롤 없이 보인다 ── */
{
  const { ctx, page } = await open(390, 844, { status: 200, body: { ok: true, schedules: [row({ mode: 'LIVE' })] } });
  await page.waitForTimeout(2600);
  const g = await page.evaluate(() => {
    const h = document.querySelector('[data-region="executionTruth"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrollY: window.scrollY };
  });
  say(!!g && g.scrollY === 0 && g.top >= 0 && g.bottom < g.vh,
    '390에서 스크롤 없이 첫 줄 전체가 보인다', g ? `top=${g.top} bottom=${g.bottom} vh=${g.vh}` : '못 찾음');
  await ctx.close();
}

/* ── ⑦ 한 화면이 두 가지 실행환경을 주장하지 않는다 ──
   실측 캡처에서 첫 줄은 LIVE인데 바로 아래 카드가 "자동매매 (테스트넷)
   TESTNET"이라고 말했다. 그 카드가 읽기 실패를 빈 목록으로 눕히고
   기본값 TESTNET을 얻고 있었기 때문이다. 아무것도 못 읽었는데 환경을
   단정하면, 첫 줄과 서로 다른 말을 하는 화면이 된다. */
{
  const { ctx, page } = await open(390, 844, { status: 200, body: { ok: true, schedules: [row({ mode: 'LIVE' })] } });
  await page.waitForTimeout(2800);
  const r = await page.evaluate(() => {
    const t = document.querySelector('[data-region="autoPage"]')?.innerText || '';
    const hero = document.querySelector('[data-region="executionTruth"]');
    return {
      heroEnv: hero?.getAttribute('data-env') || null,
      // 첫 줄이 LIVE인데 화면 어딘가가 "(테스트넷)"이라고 제목에 적으면 모순이다.
      claimsTestnetTitle: /자동매매 \(테스트넷\)/.test(t),
      claimsMockTitle: /자동매매 \(모의\)/.test(t),
    };
  });
  say(r.heroEnv === 'LIVE' && !r.claimsTestnetTitle && !r.claimsMockTitle,
    '한 화면이 두 실행환경을 주장하지 않는가',
    `첫 줄=${r.heroEnv} · "(테스트넷)" 제목=${r.claimsTestnetTitle} · "(모의)" 제목=${r.claimsMockTitle}`);
  await ctx.close();
}

await browser.close();
console.log(fails === 0 ? '\n첫 화면 조작 전부 동작' : `\n🚨 ${fails}건 실패`);
process.exit(fails === 0 ? 0 : 1);
