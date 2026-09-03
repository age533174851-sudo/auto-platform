import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
const PORT=process.argv[2], LABEL=process.argv[3], OUT=process.argv[4];
const ONLY=process.argv[5];
const B=`http://localhost:${PORT}`;
mkdirSync(OUT,{recursive:true});
const REGIONS = readFileSync(new URL('./trading-regions.js', import.meta.url), 'utf8');

const VIEWPORTS=[['1366x768',1366,768],['1440x900',1440,900],['1664x936',1664,936],
 ['1920x1080',1920,1080],['2560x1440',2560,1440],['1024x768',1024,768],['834x1194',834,1194],
 ['430x932',430,932],['390x844',390,844],['360x800',360,800]]
 .filter(v=>!ONLY||v[0]===ONLY);

const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
/* 뷰포트를 나눠 돌려도 결과가 쌓이게 병합한다. 덮어쓰면 마지막 한
   뷰포트만 남아서 전후 비교표를 만들 수 없다. */
const OUTJSON=`${OUT}/${LABEL}.json`;
const all = existsSync(OUTJSON) ? JSON.parse(readFileSync(OUTJSON,'utf8')) : {};
let fails=0;

for(const [name,w,h] of VIEWPORTS){
  const ctx=await browser.newContext({viewport:{width:w,height:h},serviceWorkers:'block'});
  await ctx.addInitScript(()=>{localStorage.setItem('tg_onboarded_v1','1');localStorage.setItem('tg_lang','ko');});
  await ctx.addInitScript(REGIONS);
  const page=await ctx.newPage();
  await page.route('**/api/news**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,source:'mock',news:[{id:'n1',title:'예시 기사',source:'X',time:'5분 전',category:'코인',sentiment:'neutral'}]})}));
  await page.goto(B,{waitUntil:'networkidle'});
  for(let i=0;i<4;i++){const s=await page.evaluate(()=>{const b=[...document.querySelectorAll('button,div,span')].find(e=>(e.innerText||'').trim()==='건너뛰기');if(b){b.click();return true}return false;});await page.waitForTimeout(300);if(!s)break;}
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(500);
  await page.evaluate(()=>{const t=[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='매매'&&e.children.length===0);if(t)(t.closest('button,a,[role="button"]')||t.parentElement).click();});
  await page.waitForTimeout(2500);
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(e=>/둘러보기/.test(e.innerText||''));if(b)b.click();});
  await page.waitForTimeout(1500);

  const m=await page.evaluate(()=>{
    const cs=getComputedStyle;
    const R=e=>{const b=e.getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),r:Math.round(b.right),bt:Math.round(b.bottom)};};
    const vis=e=>{const s=cs(e);const b=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.05&&b.width>1&&b.height>1;};
    const ov=(a,b)=>Math.max(0,Math.min(a.r,b.r)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bt,b.bt)-Math.max(a.y,b.y));
    const inScrollX=el=>{let n=el.parentElement;while(n&&n!==document.body){const o=cs(n).overflowX;if(o==='auto'||o==='scroll')return true;n=n.parentElement;}return false;};
    const fragsOf = e => [...e.getClientRects()]
      .filter(r=>r.width>1&&r.height>1)
      .map(r=>({x:r.x,y:r.y,r:r.right,bt:r.bottom}));
    const rg=window.__findRegions();
    const out={viewport:{w:innerWidth,h:innerHeight},
      bodyOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      regionsFound:rg.ok, regionHow:rg.how, regionReason:rg.reason, kind:rg.kind,
      rects:{}, persistentOverlaps:[], orderOverlaps:0, orderSamples:[], clipping:[], escapes:0,
      headerOverlaps:0, headerSamples:[], wordBreaks:[],
      orderMode:null, marketMode:null, infoMode:null};

    for(const [k,e] of Object.entries(rg.found)) if(e&&vis(e)) out.rects[k]=R(e);

    // persistent 영역끼리 겹침 (중첩 관계 제외)
    const F=rg.found;
    const pairs=[['market','chart'],['chart','order'],['market','order'],['order','newsRail'],['chart','newsRail'],['menu','market'],['menu','chart']];
    for(const [a,b] of pairs){
      if(!out.rects[a]||!out.rects[b]) continue;
      if(F[a]&&F[b]&&(F[a].contains(F[b])||F[b].contains(F[a]))) continue;
      const area=ov(out.rects[a],out.rects[b]);
      if(area>16) out.persistentOverlaps.push({a,b,area});
    }

    // ── 주문 패널 내부 겹침 ──
    //
    // **bounding box로 재면 안 된다.** 줄바꿈된 인라인 요소는
    // getBoundingClientRect()가 모든 줄을 덮는 하나의 박스를 돌려준다.
    // 실제로는 앞 조각이 라벨 오른쪽에 나란히 있고 뒤 조각만 다음 줄로
    // 내려간 것인데, 박스끼리는 겹친 것으로 나온다.
    // 실측 예: "계좌 예상 손실"(x14~91) vs "손절 가격을…"(조각 x91~208,
    // x14~54) → 조각은 안 겹치는데 박스는 847px² 겹침으로 나왔다.
    // 그래서 **줄 조각(getClientRects)** 단위로 본다.
    if(F.order){
      const leaves=[...F.order.querySelectorAll('span,div,button,input,label,b,strong')]
        .filter(e=>vis(e)&&e.children.length===0&&((e.textContent||'').trim().length>0||e.tagName==='INPUT'));
      const frags=leaves.map(fragsOf);
      for(let i=0;i<leaves.length;i++){
        for(let j=i+1;j<leaves.length;j++){
          let area=0;
          for(const a of frags[i]) for(const b of frags[j]) area=Math.max(area,ov(a,b));
          if(area>24){out.orderOverlaps++;
            if(out.orderSamples.length<8)out.orderSamples.push({a:(leaves[i].textContent||'').trim().slice(0,20),b:(leaves[j].textContent||'').trim().slice(0,20),area:Math.round(area)});}}}
      out.orderMode=F.order.getAttribute('data-mode')||'persistent';
    }
    // ── 상단 헤더 내부 겹침 ──
    // 헤더는 한 줄 flex인데 자식 여럿이 nowrap이라, 더 줄일 수 없게 되면
    // 줄어드는 대신 겹쳐 그려진다. 주문판과 같은 방식(줄 조각)으로 본다.
    {
      const bar=rg.found.topbar;
      if(bar){
        const hl=[...bar.querySelectorAll('span,div,button,b')]
          .filter(e=>vis(e)&&e.children.length===0&&(e.textContent||'').trim().length>0);
        const hf=hl.map(fragsOf);
        for(let i=0;i<hl.length;i++) for(let j=i+1;j<hl.length;j++){
          let area=0;
          for(const a of hf[i]) for(const b of hf[j]) area=Math.max(area,ov(a,b));
          if(area>24){ out.headerOverlaps++;
            if(out.headerSamples.length<6)
              out.headerSamples.push({a:(hl[i].textContent||'').trim().slice(0,18),b:(hl[j].textContent||'').trim().slice(0,18),area:Math.round(area)}); }
        }
      } else out.headerOverlaps=-1;   // 표식 없음 = 측정 실패(통과가 아니다)
    }

    // 종목 패널
    if(F.market){
      out.marketMode=F.market.getAttribute('data-mode')||'expanded';
      if(out.marketMode!=='compact'){
        const targets=[...F.market.querySelectorAll('span,div,b')]
          .filter(e=>vis(e)&&e.children.length===0&&(e.textContent||'').trim().length>1);
        for(const el of targets){
          // ① 칸을 넘어 잘린 것
          if(el.scrollWidth>el.clientWidth+1)
            out.clipping.push({text:(el.textContent||'').trim().slice(0,22),scroll:el.scrollWidth,client:el.clientWidth});
          // ② **한국어 단어가 줄 중간에서 끊긴 것.**
          //    "종목 · 거래대금"이 "종목 · 거"/"래대금"이 되면 읽을 수 없다.
          const t=(el.textContent||'').trim();
          if(!/[가-힣]{2,}/.test(t)) continue;
          const st=getComputedStyle(el);
          if(st.wordBreak==='keep-all') continue;
          if(/…|\.\.\./.test(t)) continue;              // 말줄임은 의도된 축약

          // ── 단어 사이 줄바꿈과 단어 **중간** 끊김을 구분한다 ──
          //
          // "거래소 목록을 받지 못했습니다"가 세 줄이 되는 것은 정상이다.
          // 고장은 "거래대금"이 "거"/"래대금"으로 쪼개지는 것이고, 실측에서는
          // 라벨이 폭 10px에 높이 105px가 되어 글자가 세로로 쌓이기까지 했다.
          //
          // 그래서 **가장 긴 낱말이 칸에 들어가는가**를 잰다. 안 들어가면
          // 그 낱말은 반드시 중간에서 끊긴다. 낱말 폭은 Range로 실제 측정한다.
          // **Range로 재면 안 된다.** 이미 끊긴 단어는 좁게 접힌 상자를
          // 돌려주므로(실측 10px) "칸에 들어간다"로 나온다. 글꼴로 계산한
          // **고유 폭**을 써야 끊기기 전 크기를 알 수 있다.
          const words=t.split(/\s+/).filter(w=>w.length>1&&/[가-힣]/.test(w));
          if(!words.length) continue;
          if(!window.__mt){ const cv=document.createElement('canvas'); window.__mt=cv.getContext('2d'); }
          window.__mt.font=`${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
          let widest=0, widestWord='';
          for(const w of words){
            const ww=window.__mt.measureText(w).width;
            if(ww>widest){ widest=ww; widestWord=w; }
          }
          const avail=el.clientWidth||el.getBoundingClientRect().width;
          if(widest>0 && avail>0 && widest>avail+1)
            out.wordBreaks.push({text:t.slice(0,22),word:widestWord,wordW:Math.round(widest),avail:Math.round(avail)});
        }
      }
    }
    if(F.newsRail) out.infoMode = document.querySelector('.aw')?.getAttribute('data-right') || 'rail';
    if(rg.kind!=='desktop'){ out.orderMode='sheet'; out.marketMode='drawer'; }

    for(const el of document.querySelectorAll('button,a[href],input,[role="button"]')){
      if(!vis(el))continue;const b=el.getBoundingClientRect();
      if(b.width<1||b.height<1)continue;
      if((b.left<-1||b.right>innerWidth+1)&&!inScrollX(el))out.escapes++;
    }
    return out;
  });

  m.name=name; all[name]=m;
  await page.screenshot({path:`${OUT}/${LABEL}-${name}.png`,fullPage:false});
  await ctx.close();
  // 계약은 배치마다 다르다.
  const desktop = m.kind === 'desktop';
  const widthFail = desktop && ((m.rects.order?.w ?? 0) < 340 || (m.rects.chart?.w ?? 0) < 560);
  const bad = m.bodyOverflow>0||m.persistentOverlaps.length>0||m.orderOverlaps>0
            ||m.clipping.length>0||m.escapes>0||!m.regionsFound||widthFail
            ||m.headerOverlaps!==0||m.wordBreaks.length>0;
  if(bad) fails++;
  console.log(`${bad?'✗':'✓'} ${name.padEnd(10)} ${(m.kind||'?').padEnd(7)} found=${m.regionsFound?'Y':'N('+m.regionReason+')'} overflow=${m.bodyOverflow} pOverlap=${m.persistentOverlaps.length} ordOverlap=${m.orderOverlaps} clip=${m.clipping.length} hdr=${m.headerOverlaps} wbrk=${m.wordBreaks.length} esc=${m.escapes} | chart=${m.rects.chart?.w??'-'} order=${m.rects.order?.w??'-'}(${m.orderMode??'-'}) market=${m.rects.market?.w??'-'}(${m.marketMode??'-'})`);
}
writeFileSync(OUTJSON,JSON.stringify(all,null,1));
console.log(`\n${LABEL}: ${VIEWPORTS.length-fails}/${VIEWPORTS.length} PASS`);
await browser.close();
