// src/lib/strategies/entryLedger.ts
//
// **진입 증거를 장부 상태로 옮기는 단 하나의 표.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// daily-ladder는 이렇게 갈렸다:
//
//     exec.ok ? confirmReservation(...)      // → status OPEN
//             : releaseReservation(...)      // → 예약 행 DELETE
//
// 두 갈래뿐이라 **"모른다"가 갈 곳이 없었다.**
//
// `executeOrder`의 `ok: false`에는 서로 다른 세 가지가 섞여 있다:
//
//   REJECTED  거래소가 거부했다      — 안 나갔다
//   FAILED    보내지 못했다          — 안 나갔다
//   UNKNOWN   응답을 못 받았다       — **나갔는지 모른다**
//
// 마지막 것을 `releaseReservation`으로 보내면 예약 행이 지워지고,
// `(user_id, strategy_id, trade_date)` unique가 풀린다. 즉 **하루 1회
// 잠금이 열린다.** 그 상태에서 다음 주기가 오면 같은 날 두 번째 주문이
// 나가고, 앞 주문이 실제로는 체결돼 있었다면 포지션이 두 배가 된다.
//
// 아래쪽 방어(clientOrderId 멱등성 · 상태 대조)가 받아 주기는 한다.
// 그래도 **상위 장부가 먼저 문을 여는 구조는 그 자체로 틀렸다.**
// 모르는 것은 통과가 아니다.
//
// 반대 방향도 마찬가지다. `ok: true`는 접수(ACKED)만으로도 참이다.
// 그걸 진입 완료로 적으면 체결되지 않은 주문이 장부에 남고, 그 위에서
// 계산한 손익은 처음부터 틀린다.
//
// 무엇으로 정하는가
// ─────────────────
// `entryEvidence.enteredVerdict()`가 이미 증거를 모아 네 가지로 판정한다.
// 이 파일은 그 네 가지를 **장부 행이 어떤 상태로 남을지**로만 옮긴다.
// 판정을 여기서 다시 하지 않는다 — 같은 판단이 두 곳에 있으면 갈린다.

import type { EnteredCode } from '../engine/entryEvidence';

/** 예약 행에 남을 상태 */
export type LedgerStatus =
  /** 진입이 증거로 확인됐다 */
  | 'OPEN'
  /** 들어갔는데 보호주문이 없다. **포지션은 있다** */
  | 'UNPROTECTED'
  /** 나갔는지 모른다. **하루 잠금은 유지한다** */
  | 'RECONCILE_REQUIRED';

export interface EntryLedgerPlan {
  /** 예약 행을 지울 것인가 (= 오늘 하루를 돌려줄 것인가) */
  releaseDay: boolean;
  /** 지우지 않는다면 어떤 상태로 남기는가 */
  status: LedgerStatus | null;
  /** 이 거래를 청산 감시가 봐야 하는가 */
  monitor: boolean;
  /** 같은 날 다시 주문을 내도 되는가. **UNKNOWN이면 안 된다** */
  allowRetryToday: boolean;
  /** 장부에 남길 사유 */
  note: string;
}

/**
 * 진입 판정 → 장부 행의 운명.
 *
 * **순수 함수다.** 네트워크도 DB도 안 본다 — 여기가 틀리면 하루 1회
 * 제약이 풀리거나, 실제로 열린 포지션이 장부에서 사라진다.
 */
export function entryLedgerPlan(code: EnteredCode): EntryLedgerPlan {
  switch (code) {
    case 'ENTERED':
      return {
        releaseDay: false, status: 'OPEN', monitor: true, allowRetryToday: false,
        note: '진입이 거래소 증거로 확인됐습니다',
      };

    case 'NOT_ENTERED':
      // **여기만 하루를 돌려준다.** 거절 + 재조회에서 포지션 없음처럼
      // "안 들어갔다"가 확인된 경우다. 모르는 것은 여기 오지 않는다.
      return {
        releaseDay: true, status: null, monitor: false, allowRetryToday: true,
        note: '주문이 나가지 않은 것이 확인돼 오늘 한 번을 돌려줍니다',
      };

    case 'ENTERED_UNPROTECTED':
      // 포지션은 있다. **지우면 안 된다** — 지우면 보호 없는 포지션을
      // 아무도 안 보게 된다. 감시 대상으로 남기고 재진입은 막는다.
      return {
        releaseDay: false, status: 'UNPROTECTED', monitor: true, allowRetryToday: false,
        note: '포지션은 확인됐지만 보호주문을 확인하지 못했습니다 — 청산 감시가 계속 봅니다',
      };

    case 'UNKNOWN':
    default:
      // **모르는 것은 통과가 아니다.** 하루 잠금을 유지하고, 거래소에
      // 물어봐서 확정될 때까지 재주문을 열지 않는다.
      return {
        releaseDay: false, status: 'RECONCILE_REQUIRED', monitor: true, allowRetryToday: false,
        note: '주문이 나갔는지 확인하지 못했습니다 — 오늘 한 번을 돌려주지 않습니다. '
          + '돌려주면 같은 날 두 번째 주문이 나가고, 앞 주문이 체결돼 있었다면 포지션이 두 배가 됩니다',
      };
  }
}

/**
 * 청산 감시가 훑어야 할 상태들.
 *
 * **`OPEN` 하나만 보면 안 된다.** 보호 없는 포지션과 미확정 주문이야말로
 * 가장 먼저 봐야 할 것들이다.
 */
export const MONITORED_STATUSES: LedgerStatus[] = ['OPEN', 'UNPROTECTED', 'RECONCILE_REQUIRED'];

/** 이 상태가 "확인된 열린 거래"인가. 화면의 건수는 이것만 센다 */
export function isConfirmedOpen(status: any): boolean {
  return String(status ?? '').toUpperCase() === 'OPEN';
}
