#!/usr/bin/env node
// scripts/probe/position-close.mjs
//
// **전량청산 — 실기에서 눌러 본다.**
//
// 무엇을 증명하는가
// ─────────────────
// 시험은 순수 전이(`closeReviewReduce`)를 본다. 그 전이가 화면에 **실제로
// 배선됐는지**는 다른 사실이다. 여기서는 세는 것만 본다:
//
//   포지션 3개      3개가 다 보인다 (예전에는 첫 줄 + "외 2건")
//   두 번째 [전량청산] 창이 열리고 **/api/paper/close 0건**
//   창의 정체성     두 번째 포지션이다 (A를 눌렀는데 B가 뜨면 FAIL)
//   취소            0건
//   확인 연타       **정확히 1건** · 본문은 { positionId } 하나
//   실패            창 유지 + 사유
//   성공            창 닫힘 + 장부 다시 읽기
//   키보드          Tab 28회에 창 밖으로 나가지 않는다 · 배경 inert
//   닫은 뒤         포커스가 원래 버튼으로 돌아온다
//
// 사용법:
//   PROBE_ENV로 빌드한 서버에
//   node scripts/probe/position-close.mjs <port> [out]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { seedAuthScript, blockAuthHost, assertProbeSignedIn } from './lib/auth.mjs';

const PORT = process.argv[2], OUT = process.argv[3] || '/tmp/position-close';
const B = `http://localhost:${PORT}`;
if (!PORT) { console.error('사용법: node scripts/probe/position-close.mjs <port> [out]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [['360x660', 360, 660], ['390x844', 390, 844], ['430x932', 430, 932]];

/** 장부가 돌려줄 포지션 셋. **id가 정체성이다** */
const POSITIONS = [
  { id: 'pos-aaa', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 60000, quantity: 0.01,
    notional: 600, leverage: 10, margin: 60, stopLoss: 59400, takeProfit: null,
    liquidationPrice: 54300, openedAt: '2026-09-27T00:00:00.000Z' },
  { id: 'pos-bbb', symbol: 'ETHUSDT', side: 'SHORT', fillPrice: 3000, quantity: 1,
    notional: 3000, leverage: 5, margin: 600, stopLoss: 3030, takeProfit: null,
    liquidationPrice: 3540, openedAt: '2026-09-27T01:00:00.000Z' },
  { id: 'pos-ccc', symbol: 'SOLUSDT', side: 'LONG', fillPrice: 150, quantity: 4,
    notional: 600, leverage: 3, margin: 200, stopLoss: null, takeProfit: null,
    liquidationPrice: null, openedAt: null },
];
const TARGET = POSITIONS[1];   // 두 번째를 닫는다

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const all = {};
let fails = 0, unknowns = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); fails += 1; };
const ok = (m) => console.log(`  ✓ ${m}`);
const note = (m) => { console.log(`  · ${m}`); unknowns += 1; };

for (const [name, w, h] of VIEWPORTS) {
  console.log(`\n── ${name} ──`);
  const r = all[name] = {};
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('tg_onboarded_v1', '1');
    localStorage.setItem('tg_lang', 'ko');
  });
  await ctx.addInitScript(seedAuthScript());
  const page = await ctx.newPage();
  await blockAuthHost(page);

  // ── 나가는 청산 요청을 **센다** ──
  const closes = [];
  let closeOk = true;
  await page.route('**/api/paper/close', async (route) => {
    closes.push(route.request().postData() || '');
    await route.fulfill({
      status: closeOk ? 200 : 409, contentType: 'application/json',
      body: JSON.stringify(closeOk
        ? { ok: true, message: '포지션을 청산했습니다' }
        : { ok: false, error: 'already_closed', message: '이미 청산된 포지션입니다' }),
    });
  });

  let served = POSITIONS;
  await page.route('**/api/paper/positions**', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      account: { balance: 10000, available: 9000, availableUnknownReason: null },
      openPositions: served,
    }),
  }));
  await page.route('**/api/news**', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, source: 'mock', news: [] }),
  }));

  // 하단 내비의 **포지션** 탭. 내부 id는 `trading`이다 (`page.tsx`).
  await page.goto(`${B}/?tab=trading`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  await assertProbeSignedIn(page);

  // ── 덮개를 걷는다 ──
  //
  //   온보딩(언어 선택)과 로그인 모달이 뜰 수 있다. **덮인 채로 재면
  //   증거가 아니다** — JS로 부르는 클릭은 덮개를 통과하므로 동작은
  //   초록인데 사람은 못 누르는 상태가 그대로 남는다. 실제로 첫 판에서
  //   스크린샷이 온보딩 화면이었다.
  for (let i = 0; i < 6; i += 1) {
    const skipped = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,div,span,a')]
        .find(e => (e.innerText || '').trim() === '건너뛰기');
      if (b) { b.click(); return true; } return false;
    });
    await page.waitForTimeout(350);
    if (!skipped) break;
  }
  for (let i = 0; i < 3; i += 1) {
    const found = await page.evaluate(() => {
      const m = [...document.querySelectorAll('div')]
        .find(e => getComputedStyle(e).zIndex === '10070' && getComputedStyle(e).position === 'fixed');
      if (!m) return false;
      const x = [...m.querySelectorAll('button')]
        .find(b => (b.getAttribute('aria-label') || '') === '닫기');
      (x || m).click();
      return true;
    });
    await page.waitForTimeout(400);
    if (!found) break;
  }
  await page.waitForTimeout(600);

  const read = () => page.evaluate(() => {
    const host = document.querySelector('[data-testid="positions-orders-host"]');
    const sheet = document.querySelector('[data-testid="paper-close-review-sheet"]');
    const body = document.querySelector('[data-testid="positions-orders-screen"]');
    const txt = (t) => document.querySelector(`[data-testid="${t}"]`)?.textContent?.trim() ?? null;
    return {
      items: [...document.querySelectorAll('[data-testid="position-item"]')]
        .map(e => e.getAttribute('data-position-id')),
      more: !!document.querySelector('[data-testid="position-more"]'),
      closePhase: host?.getAttribute('data-close-phase') ?? null,
      sheet: !!sheet,
      sheetId: sheet?.getAttribute('data-close-position-id') ?? null,
      sheetSymbol: sheet?.getAttribute('data-close-symbol') ?? null,
      dialog: sheet ? {
        role: sheet.getAttribute('role'), modal: sheet.getAttribute('aria-modal'),
        label: sheet.getAttribute('aria-label'),
      } : null,
      bodyInert: body ? (body.inert === true) : null,
      confirmDisabled: document.querySelector('[data-testid="close-review-confirm"]')?.disabled ?? null,
      confirmAction: document.querySelector('[data-testid="close-review-confirm"]')
        ?.getAttribute('data-close-action') ?? null,
      message: txt('close-review-message'),
      note: txt('paper-close-review-sheet-note'),
      values: {
        SYMBOL: txt('close-value-SYMBOL'), SIDE: txt('close-value-SIDE'),
        ENTRY_PRICE: txt('close-value-ENTRY_PRICE'), QUANTITY: txt('close-value-QUANTITY'),
        LIQUIDATION_PRICE: txt('close-value-LIQUIDATION_PRICE'),
      },
      activeTestid: (document.activeElement?.closest?.('[data-testid]'))
        ?.getAttribute('data-testid') ?? null,
      activeFor: (document.activeElement)?.getAttribute?.('data-for-position') ?? null,
    };
  });

  const clickClose = (id) => page.evaluate((pid) =>
    document.querySelector(`[data-testid="position-close"][data-for-position="${pid}"]`)?.click(), id);

  // ── ⓐ 포지션이 **전부** 보인다 ──
  const first = await read();
  r.first = first;
  await page.screenshot({ path: `${OUT}/${name}-positions.png` });
  if (first.items.length !== 3) {
    bad(`${name}: 포지션 3개 중 ${first.items.length}개만 보입니다 (${first.items.join(',')})`);
    await ctx.close(); continue;
  }
  if (first.more) bad(`${name}: 나머지를 "외 N건"으로 접었습니다`);
  else ok(`${name}: 열린 포지션 3개가 전부 보인다 (${first.items.join(' · ')})`);

  // ── ⓑ 첫 클릭 — 창만 열리고 요청 0건 ──
  await clickClose(TARGET.id);
  await page.waitForTimeout(600);
  const opened = await read();
  r.opened = opened;
  await page.screenshot({ path: `${OUT}/${name}-close-review.png` });

  if (!opened.sheet) { bad(`${name}: 확인 창이 열리지 않았습니다`); await ctx.close(); continue; }
  if (closes.length) bad(`${name}: ★ 창을 여는데 청산 요청이 나갔습니다 (${closes.length}건)`);
  else ok(`${name}: 첫 클릭 — 창이 열리고 청산 요청 0건`);

  if (opened.sheetId !== TARGET.id || opened.sheetSymbol !== TARGET.symbol) {
    bad(`${name}: ★ 두 번째를 눌렀는데 창은 ${opened.sheetId}/${opened.sheetSymbol}입니다`);
  } else ok(`${name}: 창의 정체성 = ${TARGET.id} · ${TARGET.symbol}`);

  if (opened.values.LIQUIDATION_PRICE == null) {
    note(`${name}: 표시값을 읽지 못했습니다`);
  } else if (Number(opened.values.ENTRY_PRICE) !== TARGET.fillPrice) {
    bad(`${name}: 진입가가 장부와 다릅니다 (${opened.values.ENTRY_PRICE} vs ${TARGET.fillPrice})`);
  } else ok(`${name}: 표시값이 장부 그대로 (진입 ${opened.values.ENTRY_PRICE})`);

  if (!/서버가 다시 조회/.test(opened.note || '')) {
    bad(`${name}: 서버 재조회 문구가 없습니다 (${opened.note})`);
  } else ok(`${name}: 서버 재조회 문구 표시`);

  // ★ **그 자리에 정말 확인 버튼이 있는가.** JS 클릭은 덮개를 통과한다 —
  //   동작만 보면 "사람은 못 누르는데 초록"이 된다.
  {
    const hit = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="close-review-confirm"]');
      if (!b) return null;
      const q = b.getBoundingClientRect();
      const el = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      return {
        same: el === b || b.contains(el),
        tag: el?.tagName ?? null,
        testid: el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        txt: (el?.textContent || '').slice(0, 40),
        top: Math.round(q.top), bottom: Math.round(q.bottom), h: window.innerHeight,
      };
    });
    r.hit = hit;
    if (!hit) bad(`${name}: 확인 버튼 좌표를 재지 못했습니다`);
    else if (!hit.same) {
      bad(`${name}: 확인 버튼 자리를 다른 것이 덮고 있습니다 (${hit.tag} · ${hit.testid} · ${hit.txt})`);
    } else if (hit.bottom > hit.h + 1) {
      bad(`${name}: 확인 버튼이 화면 밖입니다 (${hit.top}~${hit.bottom} / ${hit.h})`);
    } else ok(`${name}: 확인 버튼이 화면 안이고 맨 위에 있다 (${hit.top}~${hit.bottom} / ${hit.h})`);
  }

  // ── ⓒ modal 안전성 ──
  if (!opened.dialog || opened.dialog.role !== 'dialog' || opened.dialog.modal !== 'true'
      || !opened.dialog.label) {
    bad(`${name}: 확인 창에 modal 의미가 없습니다 (${JSON.stringify(opened.dialog)})`);
  } else ok(`${name}: dialog / aria-modal / 이름 있음`);

  if (opened.bodyInert !== true) {
    bad(`${name}: 창이 떠 있는데 뒤 본문이 키보드에 살아 있습니다 (inert=${opened.bodyInert})`);
  } else ok(`${name}: 창이 떠 있는 동안 뒤 본문이 inert`);

  // ★ 열자마자 **확인**에 포커스가 있으면 Enter 한 번에 포지션이 닫힌다.
  {
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid') ?? null);
    r.focusOnOpen = focused;
    if (focused === 'close-review-confirm') {
      bad(`${name}: ★ 열자마자 확인 버튼에 포커스가 있습니다 — Enter 한 번에 닫힙니다`);
    } else if (focused !== 'close-review-cancel') {
      bad(`${name}: 열었는데 포커스가 창의 버튼에 없습니다 (${focused})`);
    } else ok(`${name}: 열면 포커스가 [돌아가기]에 간다 (확인이 아니다)`);
  }

  {
    const escaped = [];
    for (const shift of [false, true]) {
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
        const where = await page.evaluate(() => {
          const a = document.activeElement;
          const sheet = document.querySelector('[data-testid="paper-close-review-sheet"]');
          if (!a || a === document.body) return 'BODY';
          return sheet && sheet.contains(a) ? 'IN'
            : (a.closest('[data-testid]')?.getAttribute('data-testid') || a.tagName);
        });
        if (where !== 'IN') escaped.push(`${shift ? 'S' : ''}Tab#${i}:${where}`);
      }
    }
    r.tabEscapes = escaped;
    if (escaped.length) {
      bad(`${name}: ★ Tab으로 확인 창 밖에 포커스가 갔습니다 (${escaped.slice(0, 4).join(' ')})`);
    } else ok(`${name}: Tab / Shift+Tab 28회 — 포커스가 창 안에 갇힌다`);
  }

  // ── ⓓ 취소 — 요청 0건 + 포커스 복원 ──
  await page.evaluate(() =>
    document.querySelector('[data-testid="close-review-cancel"]')?.click());
  await page.waitForTimeout(700);
  const cancelled = await read();
  r.cancelled = cancelled;
  if (cancelled.sheet) bad(`${name}: 취소했는데 창이 남아 있습니다`);
  else if (closes.length) bad(`${name}: ★ 취소했는데 청산 요청이 나갔습니다 (${closes.length}건)`);
  else ok(`${name}: 취소 — 창이 닫히고 청산 요청 0건`);
  if (cancelled.bodyInert === true) bad(`${name}: 창을 닫았는데 뒤 본문이 아직 inert입니다`);
  if (cancelled.activeFor !== TARGET.id) {
    bad(`${name}: 닫은 뒤 포커스가 원래 버튼으로 돌아오지 않았습니다`
      + ` (${cancelled.activeTestid} / ${cancelled.activeFor})`);
  } else ok(`${name}: 닫은 뒤 포커스가 눌렀던 [전량청산]으로 복원`);

  // ── ⓔ 실패 — 창 유지 + 사유 ──
  closeOk = false;
  await clickClose(TARGET.id);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="close-review-confirm"]');
    b?.click(); b?.click(); b?.click();
  });
  await page.waitForTimeout(1400);
  const failed = await read();
  r.failed = { ...failed, closes: closes.length };
  await page.screenshot({ path: `${OUT}/${name}-close-failed.png` });
  if (closes.length !== 1) {
    bad(`${name}: ★ 확인 연타에 청산이 ${closes.length}건 나갔습니다 — 정확히 1건이어야 합니다`);
  } else ok(`${name}: 확인 — 연타해도 청산 요청 정확히 1건`);
  if (!failed.sheet) bad(`${name}: ★ 실패했는데 창이 닫혀 사유가 사라졌습니다`);
  else if (!failed.message) bad(`${name}: 실패 사유가 화면에 없습니다`);
  else ok(`${name}: 실패 — 창 유지 + 사유 표시 (${failed.message.slice(0, 20)}…)`);

  try {
    const body = JSON.parse(closes[0] || '{}');
    const keys = Object.keys(body).join(',');
    if (keys !== 'positionId') bad(`${name}: ★ 청산 본문에 다른 값이 실렸습니다 (${keys})`);
    else if (body.positionId !== TARGET.id) {
      bad(`${name}: ★ 창에 적힌 포지션과 다른 것을 닫았습니다 (${body.positionId})`);
    } else ok(`${name}: 본문 = { positionId: '${TARGET.id}' } 하나뿐`);
  } catch { note(`${name}: 청산 본문을 읽지 못했습니다`); }

  // ── ⓕ 성공 — 창 닫힘 + 장부 다시 읽기 ──
  closeOk = true;
  served = POSITIONS.filter(p => p.id !== TARGET.id);   // 서버가 닫았다
  await page.evaluate(() =>
    document.querySelector('[data-testid="close-review-confirm"]')?.click());
  await page.waitForTimeout(1600);
  const done = await read();
  r.done = { ...done, closes: closes.length };
  await page.screenshot({ path: `${OUT}/${name}-close-done.png` });
  if (closes.length !== 2) {
    bad(`${name}: 재시도 청산이 ${closes.length - 1}건입니다 (1건이어야 합니다)`);
  }
  if (done.sheet) bad(`${name}: ★ 성공했는데 창이 남아 있습니다`);
  else if (done.items.length !== 2 || done.items.includes(TARGET.id)) {
    bad(`${name}: 청산 뒤 장부를 다시 읽지 않았습니다 (${done.items.join(',')})`);
  } else ok(`${name}: 성공 — 창 닫힘 · 장부 재조회 (${done.items.join(' · ')})`);
  if (done.bodyInert === true) bad(`${name}: 성공 뒤에도 뒤 본문이 inert입니다`);

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/position-close.json`, JSON.stringify(all, null, 2));
console.log(`\n스크린샷·측정값: ${OUT}`);
if (fails) { console.error(`\n실패 ${fails}건`); process.exit(1); }
if (unknowns) console.log(`\n확인 못 한 항목 ${unknowns}건 (위 · 표시 — 통과가 아닙니다)`);
console.log('\n✅ 전량청산 — 포지션 전부 표시 · 첫 클릭 요청 0건 · 정체성 일치 ·'
  + ' 취소 0건 · 확인 1건(연타 포함) · 본문 positionId만 · 실패 유지 · 성공 닫힘+재조회 ·'
  + ' 키보드 탈출 0 · 포커스 복원');
