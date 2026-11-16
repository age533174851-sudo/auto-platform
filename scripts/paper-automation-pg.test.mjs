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
  // **운영이 쓰는 모양으로 올린다.**
  //
  // 전에는 099만 올렸다. 그래서 102가 바꾼 claim 함수와 claim 인덱스를
  // 실제 PostgreSQL로 검증하는 곳이 **없었다** — 이 시험이 그 유일한
  // 자리인데 운영이 쓰지 않는 스키마를 보고 있었다.
  //
  // 목록을 손으로 적는 것이 바로 그 드리프트의 원인이므로,
  // `scripts/check-paper-automation-migrations.mjs`가 이 목록이 저장소의
  // `09*`/`1??_paper*` 마이그레이션을 전부 담고 있는지 CI에서 센다.
  const LATE = ['099_paper_automation.sql','101_paper_claim_lease_recheck.sql','102_paper_multi_bot.sql','103_paper_auto_claim_lock.sql'];
  for (const name of LATE) {
    const migration = resolve(root, 'supabase/migrations', name);
    if (existsSync(migration) && !process.env.PAPER_AUTOMATION_RED && !(name.startsWith('101_') && process.env.PAPER_CLAIM_RED)) psqlFile(target, db, migration);
  }
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
  // **한 번만 돌리는 경합 시험은 경합을 못 잡는다.**
  //
  // 바로 위 시험은 8중 깨우기를 한 번 돌린다. 103 없이 로컬 PostgreSQL 16에서
  // 실제로 센 재현율은 회당 15%였다 (20회 중 3회 · 40회 중 6회). 즉 한 번만
  // 돌리면 **85%는 초록으로 지나간다** — 그 초록은 "경합이 없다"는 뜻이 아니다.
  //
  // 그래서 같은 경합을 여러 번 돌린다. 회당 15%면 30회에서 적어도 한 번
  // 잡을 확률이 1-0.85^30 = 99.2%다. 103을 적용하고 센 결과는 0/40 · 0/100
  // 으로 실패가 없었다 — 고쳐진 상태에서 이 시험은 흔들리지 않는다.
  //
  // **세는 것은 회차 수가 아니라 토큰 수다.** 증상은 회차가 둘이 되는 것이
  // 아니라 같은 회차에 lease_token이 두 번 발급되는 것이다 (뒤에 들어온
  // 깨우기가 ELSE 복구 가지를 타고 먼저 돌던 워커의 회차를 조용히 빼앗는다).
  // 유일 인덱스는 INSERT가 아니므로 위반되지 않고, 회차 수는 1로 보인다.
  const RACE_ROUNDS = 30;
  test(`8 simultaneous wakeups stay single-token across ${RACE_ROUNDS} rounds`, async () => {
    const broken = [];
    for (let i = 0; i < RACE_ROUNDS; i++) {
      start();
      const replies = await raceClaims(target, db, Array(8).fill('SELECT * FROM paper_auto_claim()'));
      const failed = replies.filter(r => r.code !== 0).length;
      const tokens = replies.filter(r => r.out.includes('lease_token')).length;
      const claimed = q("SELECT count(*) FROM paper_automation_runs WHERE state='CLAIMED'")[0];
      if (tokens !== 1 || claimed !== '1' || failed) {
        broken.push(`${i + 1}회: 토큰 ${tokens} · CLAIMED ${claimed}${failed ? ` · psql 실패 ${failed}` : ''}`);
      }
    }
    assert.deepEqual(broken, [], `경합 ${broken.length}/${RACE_ROUNDS}회\n${broken.join('\n')}`);
  });
  test('8 simultaneous fill retries debit the existing ledger only once', async () => {
    start(); const r=claim();
    const replies=await raceClaims(target,db,Array(8).fill(fill(r)));
    assert.equal(replies.filter(r=>r.out.trim()==='OPENED').length,1);
    assert.equal(replies.filter(r=>r.out.trim()==='DUPLICATE').length,7);
    assert.equal(q('SELECT balance FROM paper_accounts')[0],'9999.95');
    assert.equal(q('SELECT count(*) FROM paper_positions')[0],'1');
  });
  test('retroactive migration 101 preserves the newer multi-bot claim function', () => {
    const fingerprint = () => q("SELECT md5(pg_get_functiondef('paper_auto_claim()'::regprocedure))")[0];
    const before = fingerprint();
    psqlFile(target, db, resolve(root, 'supabase/migrations/101_paper_claim_lease_recheck.sql'));
    assert.equal(fingerprint(), before, 'late application downgraded the multi-bot claim fence');
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
  // 103이 경합을 막으면서 생긴 성질. 봇마다 권고 잠금을 잡고 **못 잡으면
  // 건너뛰므로**, 한 봇이 도는 동안 다른 봇이 막히지 않아야 한다.
  //
  // 이 시험이 없으면 누가 후보 루프를 `LIMIT 1`로 "단순화"하고, 그러면 맨 앞
  // 봇이 회차를 들고 있는 45초 동안 **나머지 봇 전부가 멈춘다** — 봇을
  // 여러 개 만든 이유가 사라진다.
  test('a bot holding a run does not block another bot from claiming', () => {
    start(); const first=claim();
    assert.equal(first.bot_id,'paper-auto-v1');
    q(`SELECT paper_auto_control('${uid}','bot-two',true,'BTCUSDT',60)`);
    const second=claim();
    assert.ok(second&&second.lease_token,'두 번째 봇이 막혔다');
    assert.equal(second.bot_id,'bot-two');
    assert.notEqual(second.id,first.id);
    assert.notEqual(second.lease_token,first.lease_token);
    assert.equal(q("SELECT count(*) FROM paper_automation_runs WHERE state='CLAIMED'")[0],'2');
    // 그리고 **같은 봇은 두 번 잡히지 않는다** — 둘 다 리스가 살아 있으므로.
    assert.equal(q('SELECT count(*) FROM paper_auto_claim()')[0],'0');
    // 뒷정리: 이 봇이 남으면 다음 시험의 '도래한 봇' 수가 달라진다.
    q(`DELETE FROM paper_automation_runs WHERE bot_id='bot-two';
       DELETE FROM paper_automation_settings WHERE bot_id='bot-two'`);
  });
}
