// 스냅샷 발행이 안정되는가 — 그리고 실제 변화는 여전히 전달되는가.
//
// 읽는 곳을 하나로 합치면서 카드가 읽은 스냅샷을 화면 위로 올리게 했다.
// 부모는 **참조 동일성**으로 중복 갱신을 막았는데, `autotradeHealth()`는
// 렌더마다 새 배열을 돌려준다. 그래서 값이 안 바뀌어도 늘 "달라졌다"가
// 되고, 부모 → 자식 → 새 배열 → 부모 … 구조가 만들어진다.
//
// 실측으로는 폭주하지 않았다. 하지만 **안 도는 이유가 계약이 아니라
// 우연**이라 의미 기반 비교(snapshotSignature)로 바꿨다. 이 검사는 그
// 계약이 깨지는 것을 잡는다.
//
// 화면 모양만 보는 검사로는 이걸 못 잡는다 — 같은 값을 계속 다시 그려도
// 화면은 똑같아 보인다. 그래서 여기서는 **주 스레드와 콘솔**을 본다.
//
// 사용법: node scripts/probe/auto-snapshot-stability.mjs <port>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const B = 'http://localhost:' + process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fails = 0;
const say = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`); };

const bodyOf = (over = {}) => ({
  ok: true, adminSecretSet: true, cronSecretSet: true, liveUnlocked: true,
  liveGate: { env: 'production', reason: '' },
  marginColumnPresent: true, openTradeCount: 0, cronUtcHour: 23,
  runs: [{ status: 'ok', detail: '평가 완료', started_at: new Date().toISOString() }],
  exitRuns: [{ status: 'ok', detail: '감시 완료', started_at: new Date().toISOString() }],
  connections: [{ id: 'c-1', is_testnet: true, exchange_id: 'binance', label: '테스트넷' }],
  schedules: [{
    id: 's-1', symbol: 'BTCUSDT', enabled: true, mode: 'TESTNET', connection_id: 'c-1',
    interval_min: 60, last_run_at: new Date(Date.now() - 300_000).toISOString(),
    connectionState: 'OK', strategyRunnable: true,
    runtime: { state: 'WATCHING', reason: '정상 평가 중' }, state: 'ACTIVE',
  }],
  ...over,
});

const box = { body: bodyOf() };
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  localStorage.setItem('tg_onboarded_v1', '1'); localStorage.setItem('tg_lang', 'ko');
  localStorage.setItem('sb_access_token', 'probe-token');
});
const page = await ctx.newPage();
const reactErrors = [];
page.on('console', m => {
  const t = m.text();
  // 샌드박스에는 바깥 네트워크가 없어 리소스 오류가 뜬다. 그건 화면 결함이
  // 아니므로 **React가 낸 것만** 센다.
  if (/Maximum update depth|Too many re-renders|Warning:.*React|The above error occurred/i.test(t)) {
    reactErrors.push(t.slice(0, 200));
  }
});
page.on('pageerror', e => reactErrors.push('pageerror: ' + String(e).slice(0, 200)));

let apiHits = 0;
await page.route('**/api/autotrade/schedule**', r => {
  apiHits++;
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(box.body) });
});
await page.route('**/api/news**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"news":[]}' }));
await page.goto(B, { waitUntil: 'networkidle' });
for (let i = 0; i < 4; i++) {
  const s = await page.evaluate(() => { const b = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText || '').trim() === '건너뛰기'); if (b) { b.click(); return true; } return false; });
  await page.waitForTimeout(250); if (!s) break;
}
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /둘러보기/.test(e.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(300);
await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
await page.waitForTimeout(3000);

const stateOf = () => page.evaluate(() => {
  const h = document.querySelector('[data-region="executionTruth"]');
  return { state: h?.getAttribute('data-state') ?? null, text: (h?.innerText || '').replace(/\s+/g, ' ').slice(0, 90) };
});

/* ── ① 같은 값이면 조용해진다 ──
   렌더 루프가 있으면 주 스레드가 굶는다. rAF 간격과 타이머 지연으로 잰다.
   요청 수도 늘지 않아야 한다. */
{
  const hits0 = apiHits;
  const perf = await page.evaluate(async () => {
    const gaps = []; let last = performance.now();
    await new Promise(res => {
      let n = 0;
      const tick = () => {
        const t = performance.now(); gaps.push(t - last); last = t;
        if (++n >= 90) return res(); requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const t0 = performance.now(); await new Promise(r => setTimeout(r, 120));
    return {
      rafAvg: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length),
      rafMax: Math.round(Math.max(...gaps)),
      timerLate: Math.round(performance.now() - t0 - 120),
    };
  });
  await page.waitForTimeout(2500);
  const grew = apiHits - hits0;
  const ok = reactErrors.length === 0 && grew === 0 && perf.rafAvg < 40 && perf.timerLate < 250;
  say(ok, '같은 값이면 발행이 멈춘다',
    `React 오류 ${reactErrors.length} · 추가 요청 ${grew} · rAF 평균 ${perf.rafAvg}ms 최대 ${perf.rafMax}ms · 타이머 지연 ${perf.timerLate}ms`);
}

/* ── ② 실제로 바뀌면 전달된다 (ok → bad) ── */
{
  const before = await stateOf();
  box.body = bodyOf({ adminSecretSet: false });
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  await page.waitForTimeout(3000);
  const after = await stateOf();
  say(before.state === 'ARMED' && after.state === 'BLOCKED',
    '점검이 ok → bad로 바뀌면 첫 줄에 전달된다', `${before.state} → ${after.state}`);
}

/* ── ③ unknown → ok 도 전달된다 ── */
{
  box.body = bodyOf({ runs: null, runsError: '실행 기록을 읽지 못했습니다' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  await page.waitForTimeout(3000);
  const unknown = await stateOf();
  box.body = bodyOf();
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => { const t = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '자동' && e.children.length === 0); if (t) (t.closest('button,a,[role="button"]') || t.parentElement).click(); });
  await page.waitForTimeout(3000);
  const ok = await stateOf();
  say(unknown.state === 'UNCONFIRMED' && ok.state === 'ARMED',
    '점검이 unknown → ok로 바뀌면 첫 줄에 전달된다', `${unknown.state} → ${ok.state}`);
}

await browser.close();
console.log(fails === 0 ? '\n스냅샷 발행 안정 · 변화 전달 확인' : `\n🚨 ${fails}건 실패`);
process.exit(fails === 0 ? 0 : 1);
