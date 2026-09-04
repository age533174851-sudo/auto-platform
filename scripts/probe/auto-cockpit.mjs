// 자동매매 첫 화면이 각 상태에서 실제로 무엇을 그리는가.
//
// 서버를 실전 상태로 바꿀 수 없으므로 `/api/autotrade/schedule` 응답만
// 갈아끼워 상태를 재현한다. **가짜 데이터를 화면 코드에 넣지 않는다** —
// 이 파일 안에서만 산다.
//
// 사용법: node scripts/probe/auto-cockpit.mjs <port> <out-dir> [WxH]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const PORT = process.argv[2], OUT = process.argv[3] || '/tmp/cockpit';
const ONLY = process.argv[4];
const B = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  ['1366x768', 1366, 768], ['1440x900', 1440, 900], ['1664x936', 1664, 936],
  ['1920x1080', 1920, 1080], ['2560x1440', 2560, 1440],
  ['1024x768', 1024, 768], ['834x1194', 834, 1194],
  ['430x932', 430, 932], ['390x844', 390, 844], ['360x800', 360, 800],
].filter(v => !ONLY || v[0] === ONLY);

const row = (o = {}) => ({
  id: `s-${o.symbol || 'BTCUSDT'}`, symbol: 'BTCUSDT', enabled: true, mode: 'TESTNET',
  connectionState: 'OK', strategyRunnable: true, strategyName: '계단식',
  runtime: { state: 'WATCHING', reason: '정상 평가 중' }, state: 'ACTIVE',
  ...o,
});

// 재현할 상태들. body 는 /api/autotrade/schedule 이 돌려줄 값.
const STATES = {
  UNKNOWN: { status: 401, body: { ok: false, error: 'auth_required', message: '로그인이 필요합니다' } },
  OFF:     { status: 200, body: { ok: true, schedules: [row({ enabled: false })] } },
  ARMED_TESTNET: { status: 200, body: { ok: true, schedules: [row(), row({ symbol: 'ETHUSDT' })] } },
  ARMED_LIVE: { status: 200, body: { ok: true, schedules: [row(), row({ symbol: 'ETHUSDT', mode: 'LIVE_LIMITED' })] } },
  BLOCKED: { status: 200, body: { ok: true, schedules: [row({ runtime: { state: 'STALE', reason: '주 실행기가 12분째 응답이 없습니다' } })] } },
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const OUTJSON = `${OUT}/cockpit.json`;
const all = existsSync(OUTJSON) ? JSON.parse(readFileSync(OUTJSON, 'utf8')) : {};
let fails = 0;

for (const [name, w, h] of VIEWPORTS) {
  for (const [stateName, fixture] of Object.entries(STATES)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko');
      localStorage.setItem('sb_access_token', 'probe-token');
    });
    const page = await ctx.newPage();
    await page.route('**/api/autotrade/schedule**', r => r.fulfill({
      status: fixture.status, contentType: 'application/json', body: JSON.stringify(fixture.body),
    }));
    await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"news":[]}' }));
    await page.goto(B, { waitUntil: 'networkidle' });
    for (let i = 0; i < 4; i++) {
      const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
      await page.waitForTimeout(250); if (!s) break;
    }
    // 가짜 토큰이라 로그인 창이 뜬다. 이건 이 프로브의 사정이지 화면 결함이
    // 아니므로 닫고 나서 잰다.
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
    await page.waitForTimeout(2600);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
    await page.waitForTimeout(900);

    const m = await page.evaluate(() => {
      const cs = getComputedStyle;
      const vis = e => { const s = cs(e); const b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && b.width > 1 && b.height > 1; };
      const hero = document.querySelector('[data-region="executionTruth"]');
      const r = hero ? hero.getBoundingClientRect() : null;
      // 첫 화면 안에 보이는가 — 스크롤하지 않고
      const inFirstView = !!r && r.top >= 0 && r.top < innerHeight && r.bottom > 0;
      // 겹침: 첫 줄이 다른 상주 요소와 겹치는가
      let overlaps = 0;
      if (hero && r) {
        for (const e of [...document.querySelectorAll('button,[role="button"],input,select')].filter(vis)) {
          if (hero.contains(e)) continue;
          const b = e.getBoundingClientRect();
          const x = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left));
          const y = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
          if (x > 1 && y > 1) overlaps++;
        }
      }
      const small = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
        .filter(e => e.getAttribute('role') !== 'separator')
        .filter(e => { const b = e.getBoundingClientRect(); return b.height < 40 || b.width < 40; }).length;
      return {
        found: !!hero,
        state: hero?.getAttribute('data-state') ?? null,
        env: hero?.getAttribute('data-env') || null,
        text: hero ? (hero.innerText || '').replace(/\s+/g, ' ').slice(0, 160) : '',
        top: r ? Math.round(r.top) : null, h: r ? Math.round(r.height) : null,
        inFirstView, overlaps, small,
        bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        // 첫 줄보다 위에 있는 상주 카드가 있는가 (진단이 진실을 밀어냈는가)
        aboveHero: r ? [...document.querySelectorAll('[data-region="autoPage"] > *')].filter(vis)
          .filter(e => e.getBoundingClientRect().bottom <= r.top + 1).length : null,
      };
    });

    const expectState = stateName === 'ARMED_LIVE' || stateName === 'ARMED_TESTNET' ? 'ARMED' : stateName;
    // BLOCKED도 켜진 예약이 있으므로 환경을 안다. 환경을 그리지 않는 것은
    // UNKNOWN(못 읽음)과 OFF(켜진 것 없음)뿐이다.
    const expectEnv = stateName === 'ARMED_LIVE' ? 'LIVE'
      : (stateName === 'ARMED_TESTNET' || stateName === 'BLOCKED') ? 'TESTNET' : null;
    const ok = m.found && m.state === expectState && (m.env || null) === expectEnv
      && m.inFirstView && m.overlaps === 0 && m.small === 0 && m.bodyOverflow === 0
      && m.aboveHero === 0;
    if (!ok) fails++;
    all[name] = all[name] || {};
    all[name][stateName] = { ...m, expectState, expectEnv, pass: ok };
    console.log(`${ok ? '✓' : '✗'} ${name.padEnd(10)} ${stateName.padEnd(14)} state=${m.state} env=${m.env ?? '-'} top=${m.top} 첫화면=${m.inFirstView} 위에=${m.aboveHero} 겹침=${m.overlaps} 작은버튼=${m.small} 넘침=${m.bodyOverflow}`);
    if (stateName === 'ARMED_LIVE' || stateName === 'UNKNOWN' || stateName === 'BLOCKED') {
      await page.screenshot({ path: `${OUT}/head-${name}-${stateName}.png` });
    }
    await ctx.close();
  }
}
writeFileSync(OUTJSON, JSON.stringify(all, null, 1));
await browser.close();
console.log(fails === 0 ? '\n첫 화면 상태 전부 기대대로' : `\n🚨 ${fails}건 실패`);
process.exit(fails === 0 ? 0 : 1);
