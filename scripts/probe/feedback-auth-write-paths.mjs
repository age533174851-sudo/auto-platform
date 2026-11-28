// 고객지원 화면 — **쓰기 경로**가 인증 전환을 건너 이전 사람에게 되돌아가는가.
//
// `feedback-auth-isolation.mjs`는 **읽기** 두 곳(목록·문의 내용)을 쟀다.
// 이 프로브는 그 프로브가 재지 않은 두 자리를 본다:
//
//   ④ 접수하다 만 글. 제목·내용·재현 단계는 인증이 바뀔 때 비워지지
//      않는다 — A 가 적다 만 버그 제보가 B 의 화면에 남는가.
//   ⑤ 날아가 있는 답장 POST. 응답이 인증 전환 **뒤에** 돌아오면
//      `await openTicket(openId)`의 `openId`는 **닫힌 함수가 들고 있는
//      이전 사람의 ticket id**다. 그러면 B 의 화면이 A 의 문의로 돌아간다.
//   ⑦ 날아가 있는 **접수** POST. 같은 모양이다 — 성공 처리가
//      `setTab('mine')` 과 `loadList()` 를 부르고, 성공 안내문을 띄우고,
//      **접수 칸을 비운다.** 그 비우기가 다음 사람의 글을 지운다.
//
// ⑤·⑦이 더 나쁘다. 비우기는 돌았는데 **그 뒤에** 되돌려 놓는 것이고,
// 되돌아온 상태에서 한 번 더 누르면 A 의 ticket 으로 나간다.
//
// ⑦은 [Codex 독립 재현](https://github.com/age533174851-sudo/auto-platform/pull/821#issuecomment-7236099670)
// 이 `submit` 경합 2위반으로 먼저 지적한 자리다. 고친 판이 그것도 막는지
// **내 손으로 재지 않고는 적지 않는다.**
//
// 사용법 — **빌드와 서버 둘 다 `PROBE_ENV` 가 필요하다.** `NEXT_PUBLIC_*`
// 은 빌드 시점에 박히므로, 그것 없이 빌드하면 화면이 세션을 못 보고
// 요청이 한 건도 안 나간다(겪었다: 위반 0 이 아니라 "전제 실패" 로 끝난다).
//
//   node -e "import('./scripts/probe/lib/auth.mjs').then(m=>console.log(JSON.stringify(m.PROBE_ENV)))"
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... npm run build
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... npx next start -p 3951
//   node scripts/probe/feedback-auth-write-paths.mjs 3951
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
// 저장소 키와 호스트 차단은 **공용 것을 쓴다.** 베껴 두면 `PROBE_SUPABASE_URL`
// 을 바꿀 때 한쪽만 고쳐지고, 그때부터 세션이 안 심기는데 프로브는
// "재현 안 됨"으로 끝난다 — 실제로 한 번 그랬다.
import { PROBE_STORAGE_KEY, blockAuthHost } from './lib/auth.mjs';

const PORT = process.argv[2] ?? '3951';
const BASE = `http://127.0.0.1:${PORT}`;
const STORAGE_KEY = PROBE_STORAGE_KEY;
const HOUR = 3600;

/** A 가 적다 만 글. 이 문자열들이 B 의 화면에 남아 있으면 유출이다. */
const DRAFT = {
  title: 'A가 적다 만 제목 · 계좌가 비었다',
  body: 'A의 사적인 재현 내용 — 여기에 계좌 상황을 적었다',
  steps: 'A의 1단계 · 내 계좌로 로그인한다',
};
/** A 의 답장 응답에만 실려 오는 문장 */
const A_NOTICE = 'A 의 글에서 지운 비밀이 있습니다';

/** ⑦ 에서 A 가 보내는 접수 글 · B 가 그 뒤에 적는 글 */
const A_SUBMIT_TITLE = 'A 의 접수 제목 · SYNTHETIC_A_PRIVATE';
const B_KEEP_TITLE = 'B 가 적던 제목 · 지워지면 안 된다';

const SUB = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
};

/**
 * **진짜 JWT 모양으로 만든다.** Supabase access token 은 JWT 이고, 화면은
 * 그 `sub` 로 "누구인가"를 읽는다. 토큰을 `A.access.token` 같은 아무
 * 문자열로 두면 신원을 못 읽는 경로만 타게 되고, **갱신과 사람 교체를
 * 가르는 바로 그 판단을 재지 못한다.** 서명은 검사되지 않는다(화면은
 * 신원만 읽고, 권한은 서버가 본다).
 */
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub, nonce) => [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ sub, exp: Math.floor(Date.now() / 1000) + 24 * HOUR, nonce }),
  'signature-not-checked-in-probe',
].join('.');

/** 토큰 → 누구. 프로브가 만든 것만 들어 있다. */
const tokens = new Map();

const session = (who, nonce = 'n1') => {
  const now = Math.floor(Date.now() / 1000);
  const access = jwt(SUB[who], `${who}-${nonce}`);
  tokens.set(access, who);
  return {
    access_token: access,
    refresh_token: `${who}.refresh.${nonce}`,
    token_type: 'bearer',
    expires_in: 24 * HOUR,
    expires_at: now + 24 * HOUR,
    user: {
      id: SUB[who],
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
  'ticket-of-A': [{ id: 'm1', author: 'USER', body: 'A가 쓴 본문', created_at: new Date(0).toISOString() }],
  'ticket-of-B': [{ id: 'm3', author: 'USER', body: 'B가 쓴 본문', created_at: new Date(0).toISOString() }],
};

const whoOf = (h) => tokens.get(String(h ?? '').replace(/^Bearer\s+/i, '')) ?? '?';

const out = { violations: [] };
const note = (s) => console.log(`  ${s}`);

/** 인증이 B 로 바뀐 시점. 그 뒤에 나간 요청만 ⑤·⑦의 증거다. */
let switchedAt = null;
/** 붙잡아 둔 POST 를 놓아 주는 함수. `hold` 로 어느 POST 를 잡을지 고른다 */
let release = null;
const gets = [];                  // {kind, who, id, afterSwitch}

/**
 * 두 단계가 **같은 응답**을 쓰게 한다. 베껴 두면 한 단계만 고쳐지고,
 * 그때 두 단계가 다른 것을 재면서 같은 이름으로 보고된다.
 *
 * @param hold 'reply' | 'submit' — 이 POST 의 응답을 붙잡아 둔다
 */
async function installRoutes(target, hold) {
  // **먼저** 등록한다 — Playwright 는 나중에 등록한 route 가 이긴다.
  await target.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await target.route('**/api/feedback/reports', async (r) => {
    const req = r.request();
    const who = whoOf(req.headers().authorization);
    if (req.method() !== 'GET') {
      if (hold === 'submit') {
        note(`접수 POST 가 나갔다 (인증=${who}) — 응답을 붙잡아 둔다`);
        await new Promise((res) => { release = res; });
        return r.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, redactionNotice: A_NOTICE }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    gets.push({ kind: 'list', who, id: null, afterSwitch: switchedAt !== null });
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, tickets: who === '?' ? [] : [TICKET[who]] }),
    });
  });

  await target.route('**/api/feedback/reports/*', async (r) => {
    const req = r.request();
    const who = whoOf(req.headers().authorization);
    const id = req.url().split('/').pop().split('?')[0];
    if (req.method() !== 'GET') {
      if (hold === 'reply') {
        note(`답장 POST 가 나갔다 (id=${id} · 인증=${who}) — 응답을 붙잡아 둔다`);
        await new Promise((res) => { release = res; });
      }
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, redactionNotice: A_NOTICE }),
      });
    }
    gets.push({ kind: 'ticket', who, id, afterSwitch: switchedAt !== null });
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, ticket: TICKET[who] ?? null, messages: MESSAGES[id] ?? [] }),
    });
  });
}

/** 입력칸에 리액트가 알아듣는 방식으로 값을 넣는다 */
const setValOn = (target, sel, v) => target.evaluate(({ sel, v }) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}, { sel, v });

/** 제품의 탭은 `role="tab"` 이다 — 전역 메뉴에 비슷한 글자가 있다 */
const toTabOn = (target, label) => target.evaluate((l) => {
  const hit = [...document.querySelectorAll('button[role="tab"]')]
    .find((e) => (e.textContent || '').trim().startsWith(l));
  if (!hit) return false;
  hit.click();
  return true;
}, label);

const clickText = (target, label) => target.evaluate((l) => {
  const hit = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === l);
  if (!hit) return false;
  hit.click();
  return true;
}, label);

const switchTo = (target, who, nonce) => target.evaluate(({ k, s }) => {
  localStorage.setItem(k, JSON.stringify(s));
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
}, { k: STORAGE_KEY, s: session(who, nonce) });

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(({ k, s }) => {
    try { localStorage.setItem(k, JSON.stringify(s)); } catch { /* 저장소 없음 */ }
  }, { k: STORAGE_KEY, s: session('A') });
  const page = await ctx.newPage();
  await blockAuthHost(page);
  await installRoutes(page, 'reply');

  await page.goto(`${BASE}/?tab=feedback`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const onScreen = await page.evaluate(() => /내 문의|새 문의|고객지원|문의 보내기/.test(document.body.innerText));
  note(`고객지원 화면 진입: ${onScreen ? '됐다' : '안 됐다'}`);
  if (!onScreen) {
    out.violations.push('전제 실패 — 고객지원 화면에 들어가지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }

  // ── ④ 접수하다 만 글 ──
  const setVal = (sel, v) => setValOn(page, sel, v);

  const filled = {
    title: await setVal('input[aria-label="제목"]', DRAFT.title),
    body: await setVal('textarea[aria-label="내용"]', DRAFT.body),
    steps: await setVal('textarea[data-testid="feedback-steps"]', DRAFT.steps),
  };
  note(`A 가 적다 만 칸: 제목 ${filled.title ? '적음' : '칸 없음'} · 내용 ${filled.body ? '적음' : '칸 없음'} · 재현단계 ${filled.steps ? '적음' : '칸 없음'}`);
  if (!filled.title || !filled.body) {
    out.violations.push('전제 실패 — 접수 칸을 찾지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }
  await page.waitForTimeout(400);

  // ── ⑤ 날아가 있는 답장 POST 를 만든다 ──
  // '내 문의' 로 가서 A 의 문의를 열고, 답장을 눌러 POST 를 띄워 둔다.
  const toTab = (label) => toTabOn(page, label);

  const toMine = await toTab('내 문의');
  note(`전제 · '내 문의' 탭: ${toMine ? '눌렀다' : '못 찾았다'}`);
  if (!toMine) {
    out.violations.push('전제 실패 — 탭을 찾지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }
  await page.waitForTimeout(1500);
  const openedList = await page.evaluate(() => document.body.innerText.includes('A의 비밀 문의 제목'));
  note(`전제 · A 의 목록이 보이는가: ${openedList ? '보인다' : '안 보인다'}`);
  if (!openedList) {
    out.violations.push('전제 실패 — A 의 목록이 안 그려졌다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }
  await clickText(page, '대화 보기');
  await page.waitForTimeout(1500);
  const typed = await setVal('textarea[aria-label="답장"]', 'A 가 쓰던 답장');
  note(`전제 · 답장 입력칸: ${typed ? '있다' : '없다'}`);
  if (!typed) {
    out.violations.push('전제 실패 — 답장 칸을 찾지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }
  await clickText(page, '답장 보내기');
  // POST 가 route 에 닿아 붙잡히기를 기다린다
  for (let i = 0; i < 40 && release === null; i += 1) await page.waitForTimeout(100);
  if (release === null) {
    out.violations.push('전제 실패 — 답장 POST 가 나가지 않았다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }

  // ── 인증을 B 로 바꾼다 (제품 경로) ──
  switchedAt = Date.now();
  await switchTo(page, 'B');
  note('인증을 B 로 바꿨다 (답장 POST 는 아직 날아가 있다)');
  await page.waitForTimeout(1200);

  // ④ 판정 — A 의 적다 만 글이 남아 있는가
  const draftLeft = await page.evaluate((d) => {
    const v = (sel) => document.querySelector(sel)?.value ?? '';
    const t = document.body.innerText;
    return {
      title: v('input[aria-label="제목"]').includes(d.title) || t.includes(d.title),
      body: v('textarea[aria-label="내용"]').includes(d.body) || t.includes(d.body),
      steps: v('textarea[data-testid="feedback-steps"]').includes(d.steps) || t.includes(d.steps),
    };
  }, DRAFT);
  // 접수 탭으로 돌아가 칸을 직접 본다 — '내 문의' 탭에서는 안 그려진다
  const backToNew = await toTab('문의하기');
  note(`④ '문의하기' 탭으로 되돌아가기: ${backToNew ? '눌렀다' : '못 찾았다'}`);
  await page.waitForTimeout(800);
  // **칸이 화면에 없는데 "비었다"로 읽으면 안 된다.** 둘 다 빈 문자열을
  // 돌려주므로 구멍을 "사라졌다"로 적게 된다. 칸의 존재를 먼저 본다.
  const form = await page.evaluate((d) => {
    const el = (sel) => document.querySelector(sel);
    const v = (sel) => el(sel)?.value ?? null;
    return {
      present: !!el('input[aria-label="제목"]') && !!el('textarea[aria-label="내용"]'),
      title: v('input[aria-label="제목"]'),
      body: v('textarea[aria-label="내용"]'),
      steps: v('textarea[data-testid="feedback-steps"]'),
    };
  }, DRAFT);
  if (!form.present) {
    note('④ 접수 칸을 화면에서 찾지 못했다 — **UNKNOWN**. 비었다고 적지 않는다');
    out.violations.push('④ 판정 불가 — 접수 칸이 화면에 없어 확인하지 못했다 (통과가 아니다)');
  } else {
    const draftOnForm = {
      title: String(form.title ?? '').includes(DRAFT.title),
      body: String(form.body ?? '').includes(DRAFT.body),
      steps: String(form.steps ?? '').includes(DRAFT.steps),
    };
    const leaked = ['title', 'body', 'steps'].filter((k) => draftLeft[k] || draftOnForm[k]);
    note(`④ 바꾼 뒤에도 A 가 적다 만 글: ${leaked.length ? `남아 있다 (${leaked.join(' · ')})` : '사라졌다'}`
      + ` (칸 확인됨 · 제목칸 길이 ${String(form.title ?? '').length} · 내용칸 길이 ${String(form.body ?? '').length})`);
    if (leaked.length) {
      out.violations.push(`인증이 바뀐 뒤에도 이전 사용자가 적다 만 글이 남아 있다 (${leaked.join(' · ')})`);
    }
  }

  // ── ⑤ 붙잡아 둔 답장 응답을 놓아 준다 ──
  release();
  await page.waitForTimeout(2000);

  const backToA = gets.filter((g) => g.afterSwitch && g.kind === 'ticket' && g.id === 'ticket-of-A');
  note(`⑤ 인증 전환 뒤에 A 의 문의를 다시 읽은 요청: ${backToA.length}건`
    + `${backToA.length ? ` (인증=${backToA.map((g) => g.who).join(',')})` : ''}`);
  if (backToA.length) {
    out.violations.push('날아가 있던 답장 응답이 돌아오며 화면을 이전 사용자의 문의로 되돌렸다');
  }
  const noticeLeft = await page.evaluate((s) => document.body.innerText.includes(s), A_NOTICE);
  note(`⑤ A 의 응답에만 있던 안내문이 B 의 화면에: ${noticeLeft ? '보인다' : '안 보인다'}`);
  if (noticeLeft) out.violations.push('이전 사용자의 응답에만 있던 안내문이 다음 사용자 화면에 보인다');

  note(`(참고) 인증 전환 뒤 나간 요청: ${JSON.stringify(gets.filter((g) => g.afterSwitch))}`);

  // ── ⑥ 대조군: **토큰 갱신은 사람 교체가 아니다** ──
  //
  // 토큰은 한 시간마다 갱신된다. 그때마다 비우면 같은 사람이 적던 글을
  // 시스템이 지운다 — 유출을 막으려고 사용자의 글을 버리는 것이다.
  // 그래서 "같은 `sub`, 다른 토큰"에서는 **남아 있어야 한다.**
  const toNew = await toTab('문의하기');
  if (!toNew) {
    out.violations.push('⑥ 판정 불가 — 접수 탭으로 가지 못했다 (통과가 아니다)');
  } else {
    const KEEP = 'B 가 적다 만 제목 · 지워지면 안 된다';
    const okTitle = await setVal('input[aria-label="제목"]', KEEP);
    const okBody = await setVal('textarea[aria-label="내용"]', 'B 의 내용 · 지워지면 안 된다');
    if (!okTitle || !okBody) {
      out.violations.push('⑥ 판정 불가 — 접수 칸을 찾지 못했다 (통과가 아니다)');
    } else {
      await page.waitForTimeout(400);
      // 같은 사람(B)의 **새 토큰**. Supabase 의 TOKEN_REFRESHED 와 같은 모양이다.
      await switchTo(page, 'B', 'refreshed');
      note('B 의 토큰을 갱신했다 (같은 sub · 다른 토큰)');
      await page.waitForTimeout(1500);
      const kept = await page.evaluate((t) => {
        const el = document.querySelector('input[aria-label="제목"]');
        return el ? { present: true, has: String(el.value ?? '').includes(t) } : { present: false, has: false };
      }, KEEP);
      if (!kept.present) {
        out.violations.push('⑥ 판정 불가 — 갱신 뒤 접수 칸이 화면에 없다 (통과가 아니다)');
        note('⑥ 갱신 뒤 접수 칸을 찾지 못했다 — **UNKNOWN**');
      } else {
        note(`⑥ 토큰 갱신 뒤 B 가 적다 만 글: ${kept.has ? '남아 있다 (옳다)' : '지워졌다'}`);
        if (!kept.has) {
          out.violations.push('토큰 갱신만으로 같은 사람이 적던 글을 지웠다 — 유출을 막으려고 사용자의 글을 버린다');
        }
      }
    }
  }

  // ── ⑦ 접수(submit) 경합 ──
  //
  // 답장과 같은 모양이지만 성공 처리가 하는 일이 더 많다 —
  // `setTab('mine')` · `loadList()` · 안내문 · **접수 칸 비우기**.
  // 그 비우기가 다음 사람의 글을 지운다.
  release = null;
  switchedAt = null;
  const before7 = gets.length;
  const p2 = await ctx.newPage();
  await blockAuthHost(p2);
  await installRoutes(p2, 'submit');
  await p2.evaluate(({ k, s }) => {
    try { localStorage.setItem(k, JSON.stringify(s)); } catch { /* 저장소 없음 */ }
  }, { k: STORAGE_KEY, s: session('A', 'p7') });
  await p2.goto(`${BASE}/?tab=feedback`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);

  const f7a = await setValOn(p2, 'input[aria-label="제목"]', A_SUBMIT_TITLE);
  const f7b = await setValOn(p2, 'textarea[aria-label="내용"]', 'A 의 접수 본문 · 사적인 내용');
  note(`⑦ 전제 · A 의 접수 칸: 제목 ${f7a ? '적음' : '칸 없음'} · 내용 ${f7b ? '적음' : '칸 없음'}`);
  if (!f7a || !f7b) {
    out.violations.push('⑦ 전제 실패 — 접수 칸을 찾지 못했다. 이 단계는 증거가 아니다');
  } else {
    await p2.waitForTimeout(400);
    const sent = await clickText(p2, '문의 보내기');
    note(`⑦ 전제 · '문의 보내기': ${sent ? '눌렀다' : '못 찾았다'}`);
    for (let i = 0; i < 40 && release === null; i += 1) await p2.waitForTimeout(100);
    if (release === null) {
      out.violations.push('⑦ 전제 실패 — 접수 POST 가 나가지 않았다. 이 단계는 증거가 아니다');
    } else {
      switchedAt = Date.now();
      await switchTo(p2, 'B', 'p7');
      note('⑦ 인증을 B 로 바꿨다 (접수 POST 는 아직 날아가 있다)');
      await p2.waitForTimeout(1200);

      // B 가 자기 글을 적기 시작한다. A 의 접수 성공이 이걸 지우면 안 된다.
      const to7 = await toTabOn(p2, '문의하기');
      const okB = to7 ? await setValOn(p2, 'input[aria-label="제목"]', B_KEEP_TITLE) : false;
      note(`⑦ B 가 자기 글을 적는다: ${okB ? '적음' : '칸 없음'}`);
      await p2.waitForTimeout(400);

      // A 의 접수 응답을 놓아 준다
      release();
      await p2.waitForTimeout(2000);

      const after7 = gets.slice(before7).filter((g) => g.afterSwitch);
      const staleA = after7.filter((g) => g.who === 'A');
      note(`⑦ 전환 뒤 **A 인증**으로 나간 요청: ${staleA.length}건`
        + `${staleA.length ? ` (${staleA.map((g) => g.kind).join(',')})` : ''}`);
      if (staleA.length) {
        out.violations.push('날아가 있던 접수 응답이 돌아오며 이전 사용자의 인증으로 다시 조회했다');
      }
      const n7 = await p2.evaluate((t) => document.body.innerText.includes(t), A_NOTICE);
      note(`⑦ A 의 접수 안내문이 B 의 화면에: ${n7 ? '보인다' : '안 보인다'}`);
      if (n7) out.violations.push('이전 사용자의 접수 안내문이 다음 사용자 화면에 보인다');
      // 되돌아온 목록에 실려 오는 것은 접수한 제목이 아니라 **A 의 기존
      // 문의 제목**이다(목록 fixture 가 그것을 돌려준다). 접수 제목으로
      // 찾으면 영원히 안 걸리는 검사가 된다 — 쓸모없는 초록이다.
      const t7 = await p2.evaluate((t) => document.body.innerText.includes(t), TICKET.A.title);
      note(`⑦ A 의 문의 제목이 B 의 화면에: ${t7 ? '보인다' : '안 보인다'}`);
      if (t7) out.violations.push('날아가 있던 접수 응답이 이전 사용자의 문의 목록을 다음 사용자 화면에 띄웠다');

      if (!okB) {
        note('⑦ B 의 글을 적지 못해 "지워졌는가"는 **UNKNOWN**');
        out.violations.push('⑦ 판정 불가 — B 의 접수 칸에 적지 못했다 (통과가 아니다)');
      } else {
        const back = await toTabOn(p2, '문의하기');
        await p2.waitForTimeout(600);
        const kept7 = await p2.evaluate((t) => {
          const el = document.querySelector('input[aria-label="제목"]');
          return el ? { present: true, has: String(el.value ?? '').includes(t) } : { present: false, has: false };
        }, B_KEEP_TITLE);
        if (!back || !kept7.present) {
          note('⑦ 접수 칸을 다시 찾지 못했다 — **UNKNOWN**');
          out.violations.push('⑦ 판정 불가 — 접수 칸이 화면에 없어 확인하지 못했다 (통과가 아니다)');
        } else {
          note(`⑦ A 의 접수 성공이 B 가 적던 글을: ${kept7.has ? '남겨 뒀다 (옳다)' : '지웠다'}`);
          if (!kept7.has) {
            out.violations.push('이전 사용자의 접수 성공 처리가 다음 사용자가 적던 글을 지웠다');
          }
        }
      }
    }
  }

} catch (e) {
  out.violations.push(`프로브 중단: ${e.message}`);
} finally {
  if (release) { try { release(); } catch { /* 이미 놓음 */ } }
  await browser.close();
  console.log('');
  console.log(`  위반 ${out.violations.length}건`);
  for (const v of out.violations) console.log(`    · ${v}`);
  process.exit(out.violations.length ? 1 : 0);
}
