// 고객지원 화면이 **인증이 바뀐 뒤에도 이전 사용자의 문의를 들고 있는가.**
//
// 무엇을 재는가
// ─────────────
//   ① A 로 로그인해 문의를 열면 A 의 제목·직원 답장이 보인다 (전제)
//   ② 인증을 B 로 바꾸고 B 의 목록 응답을 늦추면, 화면에 **A 의 것**이
//      남아 있는가
//   ③ 그 상태에서 '답장 보내기'를 누르면 **B 의 Authorization 으로 A 의
//      ticket id** 에 POST 하는가
//
// 왜 필요한가
// ───────────
// 토큰은 `watchAuthToken`으로 **화면을 다시 그리지 않고도** 바뀐다(토큰
// 갱신·다른 계정 로그인). 그때 `tickets`·`openId`·`messages`·`reply`를
// 비우지 않으면 이전 사람의 것이 다음 사람 화면에 남는다. 세 번째가 가장
// 나쁘다 — 서버가 소유자를 확인해 거절해도, 화면은 다른 사람의 글에
// 쓰려고 한 것이다.
//
// 실측 (main `ed00c1a4`): **위반 3건** — 제목 남음 · 직원 답장 남음 ·
// B 인증으로 A 의 ticket 에 POST 1건. 고친 뒤 **위반 0건**.
//
// 이 프로브가 CI 에 없는 이유는 `scripts/probe/README.md` 와 같다 —
// Playwright 는 이 저장소의 의존성이 아니다. 화면 증거는 수동으로 잰다.
//
// 잘못 재기 쉬운 두 가지 (실제로 겪음)
// ────────────────────────────────────
// 1. **Playwright 는 나중에 등록한 route 가 이긴다.** catch-all `**/api/**`
//    을 구체적인 경로보다 **뒤에** 등록하면 피드백 요청이 전부 `{"ok":true}`
//    로 가로채져 목록이 빈다. 그 상태의 "안 보인다"를 결과로 적으면 안 된다.
// 2. 화면 진입은 제품의 딥링크(`?tab=feedback`)로 한다. 홈에서 버튼을
//    글자로 찾으면 메뉴 안에 있어 못 찾는다.
//
// 사용법:
//   npm run build
//   npx next start -p 3942 &
//   node scripts/probe/feedback-auth-isolation.mjs 3942
//
// 프로브 빌드에는 `scripts/probe/lib/auth.mjs` 의 PROBE_ENV 를 준다.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
// 저장소 키는 **공용 것을 쓴다** — 베낀 값이 `PROBE_SUPABASE_URL` 과
// 갈리면 세션이 안 심기고, 프로브는 구멍을 "재현 안 됨" 으로 적는다.
import { PROBE_STORAGE_KEY } from './lib/auth.mjs';

const PORT = process.argv[2] ?? '3941';
const BASE = `http://127.0.0.1:${PORT}`;
const STORAGE_KEY = PROBE_STORAGE_KEY;
const HOUR = 3600;

const session = (who) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: `${who}.access.token`,
    refresh_token: `${who}.refresh.token`,
    token_type: 'bearer',
    expires_in: 24 * HOUR,
    expires_at: now + 24 * HOUR,
    user: {
      id: who === 'A' ? '00000000-0000-4000-8000-00000000000a'
        : '00000000-0000-4000-8000-00000000000b',
      aud: 'authenticated', role: 'authenticated',
      email: `${who.toLowerCase()}@local.invalid`,
      app_metadata: {}, user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  };
};

const TICKET = {
  A: {
    id: 'ticket-of-A', ref: 101, category: 'BUG', title: 'A의 비밀 문의 제목',
    status: 'REVIEWING', severity: 'HIGH', visibility: 'PRIVATE',
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  },
  B: {
    id: 'ticket-of-B', ref: 202, category: 'BUG', title: 'B의 문의 제목',
    status: 'RECEIVED', severity: 'LOW', visibility: 'PRIVATE',
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  },
};
const MESSAGES = {
  'ticket-of-A': [
    { id: 'm1', author: 'USER', body: 'A가 쓴 본문', created_at: new Date(0).toISOString() },
    { id: 'm2', author: 'STAFF', body: 'A에게만 보낸 직원 답장', created_at: new Date(0).toISOString() },
  ],
  'ticket-of-B': [
    { id: 'm3', author: 'USER', body: 'B가 쓴 본문', created_at: new Date(0).toISOString() },
  ],
};

const whoOf = (h) => (String(h ?? '').includes('A.access.token') ? 'A'
  : String(h ?? '').includes('B.access.token') ? 'B' : '?');

const out = { steps: [], posts: [], gets: [], violations: [] };
const note = (s) => { out.steps.push(s); console.log(`  ${s}`); };

const browser = await chromium.launch();
let holdB = true;   // B 의 목록 응답을 붙잡아 둔다
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(({ k, s }) => {
    try { localStorage.setItem(k, JSON.stringify(s)); } catch { /* 저장소 없음 */ }
  }, { k: STORAGE_KEY, s: session('A') });
  const page = await ctx.newPage();
  await page.route('**://*.supabase.co/**', (r) => r.abort());

  // 그 밖의 API 는 조용히. **먼저** 등록한다 — Playwright 는 나중에 등록한
  // route 가 이기므로, 아래 구체적인 경로들이 이 catch-all 을 덮어야 한다.
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  // 목록
  await page.route('**/api/feedback/reports', async (r) => {
    const req = r.request();
    const who = whoOf(req.headers().authorization);
    if (req.method() !== 'GET') {
      out.posts.push({ url: req.url(), who, body: req.postData() });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (who === 'B' && holdB) {
      // 응답을 늦춘다 — "B 의 목록이 아직 안 왔다"
      await new Promise((res) => setTimeout(res, 4000));
    }
    out.gets.push({ kind: 'list', who });
    const t = who === '?' ? [] : [TICKET[who]];
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tickets: t }) });
  });
  // 상세 / 답장
  await page.route('**/api/feedback/reports/*', async (r) => {
    const req = r.request();
    const who = whoOf(req.headers().authorization);
    const id = req.url().split('/').pop().split('?')[0];
    if (req.method() !== 'GET') {
      out.posts.push({ id, who, body: req.postData() });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, ticket: TICKET[who] ?? null, messages: MESSAGES[id] ?? [] }),
    });
  });

  await page.goto(`${BASE}/?tab=feedback`, { waitUntil: 'domcontentloaded' });
  const seeded = await page.evaluate((k) => {
    try { return !!JSON.parse(localStorage.getItem(k) || 'null')?.access_token; } catch { return false; }
  }, STORAGE_KEY);
  if (!seeded) throw new Error('프로브 세션이 심어지지 않았다 — 이 결과는 화면 증거가 아니다');
  note('A 세션 심음');

  // 제품의 딥링크로 들어왔다. 화면이 붙을 때까지 기다린다.
  await page.waitForTimeout(2500);
  const onScreen = await page.evaluate(() => /내 문의|새 문의|고객지원/.test(document.body.innerText));
  note(`고객지원 화면 진입: ${onScreen ? '됐다' : '안 됐다'}`);
  if (!onScreen) {
    out.violations.push('전제 실패 — 고객지원 화면에 들어가지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }

  // '내 문의' 탭
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button,[role="button"]')]
      .find((e) => /내 문의/.test(e.textContent || ''));
    if (hit) hit.click();
  });
  await page.waitForTimeout(1500);

  note(`나간 목록 요청: ${JSON.stringify(out.gets)}`);
  const aVisible = await page.evaluate(() => document.body.innerText.includes('A의 비밀 문의 제목'));
  note(`① A 의 제목이 보이는가: ${aVisible ? '보인다' : '안 보인다'}`);
  if (!aVisible) {
    out.violations.push('전제 실패 — A 의 목록이 화면에 안 그려졌다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }

  // 문의를 연다 — 행의 '대화 보기' 버튼이 정본 경로다.
  const openedTicket = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button')]
      .find((e) => (e.textContent || '').trim() === '대화 보기');
    if (hit) { hit.click(); return true; }
    return false;
  });
  note(`'대화 보기' 버튼: ${openedTicket ? '눌렀다' : '못 찾았다'}`);
  await page.waitForTimeout(1800);
  const staffVisible = await page.evaluate(() => document.body.innerText.includes('A에게만 보낸 직원 답장'));
  note(`① A 의 직원 답장이 보이는가: ${staffVisible ? '보인다' : '안 보인다'}`);

  // ── 인증을 B 로 바꾼다 (제품 경로: 저장소 교체 + focus/visibility) ──
  await page.evaluate(({ k, s }) => {
    localStorage.setItem(k, JSON.stringify(s));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, { k: STORAGE_KEY, s: session('B') });
  note('인증을 B 로 바꿨다 (B 의 목록 응답은 붙잡아 둔다)');
  await page.waitForTimeout(1500);

  const stillA = await page.evaluate(() => ({
    title: document.body.innerText.includes('A의 비밀 문의 제목'),
    staff: document.body.innerText.includes('A에게만 보낸 직원 답장'),
  }));
  note(`② 바꾼 뒤에도 A 의 제목: ${stillA.title ? '남아 있다' : '사라졌다'} · A 의 직원 답장: ${stillA.staff ? '남아 있다' : '사라졌다'}`);
  if (stillA.title) out.violations.push('인증이 바뀐 뒤에도 이전 사용자의 문의 제목이 보인다');
  if (stillA.staff) out.violations.push('인증이 바뀐 뒤에도 이전 사용자의 직원 답장이 보인다');

  // ③ 답장 전송 시 어떤 id·어떤 인증으로 나가는가
  const typed = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="답장"]');
    if (!ta) return false;
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '이 답장은 어디로 가나');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  note(`답장 입력칸: ${typed ? '있다' : '없다'}`);
  if (typed) {
    await page.evaluate(() => {
      const hit = [...document.querySelectorAll('button')]
        .find((e) => (e.textContent || '').trim() === '답장 보내기');
      if (hit) hit.click();
    });
    await page.waitForTimeout(1200);
  }
  const bad = out.posts.filter((p) => p.id === 'ticket-of-A' && p.who === 'B');
  note(`③ B 인증으로 A 의 ticket 에 나간 POST: ${bad.length}건 (전체 POST ${out.posts.length}건)`);
  if (bad.length) out.violations.push('B 의 Authorization 으로 A 의 ticket id 에 POST 했다');

  holdB = false;
} catch (e) {
  out.violations.push(`프로브 중단: ${e.message}`);
} finally {
  await browser.close();
  console.log('');
  console.log(`  위반 ${out.violations.length}건`);
  for (const v of out.violations) console.log(`    · ${v}`);
  process.exit(out.violations.length ? 1 : 0);
}
