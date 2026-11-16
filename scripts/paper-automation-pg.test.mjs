// Local PostgreSQL only. Replays the existing money path; never connects to production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pgTarget, createScratchDb, dropScratchDb, psql, psqlFile, raceClaims, psqlSpawn } from './ten-slot-pg.mjs';

const target = pgTarget();
const root = resolve(import.meta.dirname, '..');
const names = readdirSync(resolve(root, 'supabase/migrations'));
const ids = [10,25,33,71,72,74,75,81,82,83,84,85,86,87,88];
if (!target.ok) test('PAPER automation PostgreSQL not run', { skip: target.reason }, () => {});
else {
  const db = createScratchDb(target, 'paper_auto', ids.map(id => resolve(root, 'supabase/migrations', names.find(n => n.startsWith(String(id).padStart(3,'0')+'_')))));
  process.on('exit', () => { dropScratchDb(target, db); });
  const migration = resolve(root, 'supabase/migrations/099_paper_automation.sql');
  if (existsSync(migration) && !process.env.PAPER_AUTOMATION_RED) psqlFile(target, db, migration);
  const q = sql => psql(target, db, sql);
  const uid = 'ab000000-0000-0000-0000-000000000001';
  q(`INSERT INTO paper_accounts(user_id,is_default,balance,initial_balance,started_at) VALUES ('${uid}',true,10000,10000,now())`);
  test('start persists a due PAPER run without a browser', () => {
    assert.equal(q(`SELECT paper_auto_control('${uid}',true,'BTCUSDT',60)->>'enabled'`)[0], 'true');
    assert.equal(q(`SELECT count(*) FROM paper_auto_claim()`)[0], '1');
  });
  const start = () => {
    q(`SELECT paper_auto_control('${uid}',false,'BTCUSDT',60);
      DELETE FROM paper_automation_runs; DELETE FROM paper_positions;
      UPDATE paper_accounts SET balance=10000,started_at=now() WHERE user_id='${uid}';
      SELECT paper_auto_control('${uid}',true,'BTCUSDT',60)`);
  };
  const claim = () => JSON.parse(q('SELECT * FROM paper_auto_claim()')[0]);
  const order = { p_symbol:'BTCUSDT',p_market:'USDM',p_side:'LONG',p_entry_price:100,
    p_fill_price:100.05,p_quantity:1,p_notional:100.05,p_leverage:5,p_margin:20.01,
    p_stop_loss:98,p_take_profit:104,p_liquidation_price:80,p_entry_fee:0.05 };
  const fill = (r, payload=order) => `SELECT status FROM paper_auto_open('${r.id}','${r.lease_token}','${JSON.stringify(payload)}')`;
  test('8 simultaneous wakeups claim exactly one durable run', async () => {
    start();
    const replies = await raceClaims(target,db,Array(8).fill('SELECT * FROM paper_auto_claim()'));
    assert.ok(replies.every(r=>r.code===0));
    assert.equal(replies.filter(r=>r.out.includes('lease_token')).length,1);
    assert.equal(q("SELECT count(*) FROM paper_automation_runs WHERE state='CLAIMED'")[0],'1');
  });
  test('8 simultaneous fill retries debit the existing ledger only once', async () => {
    start(); const r=claim();
    const replies=await raceClaims(target,db,Array(8).fill(fill(r)));
    assert.equal(replies.filter(r=>r.out.trim()==='OPENED').length,1);
    assert.equal(replies.filter(r=>r.out.trim()==='DUPLICATE').length,7);
    assert.equal(q('SELECT balance FROM paper_accounts')[0],'9999.95');
    assert.equal(q('SELECT count(*) FROM paper_positions')[0],'1');
  });
  test('Stop acknowledges only after revoking the final write', () => {
    start();const r=claim();
    q(`SELECT paper_auto_control('${uid}',false,'BTCUSDT',60)`);
    assert.equal(q(fill(r))[0],'STALE_RUN');
    assert.equal(q('SELECT count(*) FROM paper_positions')[0],'0');
    assert.equal(q('SELECT count(*) FROM paper_auto_claim()')[0],'0');
    assert.equal(q(`SELECT paper_auto_finish('${r.id}','${r.lease_token}','{"code":"WAIT"}')`)[0],'f');
  });
  test('crashed lease recovers the same signal, rejecting the previous worker', () => {
    start(); const old=claim();
    q(`UPDATE paper_automation_runs SET lease_until=now()-interval '1 second' WHERE id='${old.id}'`);
    const next=claim();
    assert.equal(next.id,old.id);assert.notEqual(next.lease_token,old.lease_token);
    assert.equal(q(fill(old))[0],'STALE_RUN');assert.equal(q(fill(next))[0],'OPENED');
    assert.equal(q('SELECT count(*) FROM paper_positions')[0],'1');
  });
  test('lost fill reply recovers committed position and fee, even after process restart', () => {
    start();const old=claim();assert.equal(q(fill(old))[0],'OPENED');
    q(`UPDATE paper_automation_runs SET lease_until=now()-interval '1 second' WHERE id='${old.id}'`);
    const r=claim();assert.equal(r.id,old.id);assert.ok(r.entry_position_id);
    // A new psql backend sees the committed position; no in-memory runner state is used.
    assert.equal(q(fill(r))[0],'DUPLICATE');
    assert.equal(q(`SELECT paper_auto_finish('${r.id}','${r.lease_token}','{"code":"EVALUATION_FAILED"}')`)[0],'t');
    assert.equal(q("SELECT result->>'code' FROM paper_automation_runs")[0],'ENTERED');
    assert.equal(q('SELECT balance FROM paper_accounts')[0],'9999.95');
    assert.equal(q('SELECT count(*) FROM paper_auto_claim()')[0],'0');
    q(`UPDATE paper_automation_settings SET next_run_at=now()-interval '1 second' WHERE user_id='${uid}'`);
    assert.notEqual(claim().id,r.id);
  });
  test('capacity includes manual positions and locks the same account', () => {
    start();const r=claim();
    const insert=`SELECT * FROM paper_open_position('${uid}','manual',NULL,NULL,'ETHUSDT','USDM','LONG',100,100,1,100,5,20,98,104,80,0.05,'ISOLATED',now(),NULL)`;
    q(insert);assert.equal(q(fill(r))[0],'SLOT_BUSY');
    assert.equal(q('SELECT count(*) FROM paper_positions')[0],'1');
  });
  test('lease expiration while waiting for an account lock prevents a late fill', async () => {
    start();const r=claim();
    q(`UPDATE paper_automation_runs SET lease_until=now()+interval '1 second' WHERE id='${r.id}'`);
    const holder=psqlSpawn(target,db,"BEGIN; SELECT balance FROM paper_accounts FOR UPDATE; SELECT pg_sleep(2); COMMIT");
    // Observe the lock holder rather than assuming a fixed startup delay.
    for(let i=0;i<50;i++) {
      if(q("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'BEGIN; SELECT balance%' AND wait_event='PgSleep'")[0]==='1')break;
      await new Promise(r=>setTimeout(r,20));
    }
    const late=psqlSpawn(target,db,fill(r));
    const [held,done]=await Promise.all([holder.done,late.done]);
    assert.equal(held.code,0);assert.equal(done.code,0,done.err);assert.equal(done.out.trim(),'STALE_RUN');
    assert.equal(q('SELECT count(*) FROM paper_positions')[0],'0');
  });
  test('authenticated users cannot call service RPCs or write settings', () => {
    assert.match(psql(target,db,`SET ROLE authenticated; SELECT * FROM paper_auto_claim()`,{expectError:true}).error,/permission denied/);
    assert.match(psql(target,db,`SET ROLE authenticated; UPDATE paper_automation_settings SET enabled=true`,{expectError:true}).error,/permission denied/);
    assert.equal(q('SELECT count(*) FROM paper_automation_settings WHERE enabled')[0],'1');
  });
}
