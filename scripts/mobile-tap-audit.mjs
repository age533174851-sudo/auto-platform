// 안 눌리는 버튼을 눈이 아니라 **좌표로** 찾는다.
//
// 왜 필요한가
// ───────────
// "25% 버튼이 안 눌린다"는 제보가 있었다. 핸들러는 멀쩡했다. 실제 원인은
// 롱/숏 진입 블록이 `position: sticky; bottom: 0`으로 그 줄 **위에 얹혀**
// 있었던 것이다 — 탭이 진입 버튼으로 들어갔다.
//
// 이건 스크린샷으로도, 유닛 테스트로도 안 잡힌다. 버튼은 분명히 그려져
// 있고, 코드도 맞다. 겹침은 **실제 배치가 끝난 뒤에만** 존재한다.
// 그래서 각 버튼의 (잘린 뒤 실제로 보이는) 중심에서 elementFromPoint를
// 찍어 무엇이 그 탭을 받는지 본다.
//
// 세 가지를 구분해서 보고한다. 섞으면 쓸모가 없다:
//   덮임(blocked)  다른 것이 위에 있다 — **사고다**
//   잘림(clipped)  스크롤 칸에 가려 지금 안 보인다 — 스크롤하면 눌린다
//   disabled       의도적으로 막은 것. 이유(title)까지 같이 적는다
//
// 쓰는 법
// ───────
//   npm i -D playwright-core        (기본 의존성이 아니다 — CI를 느리게 하지 않으려고)
//   npm run dev
//   node scripts/mobile-tap-audit.mjs out 360 645
//
// 높이 645는 추측이 아니라 실측이다: 1080×2340 기기(DPR 3, CSS 360×780)에서
// 크롬 URL 바와 안드로이드 내비를 빼면 **645**가 남는다. 780으로 맞추면
// 실기기에서 135px이 모자란다 — 이 화면이 정확히 그것 때문에 밀렸다.
import { chromium } from 'playwright-core';

const OUT = process.env.AUDIT_OUT || '.';
const W = Number(process.argv[3] || 360);
const H = Number(process.argv[4] || 645);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message.slice(0, 160)));

await p.addInitScript(() => {
  const Real = window.WebSocket;
  class FakeWS {
    constructor(url){ this.url=url; this.readyState=1; this._l={};
      setTimeout(()=>{ this._fire('open',{}); this.pump(); },60); }
    addEventListener(t,f){ (this._l[t]=this._l[t]||[]).push(f); }
    removeEventListener(t,f){ this._l[t]=(this._l[t]||[]).filter(x=>x!==f); }
    _fire(t,e){ const h=this['on'+t]; if(h)h(e); for(const f of (this._l[t]||[])) f(e); }
    pump(){ const base=62973.6;
      const send=()=>{ if(this.readyState!==1) return;
        const bids=Array.from({length:20},(_,i)=>[String(base-i*0.1),(Math.random()*4).toFixed(4)]);
        const asks=Array.from({length:20},(_,i)=>[String(base+0.05+i*0.1),(Math.random()*4).toFixed(4)]);
        for(const d of [
          {e:'24hrTicker',s:'BTCUSDT',c:String(base),P:'-2.78',p:'-1800',h:'65000',l:'62000',v:'1200',q:'70000000000'},
          {lastUpdateId:Date.now(),bids,asks,b:bids,a:asks},
          {e:'aggTrade',s:'BTCUSDT',p:String(base),q:'0.01',T:Date.now(),m:false},
        ]) this._fire('message',{data:JSON.stringify(d)});
        setTimeout(send,700); };
      send(); }
    send(){} close(){ this.readyState=3; }
  }
  window.WebSocket = new Proxy(Real, { construct(t,a){ return /binance/i.test(String(a[0]||'')) ? new FakeWS(a[0]) : new t(...a); } });
});

await p.goto('http://127.0.0.1:3000/', { waitUntil: 'load' });
await p.waitForTimeout(4000);
for (let i = 0; i < 6; i++) {
  const skip = p.locator('text=건너뛰기').first();
  if (await skip.count() && await skip.isVisible().catch(()=>false)) {
    await skip.click().catch(()=>{}); await p.waitForTimeout(800); continue;
  }
  const next = p.locator('text=다음').first();
  if (await next.count() && await next.isVisible().catch(()=>false)) {
    await next.click().catch(()=>{}); await p.waitForTimeout(800); continue;
  }
  break;
}
await p.waitForTimeout(1500);
for (const t of ['로그인 없이 둘러보기 (모의투자 체험)', '로그인 없이 둘러보기']) {
  const el = p.locator(`text=${t}`).first();
  if (await el.count() && await el.isVisible().catch(()=>false)) {
    await el.click().catch(()=>{}); await p.waitForTimeout(2500); break;
  }
}
await p.waitForTimeout(1200);
const trade = p.locator('text=매매').last();
try { await trade.click({ timeout: 5000 }); } catch {}
await p.waitForTimeout(8000);

await p.screenshot({ path: `${OUT}/${process.argv[2] || 'audit'}.png` });

const report = await p.evaluate(() => {
  const vw = innerWidth, vh = innerHeight;
  const label = e => {
    const t = (e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 34) || `<${e.tagName.toLowerCase()}>`;
  };
  const path = e => {
    const out = [];
    for (let n = e; n && n !== document.body && out.length < 4; n = n.parentElement) {
      out.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''));
    }
    return out.join(' < ');
  };

  // 조상 중 overflow가 걸린 칸에 의해 **잘린** 뒤 실제로 보이는 사각형.
  // 이걸 안 하면 '스크롤해야 보이는 버튼'과 '다른 것이 덮은 버튼'이
  // 똑같이 잡힌다 — 앞은 정상, 뒤는 사고다.
  const visibleRect = el => {
    let r = el.getBoundingClientRect();
    let box = { l: r.left, t: r.top, rt: r.right, b: r.bottom };
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const p = n.getBoundingClientRect();
      box = { l: Math.max(box.l, p.left), t: Math.max(box.t, p.top),
              rt: Math.min(box.rt, p.right), b: Math.min(box.b, p.bottom) };
    }
    box = { l: Math.max(box.l, 0), t: Math.max(box.t, 0),
            rt: Math.min(box.rt, vw), b: Math.min(box.b, vh) };
    return { ...box, w: box.rt - box.l, h: box.b - box.t };
  };

  const buttons = Array.from(document.querySelectorAll('button, [role="button"], input, select'));
  const blocked = [], disabled = [], offscreen = [], clipped = [], ok = [];

  for (const el of buttons) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    // 화면 밖이면 지금 탭에 없는 것 — 검사 대상 아님
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;

    const rec = { t: label(el), x: Math.round(r.left), y: Math.round(r.top),
                  w: Math.round(r.width), h: Math.round(r.height) };

    if (el.disabled) disabled.push({ ...rec, why: el.getAttribute('title') || '' });

    // 스크롤 칸에 잘려 지금은 안 보이는 것. 스크롤하면 눌린다 — 사고가 아니다.
    const v = visibleRect(el);
    if (v.w < 8 || v.h < 8) { clipped.push({ ...rec, shown: `${Math.round(v.w)}×${Math.round(v.h)}` }); continue; }

    // **보이는 부분의** 중심에서 찍는다. 잘린 버튼의 원래 중심을 쓰면
    // 화면 밖 좌표라 엉뚱한 것이 잡힌다.
    const cx = Math.round(v.l + v.w / 2);
    const cy = Math.round(v.t + v.h / 2);
    if (cx < 0 || cx >= vw || cy < 0 || cy >= vh) { offscreen.push(rec); continue; }

    const hit = document.elementFromPoint(cx, cy);
    if (!hit) { offscreen.push(rec); continue; }
    if (el === hit || el.contains(hit)) { ok.push(rec); continue; }

    // 덮은 것이 무엇인지까지 적는다 — 원인을 알아야 고친다
    blocked.push({ ...rec, by: label(hit), byPath: path(hit),
                   byPos: getComputedStyle(hit).position });
  }

  const scrollers = Array.from(document.querySelectorAll('*'))
    .filter(e => e.scrollHeight > e.clientHeight + 4 && ['auto','scroll'].includes(getComputedStyle(e).overflowY))
    .map(e => ({ over: e.scrollHeight - e.clientHeight, h: e.clientHeight,
                 txt: (e.textContent||'').slice(0,26).replace(/\s+/g,' ') }));

  return { vw, vh, counts: { ok: ok.length, blocked: blocked.length, clipped: clipped.length,
                             disabled: disabled.length, offscreen: offscreen.length },
           blocked, clipped, disabled, offscreen, scrollers };
});

console.log(JSON.stringify(report, null, 1));
await b.close();
