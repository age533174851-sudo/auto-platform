import { test, eq } from '../../test/harness';
import { diagnoseScalpSignal } from './scalpSignalDiagnosis';
import type { ScalpResult } from './scalpSignal';

const cases = [
  ['돌파 없음 (1.00 ~ 2.00 안)', 'NO_BREAKOUT'],
  ['돌파했지만 거래량이 부족합니다 (평균의 1.00배 · 1.3배 필요)', 'VOLUME_BELOW_THRESHOLD'],
  ['거래량을 확인하지 못했습니다', 'VOLUME_UNAVAILABLE'],
  ['평균 거래량이 0입니다', 'VOLUME_UNAVAILABLE'],
  ['봉 데이터가 없습니다', 'BARS_UNAVAILABLE'],
  ['봉이 모자랍니다 (2개 · 최소 22개 필요)', 'BARS_INSUFFICIENT'],
  ['현재가를 읽지 못했습니다', 'PRICE_UNAVAILABLE'],
  ['변동성(ATR)을 계산하지 못했습니다', 'ATR_UNAVAILABLE'],
  ['손절 폭을 계산하지 못했습니다', 'STOP_INVALID'],
  ['목표 0.100%가 왕복 비용 0.15%보다 작습니다', 'COST_EXCEEDS_TARGET'],
  ['알 수 없는 신규 사유', 'UNKNOWN_REASON'],
] as const;

for (const [reason, code] of cases) {
  test('diagnose scalp: ' + code + ': ' + reason, () => {
    const d = diagnoseScalpSignal({ signal: null, reason });
    eq(d.code, code);
    eq(d.reason, reason);
    eq(d.signalPresent, false);
  });
}

test('diagnose scalp: unknown never becomes pass', () => {
  eq(diagnoseScalpSignal({ signal: null, reason: '' }).code, 'UNKNOWN_REASON');
});

test('diagnose scalp: actual signal is present', () => {
  const result = { signal: { side: 'LONG' }, reason: '' } as unknown as ScalpResult;
  const d = diagnoseScalpSignal(result);
  eq(d.code, 'SIGNAL_PRESENT');
  eq(d.signalPresent, true);
});
