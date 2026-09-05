// 전체정지 버튼이 **서버에 닿는가.**
//
// 무엇을 재는가
// ─────────────
// 화면이 "껐다"고 적는지가 아니라, 실제로 서버로 나간 요청을 센다.
//
//   GET   /api/autotrade/schedule        전체정지가 무엇을 끌지 읽는 호출
//   PATCH /api/autotrade/schedule        실제로 끄는 호출
//
// 표시용 카드(AutotradeControl)도 같은 GET을 쓰므로, **버튼을 누른 뒤에
// 늘어난 수**만 전체정지의 몫으로 센다.
//
// 왜 이 프로브가 필요한가
// ───────────────────────
// 표시용 read는 정본 Supabase 세션을 쓰고, 전체정지는 legacy
// `localStorage.sb_access_token`을 읽는다. 저장소 역사에서 그 키를 쓰는
// production writer를 찾지 못했고, **정상 production app flow에서는 그 키가
// 채워지지 않는다.** 비면 `loadSchedules()`가 첫 GET 전에 종료하므로
// **화면은 예약을 정확히 그리는데 정지 버튼만 서버에 닿지 못한다.**
//
// 코드를 읽어서 그렇게 보이는 것과 실제로 그런 것은 다르다. 그래서 센다.
//
// 사용법: node scripts/probe/global-stop-auth.mjs <port>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { seedAuthScript, blockAuthHost, assertProbeSignedIn } from './lib/auth.mjs';
import { scheduleRow, okBody } from './lib/fixtures.mjs';

const B = 'http://localhost:' + process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fails = 0;
const say = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`); };

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko');
});
await ctx.addInitScript(seedAuthScript());
const page = await ctx.newPage();

// 켜져 있는 예약 둘. 전체정지가 끌 대상이다.
const rows = () => [
  scheduleRow({ id: 's-1', symbol: 'BTCUSDT' }),
  scheduleRow({ id: 's-2', symbol: 'ETHUSDT' }),
];
let enabled = { 's-1': true, 's-2': true };

const calls = { get: 0, patch: 0, patchAuth: [], getAuth: [] };
await blockAuthHost(page);
// Playwright는 **나중에 등록한** 라우트를 먼저 쓴다. 포괄 라우트를 맨 앞에
// 걸어야 아래의 구체 라우트가 이긴다 — 순서를 뒤집으면 스케줄 호출까지
// 이 라우트가 삼켜서 '요청이 0회'라는 거짓 증거가 나온다(실제로 겪었다).
await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
await page.route('**/api/autotrade/schedule**', async r => {
  const req = r.request();
  const auth = req.headers()['authorization'] ?? '(none)';
  if (req.method() === 'PATCH') {
    calls.patch++; calls.patchAuth.push(auth);
    const body = JSON.parse(req.postData() || '{}');
    enabled[body.id] = false;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  }
  calls.get++; calls.getAuth.push(auth);
  const live = rows().filter(x => enabled[x.id]);
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(okBody(live)) });
});
await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"news":[]}' }));

await page.goto(B, { waitUntil: 'networkidle' });
await assertProbeSignedIn(page);
for (let i = 0; i < 4; i++) {
  const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
  await page.waitForTimeout(250); if (!s) break;
}
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(400);
await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
await page.waitForTimeout(2600);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(600);

// 표시용 카드가 이미 부른 GET은 전체정지의 몫이 아니다.
const before = { get: calls.get, patch: calls.patch };

const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .find(e => (e.getAttribute('aria-label') || '') === '등록된 자동매매 예약 전체 끄기');
  if (!b) return false; b.click(); return true;
});
await page.waitForTimeout(3000);

// 첫 줄(ExecutionTruthHero)도 role="status"다. 전체정지 결과 상자만 골라야
// 한다 — 첫 줄을 집으면 버튼을 누르지 않아도 문장이 잡혀서 통과처럼 보인다.
const shown = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('[role="status"]')]
    .filter(e => !e.closest('[data-region="executionTruth"]'));
  return boxes.length ? (boxes[0].innerText || '').replace(/\s+/g, ' ').slice(0, 160) : '(결과 상자 없음)';
});
const afterStop = { get: calls.get - before.get, patch: calls.patch - before.patch };

say(clicked, '전체정지 버튼을 찾았다', clicked ? 'aria-label로 찾음' : '못 찾음');
say(afterStop.get > 0, '전체정지가 서버에 목록을 물어본다',
  `버튼 누른 뒤 GET ${afterStop.get}회`);
say(afterStop.patch === 2, '켜져 있던 예약 2개에 PATCH가 나간다',
  `PATCH ${afterStop.patch}회 (기대 2)`);
say(calls.patchAuth.every(a => /^Bearer .+/.test(a)) && calls.patchAuth.length > 0,
  'PATCH가 정본 토큰을 들고 나간다',
  calls.patchAuth.length ? calls.patchAuth.map(a => a.slice(0, 28)).join(' · ') : '나간 PATCH 없음');
say(/전체|모두|껐|중단/.test(shown) && !/확인하지 못|로그인이 필요/.test(shown),
  '화면이 정지 확인을 말한다', `"${shown.slice(0, 90)}"`);

console.log('\n표시용 카드가 쓴 인증:', calls.getAuth[0] ? calls.getAuth[0].slice(0, 28) : '(없음)');
await browser.close();
console.log(fails === 0 ? '\n전체정지가 서버에 닿는다' : `\n🚨 ${fails}건 실패 — 전체정지가 서버에 닿지 못한다`);
process.exit(fails === 0 ? 0 : 1);
