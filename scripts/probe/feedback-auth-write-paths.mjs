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
//
// ⑤가 더 나쁘다. 비우기는 돌았는데 **그 뒤에** 되돌려 놓는 것이고,
// 되돌아온 상태에서 한 번 더 누르면 A 의 ticket 으로 나간다.
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

/** 인증이 B 로 바뀐 시점. 그 뒤에 나간 요청만 ⑤의 증거다. */
let switchedAt = null;
let releaseReply = null;          // 붙잡아 둔 답장 POST 를 놓아 준다
const gets = [];                  // {kind, who, id, afterSwitch}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(({ k, s }) => {
    try { localStorage.setItem(k, JSON.stringify(s)); } catch { /* 저장소 없음 */ }
  }, { k: STORAGE_KEY, s: session('A') });
  const page = await ctx.newPage();
  await blockAuthHost(page);

  // **먼저** 등록한다 — Playwright 는 나중에 등록한 route 가 이긴다.
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.route('**/api/feedback/reports', async (r) => {
    const req = r.request();
    const who = whoOf(req.headers().authorization);
    if (req.method() !== 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    gets.push({ kind: 'list', who, id: null, afterSwitch: switchedAt !== null });
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, tickets: who === '?' ? [] : [TICKET[who]] }),
    });
  });

  await page.route('**/api/feedback/reports/*', async (r) => {
    const req = r.request();
    const who = whoOf(req.headers().authorization);
    const id = req.url().split('/').pop().split('?')[0];
    if (req.method() !== 'GET') {
      // 답장 POST — **붙잡아 둔다.** 인증을 바꾼 뒤에 놓아 준다.
      note(`답장 POST 가 나갔다 (id=${id} · 인증=${who}) — 응답을 붙잡아 둔다`);
      await new Promise((res) => { releaseReply = res; });
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

  await page.goto(`${BASE}/?tab=feedback`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const onScreen = await page.evaluate(() => /내 문의|새 문의|고객지원|문의 보내기/.test(document.body.innerText));
  note(`고객지원 화면 진입: ${onScreen ? '됐다' : '안 됐다'}`);
  if (!onScreen) {
    out.violations.push('전제 실패 — 고객지원 화면에 들어가지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }

  // ── ④ 접수하다 만 글 ──
  const setVal = async (sel, v) => page.evaluate(({ sel, v }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { sel, v });

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
  const toTab = (label) => page.evaluate((l) => {
    // 제품의 탭은 `role="tab"` 이다. 전역 메뉴에도 비슷한 글자가 있어
    // 아무 버튼이나 집으면 탭이 아닌 것을 누른다 (겪었다).
    const hit = [...document.querySelectorAll('button[role="tab"]')]
      .find((e) => (e.textContent || '').trim().startsWith(l));
    if (!hit) return false;
    hit.click();
    return true;
  }, label);

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
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '대화 보기');
    if (hit) hit.click();
  });
  await page.waitForTimeout(1500);
  const typed = await setVal('textarea[aria-label="답장"]', 'A 가 쓰던 답장');
  note(`전제 · 답장 입력칸: ${typed ? '있다' : '없다'}`);
  if (!typed) {
    out.violations.push('전제 실패 — 답장 칸을 찾지 못했다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '답장 보내기');
    if (hit) hit.click();
  });
  // POST 가 route 에 닿아 붙잡히기를 기다린다
  for (let i = 0; i < 40 && releaseReply === null; i += 1) await page.waitForTimeout(100);
  if (releaseReply === null) {
    out.violations.push('전제 실패 — 답장 POST 가 나가지 않았다. 이 프로브는 증거가 아니다');
    throw new Error('전제 실패');
  }

  // ── 인증을 B 로 바꾼다 (제품 경로) ──
  switchedAt = Date.now();
  await page.evaluate(({ k, s }) => {
    localStorage.setItem(k, JSON.stringify(s));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, { k: STORAGE_KEY, s: session('B') });
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
  releaseReply();
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
      await page.evaluate(({ k, s }) => {
        localStorage.setItem(k, JSON.stringify(s));
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      }, { k: STORAGE_KEY, s: session('B', 'refreshed') });
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
} catch (e) {
  out.violations.push(`프로브 중단: ${e.message}`);
} finally {
  if (releaseReply) { try { releaseReply(); } catch { /* 이미 놓음 */ } }
  await browser.close();
  console.log('');
  console.log(`  위반 ${out.violations.length}건`);
  for (const v of out.violations) console.log(`    · ${v}`);
  process.exit(out.violations.length ? 1 : 0);
}
