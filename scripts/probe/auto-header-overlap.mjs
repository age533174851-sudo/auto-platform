import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const B='http://localhost:'+process.argv[2];
// 자동매매 화면 상단에서 조작 요소가 서로 겹치는가.
//
// 떠 있는 알림 벨(NotifyHost)은 화면 위에 있어서 **자기 자리를 스스로
// 비워 두지 못한다.** 오른쪽 레일이 사라지는 1024px 미만에서 헤더의
// 로그인·프로필 버튼을 1376px² 덮고 있었다.
//
// 사용법: node scripts/probe/auto-header-overlap.mjs <port>
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
for(const [w,h] of [[430,932],[390,844],[360,800],[834,1194],[1024,768],[1366,768],[1664,936]]){
  const ctx=await br.newContext({viewport:{width:w,height:h},serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('tg_onboarded_v1','1');localStorage.setItem('tg_lang','ko');});
  const page=await ctx.newPage();
  await page.goto(B,{waitUntil:'networkidle'});
  for(let i=0;i<4;i++){const s=await page.evaluate(()=>{const b=[...document.querySelectorAll('button,div,span')].find(e=>(e.innerText||'').trim()==='건너뛰기');if(b){b.click();return true}return false;});await page.waitForTimeout(300);if(!s)break;}
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(400);
  await page.evaluate(()=>{const t=[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='자동'&&e.children.length===0);if(t)(t.closest('button,a,[role="button"]')||t.parentElement).click();});
  await page.waitForTimeout(2500);
  const r = await page.evaluate(()=>{
    const cs=getComputedStyle;
    const vis=e=>{const s=cs(e);const b=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.05&&b.width>1&&b.height>1;};
    // 상단 60px 안의 대화형 요소들
    const top=[...document.querySelectorAll('button,[role="button"],a,select')].filter(vis).filter(e=>{const b=e.getBoundingClientRect();return b.top<60&&b.bottom>0;})
      .map(e=>{const b=e.getBoundingClientRect();return {t:(e.innerText||e.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,20), x:Math.round(b.x),r:Math.round(b.right),y:Math.round(b.y),bt:Math.round(b.bottom),w:Math.round(b.width),h:Math.round(b.height)};});
    const ov=[];
    for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
      const a=top[i],b=top[j];
      const x=Math.max(0,Math.min(a.r,b.r)-Math.max(a.x,b.x)), y=Math.max(0,Math.min(a.bt,b.bt)-Math.max(a.y,b.y));
      if(x>1&&y>1) ov.push({a:a.t||'(무명)',b:b.t||'(무명)',area:x*y, ax:[a.x,a.r], bx:[b.x,b.r]});
    }
    // ticker 실제 상태
    const tk=document.querySelector('.ticker');
    const tkInfo = tk? {overflowX:cs(tk).overflowX, anim:cs(tk).animationName, childAnim: tk.firstElementChild?cs(tk.firstElementChild).animationName:null} : null;
    return {top, ov, tkInfo};
  });
  console.log(`\n=== ${w}x${h} ===`);
  console.log('상단 요소:', JSON.stringify(r.top));
  console.log('겹침:', JSON.stringify(r.ov));
  console.log('ticker:', JSON.stringify(r.tkInfo));
  await ctx.close();
}
await br.close();
