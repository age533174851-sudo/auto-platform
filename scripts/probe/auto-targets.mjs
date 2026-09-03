// 자동매매 화면에서 손으로 누르는 자리가 손가락만 한가.
//
// 검사기 두 번 고쳤다 — 둘 다 거짓 양성이었다.
//   · 시세 띠(.ticker)를 "칸 밖으로 3,600px 넘침"으로 잡았다. 마퀴
//     트랙이고 부모가 정확히 잘라 준다. 그것을 "고쳤다면" 멀쩡한 띠를
//     망가뜨렸을 것이다.
//   · 폭 조절 손잡이(7px)를 작은 조작 대상으로 잡았다. 손가락으로 누르는
//     대상이 아니고 터치 기기에서는 CSS가 숨긴다. UI-1에서 키보드 경로를
//     따로 붙여 뒀다.
//
// 사용법: node scripts/probe/auto-targets.mjs <port> <out-dir> [WxH]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const B='http://localhost:'+process.argv[2], OUT=process.argv[3];
const VPS = process.argv[4] ? [process.argv[4].split('x').map(Number)] :
  [[1664,936],[1366,768],[390,844]];
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
for(const [w,h] of VPS){
  const ctx=await br.newContext({viewport:{width:w,height:h},serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('tg_onboarded_v1','1');localStorage.setItem('tg_lang','ko');});
  const page=await ctx.newPage();
  await page.goto(B,{waitUntil:'networkidle'});
  for(let i=0;i<4;i++){const s=await page.evaluate(()=>{const b=[...document.querySelectorAll('button,div,span')].find(e=>(e.innerText||'').trim()==='건너뛰기');if(b){b.click();return true}return false;});await page.waitForTimeout(300);if(!s)break;}
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(400);
  await page.evaluate(()=>{const t=[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='자동'&&e.children.length===0);if(t)(t.closest('button,a,[role="button"]')||t.parentElement).click();});
  await page.waitForTimeout(3000);
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(1200);
  const m = await page.evaluate(()=>{
    const cs=getComputedStyle;
    const vis=e=>{const s=cs(e);const b=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.05&&b.width>1&&b.height>1;};
    const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.textContent||'').trim()&&vis(e));
    // 잘림: 스크롤 컨테이너가 아닌데 내용이 칸을 넘음
    // 잘림 판정 — 이 검사기의 첫 판은 마퀴(ticker)를 결함으로 잡았다.
    // 마퀴 트랙은 부모보다 넓은 것이 정상이고 부모가 잘라 준다. 그것을
    // "고쳤다면" 멀쩡한 시세 띠를 망가뜨렸을 것이다. 그래서 세 가지를 뺀다:
    //   · 스스로 스크롤 되는 칸 (사용자가 볼 수 있다)
    //   · 조상이 스크롤 되는 칸 (사용자가 볼 수 있다)
    //   · 내용이 스스로 움직이는 칸 (마퀴 — 시간이 지나면 다 보인다)
    const scrolls=e=>{const s=cs(e);return s.overflowX==='auto'||s.overflowX==='scroll';};
    const moving=e=>{
      if(cs(e).animationName!=='none') return true;
      for(const c of e.children) if(cs(c).animationName!=='none') return true;
      return false;
    };
    const clip=[];
    for(const e of [...document.querySelectorAll('*')].filter(vis)){
      if(scrolls(e)||moving(e)) continue;
      if(!(e.scrollWidth-e.clientWidth>2 && e.clientWidth>0)) continue;
      let n=e.parentElement, ok=true;
      while(n&&n!==document.body){ if(scrolls(n)){ok=false;break;} n=n.parentElement; }
      if(!ok) continue;
      clip.push({t:(e.textContent||'').trim().slice(0,40), over:e.scrollWidth-e.clientWidth, cls:e.className?.toString?.().slice(0,40)});
    }
    // 작은 터치 타깃
    // 폭 조절 손잡이는 뺀다. 손가락으로 누르는 대상이 아니고(터치
    // 기기에서는 CSS가 아예 숨긴다) UI-1에서 키보드 경로를 따로 붙였다.
    // 이것까지 40px로 만들면 얇은 경계선이 두꺼운 띠가 된다.
    const small=[...document.querySelectorAll('button,[role="button"],a')].filter(vis)
      .filter(e=>e.getAttribute('role')!=='separator').map(e=>{const b=e.getBoundingClientRect();return {t:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,24), w:Math.round(b.width), h:Math.round(b.height)};}).filter(x=>x.h<40||x.w<40);
    // 한 글자씩 세로로 쌓인 한글
    const stacked=leaves.filter(e=>{const b=e.getBoundingClientRect();const t=(e.textContent||'').trim();return t.length>=3&&/[가-힣]/.test(t)&&b.width<26&&b.height>b.width*2;}).map(e=>(e.textContent||'').trim().slice(0,20));
    return {
      bodyOverflow: document.documentElement.scrollWidth-document.documentElement.clientWidth,
      clip: clip.slice(0,12), clipCount: clip.length,
      small: small.slice(0,12), smallCount: small.length,
      stacked: stacked.slice(0,8),
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(e=>e.textContent.trim().slice(0,30)).slice(0,15),
    };
  });
  console.log(`\n=== ${w}x${h} ===`);
  console.log(JSON.stringify(m,null,1));
  await page.screenshot({path:`${OUT}/auto-${w}x${h}.png`, fullPage:false});
  await ctx.close();
}
await br.close();
