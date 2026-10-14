import { test, eq } from '../../test/harness';
import { decideMonitoredExit, kstNineEntryWindowKey } from './nineKstMonitorPolicy';

export function runNineKstMonitorPolicyTests() {
  test('09시 KST 이전에는 전날 판단 창', () => {
    eq(kstNineEntryWindowKey(Date.parse('2026-10-14T23:59:00+09:00')), '2026-10-14');
    eq(kstNineEntryWindowKey(Date.parse('2026-10-15T08:59:59+09:00')), '2026-10-14');
    eq(kstNineEntryWindowKey(Date.parse('2026-10-15T09:00:00+09:00')), '2026-10-15');
  });
  test('청산 신호가 있을 때만 청산 후보', () => {
    const base = { nowMs: 1_000_000, marketDataAtMs: 999_000, maxMarketAgeMs: 5_000, monitorHealthy: true, exitSignal: false };
    eq(decideMonitoredExit(base).action, 'KEEP_MONITORING');
    eq(decideMonitoredExit({ ...base, exitSignal: true }).action, 'CLOSE_SIGNAL');
  });
  test('시장 데이터가 오래되면 안전한 보유로 판정하지 않음', () => {
    eq(decideMonitoredExit({ nowMs: 1_000_000, marketDataAtMs: 990_000, maxMarketAgeMs: 5_000, monitorHealthy: true, exitSignal: true }).action, 'UNVERIFIED');
  });
  test('감시 상태나 청산 신호를 모르면 미확인', () => {
    const base = { nowMs: 1_000_000, marketDataAtMs: 999_000, maxMarketAgeMs: 5_000, monitorHealthy: null, exitSignal: false };
    eq(decideMonitoredExit(base).action, 'UNVERIFIED');
    eq(decideMonitoredExit({ ...base, monitorHealthy: true, exitSignal: null }).action, 'UNVERIFIED');
  });
  test('미래 데이터와 잘못된 시간은 미확인', () => {
    eq(decideMonitoredExit({ nowMs: 1_000_000, marketDataAtMs: 1_000_001, maxMarketAgeMs: 5_000, monitorHealthy: true, exitSignal: true }).action, 'UNVERIFIED');
    eq(kstNineEntryWindowKey(NaN), null);
  });
}
