// 거래화면 **조작**이 실제로 동작하는가.
//
// 기하 검사만으로는 부족하다. UI-3C 1차 후보(122b0c09)는 10개 뷰포트
// 기하 검사를 전부 통과했지만, 사람이 써 보니 세 가지가 죽어 있었다:
//   · 왼쪽 손잡이가 보이는데 끌어도 안 움직였다 (onDrag가 빈 함수였다)
//   · 좁은 화면에서 종목을 고를 방법이 사라졌다 (겹침을 없애려고 목록을 지웠다)
//   · 자동으로 접힌 오른쪽 레일이 한 번 눌러서는 안 열렸다
//
// 셋 다 "안 겹친다"는 조건은 만족한다. **겹치지 않는 것과 쓸 수 있는 것은
// 다르다.** 그래서 조작을 직접 해 보고 결과가 바뀌는지 본다.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const B = 'http://localhost:' + process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fails = 0;
const say = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`); };

async function open(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko'); });
  const page = await ctx.newPage();
  await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, source: 'mock', news: [] }) }));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (let i = 0; i < 4; i++) {
    const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
    await page.waitForTimeout(300); if (!s) break;
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '매매' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  await page.waitForTimeout(2600);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
  await page.waitForTimeout(1200);
  return { ctx, page };
}
const widthOf = (page, region) => page.evaluate(r => {
  const e = document.querySelector(`[data-region="${r}"]`);
  return e ? Math.round(e.getBoundingClientRect().width) : null;
}, region);

/* ── ① 왼쪽 손잡이가 종목 레일 폭을 실제로 바꾸는가 ──
   두 경로를 다 확인한다.
   · 키보드 — 이 환경에서 결정적으로 재현된다
   · 마우스 — 합성 이벤트로 앱의 리스너를 직접 친다.
     Playwright의 실제 마우스 드래그는 이 컨테이너에서 버튼을 누른 동안
     mousemove가 페이지에 전달되지 않아(실측 0회) 쓸 수 없다.
     그것은 앱이 아니라 환경의 문제이므로, 배선 여부는 합성 이벤트로 본다. */
{
  const { ctx, page } = await open(1920, 1080);
  const sep = '[role="separator"][aria-label="종목 패널 폭 조절"]';
  const exists = await page.evaluate(s => !!document.querySelector(s), sep);
  const before = await widthOf(page, 'market');

  // 키보드
  await page.evaluate(s => document.querySelector(s).focus(), sep);
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120); }
  const afterKey = await widthOf(page, 'market');

  // 마우스(합성)
  const mid = await widthOf(page, 'market');
  // mousedown 뒤 리스너가 붙을 틈을 준다. 같은 틱에 mousemove를 쏘면
  // React가 아직 state를 반영하지 않아 window 리스너가 없다.
  const anchor = await page.evaluate(s => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const x = r.left + 2, y = r.top + r.height / 2;
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
    return { x, y };
  }, sep);
  await page.waitForTimeout(250);
  await page.evaluate(a => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: a.x + 40, clientY: a.y, bubbles: true }));
  }, anchor);
  await page.waitForTimeout(250);
  await page.evaluate(a => {
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: a.x + 40, clientY: a.y, bubbles: true }));
  }, anchor);
  await page.waitForTimeout(400);
  const afterMouse = await widthOf(page, 'market');

  say(exists && afterKey > before + 40 && afterMouse > mid + 20,
    'BLOCKER 1 왼쪽 리사이즈',
    `손잡이=${exists ? '있음' : '없음'} · 키보드 →→→→ ${before}px→${afterKey}px · 마우스(합성 +40) ${mid}px→${afterMouse}px`);
  await ctx.close();
}

/* ── ② 좁은 화면(compact)에서 종목을 고를 수 있는가 ── */
{
  const { ctx, page } = await open(1366, 768);
  const mode = await page.evaluate(() => document.querySelector('[data-region="market"]')?.getAttribute('data-mode'));
  const picks = await page.evaluate(() => [...document.querySelectorAll('[data-symbol]')].map(e => e.getAttribute('data-symbol')));
  const cur = () => page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-symbol]')].find(e => getComputedStyle(e).borderLeftColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(e).fontWeight === '800');
    return b?.getAttribute('data-symbol') || null;
  });
  const start = await cur();
  const other = picks.find(p => p !== start);
  await page.evaluate(id => document.querySelector(`[data-symbol="${id}"]`).click(), other);
  await page.waitForTimeout(700);
  const mid = await cur();
  await page.evaluate(id => document.querySelector(`[data-symbol="${id}"]`).click(), start);
  await page.waitForTimeout(700);
  const back = await cur();
  say(mode === 'compact' && picks.length >= 2 && mid === other && back === start,
    'BLOCKER 2 접힌 레일 종목 선택', `mode=${mode} 목록 ${picks.length}개 · ${start}→${mid}→${back}`);
  await ctx.close();
}

/* ── ③ 자동으로 접힌 오른쪽 레일이 한 번 눌러서 열리는가 ── */
{
  const { ctx, page } = await open(1440, 900);
  const st = () => page.evaluate(() => document.querySelector('.aw')?.getAttribute('data-right'));
  const before = await st();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[aria-expanded]')].find(e => /오른쪽/.test(e.getAttribute('aria-label') || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(600);
  const after = await st();
  say(before === 'collapsed' && after === 'expanded',
    'BLOCKER 3 레일 한 번 클릭', `${before} → 클릭 1회 → ${after}`);
  await ctx.close();
}

await browser.close();
console.log(fails === 0 ? '\n조작 전부 동작' : `\n🚨 ${fails}건 동작하지 않음`);
process.exit(fails === 0 ? 0 : 1);
