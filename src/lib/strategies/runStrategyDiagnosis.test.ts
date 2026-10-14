import { test, eq } from '../../test/harness';
import { outcomeOf } from './runStrategy';

export function runRunStrategyDiagnosisTests(): void {
test('NO_SIGNAL: known reason code is persisted without changing outcome', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: 'NO_BREAKOUT' } });
  eq(v.outcome, 'NO_SIGNAL');
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음 · 사유코드 NO_BREAKOUT');
});

test('NO_SIGNAL: unknown or malicious code is not persisted', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: 'INJECTED:secret' } });
  eq(v.outcome, 'NO_SIGNAL');
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음');
});

test('NO_SIGNAL: old response remains backward compatible', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false } });
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음');
});

test('NO_SIGNAL: diagnostic never overrides blocked or entered outcomes', () => {
  eq(outcomeOf({ httpOk: true, body: { executed: true, reasonCode: 'NO_BREAKOUT' } }).outcome, 'ENTERED');
  eq(outcomeOf({ httpOk: true, body: { checklist: { allowed: false }, reasonCode: 'NO_BREAKOUT' } }).outcome, 'BLOCKED');
});

}
