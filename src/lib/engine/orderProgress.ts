// src/lib/engine/orderProgress.ts
//
// **주문 한 번은 한 사건이 아니다.**
//
// 화면은 지금 "주문 접수됨" 하나로 끝난다. 그런데 실제로 일어나는 일은
// 다섯 단계다:
//
//   전송 → 거래소 접수 → 체결 → 포지션 확인 → 보호 주문 확인
//
// 그 다섯을 한 줄로 뭉치면 **어디까지 갔는지 아무도 모른다.** 접수만
// 되고 체결이 안 됐는데 사용자는 다 됐다고 읽고, 반대로 체결됐는데
// 화면이 안 바뀌면 안 됐다고 읽는다. 뒤가 더 비싸다 — 한 번 더 누르면
// 포지션이 두 배가 되고, 그건 사용자가 정한 크기가 아니다.
//
// 이 파일이 하는 일
// ─────────────────
// **관측한 사실만 받아서 지금 어느 단계인지 말한다.** 거래소도 저장소도
// 안 부른다 — 그래야 "체결 미확정일 때 재주문이 잠기는가"에 테스트를
// 붙일 수 있다.
//
// 규칙 하나: **확정되기 전에는 잠근다.** 확정이란 거래소가 결과를
// 말해 준 것이고, 우리가 기다리다 지친 것이 아니다.

import type { FillVerdict } from './fillPoll';

export type ProgressStage =
  /** 아직 안 보냈다 */
  | 'IDLE'
  /** 보내는 중 */
  | 'SUBMITTING'
  /** 거래소가 받았다. **체결은 아직 모른다** */
  | 'ACCEPTED'
  /** 일부 붙었다 */
  | 'PARTIAL'
  /** 다 붙었다 */
  | 'FILLED'
  /** 보호 주문까지 확인됐다 */
  | 'PROTECTED'
  /** 보호 주문이 없다 — 포지션은 있는데 */
  | 'UNPROTECTED'
  /** 결과를 모른다 */
  | 'UNKNOWN'
  /** 거절·실패 */
  | 'FAILED';

export interface ProgressInput {
  /** 요청을 보냈는가 */
  sent?: boolean;
  /** 응답이 왔는가 */
  responded?: boolean;
  /** 서버가 ok를 줬는가 */
  ok?: boolean;
  /** 체결 판정 (fillPoll). 없으면 서버가 안 준 것이다 */
  fill?: Pick<FillVerdict, 'phase' | 'settled' | 'filledQty' | 'requestedQty'> | null;
  /**
   * 서버의 settled. **fill이 없을 때 쓰는 값이다** —
   * 바이낸스 경로는 아직 이 값을 안 준다(undefined).
   */
  settled?: boolean | null;
  /** 보호 주문이 걸렸는가 */
  protectedNow?: boolean | null;
  /** 진입인데 보호가 없다고 서버가 말했는가 */
  unprotected?: boolean | null;
}

export interface ProgressView {
  stage: ProgressStage;
  /** 화면에 적을 한 줄 */
  label: string;
  /** 다섯 단계 중 몇 번째까지 왔는가 (0~5) */
  step: number;
  /**
   * 같은 방향 재주문을 잠글 것인가.
   *
   * **모르는 동안 잠근다.** 사용자가 "안 됐네" 하고 한 번 더 누르는
   * 사이에 앞 주문이 붙으면 포지션이 두 배가 된다.
   */
  locked: boolean;
  /** 왜 잠겼는지. 잠기지 않았으면 빈 문자열 */
  lockReason: string;
}

/** 화면에 순서대로 그릴 단계 이름 */
export const PROGRESS_STEPS: readonly string[] = [
  '전송', '거래소 접수', '체결', '포지션 확인', '손절 확인',
];

const view = (
  stage: ProgressStage, label: string, step: number,
  locked: boolean, lockReason = '',
): ProgressView => ({ stage, label, step, locked, lockReason });

/**
 * 지금 어느 단계인가.
 *
 * **응답이 안 왔으면 잠근다.** 그 사이가 가장 위험하다 — 사용자는
 * 아무 반응이 없는 화면을 보고 다시 누른다.
 */
export function progressOf(input: ProgressInput | null | undefined): ProgressView {
  const i = input ?? {};

  if (!i.sent) return view('IDLE', '', 0, false);
  if (!i.responded) {
    return view('SUBMITTING', '주문 전송 중…', 1, true,
      '응답을 기다리는 중입니다 — 이 사이에 다시 누르면 두 번 나갈 수 있습니다');
  }
  if (i.ok === false) {
    // 실패는 잠그지 않는다. 사유를 고치고 다시 시도할 수 있어야 한다.
    return view('FAILED', '주문 실패', 1, false);
  }

  // 체결 판정이 있으면 그것이 우선이다. 없으면 서버의 settled를 본다.
  const phase = i.fill?.phase ?? null;
  const settled = i.fill?.settled ?? (i.settled ?? null);

  if (phase === 'UNFILLED') {
    return view('FAILED', '체결되지 않음', 2, false);
  }

  // **settled를 안 준 경로**(바이낸스)는 예전처럼 동작한다. 여기서
  // 잠그면 지금까지 되던 주문이 갑자기 한 번씩 막힌다.
  if (settled == null && phase == null) {
    return view('ACCEPTED', '거래소 접수됨', 2, false);
  }

  if (settled === false) {
    return view(
      phase === 'PARTIAL' ? 'PARTIAL' : 'ACCEPTED',
      phase === 'PARTIAL'
        ? `부분 체결 ${i.fill?.filledQty ?? '?'}/${i.fill?.requestedQty ?? '?'} · 나머지 확인 중…`
        : '거래소 접수됨 · 체결 확인 중…',
      phase === 'PARTIAL' ? 3 : 2,
      true,
      '체결 결과가 아직 확정되지 않았습니다 — 지금 다시 누르면 포지션이 두 배가 될 수 있습니다',
    );
  }

  // 여기부터는 확정된 상태다.
  if (i.unprotected === true) {
    return view('UNPROTECTED', '체결됨 · 보호되지 않은 포지션', 4, false);
  }
  if (i.protectedNow === true) {
    return view('PROTECTED', '체결 완료 · 손절 확인', 5, false);
  }
  if (phase === 'PARTIAL') {
    return view('PARTIAL',
      `부분 체결 ${i.fill?.filledQty ?? '?'}/${i.fill?.requestedQty ?? '?'}로 종료`, 3, false);
  }
  return view('FILLED', '체결 완료', 3, false);
}

/**
 * 체결이 확정된 뒤에 **무엇을 다시 읽어야 하는가.**
 *
 * 하나만 읽으면 화면이 반쯤만 맞는다 — 포지션은 새 값인데 잔고는 옛
 * 값이면, 사용자는 그 차이를 보고 계산을 다시 한다.
 */
export const REFRESH_AFTER_FILL: readonly string[] = [
  'positions', 'openOrders', 'balances', 'protection',
];

/** 이 단계에서 화면을 다시 읽어야 하는가 */
export function shouldRefresh(v: ProgressView): boolean {
  return v.stage === 'FILLED' || v.stage === 'PARTIAL'
    || v.stage === 'PROTECTED' || v.stage === 'UNPROTECTED';
}
