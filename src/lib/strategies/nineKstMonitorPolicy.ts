/**
 * 09:00 KST 진입 이후 포지션 감시 판단 — 연구용 순수 함수.
 * 주문/스케줄러에 연결하지 않는다. 시간 경과만으로 청산하지 않는다.
 * 실제 청산 권한은 별도 감사·테스트 후 연결한다.
 */
export type MonitorDecision =
  | { action: 'CLOSE_SIGNAL'; reason: 'EXIT_SIGNAL' }
  | { action: 'KEEP_MONITORING'; reason: 'NO_EXIT_SIGNAL' }
  | { action: 'UNVERIFIED'; reason: 'STALE_MARKET_DATA' | 'MONITOR_HEALTH_UNKNOWN' | 'INVALID_INPUT' };

export interface MonitorInput {
  nowMs: number;
  marketDataAtMs: number;
  maxMarketAgeMs: number;
  monitorHealthy: boolean | null;
  exitSignal: boolean | null;
}

/** 상태 불명은 '계속 보유해도 안전'으로 읽지 않는다. */
export function decideMonitoredExit(i: MonitorInput): MonitorDecision {
  if (![i.nowMs, i.marketDataAtMs, i.maxMarketAgeMs].every(Number.isFinite)
    || i.maxMarketAgeMs <= 0 || i.marketDataAtMs > i.nowMs) {
    return { action: 'UNVERIFIED', reason: 'INVALID_INPUT' };
  }
  if (i.nowMs - i.marketDataAtMs > i.maxMarketAgeMs) {
    return { action: 'UNVERIFIED', reason: 'STALE_MARKET_DATA' };
  }
  if (i.monitorHealthy !== true || i.exitSignal === null) {
    return { action: 'UNVERIFIED', reason: 'MONITOR_HEALTH_UNKNOWN' };
  }
  return i.exitSignal
    ? { action: 'CLOSE_SIGNAL', reason: 'EXIT_SIGNAL' }
    : { action: 'KEEP_MONITORING', reason: 'NO_EXIT_SIGNAL' };
}

/** UTC epoch millisecond 기준 매일 한국시간 09:00의 날짜 키. DST 가정 없음. */
export function kstNineEntryWindowKey(nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;
  const kst = new Date(nowMs + 9 * 60 * 60_000);
  if (!Number.isFinite(kst.getTime())) return null;
  const date = kst.toISOString().slice(0, 10);
  const hh = kst.getUTCHours();
  return hh >= 9 ? date : new Date(nowMs + 9 * 60 * 60_000 - 86_400_000).toISOString().slice(0, 10);
}
