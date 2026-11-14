// Actual local PostgreSQL + official PostgREST + supabase-js CAS, no venue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {createHmac,randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,openSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {pgTarget,createScratchDb,dropScratchDb,psql,psqlFile} from './ten-slot-pg.mjs';
const target=pgTarget();
if(!target.ok||!process.env.PAPER_AUTO_POSTGREST_BIN) test('native Algo intent persistence not run',{skip:!target.ok?target.reason:'PAPER_AUTO_POSTGREST_BIN missing'},()=>{});
else test('atomic Algo intents survive concurrent send claims and a lost DB reply',async()=>{
 const root=resolve(import.meta.dirname,'..'),dir=mkdtempSync(join(tmpdir(),'algo-pg-'));
 const db=createScratchDb(target,'algo_cas',[join(root,'supabase/migrations/012_live_orders.sql')]);
 let rest;
 try {
  const q=sql=>psql(target,db,sql);
  const uid='aa000000-0000-4000-8000-000000000001',conn='aa000000-0000-4000-8000-000000000002',parentId='aa000000-0000-4000-8000-000000000003';
  q(`CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${uid}')`);
  psqlFile(target,db,join(root,'supabase/migrations/004_exchange_connections.sql'));
  if(!process.env.ALGO_PG_RED)psqlFile(target,db,join(root,'supabase/migrations/100_testnet_algo_intents.sql'));
  q(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; INSERT INTO exchange_connections(id,user_id,exchange_id,is_testnet,has_withdrawal) VALUES('${conn}','${uid}','binance',true,false);
   INSERT INTO live_orders(id,user_id,connection_id,client_order_id,exchange,mode,symbol,side,quantity,status)
   VALUES('${parentId}','${uid}','${conn}','smo-nativeBTCUSDE0','binance','TESTNET','BTCUSDT','BUY',1,'FILLED')`);
  execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--rootDir',join(root,'src'),'--outDir',join(dir,'build'),
   '--module','commonjs','--target','ES2020','--skipLibCheck','--types','node',join(root,'src/lib/exchanges/binanceAlgoStore.ts')],{cwd:root,stdio:'pipe'});
  const req=createRequire(import.meta.url),{createClient}=req('@supabase/supabase-js');
  const store=createRequire(join(dir,'fixture.cjs'))('./build/lib/exchanges/binanceAlgoStore.js');
  const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const secret=randomBytes(32).toString('hex'),b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const claims=b64({alg:'HS256',typ:'JWT'})+'.'+b64({role:'service_role',exp:Math.floor(Date.now()/1000)+600});
  const token=claims+'.'+createHmac('sha256',secret).update(claims).digest('base64url');
  const url=new URL(target.url);url.pathname='/'+db;
  writeFileSync(join(dir,'config'),`db-uri = "${url}"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${secret}"\nserver-host = "127.0.0.1"\nserver-port = ${port}\n`);
  const log=openSync(join(dir,'rest.log'),'w');rest=spawn(process.env.PAPER_AUTO_POSTGREST_BIN,[join(dir,'config')],{stdio:['ignore',log,log]});
  let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,30));}assert.ok(ready);
  const direct=(input,init)=>fetch(String(input).replace('/rest/v1/','/'),init);
  const client=(fetcher=direct)=>createClient(`http://127.0.0.1:${port}`,token,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:fetcher}});
  const sb=client(),scope={userId:uid,connectionId:conn,parentId};
  const payload={symbol:'BTCUSDT',side:'SELL',type:'STOP_MARKET',triggerPrice:'98',workingType:'MARK_PRICE',
   algoType:'CONDITIONAL',positionSide:'BOTH',closePosition:'true',clientAlgoId:'smo-nativeBTCUSDS0'};
  const claims8=await Promise.all(Array.from({length:8},()=>store.claimTestnetAlgoIntent(sb,scope,payload)));
  assert.equal(claims8.filter(x=>x.send).length,1);
  assert.equal((await store.claimTestnetAlgoIntent(client(),scope,payload)).send,false,'new process/client must not resend');
  assert.equal(await store.testnetAlgoConnectionClear(sb,uid,conn),false);
  await store.recordTestnetAlgoIntent(sb,scope,payload.clientAlgoId,'ACKED','9223372036854775801');
  await store.recordTestnetAlgoIntent(sb,scope,payload.clientAlgoId,'ACTIVE','9223372036854775801');
  assert.equal(q(`SELECT testnet_algo_intents->'${payload.clientAlgoId}'->>'algoId' FROM live_orders WHERE id='${parentId}'`)[0],'9223372036854775801');
  const nextId='aa000000-0000-4000-8000-000000000004';
  q(`INSERT INTO live_orders(id,user_id,connection_id,client_order_id,exchange,mode,symbol,side,quantity,status)
   VALUES('${nextId}','${uid}','${conn}','smo-nextBTCUSDE0','binance','TESTNET','BTCUSDT','BUY',1,'FILLED')`);
  let lose=true;
  const lost=client(async(input,init)=>{const response=await direct(input,init);if(init?.method==='PATCH'&&lose){lose=false;await response.text();throw Error('offline lost DB reply after COMMIT');}return response;});
  const next={...scope,parentId:nextId},nextPayload={...payload,clientAlgoId:'smo-nextBTCUSDS0'};
  await assert.rejects(()=>store.claimTestnetAlgoIntent(lost,next,nextPayload));
  assert.equal((await store.claimTestnetAlgoIntent(client(),next,nextPayload)).send,false);
  await store.recordTestnetAlgoIntent(sb,scope,payload.clientAlgoId,'CANCELED','9223372036854775801');
  const observation=at=>({at:new Date(at).toISOString(),code:'OBSERVED_FLAT_NOW',positions:0,regular:0,algo:0});
  const first=Date.now()-11*60000;
  await store.attestParentAlgoIntents(sb,uid,conn,'smo-nextBTCUSDE0',observation(first),first);
  assert.equal(await store.testnetAlgoConnectionClear(sb,uid,conn),false,'one observation is not a recovery');
  const second=Date.now();
  await store.attestParentAlgoIntents(sb,uid,conn,'smo-nextBTCUSDE0',observation(second),second);
  assert.equal(await store.testnetAlgoConnectionClear(sb,uid,conn),true);
  assert.equal((await store.claimTestnetAlgoIntent(client(),next,nextPayload)).send,false,'attestation cannot authorize resend');
  assert.equal(q(`SELECT testnet_algo_intents->'${nextPayload.clientAlgoId}'->>'state' FROM live_orders WHERE id='${nextId}'`)[0],'SENT','historical submission state must be preserved');
  q(`UPDATE exchange_connections SET is_testnet=false WHERE id='${conn}'`);
  await assert.rejects(()=>store.claimTestnetAlgoIntent(sb,scope,payload),/VERIFIED_TESTNET_REQUIRED/);
  assert.equal(await store.testnetAlgoConnectionClear(sb,uid,conn),false);
 } finally {if(rest){rest.kill('SIGTERM');await new Promise(r=>rest.once('exit',r));}dropScratchDb(target,db);rmSync(dir,{recursive:true,force:true});}
});
