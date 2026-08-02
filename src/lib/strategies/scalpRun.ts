// src/lib/strategies/scalpRun.ts
//
// 단타 신호를 **주문 경로가 받는 모양**으로 바꾼다.
//
// 왜 라우트에 직접 안 쓰는가
// ──────────────────────────
// 라우트는 테스트하기 어렵다(fetch·인증·DB). 그런데 여기서 틀리기 쉬운
// 것들 — 봉 주기 문자열, 손절 방향, 재진입 간격 — 은 전부 순수 계산이다.
// 순수한 부분을 떼어 놓으면 테스트가 고정할 수 있다.
//
// **planPosition을 우회하지 않는다**
// ─────────────────────────────────
// 단타라고 별도 사이징을 짜면 위험 계층이 두 벌이 된다. 그러면 일일 손실
// 한도·청산가 검사·배율 상한이 한쪽에만 있게 되고, 어느 쪽이 실제로
// 도는지 아무도 모르게 된다. 그래서 여기서는 StandardSignal까지만 만들고,
// 크기와 배율은 riskManager가 정한다.

import type { StandardSignal } from '../engine/signalGateway';
import type { ScalpSignal } from './scalpSignal';

/**
 * 분 단위를 바이낸스 kline interval 문자열로.
 *
 * **거래소가 지원하는 값만 돌려준다.** '7m' 같은 것을 만들어 보내면
 * 거래소가 400을 주는데, 그 시점에는 이미 사용자가 7분을 골라 저장한
 * 뒤라 왜 안 도는지 알기 어렵다. 지원하지 않으면 여기서 null이다.
 */
export function klineInterval(min: number): string | null {
  const m = Number(min);
  if (!Number.isFinite(m) || m < 1) return null;
  const TABLE: Array<[number, string]> = [
    [1, '1m'], [3, '3m'], [5, '5m'], [15, '15m'], [30, '30m'],
    [60, '1h'], [120, '2h'], [240, '4h'], [360, '6h'], [480, '8h'],
    [720, '12h'], [1440, '1d'], [4320, '3d'], [10080, '1w'],
  ];
  const hit = TABLE.find(([v]) => v === m);
  return hit ? hit[1] : null;
}

/** 거래소가 지원하는 주기 목록 — 화면이 고를 수 있는 값을 여기서 읽는다 */
export const SUPPORTED_INTERVALS = [1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440] as const;

/**
 * 단타 신호를 StandardSignal로.
 *
 * bucket은 봉 주기로 정한다. 15분 이하는 'scalping'(거래당 위험 0.1~0.3%),
 * 그 위는 'daytrading'(0.3~0.7%)다. **주기가 짧을수록 위험을 줄인다** —
 * 짧은 봉일수록 신호가 잦고, 같은 위험을 걸면 하루 손실이 몇 배가 된다.
 */
export function toStandardSignal(
  sig: ScalpSignal, symbol: string, intervalMin: number, strategyId = 'scalp',
): StandardSignal | null {
  const tf = klineInterval(intervalMin);
  if (!tf) return null;
  if (!sig || !Number.isFinite(sig.entry) || !Number.isFinite(sig.stop)) return null;

  // 손절이 진입가 반대편에 있는지 마지막으로 확인한다. 여기가 뒤집히면
  // riskManager가 손절 거리를 음수로 읽고, 그 뒤 계산이 전부 무의미해진다.
  const ok = sig.side === 'LONG' ? sig.stop < sig.entry : sig.stop > sig.entry;
  if (!ok) return null;

  return {
    strategyId,
    symbol: String(symbol || '').toUpperCase().replace('/', ''),
    signal: sig.side,
    // 돌파+거래량 확인을 통과한 자리다. 그렇다고 확신이 높은 것은 아니라
    // 중간값을 준다 — confidence는 riskManager가 위험 폭을 정할 때 쓴다.
    confidence: 0.5,
    entryPrice: sig.entry,
    stopLoss: sig.stop,
    takeProfit: sig.target,
    timeframe: tf,
    timestamp: 0,   // 호출자가 채운다 (이 모듈은 시계를 읽지 않는다)
    bucket: intervalMin <= 15 ? 'scalping' : 'daytrading',
  };
}

/**
 * 다시 들어가도 되는가.
 *
 * 단타 라우트는 분 단위로 불릴 수 있다. 간격을 안 보면 조건이 맞는 동안
 * **매 분 진입한다** — 그건 자동매매가 아니라 사고다.
 *
 * `lastRunMs`가 null이면 '한 번도 안 돌았다'이므로 통과다.
 * **못 읽은 것(NaN)은 통과가 아니다** — 언제 마지막으로 냈는지 모르는
 * 채로 또 내면 중복 진입이 된다.
 */
export function reentryCheck(
  lastRunMs: number | null | undefined, nowMs: number, intervalMin: number,
): { allowed: boolean; reason: string; waitMin: number } {
  const gapMs = Math.max(1, Number(intervalMin) || 1) * 60_000;
  if (lastRunMs == null) return { allowed: true, reason: '', waitMin: 0 };
  if (!Number.isFinite(lastRunMs)) {
    return { allowed: false, reason: '마지막 실행 시각을 읽지 못했습니다 — 중복 진입을 막을 수 없어 건너뜁니다', waitMin: 0 };
  }
  const since = nowMs - lastRunMs;
  if (since < 0) {
    // 마지막 실행이 미래다. 시계가 어긋났거나 값이 잘못된 것이고, 어느
    // 쪽이든 간격 판단의 근거가 없다.
    return { allowed: false, reason: '마지막 실행 시각이 미래입니다 — 시계가 어긋났습니다', waitMin: 0 };
  }
  if (since < gapMs) {
    const waitMin = Math.ceil((gapMs - since) / 60_000);
    return { allowed: false, reason: `아직 간격이 안 됐습니다 — ${waitMin}분 남음`, waitMin };
  }
  return { allowed: true, reason: '', waitMin: 0 };
}

/**
 * 이 주기에 필요한 봉 개수.
 *
 * 모자라면 ATR도 돌파 기준선도 못 만든다. 넉넉히 받는다 — 거래소 호출
 * 한 번의 비용보다 신호를 못 내는 비용이 크다.
 */
export function barsNeeded(lookback: number, atrPeriod: number): number {
  return Math.max(lookback, atrPeriod) + 20;
}
