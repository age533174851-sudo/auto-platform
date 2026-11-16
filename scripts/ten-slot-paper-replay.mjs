// OFFLINE SYNTHETIC REPLAY — not a Binance/Gate order and not market backtesting.
// Intentionally imports ONLY the existing offline accounting/lifecycle model.
// Emits an auditable ten-round-trip trade journal for CI without network, keys, or production DB.
import { pathToFileURL } from 'node:url';
import {
  createCoupledOfflineCampaign, claimAndIntentCoupledOffline,
  applyCoupledOfflineEvent, validCoupledOfflineSnapshot,
} from './ten-slot-coupled-offline.mjs';

const ZERO = Object.freeze({ positions: 0, openOrders: 0, pendingEntries: 0 });
const LEVERAGES = Object.freeze([10, 25, 50, 75]);
const ENTRY_SLIPPAGE = 0.0005; // synthetic adverse 0.05%
const EXIT_SLIPPAGE = 0.0005;
const TAKER_FEE = 0.0004; // synthetic fee per side, not current venue tariff
const copy = x => structuredClone(x);

class OfflineCASStore {
  constructor(id, equity) { this.state = createCoupledOfflineCampaign(id, equity); this.writes = 0; }
  async read() { return copy(this.state); }
  async compareAndSwap(id, expectedVersion, next) {
    if (this.state.campaignId !== id || this.state.version !== expectedVersion) return false;
    this.state = copy(next); this.writes++;
    return true;
  }
}

class SyntheticVenue {
  constructor() { this.position = null; this.maxConcurrent = 0; this.orderCount = 0; }
  enter({ index, venue, symbol, side, leverage, margin, mark }) {
    if (this.position) throw Error('OFFLINE_CONCURRENT_POSITION');
    const direction = side === 'LONG' ? 1 : -1;
    const fill = mark * (1 + direction * ENTRY_SLIPPAGE);
    const qty = margin * leverage / fill;
    this.position = { index, venue, symbol, side, leverage, qty, fill, margin };
    this.orderCount++;
    this.maxConcurrent = Math.max(this.maxConcurrent, 1);
    return {
      fakeEntryId: 'synthetic-entry-' + index,
      fillPrice: fill, filledQty: qty, filledLots: 10,
      // The "protection" is simulated; never present these as venue attestations.
      fakeStopId: 'synthetic-sl-' + index,
      fakeTpId: 'synthetic-tp-' + index,
    };
  }
  close(index, winning) {
    if (!this.position || this.position.index !== index) throw Error('OFFLINE_POSITION_MISSING');
    const p = this.position;
    const direction = p.side === 'LONG' ? 1 : -1;
    // Deterministic synthetic move, not Binance/Gate market data.
    const midExit = p.fill * (1 + direction * (winning ? 0.006 : -0.004));
    const fillExit = midExit * (1 - direction * EXIT_SLIPPAGE);
    const grossPnl = direction * (fillExit - p.fill) * p.qty;
    const entryFee = p.fill * p.qty * TAKER_FEE;
    const exitFee = fillExit * p.qty * TAKER_FEE;
    const netPnl = grossPnl - entryFee - exitFee;
    this.orderCount++;
    this.position = null; // FakeVenue confirms zero position and zero remaining orders.
    return {
      fakeExitId: 'synthetic-exit-' + index,
      fillExit, filledLots: 10, grossPnl, entryFee, exitFee, netPnl,
      fakePositionZero: true, fakeOrdersZero: true,
    };
  }
}

function requireResult(result, expected) {
  if (!result.ok || (expected && result.code !== expected))
    throw Error('OFFLINE_REPLAY_STEP_FAILED: ' + JSON.stringify(result));
  return result;
}

/**
 * Reproducible, synthetic offline lifecycle replay (10 closed slots).
 * No actual API, no genuine fills, no strategy alpha or future profit claims.
 * faultAtSlot simulates an unverified protection read and must halt later claims.
 */
export async function runTenSlotPaperReplay({ initialEquity = 1000, faultAtSlot = null } = {}) {
  if (!Number.isFinite(initialEquity) || initialEquity <= 0 ||
      (faultAtSlot !== null && (!Number.isSafeInteger(faultAtSlot) || faultAtSlot < 0 || faultAtSlot >= 10)))
    throw TypeError('INVALID_OFFLINE_REPLAY_SETTINGS');

  const id = 'synthetic-replay';
  const store = new OfflineCASStore(id, initialEquity);
  const fake = new SyntheticVenue();
  const trades = [];
  let equity = initialEquity;
  let failure = null;
  for (let index = 0; index < 10; index++) {
    const venue = index % 2 === 0 ? 'BINANCE_FAKE' : 'GATE_FAKE';
    const symbol = index % 2 === 0 ? 'BTCUSDT' : 'ETHUSDT';
    const mark = symbol === 'BTCUSDT' ? 95000 : 3400;
    const side = index % 2 === 0 ? 'LONG' : 'SHORT';
    const leverage = LEVERAGES[index % LEVERAGES.length];
    const margin = initialEquity / 10;
    const clientOrderId = 'synthetic-intent-' + index;
    if (fake.position) throw Error('OFFLINE_PREVIOUS_POSITION_NOT_FLAT');
    const claim = requireResult(
      await claimAndIntentCoupledOffline(store, id, ZERO, clientOrderId, 10),
      'RESERVATION_AND_INTENT_DURABLE',
    );
    if (claim.index !== index) throw Error('OFFLINE_SLOT_ORDER_MISMATCH');

    const entry = fake.enter({ index, venue, symbol, side, leverage, margin, mark });
    if (faultAtSlot === index) {
      // A venue/ledger disagreement MUST NOT be turned into a synthetic PASS.
      const uncertain = requireResult(await applyCoupledOfflineEvent(store, id, {
        eventId: 'synthetic-uncertain-' + index, type: 'UNCERTAIN', clientOrderId,
      }), 'EVENT_AND_LEDGER_DURABLE');
      if (uncertain.phase !== 'UNKNOWN') throw Error('OFFLINE_UNKNOWN_NOT_PERSISTED');
      const next = await claimAndIntentCoupledOffline(store, id, ZERO, 'synthetic-next', 10);
      if (next.ok) throw Error('OFFLINE_RECLAIM_DURING_UNKNOWN');
      failure = { slotIndex: index, code: 'PROTECTION_UNVERIFIED', nextClaimBlocked: next.code };
      break;
    }
    const protectedEntry = requireResult(await applyCoupledOfflineEvent(store, id, {
      eventId: 'synthetic-protected-' + index, type: 'ENTRY_PROTECTED',
      clientOrderId, cumulativeLots: entry.filledLots,
      stopAttached: true, takeProfitAttached: true,
      venuePositionConfirmed: true, ledgerMatched: true,
    }), 'EVENT_AND_LEDGER_DURABLE');
    if (protectedEntry.phase !== 'OPEN_PROTECTED') throw Error('OFFLINE_NOT_PROTECTED');
    const exitIntent = requireResult(await applyCoupledOfflineEvent(store, id, {
      eventId: 'synthetic-exit-intent-' + index, type: 'EXIT_INTENT',
      clientOrderId, exitIntentDurable: true,
    }), 'EVENT_AND_LEDGER_DURABLE');
    if (exitIntent.phase !== 'EXIT_PENDING') throw Error('OFFLINE_NO_EXIT_INTENT');

    const winning = index % 3 !== 1;
    const exit = fake.close(index, winning);
    const closed = requireResult(await applyCoupledOfflineEvent(store, id, {
      eventId: 'synthetic-exit-flat-' + index, type: 'EXIT_FLAT', clientOrderId,
      cumulativeLots: exit.filledLots, venueFlatConfirmed: exit.fakePositionZero,
      openOrdersConfirmedZero: exit.fakeOrdersZero, ledgerMatched: true,
    }), 'EVENT_AND_LEDGER_DURABLE');
    if (closed.phase !== 'CLOSED') throw Error('OFFLINE_NOT_CLOSED');
    equity += exit.netPnl;
    trades.push({
      slotIndex: index, venue, symbol, side, leverage, marginUsd: margin,
      entryOrderId: entry.fakeEntryId, entryPrice: entry.fillPrice,
      stopOrderId: entry.fakeStopId, takeProfitOrderId: entry.fakeTpId,
      exitOrderId: exit.fakeExitId, exitPrice: exit.fillExit,
      exitReason: winning ? 'SYNTHETIC_TP' : 'SYNTHETIC_SL',
      grossPnlUsd: exit.grossPnl, feesUsd: exit.entryFee + exit.exitFee,
      netPnlUsd: exit.netPnl, equityAfterUsd: equity,
      slotStatus: store.state.ledger.slots[index].status,
    });
  }

  if (!validCoupledOfflineSnapshot(store.state)) throw Error('OFFLINE_CAMPAIGN_CORRUPT');
  const closedSlots = store.state.ledger.slots.filter(x => x.status === 'SPENT').length;
  const unknownSlots = store.state.ledger.slots.filter(x => x.status === 'UNKNOWN').length;
  const freeSlots = store.state.ledger.slots.filter(x => x.status === 'FREE').length;
  const report = {
    kind: 'SYNTHETIC_OFFLINE_FAKE_DB_FAKE_VENUE',
    actualExchangeOrders: 0, actualProductionDbWrites: 0,
    marketDataSource: 'DETERMINISTIC_SYNTHETIC_PRICES_NOT_MARKET_DATA',
    feeAndSlippage: { takerFeePerSide: TAKER_FEE, entrySlippage: ENTRY_SLIPPAGE, exitSlippage: EXIT_SLIPPAGE },
    initialEquityUsd: initialEquity, finalEquityUsd: equity,
    completedRoundTrips: trades.length, closedSlots, unknownSlots, freeSlots,
    fakeOrderRequests: fake.orderCount, maxConcurrentFakePositions: fake.maxConcurrent,
    failure, trades,
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runTenSlotPaperReplay();
  console.log(JSON.stringify(report, null, 2));
  if (report.completedRoundTrips !== 10 || report.closedSlots !== 10 ||
      report.maxConcurrentFakePositions !== 1) process.exitCode = 1;
}
