// src/lib/autotrade/entryWindowDue.ts
//
// **창을 가진 전략은 간격이 아니라 창을 기준으로 깨운다.**
//
// 왜 이 파일이 생겼는가
// ─────────────────────
// `my-original-v1`은 한국시간 09:10~09:30 **20분짜리 창**에서만 판단한다.
// 그런데 그 전략을 깨우는 `dueCheck`는 창을 모른다 — `last_run_at`에
// 간격(분)을 더한 위상만 본다.
//
// 간격 60분이면 평가는 매시 같은 분(위상 p)에 한 번 일어난다. 그래서
// 09:00~10:00 사이의 평가는 **딱 한 번, 09:p에** 온다:
//
//   p가 10~30  → 창 안 (정시 판단)                    약 35%
//   p가 31~59  → 창은 닫혔고 유예 안 (늦은 판단)      약 48%
//   p가 0~9    → 다음 평가가 10:p → 유예도 지남       약 17%
//
// 즉 **위상이 어디에 있느냐가 그날 진입의 운명을 정한다.** 그리고 위상은
// 폴링 지터 때문에 매 시간 조금씩 밀린다 — 사람이 고를 수도, 고정할 수도
// 없는 값이다. 2026-10-20 실측에서 워커의 위상은 :39~:42였고, 그 위상이면
// 창 평가는 **매일 9~12분 늦게** 일어난다.
//
// 100배에서 09:10~09:30 봉을 보고 정한 방향으로 30분 뒤에 들어가는 것은
// 같은 거래가 아니다. `originalV1.ts`가 유예를 30분으로 짧게 잡아 둔
// 이유가 그것인데, 간격 관문이 그 유예를 **기본값처럼** 쓰고 있었다.
//
// 무엇을 바꾸는가 — 더하기만 한다
// ───────────────────────────────
// 이 판정은 "평가해도 된다"를 **더하기만 한다.** 막던 것을 열지 않는다:
//
//   · `MIN_GAP_MS`(1분) 중복 방지는 이 판정보다 **먼저** 걸린다
//   · 하루 1회는 전략 라우트의 `ALREADY_DONE`이 계속 강제한다
//   · 선점(CAS)이 두 실행기의 동시 평가를 계속 막는다
//
// 그래서 늘어나는 것은 **하루 한 번, 창이 열린 직후의 평가 한 번**이다.
// 창 안에서 매 분 깨우지 않는다 — 그러면 50분짜리 창에서 평가가 50번
// 돌고, 지금 이 저장소는 egress 할당량 때문에 서비스가 제한된 참이다.

import {
  kstMinuteOfDay, WINDOW_START_KST, WINDOW_END_KST, LATE_GRACE_MIN,
} from '../strategies/originalV1';

export interface EntryWindow {
  /** 창 시작 (KST 자정부터의 분) */
  startMin: number;
  /** 창 끝 (KST 자정부터의 분) */
  endMin: number;
  /** 창이 닫힌 뒤 몇 분까지 늦게라도 판단하는가 */
  graceMin: number;
}

export type WindowDueCode =
  /** 창(또는 유예)이 열려 있고 오늘 아직 이 창에서 평가하지 않았다 */
  | 'WINDOW_OPEN'
  /** 창은 열려 있지만 오늘 이미 이 창에서 평가했다 */
  | 'WINDOW_DONE'
  /** 지금은 창 밖이다 — 간격 관문이 판단한다 */
  | 'OUTSIDE'
  /** 한국 시각을 읽지 못했다 — **창을 안다고 말하지 않는다** */
  | 'CLOCK_UNKNOWN';

export interface WindowDueVerdict {
  /** 창을 근거로 **지금 평가해도 되는가.** false는 "막는다"가 아니라
   *  "이 판정은 근거를 주지 않는다"는 뜻이다 — 간격 관문이 이어 받는다 */
  due: boolean;
  code: WindowDueCode;
  reason: string;
}

/**
 * 전략이 가진 진입 창. 창이 없는 전략이면 null.
 *
 * **표를 여기 한 곳에만 둔다.** 창 값이 두 곳에 있으면 한쪽만 고쳐지고,
 * 그때 틀어지는 것은 "어느 시각에 주문이 나가는가"다.
 */
export function entryWindowOf(strategyId: any): EntryWindow | null {
  if (String(strategyId ?? '') !== 'my-original-v1') return null;
  // 값 자체는 전략 정본(`originalV1.ts`)이 가진다. 여기서 숫자를 다시
  // 적으면 창을 옮길 때 두 곳을 고쳐야 한다.
  return {
    startMin: WINDOW_START_KST.hh * 60 + WINDOW_START_KST.mm,
    endMin: WINDOW_END_KST.hh * 60 + WINDOW_END_KST.mm,
    graceMin: LATE_GRACE_MIN,
  };
}

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 창을 근거로 지금 평가할 차례인가.
 *
 * "오늘 이 창에서 이미 평가했는가"는 `last_run_at`이 **오늘 창 시작보다
 * 뒤인가**로 본다. 그래서 창이 열려 있는 동안 평가는 정확히 한 번 늘어난다.
 */
export function windowDueVerdict(i: {
  nowMs: number;
  lastRunAtMs: number | null;
  window: EntryWindow | null;
}): WindowDueVerdict {
  const w = i.window;
  if (!w) return { due: false, code: 'OUTSIDE', reason: '창을 가진 전략이 아닙니다' };

  const nowMin = kstMinuteOfDay(i.nowMs);
  if (nowMin == null) {
    // **못 읽은 것을 '창 밖'이라고 적지 않는다.** 코드를 따로 남겨
    // 간격 관문이 이어 받았다는 사실이 기록에 보이게 한다.
    return { due: false, code: 'CLOCK_UNKNOWN', reason: '한국 시각을 읽지 못했습니다' };
  }

  const closeMin = w.endMin + w.graceMin;
  if (nowMin < w.startMin || nowMin > closeMin) {
    return { due: false, code: 'OUTSIDE',
      reason: `창(${hhmm(w.startMin)}~${hhmm(w.endMin)} KST) 밖입니다` };
  }

  // 창이 열려 있다. 오늘 창 시작 시각을 **지금에서 역산한다** — nowMin이
  // startMin 이상인 것이 위에서 보장되므로 같은 한국 날짜 안이다.
  const windowStartMs = i.nowMs - (nowMin - w.startMin) * 60_000;

  if (i.lastRunAtMs != null && i.lastRunAtMs >= windowStartMs) {
    return { due: false, code: 'WINDOW_DONE',
      reason: `오늘 ${hhmm(w.startMin)} 창에서 이미 평가했습니다` };
  }

  const lateMin = Math.max(0, nowMin - w.endMin);
  return {
    due: true, code: 'WINDOW_OPEN',
    reason: lateMin > 0
      ? `창(${hhmm(w.startMin)}~${hhmm(w.endMin)} KST)이 ${lateMin}분 전에 닫혔지만 유예 안입니다 — 지금 판단합니다`
      : `창(${hhmm(w.startMin)}~${hhmm(w.endMin)} KST) 안입니다 — 지금 판단합니다`,
  };
}
