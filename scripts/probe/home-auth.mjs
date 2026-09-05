// 홈의 두 카드가 **서버에서 값을 읽어 오는가.**
//
// 무엇을 재는가
// ─────────────
// 카드에 무엇이 적혔는지만 보면 안 된다. 요청이 실제로 나갔는지를 센다.
//
//   GET /api/autotrade/schedule   자동매매 계획 카드
//   GET /api/wallets/overview     지갑 개요
//
// 왜 이 프로브가 필요한가
// ───────────────────────
// 두 카드는 legacy `localStorage.sb_access_token`을 읽었다. 저장소 역사에서
// 그 키를 쓰는 production writer를 찾지 못했고, 정상 흐름에서는 채워지지
// 않는다. 그러면 두 카드는 요청 전에 종료한다.
//
// 그때 화면에 남는 것이 서로 다르고, 첫 번째가 더 나쁘다.
//
//   자동매매 카드 — 아무 상태도 세우지 않고 반환한다. autoPlan도 autoErr도
//                  그대로라 라벨이 **영구히 '읽는 중…'**이다. 실패를 실패로
//                  적지 않고 아직 읽는 중인 척한다.
//   지갑 개요    — '로그인하면 실제 자산을 읽습니다'. 이미 로그인한
//                  사용자에게 로그인하라고 말한다.
//
// 사용법: node scripts/probe/home-auth.mjs <port>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { seedAuthScript, blockAuthHost, assertProbeSignedIn } from './lib/auth.mjs';
import { scheduleRow, okBody } from './lib/fixtures.mjs';

const B = 'http://localhost:' + process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fails = 0;
const say = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`); };

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko');
});
await ctx.addInitScript(seedAuthScript());
const page = await ctx.newPage();

const calls = { sched: 0, wallet: 0, auth: [] };
await blockAuthHost(page);
// Playwright는 나중에 등록한 라우트를 먼저 쓴다. 포괄 라우트를 맨 앞에.
await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"news":[]}' }));
await page.route('**/api/autotrade/schedule**', r => {
  calls.sched++; calls.auth.push(r.request().headers()['authorization'] ?? '(none)');
  return r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ...okBody([scheduleRow({ id: 's-1' })]),
      plan: { code: 'HEALTHY', headline: '예약 1개가 조건을 기다립니다' },
    }),
  });
});
await page.route('**/api/wallets/overview**', r => {
  calls.wallet++; calls.auth.push(r.request().headers()['authorization'] ?? '(none)');
  return r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, envs: [{ env: 'TESTNET', connections: 1, totalUsd: 1234.5 }] }),
  });
});

await page.goto(B, { waitUntil: 'networkidle' });
await assertProbeSignedIn(page);
for (let i = 0; i < 4; i++) {
  const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
  await page.waitForTimeout(250); if (!s) break;
}
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(3000);

const seen = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ');
  const card = [...document.querySelectorAll('button')].find(e => /자동매매/.test(e.innerText || ''));
  return { body: t.slice(0, 4000), auto: card ? (card.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '(자동매매 카드 없음)' };
});

say(calls.sched > 0, '자동매매 계획을 서버에서 읽는다', `GET /api/autotrade/schedule ${calls.sched}회`);
say(calls.wallet > 0, '지갑 개요를 서버에서 읽는다', `GET /api/wallets/overview ${calls.wallet}회`);
say(!/읽는 중…/.test(seen.auto), '자동매매 카드가 영원히 "읽는 중"에 멈추지 않는다', `"${seen.auto}"`);
say(!/로그인하면 실제 자산을 읽습니다/.test(seen.body),
  '로그인한 사용자에게 로그인하라고 말하지 않는다',
  /로그인하면 실제 자산을 읽습니다/.test(seen.body) ? '그 문구가 떠 있다' : '그 문구 없음');
say(calls.auth.length > 0 && calls.auth.every(a => /^Bearer .+/.test(a)),
  '두 요청 모두 정본 토큰을 들고 나간다',
  calls.auth.length ? calls.auth.map(a => a.slice(0, 24)).join(' · ') : '나간 요청 없음');

await browser.close();
console.log(fails === 0 ? '\n홈의 두 카드가 서버에서 값을 읽는다' : `\n🚨 ${fails}건 실패`);
process.exit(fails === 0 ? 0 : 1);
