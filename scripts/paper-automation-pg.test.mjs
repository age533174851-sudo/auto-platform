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
  const leaseFix = resolve(root, 'supabase/migrations/101_paper_claim_lease_recheck.sql');
  if (existsSync(leaseFix) && !process.env.PAPER_CLAIM_RED && !process.env.PAPER_AUTOMATION_RED) psqlFile(target, db, leaseFix);
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
  test('candidate snapshot taken before another claim cannot rotate its live lease', async () => {
    start();
    const role = `claim_${db}`;
    const holderName = `${role}_holder`, waiterName = `${role}_waiter`;
    const lock = 845101;
    q(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT,UPDATE ON paper_automation_settings TO ${role};
      GRANT SELECT,INSERT,UPDATE ON paper_automation_runs TO ${role};
      GRANT EXECUTE ON FUNCTION paper_auto_claim() TO ${role};
      CREATE FUNCTION claim_test_barrier() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(${lock}); RETURN true; END $$;
      CREATE POLICY claim_test_select ON paper_automation_settings FOR SELECT TO ${role} USING (claim_test_barrier());
      CREATE POLICY claim_test_update ON paper_automation_settings FOR UPDATE TO ${role} USING (true);
      CREATE POLICY claim_test_runs ON paper_automation_runs FOR ALL TO ${role} USING (true) WITH CHECK (true)`);
    // Database is dropped by the earlier exit handler, releasing role grants.
    process.on('exit', () => psql(target, target.url.pathname.slice(1) || 'postgres', `DROP ROLE IF EXISTS ${role}`));
    const holder = psqlSpawn(target,db,[`SET application_name='${holderName}'`, `SELECT pg_advisory_lock(${lock}); SELECT pg_sleep(15)`]);
    const until = async sql => {
      for (let n=0;n<100;n++) {
        if(q(sql)[0]==='1')return;
        await new Promise(r=>setTimeout(r,25));
      }
      throw Error('claim snapshot barrier not reached');
    };
    let waiter;
    try {
      await until(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${holderName}' AND wait_event='PgSleep'`);
      waiter = psqlSpawn(target,db,[`SET application_name='${waiterName}'; SET ROLE ${role}`, 'SELECT * FROM paper_auto_claim()']);
      await until(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${waiterName}' AND wait_event='advisory'`);
      // The waiting SELECT already owns its statement snapshot. This claimant
      // bypasses only TEST RLS and commits before that snapshot can continue.
      const first = claim();
      q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='${holderName}' AND datname=current_database()`);
      const second = await waiter.done;
      assert.equal(second.code,0,second.err);
      assert.equal(second.out.includes('lease_token'),false,'stale candidate stole a fresh lease');
      assert.equal(q(`SELECT lease_token FROM paper_automation_runs WHERE id='${first.id}'`)[0],first.lease_token);
    } finally {
      q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('${holderName}','${waiterName}') AND datname=current_database()`);
      holder.child.kill('SIGTERM'); waiter?.child.kill('SIGTERM');
      await holder.done;
    }
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
