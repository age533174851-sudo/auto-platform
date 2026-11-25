// Independent campaign isolation on real, disposable localhost PostgreSQL.
// This does NOT turn the existing sequential 10-slot campaign into ten V2 bots,
// or prove venue fills/protection/PnL. Event evidence below is synthetic input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  pgTarget, createScratchDb, dropScratchDb, migrationPaths, DEFAULT_OWNER,
  psql, openCampaignSql, claimSql, parseClaim, raceClaims, readState,
  applyEventSql, parseEvent, eventRows, restartCommand, restartCluster,
} from './ten-slot-pg.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = pgTarget();
const schema = [
  '012_live_orders.sql', '078_live_orders_stop_policy.sql',
  '090_live_orders_execution_identity.sql', '091_live_orders_entry_risk_snapshot.sql',
  '097_ten_slot_atomic_claim.sql', '098_ten_slot_apply_event.sql',
];
let sequence = 0;

function fixture(t) {
  const db = createScratchDb(target, 'tsindependent', migrationPaths(root, schema));
  t.after(() => dropScratchDb(target, db));
  const stamp = `${Date.now().toString(36)}-${++sequence}`;
  const bots = Array.from({ length: 10 }, (_, i) => {
    const campaignId = `bot-${stamp}-${String(i).padStart(2, '0')}-end`;
    assert.deepEqual(psql(target, db, openCampaignSql({
      campaignId, userId: DEFAULT_OWNER, environment: 'TESTNET', startingEquity: 1000,
    })), ['OPENED|0']);
    return { campaignId, clientOrderId: `entry-${campaignId}` };
  });
  const claim = (bot, over = {}) => parseClaim(psql(target, db,
    claimSql({ ...bot, expectedVersion: 0, ...over })));
  const event = (bot, kind, version, over = {}) => parseEvent(psql(target, db,
    applyEventSql({ ...bot, slotIndex: 0, expectedVersion: version,
      eventId: `${kind}-${bot.campaignId}`, kind, evidence: 'NONE', ...over })));
  const snapshots = () => bots.map(b => ({ state: readState(target, db, b.campaignId),
    events: eventRows(target, db, b.campaignId) }));
  return { db, bots, claim, event, snapshots };
}

if (!target.ok) {
  test(`independent campaign PostgreSQL proof skipped: ${target.reason}`,
    { skip: target.reason }, () => {});
} else {
  test('ten campaigns reserve independently while duplicate workers lose within each campaign', async t => {
    const { db, bots } = fixture(t);
    const statements = bots.flatMap(bot => [
      claimSql({ ...bot, expectedVersion: 0 }),
      claimSql({ ...bot, expectedVersion: 0, clientOrderId: `duplicate-${bot.campaignId}` }),
    ]);
    const results = await raceClaims(target, db, statements, 991725);
    for (const result of results) assert.equal(result.code, 0, result.err);
    const codes = results.map(r => parseClaim(r.rows.filter(v => v.includes('|'))).code);
    assert.equal(codes.filter(c => c === 'RESERVATION_AND_INTENT_DURABLE').length, 10);
    assert.equal(codes.filter(c => c === 'STALE_VERSION').length, 10);
    for (const bot of bots) {
      const state = readState(target, db, bot.campaignId);
      assert.equal(state.version, 1);
      assert.equal(state.active, 1);
      assert.equal(state.claims, 1);
      assert.equal(state.intents, 1);
      assert.deepEqual(state.statuses, ['RESERVED', ...Array(9).fill('FREE')]);
    }
    assert.deepEqual(psql(target, db, 'SELECT count(*) FROM live_orders'), ['10']);
  });

  test('UNKNOWN blocks its own campaign without mutating or blocking another campaign', t => {
    const { db, bots, claim, event, snapshots } = fixture(t);
    const a = bots[0];
    const b = bots[1];
    assert.equal(claim(a).code, 'RESERVATION_AND_INTENT_DURABLE');
    const before = snapshots();
    assert.equal(event(a, 'UNKNOWN_RESPONSE', 1).status, 'UNKNOWN');
    assert.equal(claim(a, { expectedVersion: 2, clientOrderId: `retry-${a.campaignId}` }).code, 'SLOT_BUSY');
    assert.deepEqual(snapshots().slice(1), before.slice(1));
    assert.equal(claim(b).code, 'RESERVATION_AND_INTENT_DURABLE');
    assert.equal(readState(target, db, a.campaignId).statuses[0], 'UNKNOWN');
    // A's order identity cannot be used as synthetic ACK evidence for B.
    const bBefore = readState(target, db, b.campaignId);
    const wrong = event(b, 'ACK', 1, { evidence: 'VENUE_ORDER',
      exchangeOrderId: 'fixture-order-a', clientOrderId: a.clientOrderId });
    assert.notEqual(wrong.code, 'EVENT_APPLIED');
    assert.deepEqual(readState(target, db, b.campaignId), bBefore);
    assert.deepEqual(eventRows(target, db, b.campaignId), []);
  });

  test('lost claim responses retried in all ten campaigns cannot create duplicate intents', t => {
    const { db, bots, claim, snapshots } = fixture(t);
    for (const bot of bots) assert.equal(claim(bot).code, 'RESERVATION_AND_INTENT_DURABLE');
    const before = snapshots();
    for (const bot of bots) assert.equal(claim(bot).code, 'ORDER_ID_REUSED');
    assert.deepEqual(snapshots(), before);
    assert.deepEqual(psql(target, db, 'SELECT count(*) FROM live_orders'), ['10']);
  });

  test('real PostgreSQL restart preserves ten campaign journals and UNKNOWN; retries stay idempotent',
    { skip: restartCommand() ? false : 'TEN_SLOT_PG_RESTART not configured' }, t => {
      const { db, bots, claim, event, snapshots } = fixture(t);
      for (const bot of bots) assert.equal(claim(bot).code, 'RESERVATION_AND_INTENT_DURABLE');
      assert.equal(event(bots[0], 'UNKNOWN_RESPONSE', 1).status, 'UNKNOWN');
      const before = snapshots();
      psql(target, db, 'CHECKPOINT');
      restartCluster();
      assert.deepEqual(snapshots(), before);
      for (const bot of bots) assert.equal(claim(bot).code, 'ORDER_ID_REUSED');
      assert.deepEqual(snapshots(), before);
    });
}
