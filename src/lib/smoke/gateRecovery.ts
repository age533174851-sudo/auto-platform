export const GATE_RECOVERY_KEY = '_gateRecovery';
export const GATE_RECOVERY_INTERVAL_MS = 10 * 60 * 1000;
const OBSERVATION_WINDOW_MS = 60 * 60 * 1000;

function stepState(step: unknown) {
  return typeof step === 'string' ? step
    : step && typeof step === 'object' && 'state' in step ? step.state : null;
}

export function isGateRecoveryCandidate(row: { mode?: string; state?: string; steps?: Record<string, unknown> }) {
  return row.mode === 'TESTNET' && row.state === 'FAIL'
    && stepState(row.steps?.POSITION_ZERO) === 'PASS' && stepState(row.steps?.ORDERS_ZERO) === 'FAIL';
}

export function gateRecoveryTimes(evidence: unknown, now: number) {
  if (!evidence || typeof evidence !== 'object' || !('firstAt' in evidence)
      || typeof evidence.firstAt !== 'number' || !Number.isSafeInteger(evidence.firstAt)
      || evidence.firstAt <= 0 || evidence.firstAt > now) return null;
  const firstAt = evidence.firstAt;
  const confirmedAt = 'confirmedAt' in evidence ? evidence.confirmedAt : null;
  if (confirmedAt == null) return { firstAt, confirmedAt: null };
  if (typeof confirmedAt !== 'number' || !Number.isSafeInteger(confirmedAt)
      || confirmedAt > now || confirmedAt - firstAt < GATE_RECOVERY_INTERVAL_MS
      || confirmedAt - firstAt > OBSERVATION_WINDOW_MS) return null;
  return { firstAt, confirmedAt };
}

export function nextGateRecoveryObservation(evidence: unknown, now: number) {
  const previous = gateRecoveryTimes(evidence, now);
  if (previous?.confirmedAt != null) return { code: 'CONFIRMED', evidence: previous, write: false } as const;
  if (!previous || now - previous.firstAt > OBSERVATION_WINDOW_MS) {
    return { code: 'OBSERVED', evidence: { firstAt: now, confirmedAt: null }, write: true } as const;
  }
  if (now - previous.firstAt < GATE_RECOVERY_INTERVAL_MS) {
    return { code: 'WAIT', evidence: previous, write: false } as const;
  }
  return { code: 'CONFIRMED', evidence: { firstAt: previous.firstAt, confirmedAt: now }, write: true } as const;
}
