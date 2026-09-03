// 기하 검사기가 **자기가 잡아야 할 고장을 실제로 잡는가.**
// 소스를 고쳐 다시 빌드하는 대신 렌더된 화면을 런타임에 망가뜨린다 —
// 검증 대상은 소스가 아니라 검사기이므로 이쪽이 정확하고 빠르다.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const B='http://localhost:'+process.argv[2];
const REGIONS=readFileSync(new URL('./trading-regions.js',import.meta.url),'utf8');
const MEASURE=readFileSync(new URL('./trading-measure.js',import.meta.url),'utf8');

const MUTS = [
  ['A. 주문판을 340px 아래로', () => {
    const o=document.querySelector('[data-region="order"]'); o.style.width='300px'; o.style.flexShrink='1';
  }],
  ['B. 중앙을 560px 아래로', () => {
    const c=document.querySelector('[data-region="chart"]'); c.style.width='420px';
  }],
  ['C. 주문판 한 줄을 겹치게', () => {
    // 두 번째 글자 조각을 첫 번째 위에 **정확히** 포갠다.
    // 좌표를 임의로 주면 아무것도 없는 자리에 놓여 겹치지 않을 수 있다.
    const o=document.querySelector('[data-region="order"]');
    const leaves=[...o.querySelectorAll('span,b,div')].filter(e=>{
      const r=e.getBoundingClientRect();
      return e.children.length===0 && (e.textContent||'').trim().length>2 && r.width>30 && r.height>6;
    });
    const a=leaves[0], b=leaves.find(e=>e!==a && e.getBoundingClientRect().top!==a.getBoundingClientRect().top);
    const ra=a.getBoundingClientRect();
    b.style.position='fixed';
    b.style.left=ra.left+'px'; b.style.top=ra.top+'px';
    b.style.width=ra.width+'px'; b.style.height=ra.height+'px';
    b.style.zIndex='99'; b.style.background='red';
  }],
  ['D. body에 가로 넘침', () => {
    const d=document.createElement('div');
    d.style.cssText='position:absolute;left:0;top:0;width:calc(100vw + 300px);height:4px;';
    document.body.appendChild(d);
  }],
  ['E. 종목 핵심 정보가 칸 밖으로', () => {
    const m=document.querySelector('[data-region="market"]');
    const el=[...m.querySelectorAll('span,div')].find(e=>e.children.length===0&&/[가-힣]{2,}/.test(e.textContent||''));
    el.style.display='block'; el.style.width='8px'; el.style.overflow='visible';
  }],
  ['F. 정상 (변형 없음)', () => {}],
];

const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
let allOk=true;
for(const [name,mut] of MUTS){
  const ctx=await browser.newContext({viewport:{width:1664,height:936},serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('tg_onboarded_v1','1');localStorage.setItem('tg_lang','ko');});
  await ctx.addInitScript(REGIONS);
  const page=await ctx.newPage();
  await page.route('**/api/news**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,source:'mock',news:[]})}));
  await page.goto(B,{waitUntil:'networkidle'});
  for(let i=0;i<4;i++){const s=await page.evaluate(()=>{const b=[...document.querySelectorAll('button,div,span')].find(e=>(e.innerText||'').trim()==='건너뛰기');if(b){b.click();return true}return false;});await page.waitForTimeout(300);if(!s)break;}
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(400);
  await page.evaluate(()=>{const t=[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='매매'&&e.children.length===0);if(t)(t.closest('button,a,[role="button"]')||t.parentElement).click();});
  await page.waitForTimeout(2600);
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(1200);
  await page.evaluate(mut);
  await page.waitForTimeout(400);
  const m=await page.evaluate(new Function('return '+MEASURE)());
  const desktop=m.kind==='desktop';
  const widthFail=desktop&&((m.rects.order?.w??0)<340||(m.rects.chart?.w??0)<560);
  const fail = m.bodyOverflow>0||m.persistentOverlaps.length>0||m.orderOverlaps>0
             ||m.clipping.length>0||m.escapes>0||!m.regionsFound||widthFail
             ||m.headerOverlaps!==0||m.wordBreaks.length>0;
  const want = !name.startsWith('F.');
  const ok = fail===want;
  if(!ok) allOk=false;
  console.log(`${ok?'✅':'🚨'} ${name.padEnd(26)} 기대=${want?'FAIL':'PASS'} 실제=${fail?'FAIL':'PASS'}` +
    (fail?`  [overflow=${m.bodyOverflow} ord=${m.orderOverlaps} clip=${m.clipping.length} wbrk=${m.wordBreaks.length} hdr=${m.headerOverlaps} order=${m.rects.order?.w} chart=${m.rects.chart?.w}]`:''));
  await ctx.close();
}
await browser.close();
console.log(allOk?'\n돌연변이 전부 기대대로':'\n🚨 검사기가 놓친 것이 있다');
process.exit(allOk?0:1);
