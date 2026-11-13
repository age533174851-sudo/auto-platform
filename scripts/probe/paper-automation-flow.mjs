// Browser -> real Next routes -> supabase-js -> official PostgREST -> local PG.
// Auth and public quotes are fixtures. No venue orders or production DB access.
// Requires TEN_SLOT_PG_URL (loopback only), TEN_SLOT_PSQL, PAPER_AUTO_POSTGREST_BIN.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer,request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac,randomBytes } from 'node:crypto';
import { mkdtempSync,writeFileSync,readFileSync,readdirSync,mkdirSync,existsSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { pgTarget,createScratchDb,dropScratchDb,psql } from '../ten-slot-pg.mjs';
import { probeSession } from './lib/auth.mjs';

const { chromium }=createRequire(import.meta.url)('playwright');
const target=pgTarget();
assert.ok(target.ok,target.reason);
assert.ok(process.env.PAPER_AUTO_POSTGREST_BIN,'PAPER_AUTO_POSTGREST_BIN required');
const root=resolve(import.meta.dirname,'../..');
const tmp=mkdtempSync(join(tmpdir(),'paper-auto-flow-'));
const out=process.env.PROBE_OUT || '/tmp/paper-automation-flow';mkdirSync(out,{recursive:true});
const names=readdirSync(join(root,'supabase/migrations'));
const ids=[10,25,33,71,72,74,75,81,82,83,84,85,86,87,88,99];
const db=createScratchDb(target,'paper_flow',ids.map(id=>join(root,'supabase/migrations',names.find(n=>n.startsWith(String(id).padStart(3,'0')+'_')))));
const q=sql=>psql(target,db,sql);
const session=probeSession(),uid=session.user.id;
q(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
   INSERT INTO paper_accounts(user_id,is_default,balance,initial_balance,started_at) VALUES('${uid}',true,10000,10000,now())`);
const freePort=()=>new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const [restPort,gatewayPort,webPort]=await Promise.all([freePort(),freePort(),freePort()]);
const key=randomBytes(32).toString('hex');
const base64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const data=base64({alg:'HS256',typ:'JWT'})+'.'+base64({role:'service_role',exp:Math.floor(Date.now()/1000)+3600});
const serviceToken=data+'.'+createHmac('sha256',key).update(data).digest('base64url');
const dbUrl=new URL(target.url);dbUrl.pathname='/'+db;
writeFileSync(join(tmp,'postgrest.conf'),`db-uri = "${dbUrl}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${key}"
server-host = "127.0.0.1"
server-port = ${restPort}
`);
// Preload changes only this offline child process. Unexpected network is denied.
const quoteFile=join(tmp,'quotes.json');
let offset=0;
const quote=(mark=3000,trend='up')=>{offset+=46000;writeFileSync(quoteFile+'.next',JSON.stringify({mark,trend,offset}));renameSync(quoteFile+'.next',quoteFile);};quote();
const preload=join(tmp,'fixture.cjs');
writeFileSync(preload,`const fs=require('node:fs');const original=globalThis.fetch;const now=Date.now;
Date.now=()=>now()+JSON.parse(fs.readFileSync(process.env.PAPER_FLOW_QUOTES,'utf8')).offset;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url||String(input));
if(u.hostname.endsWith('binance.com')){if((init?.method||'GET')!=='GET')throw Error('VENUE WRITE FORBIDDEN');
const q=JSON.parse(fs.readFileSync(process.env.PAPER_FLOW_QUOTES,'utf8'));
if(u.pathname.endsWith('/premiumIndex'))return q.mark===null?Response.json({error:'offline price unavailable'},{status:503}):Response.json({symbol:'BTCUSDT',markPrice:String(q.mark),time:Date.now()});
if(u.pathname.endsWith('/klines'))return Response.json(Array.from({length:120},(_,i)=>[i*86400000,'1','1','1',String(q.trend==='up'?100+i:q.trend==='down'?220-i:100),'10']));
throw Error('Unexpected venue read '+u.pathname);}
if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('External network forbidden '+u.hostname);
return original(input,init);};`);
const restLog=await import('node:fs').then(fs=>fs.openSync(join(tmp,'postgrest.log'),'w'));
const webLog=await import('node:fs').then(fs=>fs.openSync(join(tmp,'next.log'),'w'));
const rest=spawn(process.env.PAPER_AUTO_POSTGREST_BIN,[join(tmp,'postgrest.conf')],{stdio:['ignore',restLog,restLog]});
const gateway=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
  if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
  if(req.url.startsWith('/auth/v1/user')) {
    res.setHeader('Content-Type','application/json');
    if(req.headers.authorization!==`Bearer ${session.access_token}`){res.statusCode=401;res.end(JSON.stringify({error:'fixture token rejected'}));}
    else res.end(JSON.stringify(session.user));return;
  }
  if(!req.url.startsWith('/rest/v1/')){res.statusCode=404;res.end('{}');return;}
  const proxy=httpRequest({hostname:'127.0.0.1',port:restPort,path:req.url.slice('/rest/v1'.length),method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
  proxy.on('error',()=>{res.statusCode=502;res.end('{}');});req.pipe(proxy);
});
await new Promise(r=>gateway.listen(gatewayPort,'127.0.0.1',r));
const admin='offline-paper-admin-'+randomBytes(12).toString('hex');
const launchWeb=()=>spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(webPort)],{
  cwd:root,env:{...process.env,NODE_OPTIONS:`--require=${preload}`,PAPER_FLOW_QUOTES:quoteFile,
    NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${gatewayPort}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'offline-public-key',
    SUPABASE_SERVICE_ROLE_KEY:serviceToken,ADMIN_SECRET:admin},stdio:['ignore',webLog,webLog]});
let web=launchWeb();
const origin=`http://127.0.0.1:${webPort}`;
let browser;
const call=async(path,body,headers={Authorization:`Bearer ${session.access_token}`})=>{
  const res=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:await res.json()};
};
const wake=()=>call('/api/paper/exit-monitor',{}, {'x-admin-secret':admin});
const due=()=>q(`UPDATE paper_automation_settings SET next_run_at=now()-interval '1 second' WHERE user_id='${uid}'`);
async function ready() {
  for(let i=0;i<120;i++) {
    try { if((await fetch(origin+'/api/paper/automation')).status===401)return; }catch{}
    if(i===119)throw Error('Next server unavailable: '+readFileSync(join(tmp,'next.log'),'utf8').slice(-3000));
    await new Promise(r=>setTimeout(r,500));
  }
}
try {
  await ready();
  assert.equal((await call('/api/paper/automation',undefined,{})).status,401);
  assert.equal((await call('/api/paper/automation',{action:'start',symbol:'BTCUSDT',interval:1})).status,400);
  assert.equal((await call('/api/paper/automation',{action:'start',symbol:'BTCUSDT',interval:60,userId:'attacker',mode:'LIVE'})).status,200);
  assert.equal(q('SELECT count(*) FROM paper_positions')[0],'0','Start only persists settings');
  assert.equal((await call('/api/paper/automation',{action:'stop'})).status,200);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),args:['--no-sandbox']});
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await ctx.addInitScript(({session})=>{
    localStorage.setItem('tg_ob',JSON.stringify('1'));localStorage.setItem('tg_seen_login_v1','1');
    localStorage.setItem('sb-127-auth-token',JSON.stringify(session));
    const Real=window.WebSocket;
    window.WebSocket=class extends EventTarget {
      static OPEN=1;static CLOSED=3;readyState=3;
      constructor(url){super();if(!/binance/.test(String(url)))return new Real(url);}
      close(){}send(){}
    };
  },{session});
  const page=await ctx.newPage();
  page.on('pageerror',e=>console.log('Browser error:',e.message));
  // Let only the NEW real endpoint through. Unrelated dashboard integrations are fixtures.
  const dashboardRoute=async route=>{
    const u=new URL(route.request().url());
    if(u.origin===origin && (u.pathname==='/api/paper/automation' || !u.pathname.startsWith('/api/')))return route.continue();
    if(u.origin===`http://127.0.0.1:${gatewayPort}` && u.pathname==='/auth/v1/user')return route.continue();
    if(u.origin!==origin)return route.fulfill({status:200,contentType:'application/json',body:'[]'});
    const payload=u.pathname==='/api/paper/challenge'?{ok:true,challenges:[]}:u.pathname==='/api/paper/account'?{ok:true,started:true,account:{balance:10000},positions:[]}:u.pathname==='/api/prices'?{results:[]}:{ok:true,account:{balance:10000,available:10000},openPositions:[],data:[],news:[],connections:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});
  };
  await page.route('**/*',dashboardRoute);
  await page.goto(origin+'/?tab=paper',{waitUntil:'domcontentloaded',timeout:120000});
  const panel=page.getByTestId('paper-automation');
  try { await panel.getByRole('button',{name:'서버 반복 시작',exact:true}).waitFor({timeout:45000}); }
  catch(e) { await page.screenshot({path:join(out,'failure.png'),fullPage:true});console.log((await page.locator('body').innerText()).slice(0,4500));throw e; }
  await panel.getByRole('button',{name:'서버 반복 시작',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="paper-automation-status"]')?.textContent==='반복 실행 요청 켜짐');
  await page.screenshot({path:join(out,'started.png'),fullPage:true});
  const storageState=await ctx.storageState();
  await ctx.close(); // Critical: no browser survives to send a cycle request.
  const tick=await wake();assert.equal(tick.status,200,JSON.stringify(tick));
  assert.equal(tick.body.automation?.code,'ENTERED',JSON.stringify(tick));
  assert.equal(q("SELECT count(*) FROM paper_positions WHERE status='open'")[0],'1');
  const snapshot=JSON.parse(q("SELECT json_build_object('balance',balance,'fees',total_fees) FROM paper_accounts")[0]);
  assert.ok(snapshot.fees>0);assert.ok(snapshot.balance<10000);
  // Restart the actual Next server process. Settings, history and capacity survive.
  web.kill('SIGTERM');await new Promise(r=>web.exitCode!==null?r():web.once('exit',r));
  web=launchWeb();await ready();
  assert.equal((await call('/api/paper/automation')).body.settings.enabled,true);
  // Repeat after browser closure: capacity produces a persisted WAIT, never another fill.
  due();assert.equal((await wake()).body.automation.code,'WAIT');
  assert.equal(q('SELECT count(*) FROM paper_positions')[0],'1');
  assert.equal(q('SELECT count(*) FROM paper_automation_runs')[0],'2');
  // User Stop persists, but existing protective exits remain active.
  assert.equal((await call('/api/paper/automation',{action:'stop'})).status,200);
  quote(2800);const stoppedExit=await wake();assert.equal(stoppedExit.body.closed,1,JSON.stringify(stoppedExit));
  assert.equal(q("SELECT count(*) FROM paper_positions WHERE status='closed' AND exit_reason='SL'")[0],'1');
  assert.equal(q('SELECT count(*) FROM paper_automation_runs')[0],'2');
  const status=await call('/api/paper/automation');
  assert.equal(status.body.settings.enabled,false);assert.ok(status.body.positions[0].realized_pnl<0);
  assert.ok(status.body.runs[0].result.message);assert.ok(status.body.account.balance<snapshot.balance);
  // Missing quotes persist UNKNOWN_PRICE without writing a position.
  quote(null);await call('/api/paper/automation',{action:'start',symbol:'BTCUSDT',interval:60});
  const noPrice=await wake();assert.equal(noPrice.body.automation.code,'UNKNOWN_PRICE',JSON.stringify(noPrice));
  assert.equal(q('SELECT count(*) FROM paper_positions')[0],'1');
  await call('/api/paper/automation',{action:'stop'});
  const exits=[];
  for(const reason of ['TP','MAX_HOLD','LIQUIDATION']) {
    quote(3000);await call('/api/paper/automation',{action:'start',symbol:'BTCUSDT',interval:60});
    const entry=await wake();assert.equal(entry.body.automation.code,'ENTERED',JSON.stringify(entry));
    const pos=JSON.parse(q("SELECT row_to_json(p) FROM paper_positions p WHERE status='open'")[0]);
    if(reason==='MAX_HOLD') {
      q(`UPDATE paper_positions SET opened_at=now()-interval '73 hours' WHERE id='${pos.id}'`);
      quote(3000,'flat');due();
    } else {
      await call('/api/paper/automation',{action:'stop'});
      quote(reason==='TP'?3200:2300);
    }
    await wake();
    const closed=JSON.parse(q(`SELECT row_to_json(p) FROM paper_positions p WHERE id='${pos.id}'`)[0]);
    assert.equal(closed.status,'closed');assert.equal(closed.exit_reason,reason);
    assert.ok(Number.isFinite(Number(closed.realized_pnl)));
    await call('/api/paper/automation',{action:'stop'});exits.push({reason,positionId:closed.id,realizedPnl:closed.realized_pnl});
  }
  // Re-open the actual screen to verify history, balances and reasons after reconnect.
  const resumed=await browser.newContext({viewport:{width:390,height:844},storageState});
  const after=await resumed.newPage();
  await after.route('**/*',dashboardRoute);
  await after.goto(origin+'/?tab=paper',{waitUntil:'domcontentloaded',timeout:120000});
  await after.waitForFunction(()=>document.querySelector('[data-testid="paper-automation-status"]')?.textContent==='반복 실행 정지');
  assert.ok((await after.getByRole('list',{name:'자동 모의 체결 이력'}).innerText()).includes('LIQUIDATION'));
  assert.ok((await after.getByTestId('paper-automation').innerText()).includes('실현 손익'));
  await after.screenshot({path:join(out,'settled-history.png'),fullPage:true});
  await resumed.close();
  writeFileSync(join(out,'evidence.json'),JSON.stringify({localPostgres:true,officialPostgrest:true,fixtureAuth:true,fixtureQuotes:true,browserClosedBeforeTicks:true,serverProcessRestarted:true,firstTick:tick.body,finalStatus:status.body,missingQuotes:noPrice.body,exits},null,2));
  console.log('PASS browser start -> real API/PostgREST/PG -> browser closed -> server restarted -> repeated cycles -> virtual fill/fee -> stop -> protective SL/TP/LIQUIDATION; MAX_HOLD; history; stale quotes blocked');
} catch(e) {
  console.log('Offline position diagnostics:',q('SELECT row_to_json(p) FROM paper_positions p'));
  throw e;
} finally {
  await browser?.close();web.kill('SIGTERM');rest.kill('SIGTERM');gateway.closeAllConnections();gateway.close();
  await Promise.all([new Promise(r=>web.exitCode!==null?r():web.once('exit',r)),new Promise(r=>rest.exitCode!==null?r():rest.once('exit',r))]);
  dropScratchDb(target,db);console.log('Offline logs:',tmp);
}
