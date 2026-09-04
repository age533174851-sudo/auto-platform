// 첫 화면 검사기가 진짜 잡는가 — 렌더된 화면을 런타임에 망가뜨려 본다.
//
// 소스 돌연변이(scripts/check-auto-cockpit.mjs)는 코드 모양을 본다.
// 여기서는 **화면 자체**를 망가뜨려 상태 프로브가 그것을 잡는지 본다.
// 잡지 못하면 그 프로브는 켜져 있는 것처럼 보이면서 아무것도 안 한다.
//
// 사용법: node scripts/probe/auto-cockpit-mutations.mjs <port>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const B = 'http://localhost:' + process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fails = 0;

const row = (o = {}) => ({
  id: 's-1', symbol: 'BTCUSDT', enabled: true, mode: 'LIVE_LIMITED',
  connectionState: 'OK', strategyRunnable: true,
  runtime: { state: 'WATCHING', reason: '' }, state: 'ACTIVE', ...o,
});

// [이름, 기대, 화면에 가할 변형]
const MUTATIONS = [
  ['M7 첫 줄을 뷰포트 밖으로', 'FAIL', () => {
    const h = document.querySelector('[data-region="executionTruth"]');
    h.style.position = 'absolute'; h.style.top = '-4000px';
  }],
  ['M8 주 액션을 40px 아래로', 'FAIL', () => {
    const b = document.querySelector('[data-region="autoPage"] button');
    b.style.minHeight = '24px'; b.style.height = '24px'; b.style.minWidth = '24px'; b.style.width = '24px';
  }],
  ['M9 첫 줄 위에 카드를 끼워 넣음', 'FAIL', () => {
    const wrap = document.querySelector('[data-region="autoPage"]');
    const d = document.createElement('div');
    d.textContent = '진단 카드'; d.style.height = '80px'; d.style.background = '#333';
    wrap.insertBefore(d, wrap.firstChild);
  }],
  ['M10 다른 버튼이 첫 줄을 덮음', 'FAIL', () => {
    const h = document.querySelector('[data-region="executionTruth"]').getBoundingClientRect();
    const b = document.createElement('button');
    b.textContent = '덮개';
    Object.assign(b.style, { position: 'fixed', left: `${h.left + 10}px`, top: `${h.top + 10}px`, width: '60px', height: '60px', zIndex: '99' });
    document.body.appendChild(b);
  }],
  ['M11 내용이 화면 밖으로 나감', 'FAIL', () => {
    // body에 붙이면 앱 래퍼의 overflow-x:hidden이 잘라서 body 넘침으로는
    // 안 잡힌다. 실제 회귀는 화면 안에서 생기므로 안쪽에 넣는다.
    const wrap = document.querySelector('[data-region="autoPage"]');
    const d = document.createElement('div');
    d.textContent = '너무 넓은 줄';
    // `width: 3000px`은 안 통한다 — 모바일에서 `* { max-width: 100% }`가
    // 이미 눌러 준다(실측: 3000 → 366). 그 보호를 실제로 뚫는 것은
    // min-width다(min-width가 max-width를 이긴다). 검사기를 검증하려면
    // 막지 못하는 경로로 밀어야 한다.
    Object.assign(d.style, { minWidth: '3000px', height: '20px', background: '#444' });
    wrap.appendChild(d);
  }],
  ['M12 정상 (변형 없음)', 'PASS', () => {}],
];

for (const [name, expect, mutate] of MUTATIONS) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko');
    localStorage.setItem('sb_access_token', 'probe-token');
  });
  const page = await ctx.newPage();
  await page.route('**/api/autotrade/schedule**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, schedules: [row()] }) }));
  await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"news":[]}' }));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (let i = 0; i < 4; i++) {
    const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
    await page.waitForTimeout(250); if (!s) break;
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  await page.waitForTimeout(2600);
  // 온보딩(언어 선택)과 로그인 창을 끝까지 닫는다. 남아 있으면 그 버튼이
  // 첫 줄과 겹쳐 **변형을 안 줘도 FAIL**이 되고, 그러면 다른 돌연변이도
  // 의도한 신호가 아니라 그 겹침 때문에 잡힌다 — 실제로 M11(가로 넘침)이
  // 그렇게 잡혔다. 그 상태의 검사기는 켜져 있는 것처럼 보이면서 아무것도
  // 확인하지 않는다.
  for (let i = 0; i < 4; i++) {
    const s2 = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기');
      if (b) { b.click(); return true; } return false;
    });
    await page.waitForTimeout(250); if (!s2) break;
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
  await page.waitForTimeout(900);
  await page.evaluate(mutate);
  await page.waitForTimeout(250);

  // auto-cockpit.mjs와 **같은 판정**을 쓴다. 여기서 따로 세면 두 자가 갈린다.
  const m = await page.evaluate(() => {
    const cs = getComputedStyle;
    const vis = e => { const s = cs(e); const b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && b.width > 1 && b.height > 1; };
    const hero = document.querySelector('[data-region="executionTruth"]');
    const r = hero ? hero.getBoundingClientRect() : null;
    let overlaps = 0;
    if (hero && r) {
      for (const e of [...document.querySelectorAll('button,[role="button"],input,select')].filter(vis)) {
        if (hero.contains(e)) continue;
        const b = e.getBoundingClientRect();
        if (Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)) > 1
          && Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)) > 1) overlaps++;
      }
    }
    const small = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .filter(e => e.getAttribute('role') !== 'separator')
      .filter(e => { const b = e.getBoundingClientRect(); return b.height < 40 || b.width < 40; }).length;
    return {
      found: !!hero,
      inFirstView: !!r && r.top >= 0 && r.top < innerHeight && r.bottom > 0,
      overlaps, small,
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // 조상이 overflow-x:hidden이면 넓은 내용이 잘려서 body 넘침으로는
      // 안 잡힌다. 사용자가 보는 것은 '잘려서 안 보이는 내용'이므로
      // 뷰포트 오른쪽 밖으로 나간 요소를 따로 센다.
      escaped: [...document.querySelectorAll('[data-region="autoPage"] *')].filter(vis)
        .filter(e => e.getBoundingClientRect().right > innerWidth + 2).length,
      aboveHero: r ? [...document.querySelectorAll('[data-region="autoPage"] > *')].filter(vis)
        .filter(e => e.getBoundingClientRect().bottom <= r.top + 1).length : null,
    };
  });
  const pass = m.found && m.inFirstView && m.overlaps === 0 && m.small === 0
    && m.bodyOverflow === 0 && m.escaped === 0 && m.aboveHero === 0;
  const actual = pass ? 'PASS' : 'FAIL';
  const ok = actual === expect;
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(30)} 기대=${expect} 실제=${actual}  [첫화면=${m.inFirstView} 위에=${m.aboveHero} 겹침=${m.overlaps} 작은=${m.small} 넘침=${m.bodyOverflow} 이탈=${m.escaped}]`);
  await ctx.close();
}
await browser.close();
console.log(fails === 0 ? '\n돌연변이 전부 기대대로' : `\n🚨 ${fails}건 기대와 다름`);
process.exit(fails === 0 ? 0 : 1);
