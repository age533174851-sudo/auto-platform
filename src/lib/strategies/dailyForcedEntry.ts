// src/lib/strategies/dailyForcedEntry.ts
//
// **매일 09:00 KST에 신호와 관계없이 한 번 진입을 시도한다 (TESTNET 전용).**
//
// 기존 정책과 무엇이 다른가
// ─────────────────────────
// 지금까지 09시 진입은 두 가지가 **동시에** 맞아야 났다.
//
//   ① `my-original-v1`의 판단 창  09:10~09:30 KST
//   ② 그 창 안에서 **신호가 날 것**  (돌파 + 거래량 + 비용 대비 목표)
//
// Exact100X는 `scalp` 경로를 쓰는데 그쪽도 같다 — `scalpSignal`이
// 돌파·거래량·비용 세 관문을 통과해야 신호가 나고, 대부분의 날은 나지
// 않는다. 그래서 라우트는 `signal: null`로 끝났고, **주문은 한 번도
// 만들어지지 않았다.**
//
// 최신 요구는 다르다: **매일 09:00 KST에 신호와 관계없이 시도한다.**
//   · 창 시작이 09:10이 아니라 **09:00**이다.
//   · 돌파·거래량·비용 필터를 **통과하지 못해도** 시도한다.
//
// 무엇을 **그대로 두는가** — 중요하다
// ───────────────────────────────────
// 없애는 것은 **재량 필터 세 개뿐**이다. 안전 관문은 하나도 건드리지
// 않는다: dormantGate · riskManager · 청산가 검사 · 기존 포지션/미결
// 주문 확인 · 보호주문 정책 · killSwitch · 수량 양자화는 전부 기존
// 경로 그대로 지나간다. 크기 계산도 같은 ATR 수치를 쓴다 — 방향과
// 필터만 빼고 나머지를 새로 짜면 "강제 진입만 다른 크기"가 된다.
//
// **`my-original-v1`은 건드리지 않는다.** 그 전략의 창과 신호는 그대로
// 두고, 이 정책은 Exact100X(`MAX_LEV_100X` · `EXACT_100X`) TESTNET
// 예약에만 적용한다.

import { tradingDayKst, kstMinuteOfDay } from './originalV1';
import { atr, type Bars, type ScalpConfig, type ScalpResult, type ScalpSide } from './scalpSignal';

/** 강제 진입 창 시작 (KST). **원본 전략의 09:10과 다르다** */
export const FORCED_ENTRY_START_KST = { hh: 9, mm: 0 };

/**
 * 창 길이(분).
 *
 * 실행기는 주기적으로 와서 본다 — 09:00 정각에 반드시 깨어 있지 않다.
 * 창이 1분이면 실행기가 2분 늦은 날은 그날 진입이 통째로 없어지고,
 * 그 사실이 "신호가 없었다"와 구분되지 않는다.
 */
export const FORCED_ENTRY_WINDOW_MIN = 30;

/**
 * 방향.
 *
 * 신호를 보지 않기로 했으므로 방향을 줄 것이 없다. **추측하지 않고
 * 고정한다** — 시장을 보고 고르면 그것이 곧 신호이고, 요구사항과
 * 어긋난다. 바꾸려면 이 한 곳만 바꾼다.
 */
export const FORCED_ENTRY_SIDE: ScalpSide = 'LONG';

/** 이 정책이 열리는 조합. **TESTNET 전용이다** */
export const FORCED_ENTRY_PROFILE_ID = 'MAX_LEV_100X';
export const FORCED_ENTRY_PRESET_ID = 'EXACT_100X';
export const FORCED_ENTRY_MODE = 'TESTNET';

export type ForcedEntryCode =
  /** 지금 시도할 차례다 */
  | 'DUE'
  /** 아직 09:00 전이다 */
  | 'BEFORE_WINDOW'
  /** 창이 지났다 — 오늘은 넘긴다. 다음 날 창을 기다린다 */
  | 'AFTER_WINDOW'
  /** 오늘 이미 주문을 냈다 */
  | 'ALREADY_TODAY'
  /** 오늘 냈는지 **확인하지 못했다.** 모르면 내지 않는다 */
  | 'HISTORY_UNKNOWN'
  /** 실전·모의 등 TESTNET이 아니다 */
  | 'NOT_TESTNET'
  /** Exact100X 계약이 아니다 */
  | 'NOT_EXACT100X'
  /** 시계를 읽지 못했다 */
  | 'CLOCK_UNREADABLE';

export interface ForcedEntryVerdict {
  /** 신호 없이 진입을 시도해도 되는가 */
  due: boolean;
  code: ForcedEntryCode;
  /** 이 판단이 속한 거래일(KST). 기록·중복 방지의 열쇠 */
  tradingDay: string | null;
  reason: string;
}

/**
 * 지금 **신호 없이** 진입을 시도할 차례인가.
 *
 * 중복 방지를 왜 플래그가 아니라 주문 기록으로 하는가
 * ───────────────────────────────────────────────────
 * 플래그를 따로 두면 "플래그는 섰는데 주문은 안 나간" 상태가 생기고,
 * 그날은 영영 진입하지 못한다. 재시작 한 번이면 그 모양이 난다.
 *
 * 그래서 묻는 것은 **"오늘 창에서 이 예약이 실제로 주문을 냈는가"**다.
 * 막혀서 못 낸 회차는 창이 닫히기 전까지 다시 시도한다 — 그게 맞다.
 *
 * 그리고 **못 읽은 것은 "안 냈다"가 아니다.** 조회에 실패하면
 * `HISTORY_UNKNOWN`으로 막는다. 모르는 채로 또 내면 중복 진입이다.
 */
export function forcedEntryVerdict(i: {
  nowMs: number;
  mode: any;
  profileId: any;
  presetId: any;
  /** 오늘 창에서 이 예약이 낸 주문 수. **읽지 못했으면 null** */
  ordersTodayInWindow: number | null | undefined;
}): ForcedEntryVerdict {
  const no = (code: ForcedEntryCode, reason: string, tradingDay: string | null = null)
    : ForcedEntryVerdict => ({ due: false, code, tradingDay, reason });

  if (String(i?.mode ?? '').toUpperCase() !== FORCED_ENTRY_MODE) {
    return no('NOT_TESTNET',
      `강제 진입은 ${FORCED_ENTRY_MODE}에서만 돕니다 (받은 값: ${i?.mode}) — `
      + '실전 자금으로 신호 없이 주문을 내지 않습니다');
  }
  if (String(i?.profileId ?? '') !== FORCED_ENTRY_PROFILE_ID
    || String(i?.presetId ?? '') !== FORCED_ENTRY_PRESET_ID) {
    return no('NOT_EXACT100X',
      `강제 진입은 ${FORCED_ENTRY_PROFILE_ID}/${FORCED_ENTRY_PRESET_ID} 계약에만 적용합니다`);
  }

  const day = tradingDayKst(i.nowMs);
  const minute = kstMinuteOfDay(i.nowMs);
  if (day == null || minute == null) {
    return no('CLOCK_UNREADABLE',
      'KST 시각을 읽지 못했습니다 — 언제인지 모르는 채로 주문을 내지 않습니다');
  }

  const startMin = FORCED_ENTRY_START_KST.hh * 60 + FORCED_ENTRY_START_KST.mm;
  const endMin = startMin + FORCED_ENTRY_WINDOW_MIN;
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  if (minute < startMin) {
    return no('BEFORE_WINDOW',
      `아직 진입 창 전입니다 (지금 ${hhmm(minute)} KST · 창 ${hhmm(startMin)}~${hhmm(endMin)})`, day);
  }
  if (minute >= endMin) {
    return no('AFTER_WINDOW',
      `${day} 진입 창(${hhmm(startMin)}~${hhmm(endMin)} KST)이 지났습니다 — `
      + '지난 창을 뒤늦게 열지 않습니다', day);
  }

  // **못 읽은 것을 0건으로 적지 않는다.**
  const n = i?.ordersTodayInWindow;
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) {
    return no('HISTORY_UNKNOWN',
      '오늘 이미 주문을 냈는지 확인하지 못했습니다 — 모르는 채로 또 내지 않습니다', day);
  }
  if (n > 0) {
    return no('ALREADY_TODAY',
      `${day} 창에서 이미 ${n}건을 냈습니다 — 하루 한 번입니다`, day);
  }

  return {
    due: true, code: 'DUE', tradingDay: day,
    reason: `${day} ${hhmm(startMin)}~${hhmm(endMin)} KST 창입니다 — 신호와 무관하게 한 번 시도합니다`,
  };
}

/**
 * 오늘 창이 **시작된 시각**(ms). 주문 기록을 좁혀 읽을 때 쓴다.
 *
 * 하루 전체를 세면 어제 늦게 난 주문이 오늘을 막는다. 창만 센다.
 */
export function forcedWindowStartMs(nowMs: number): number | null {
  const minute = kstMinuteOfDay(nowMs);
  if (minute == null || !Number.isFinite(nowMs)) return null;
  const startMin = FORCED_ENTRY_START_KST.hh * 60 + FORCED_ENTRY_START_KST.mm;
  return nowMs - (minute - startMin) * 60_000;
}

/**
 * 신호 없이 낼 주문의 **모양**을 만든다.
 *
 * 크기 계산을 새로 짜지 않는다 — `scalpSignal`과 **같은 ATR·같은
 * 배수·같은 보상비**를 쓴다. 그래야 강제 진입과 평소 진입이 같은
 * 크기로 나가고, riskManager가 보는 값의 뜻이 하나로 유지된다.
 *
 * 빼는 것은 재량 필터 셋뿐이다: 돌파 방향 · 거래량 확인 · 비용 대비 목표.
 *
 * **ATR을 읽지 못하면 만들지 않는다.** 손절 폭 0은 진입 즉시 손절이고,
 * 그것을 "강제니까 진행"으로 넘기면 안전 관문을 지운 것이 된다.
 */
export function forcedEntrySignal(
  bars: Bars, cfg: ScalpConfig, side: ScalpSide = FORCED_ENTRY_SIDE,
): ScalpResult {
  const no = (reason: string): ScalpResult => ({ signal: null, reason });
  const closes = bars?.closes;
  if (!Array.isArray(closes) || closes.length === 0) return no('봉을 읽지 못했습니다');
  const price = closes[closes.length - 1];
  if (!Number.isFinite(price) || price <= 0) return no('마지막 종가를 읽지 못했습니다');

  const a = atr(bars, cfg.atrPeriod);
  if (a == null || !(a > 0)) {
    return no('ATR을 계산하지 못했습니다 — 손절 폭을 모르는 채로 강제 진입하지 않습니다');
  }

  const stopDist = a * cfg.atrStopMult;
  if (!(stopDist > 0)) return no('손절 폭을 계산하지 못했습니다');
  const stop = side === 'LONG' ? price - stopDist : price + stopDist;
  if (!(stop > 0)) return no('손절가가 0 이하입니다');

  const targetDist = stopDist * cfg.rewardRisk;
  const target = side === 'LONG' ? price + targetDist : price - targetDist;
  const stopPct = (stopDist / price) * 100;
  const targetPct = (targetDist / price) * 100;

  return {
    signal: {
      side, entry: price, stop, target, stopPct, targetPct, atr: a,
      notes: [
        '09:00 KST 강제 진입 — 신호 판정을 거치지 않았습니다',
        `방향 고정 ${side} (시장을 보고 고르지 않습니다)`,
        `ATR ${a.toFixed(2)} · 손절 ${stopPct.toFixed(3)}% · 목표 ${targetPct.toFixed(3)}%`,
        '돌파·거래량·비용 필터만 건너뛰었고 위험 관문은 그대로 지납니다',
      ],
    },
    reason: '',
  };
}
