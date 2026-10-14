// Read-only classification of existing scalpSignal results.
// No order placement, thresholds, or execution contracts are changed.
import type { ScalpResult } from './scalpSignal';

export type ScalpSignalReasonCode =
  | 'SIGNAL_PRESENT'
  | 'NO_BREAKOUT'
  | 'VOLUME_BELOW_THRESHOLD'
  | 'VOLUME_UNAVAILABLE'
  | 'BARS_UNAVAILABLE'
  | 'BARS_INSUFFICIENT'
  | 'BAR_DATA_INVALID'
  | 'PRICE_UNAVAILABLE'
  | 'ATR_UNAVAILABLE'
  | 'STOP_INVALID'
  | 'COST_EXCEEDS_TARGET'
  | 'UNKNOWN_REASON';

export interface ScalpSignalDiagnosis {
  code: ScalpSignalReasonCode;
  /** Original reason is retained for display; never treat UNKNOWN as pass. */
  reason: string;
  signalPresent: boolean;
}

/** Classify the actual result; never rerun the strategy or fabricate market data. */
export function diagnoseScalpSignal(result: ScalpResult): ScalpSignalDiagnosis {
  if (result.signal !== null) {
    return { code: 'SIGNAL_PRESENT', reason: '', signalPresent: true };
  }
  const reason = String(result.reason ?? '');
  const code: ScalpSignalReasonCode =
    reason.startsWith('돌파 없음') ? 'NO_BREAKOUT'
    : reason.startsWith('돌파했지만 거래량이 부족합니다') ? 'VOLUME_BELOW_THRESHOLD'
    : reason.includes('거래량을 확인하지 못했습니다') || reason.includes('평균 거래량이 0입니다') ? 'VOLUME_UNAVAILABLE'
    : reason === '봉 데이터가 없습니다' ? 'BARS_UNAVAILABLE'
    : reason.startsWith('봉이 모자랍니다') || reason === '돌파 기준을 만들 봉이 모자랍니다' ? 'BARS_INSUFFICIENT'
    : reason.includes('봉이 있습니다') || reason.includes('개수가 종가와 다릅니다') || reason === '돌파 기준을 만들지 못했습니다' ? 'BAR_DATA_INVALID'
    : reason === '현재가를 읽지 못했습니다' ? 'PRICE_UNAVAILABLE'
    : reason.includes('변동성(ATR)') ? 'ATR_UNAVAILABLE'
    : reason.includes('손절 폭') || reason.includes('손절가') ? 'STOP_INVALID'
    : reason.startsWith('목표 ') && reason.includes('왕복 비용') ? 'COST_EXCEEDS_TARGET'
    : 'UNKNOWN_REASON';
  return { code, reason, signalPresent: false };
}
