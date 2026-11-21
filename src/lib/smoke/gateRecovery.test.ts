import { eq, test } from '../../test/harness';
import {
  GATE_RECOVERY_INTERVAL_MS,
  GATE_RECOVERY_KEY,
  gateRecoveryTimes,
  isGateRecoveryCandidate,
  nextGateRecoveryObservation,
} from './gateRecovery';
import { unresolvedExposureBlock } from './smokePlan';

export function runGateRecoveryTests() {
  const firstAt = Date.UTC(2026, 10, 15, 0, 0);
  const interval = GATE_RECOVERY_INTERVAL_MS;
  const original = {
    id: 'failed-eth',
    mode: 'TESTNET',
    state: 'FAIL',
    connection_id: 'gate-demo',
    steps: { POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'FAIL' } },
  };

  test('Gate recovery keeps the original failure and supports only verified-position failures', () => {
    eq(isGateRecoveryCandidate(original), true);
    eq(isGateRecoveryCandidate({ ...original, mode: 'LIVE' }), false);
    eq(isGateRecoveryCandidate({ ...original, state: 'UNKNOWN' }), false);
    eq(isGateRecoveryCandidate({ ...original, steps: { ...original.steps, POSITION_ZERO: 'FAIL' } }), false);
    eq(isGateRecoveryCandidate({ ...original, steps: { ...original.steps, ORDERS_ZERO: 'PASS' } }), false);
  });

  test('Gate recovery waits at least ten minutes between observations', () => {
    const first = nextGateRecoveryObservation(null, firstAt);
    eq(first.code, 'OBSERVED');
    eq(first.write, true);
    eq(first.evidence.confirmedAt, null);
    const tooSoon = nextGateRecoveryObservation(first.evidence, firstAt + interval - 1);
    eq(tooSoon.code, 'WAIT');
    eq(tooSoon.write, false);
    const second = nextGateRecoveryObservation(first.evidence, firstAt + interval);
    eq(second.code, 'CONFIRMED');
    eq(second.write, true);
    eq(second.evidence.confirmedAt, firstAt + interval);
    eq(nextGateRecoveryObservation(second.evidence, firstAt + interval + 1).write, false);
  });

  test('Gate recovery starts over after the observation window expires', () => {
    const now = firstAt + 60 * 60 * 1000 + 1;
    const result = nextGateRecoveryObservation({ firstAt, confirmedAt: null }, now);
    eq(result.code, 'OBSERVED');
    eq(result.evidence.firstAt, now);
    eq(result.evidence.confirmedAt, null);
  });

  test('Gate recovery rejects invalid confirmation timestamps', () => {
    const now = firstAt + interval;
    eq(gateRecoveryTimes({ firstAt: now + 1 }, now), null);
    eq(gateRecoveryTimes({ firstAt, confirmedAt: now - 1 }, now), null);
    eq(gateRecoveryTimes({ firstAt, confirmedAt: now + 1 }, now), null);
    eq(gateRecoveryTimes({ firstAt, confirmedAt: String(now) }, now), null);
  });

  test('A stored Gate recovery cannot clear the generic exposure guard without a venue reread', () => {
    const recorded = {
      ...original,
      steps: { ...original.steps, [GATE_RECOVERY_KEY]: { firstAt, confirmedAt: firstAt + interval } },
    };
    const result = unresolvedExposureBlock({ rows: [recorded], connectionId: 'gate-demo' });
    eq(result.blocked, true);
    eq(result.code, 'UNPROTECTED_UNRESOLVED');
    eq(result.offenders[0], original.id);
    eq(recorded.steps.ORDERS_ZERO.state, 'FAIL');
  });
}
