// Browser -> real owner API -> supabase-js -> PostgREST -> local PG.
// Authentication and signed venue GET responses are offline fixtures.
// No external network, order/cancel calls, or production credentials permitted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer,request as proxyRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {createCipheriv,createHmac,randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,openSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pgTarget,createScratchDb,dropScratchDb,psql,psqlFile} from '../ten-slot-pg.mjs';
import {probeSession} from './lib/auth.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=resolve(import.meta.dirname,'../..'),target=pgTarget();
assert.ok(target.ok,target.reason);assert.ok(process.env.PAPER_AUTO_POSTGREST_BIN);
const tmp=mkdtempSync(join(tmpdir(),'smoke-exposure-flow-'));
const out=process.env.PROBE_OUT||'/tmp/smoke-exposure-flow';mkdirSync(out,{recursive:true});
const db=createScratchDb(target,'smoke_flow',[join(root,'supabase/migrations/052_smoke_tests.sql')]);
const q=sql=>psql(target,db,sql);
const session=probeSession(),uid=session.user.id;
const cid='cc000000-0000-4000-8000-000000000001',id='cc000000-0000-4000-8000-000000000002';
const encryption=randomBytes(32).toString('hex');
const cryptoKey=createHmac('sha256','traigo-key-derivation').update(encryption).digest();
const iv=randomBytes(16),cipher=createCipheriv('aes-256-gcm',cryptoKey,iv);
const encrypted=Buffer.concat([cipher.update('offline-venue-secret'),cipher.final()]);
const enc=[iv,cipher.getAuthTag(),encrypted].map(x=>x.toString('hex')).join(':');
q(`CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${uid}')`);
psqlFile(target,db,join(root,'supabase/migrations/004_exchange_connections.sql'));
psqlFile(target,db,join(root,'supabase/migrations/063_exchange_connections_drift.sql'));
q(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO exchange_connections(id,user_id,exchange_id,api_key,api_secret_enc,is_testnet) VALUES('${cid}','${uid}','binance','offline-venue-key','${enc}',true);
INSERT INTO smoke_tests(id,user_id,connection_id,symbol,side,margin_usd,leverage,state,verdict,steps)
VALUES('${id}','${uid}','${cid}','BTCUSDT','LONG',20,10,'UNKNOWN','UNKNOWN','{"ENTRY":{"state":"FAIL"},"POSITION_ZERO":{"state":"PASS"}}')`);
const freePort=()=>new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const [restPort,gatewayPort,webPort]=await Promise.all([freePort(),freePort(),freePort()]);
const secret=randomBytes(32).toString('hex'),b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const claims=b64({alg:'HS256',typ:'JWT'})+'.'+b64({role:'service_role',exp:Math.floor(Date.now()/1000)+3600});
const token=claims+'.'+createHmac('sha256',secret).update(claims).digest('base64url');
const dbUrl=new URL(target.url);dbUrl.pathname='/'+db;
writeFileSync(join(tmp,'postgrest.conf'),`db-uri = "${dbUrl}"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${secret}"\nserver-host = "127.0.0.1"\nserver-port = ${restPort}\n`);
const clock=join(tmp,'clock'),venueCalls=join(tmp,'venue-calls');writeFileSync(clock,'0');writeFileSync(venueCalls,'');
const preload=join(tmp,'fixture.cjs');
writeFileSync(preload,`const fs=require('node:fs'),original=fetch,now=Date.now;
Date.now=()=>now()+Number(fs.readFileSync(process.env.SMOKE_FLOW_CLOCK,'utf8'));
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url||String(input));
if(u.hostname.endsWith('binance.com')){
if(u.hostname!=='demo-fapi.binance.com'||(init?.method||'GET')!=='GET')throw Error('VENUE WRITE/OTHER ENV FORBIDDEN');
fs.appendFileSync(process.env.SMOKE_FLOW_CALLS,JSON.stringify({method:'GET',path:u.pathname})+'\\n');
if(['/fapi/v2/positionRisk','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'].includes(u.pathname))return Response.json([]);
if(u.pathname.endsWith('/time'))return Response.json({serverTime:Date.now()});throw Error('Unexpected venue read '+u.pathname);}
if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('External network forbidden '+u.hostname);
return original(input,init);};`);
const rest=spawn(process.env.PAPER_AUTO_POSTGREST_BIN,[join(tmp,'postgrest.conf')],{stdio:['ignore',openSync(join(tmp,'rest.log'),'w'),openSync(join(tmp,'rest.err'),'w')]});
const gateway=createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');res.setHeader('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
 if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
 if(req.url.startsWith('/auth/v1/user')){res.setHeader('Content-Type','application/json');if(req.headers.authorization!==`Bearer ${session.access_token}`){res.statusCode=401;res.end('{}');}else res.end(JSON.stringify(session.user));return;}
 if(!req.url.startsWith('/rest/v1/')){res.statusCode=404;res.end('{}');return;}
 const upstream=proxyRequest({hostname:'127.0.0.1',port:restPort,path:req.url.slice('/rest/v1'.length),method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});upstream.on('error',()=>{res.statusCode=502;res.end('{}');});req.pipe(upstream);
});
await new Promise(r=>gateway.listen(gatewayPort,'127.0.0.1',r));
const web=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(webPort)],{cwd:root,env:{...process.env,NODE_OPTIONS:`--require=${preload}`,SMOKE_FLOW_CLOCK:clock,SMOKE_FLOW_CALLS:venueCalls,EXCHANGE_ENCRYPTION_KEY:encryption,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${gatewayPort}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'offline-public-key',SUPABASE_SERVICE_ROLE_KEY:token},stdio:['ignore',openSync(join(tmp,'next.log'),'w'),openSync(join(tmp,'next.err'),'w')]});
const origin=`http://127.0.0.1:${webPort}`;let browser;
try {
 for(let i=0;i<180;i++){try{if((await fetch(origin+'/api/autotrade/smoke-test/attest-exposure')).status===401)break;}catch{}if(i===179)throw Error('Next not ready');await new Promise(r=>setTimeout(r,500));}
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),args:['--no-sandbox']});
 const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
 await ctx.addInitScript(({session})=>{localStorage.setItem('tg_ob',JSON.stringify('1'));localStorage.setItem('tg_seen_login_v1','1');localStorage.setItem('sb-127-auth-token',JSON.stringify(session));const Real=window.WebSocket;window.WebSocket=class extends EventTarget{static OPEN=1;static CLOSED=3;readyState=3;constructor(url){super();if(['127.0.0.1','localhost'].includes(new URL(String(url),location.href).hostname))return new Real(url);}close(){}send(){}};},{session});
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===origin&&(u.pathname==='/api/autotrade/smoke-test/attest-exposure'||!u.pathname.startsWith('/api/')))return route.continue();
  if(u.origin===`http://127.0.0.1:${gatewayPort}`&&u.pathname==='/auth/v1/user')return route.continue();
  assert.equal(req.method(),'GET','unrelated browser mutation forbidden');
  const body=u.pathname==='/api/autotrade/schedule'?{ok:true,schedules:[],connections:[{id:cid,exchange_id:'binance',is_testnet:true,is_active:true,label:'Offline Demo'}]}:{ok:true,data:[],news:[],connections:[],results:[]};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(origin+'/?tab=auto',{waitUntil:'domcontentloaded',timeout:120000});
 const panel=page.getByTestId('smoke-exposure-recovery');
 try { await panel.getByRole('button',{name:'잔여 노출 확인',exact:true}).waitFor({timeout:60000}); } catch(error) { await page.screenshot({path:join(out,'failure.png'),fullPage:true}); console.error((await page.locator('body').innerText()).slice(0,2500), errors); throw error; }
 await panel.getByRole('button',{name:'잔여 노출 확인',exact:true}).click();
 await panel.getByRole('status').filter({hasText:'첫 확인이 저장'}).waitFor();
 assert.equal(q(`SELECT steps->'_attestation'->>'code' FROM smoke_tests WHERE id='${id}'`)[0],'PENDING');
 const state=await ctx.storageState();await ctx.close();
 // A fresh browser resumes the persisted first observation. Only the offline
 // server clock advances; no ten-minute production observation is claimed.
 writeFileSync(clock,'660000');
 const second=await browser.newContext({viewport:{width:390,height:844},storageState:state,serviceWorkers:'block'});
 await second.addInitScript(()=>{const Real=window.WebSocket;window.WebSocket=class extends EventTarget{static OPEN=1;static CLOSED=3;readyState=3;constructor(url){super();if(['127.0.0.1','localhost'].includes(new URL(String(url),location.href).hostname))return new Real(url);}close(){}send(){}};});
 const p=await second.newPage();p.on('pageerror',e=>errors.push(e.message));await p.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===origin&&(u.pathname==='/api/autotrade/smoke-test/attest-exposure'||!u.pathname.startsWith('/api/')))return route.continue();
  if(u.origin===`http://127.0.0.1:${gatewayPort}`&&u.pathname==='/auth/v1/user')return route.continue();
  const body=u.pathname==='/api/autotrade/schedule'?{ok:true,schedules:[],connections:[{id:cid,exchange_id:'binance',is_testnet:true,is_active:true}]}:{ok:true,data:[],news:[],results:[]};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await p.goto(origin+'/?tab=auto',{waitUntil:'domcontentloaded',timeout:120000});
 const resumed=p.getByTestId('smoke-exposure-recovery');await resumed.getByText('BTCUSDT · 첫 확인 기록 있음',{exact:true}).waitFor({timeout:60000});
 await resumed.getByRole('button',{name:'잔여 노출 확인',exact:true}).click();await resumed.getByRole('status').filter({hasText:'두 번의 잔여 노출 확인이 저장'}).waitFor();
 const final=JSON.parse(q(`SELECT jsonb_build_object('state',state,'verdict',verdict,'steps',steps) FROM smoke_tests WHERE id='${id}'`)[0]);
 assert.equal(final.state,'UNKNOWN');assert.equal(final.verdict,'UNKNOWN');assert.equal(final.steps.ENTRY.state,'FAIL');assert.equal(final.steps._attestation.code,'ATTESTED_FLAT');assert.equal(final.steps.ORDERS_ZERO,undefined);
 const calls=readFileSync(venueCalls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.equal(calls.filter(x=>x.path!=='/fapi/v1/time').length,6);assert.ok(calls.every(x=>x.method==='GET'));assert.deepEqual(errors,[]);
 await resumed.screenshot({path:join(out,'recovered.png')});
 writeFileSync(join(out,'evidence.json'),JSON.stringify({browserToApiToPostgrestToPG:true,firstPersisted:true,newBrowserResumed:true,offlineClockAdvanced:true,historicalVerdictPreserved:true,venueGets:calls.length,venueWrites:0,productionCalls:0},null,2));
 console.log('PASS: owner UI -> API -> PG, restart browser, second observation; historical verdict preserved, venue writes 0');
} catch(e){console.error('Probe logs:',tmp);throw e;}
finally {if(browser)await browser.close();web.kill('SIGTERM');rest.kill('SIGTERM');await new Promise(r=>gateway.close(r));dropScratchDb(target,db);}
