// src/lib/risk/killSwitchTruth.ts
//
// **킬스위치가 "완료됐다"고 말해도 되는 조건.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 킬스위치는 이 앱에서 사람이 가장 급할 때 누르는 버튼이다. 그리고
// 누른 사람은 **응답 문구를 읽고 손을 뗀다.** 그래서 그 문구가 사실보다
// 앞서 나가면, 남은 포지션을 아무도 안 본다.
//
// 실제로 어긋나 있던 것들
// ───────────────────────
// ① 기본 actionMode는 `BC`다. `D`가 없으므로 **포지션을 닫지 않는다.**
//    그런데 성공 응답은 "미체결 취소·포지션 종료 완료"라고 적었다.
//    닫은 적이 없는데 닫았다고 말한 것이다.
//
// ② 완료 판정이 `close?.success !== false`였다. `D`가 없으면 `close`가
//    `null`이라 `undefined !== false` → 참. **안 한 일이 성공으로 셌다.**
//
// ③ 이미 발동 중인데 다시 누르면 실행을 건너뛰고 `ok: true`를 줬다.
//    첫 실행이 절반만 됐을 때 사용자가 다시 누르는 것이 정확히 그
//    상황인데, 그때 아무것도 안 하고 성공이라고 답했다.
//
// ④ 리셋이 잔여를 확인하지 않고 `active=false`를 저장했다. 청산이
//    실패한 직후 리셋을 누르면 **남은 포지션 위에서 신규 진입 잠금이
//    풀린다.**
//
// 이 파일은 그 판정들을 한곳에 모은다. 네트워크도 DB도 안 본다.

/** 이번 발동이 무엇을 하기로 했는가 */
export interface KillIntent {
  /** 저장된/선택된 조합. 'B'=신규차단 'C'=미체결취소 'D'=전량종료 */
  actionMode: string;
}

export function intentOf(actionMode: any): { cancel: boolean; close: boolean; raw: string } {
  const raw = String(actionMode || '').toUpperCase();
  const close = raw.includes('D');
  // 종료하려면 취소가 선행된다 — executeKillActions와 같은 규칙이다.
  return { cancel: raw.includes('C') || close, close, raw };
}

/** 거래소에 지금 남아 있는 것. **못 읽었으면 null이다 — 0이 아니다** */
export interface Leftover {
  positions: number | null;
  orders: number | null;
  error?: string | null;
}

export type LeftoverCode =
  /** 포지션 0 · 미체결 0이 확인됐다 */
  | 'CLEAR'
  /** 남아 있는 것이 확인됐다 */
  | 'REMAINS'
  /** **못 읽었다.** 남은 게 없다는 뜻이 아니다 */
  | 'UNKNOWN';

export interface LeftoverVerdict {
  code: LeftoverCode;
  /** 포지션까지 0이어야 하는가 (전량 종료를 의도했을 때) */
  expectedClosed: boolean;
  reason: string;
}

/**
 * 남은 것이 정말 없는가.
 *
 * **`null`을 0으로 읽지 않는다.** 조회 실패를 '정리됨'으로 적으면
 * 킬스위치의 최종 보증이 거기서 끝난다.
 */
export function leftoverVerdict(i: {
  leftover: Leftover | null | undefined;
  expectedClosed: boolean;
}): LeftoverVerdict {
  const l = i.leftover;
  const expectedClosed = !!i.expectedClosed;

  if (!l) {
    return { code: 'UNKNOWN', expectedClosed,
      reason: '거래소 잔여를 확인하지 못했습니다 — 남은 것이 없다는 뜻이 아닙니다' };
  }
  if (l.orders == null || (expectedClosed && l.positions == null)) {
    return { code: 'UNKNOWN', expectedClosed,
      reason: `거래소 잔여를 확인하지 못했습니다${l.error ? ` (${l.error})` : ''} — `
        + '남은 것이 없다는 뜻이 아닙니다' };
  }
  const posLeft = expectedClosed && (l.positions ?? 0) > 0;
  const ordLeft = (l.orders ?? 0) > 0;
  if (posLeft || ordLeft) {
    return { code: 'REMAINS', expectedClosed,
      reason: `거래소에 남아 있습니다 — 포지션 ${l.positions ?? '?'} · 미체결 ${l.orders ?? '?'}` };
  }
  return { code: 'CLEAR', expectedClosed,
    reason: expectedClosed
      ? '포지션 0 · 미체결 0을 거래소에서 확인했습니다'
      : '미체결 0을 거래소에서 확인했습니다 (이번 단계는 포지션을 닫지 않습니다)' };
}

export interface KillExecView {
  ran?: boolean;
  cancel?: { ran?: boolean; success?: boolean } | null;
  close?: { ran?: boolean; success?: boolean; remaining?: number | null } | null;
  closeFailed?: number | null;
}

export interface KillCompletion {
  /** 의도한 것을 전부 했고 거래소에서 확인됐는가 */
  complete: boolean;
  /** 사용자에게 보여줄 한 줄. **한 적 없는 일을 적지 않는다** */
  message: string;
  /** 아직 안 된 것 */
  missing: string[];
  /** 이번 단계가 포지션을 닫기로 했는가 */
  intendedClose: boolean;
}

/**
 * **무엇을 했다고 말해도 되는가.**
 *
 * 규칙은 하나다: 하기로 한 것만 말하고, 그중 거래소가 확인해 준 것만
 * '완료'라고 적는다.
 */
export function killCompletion(i: {
  actionMode: any;
  exec: KillExecView | null | undefined;
  leftover?: LeftoverVerdict | null;
}): KillCompletion {
  const intent = intentOf(i.actionMode);
  const e = i.exec ?? null;
  const missing: string[] = [];
  const did: string[] = ['신규 주문 차단'];

  if (!e || e.ran === false) {
    return {
      complete: false, intendedClose: intent.close,
      missing: ['취소·종료를 실행하지 못했습니다'],
      message: '킬스위치는 켜졌지만(신규 주문 차단) 취소·종료를 실행하지 못했습니다 — '
        + '거래소에서 직접 확인하세요',
    };
  }

  if (intent.cancel) {
    // **안 돈 것을 성공으로 세지 않는다.** `ran`이 아니면 미실행이다.
    if (e.cancel?.ran === true && e.cancel?.success === true) did.push('미체결 취소');
    else missing.push('미체결 취소');
  }

  if (intent.close) {
    if (e.close?.ran === true && e.close?.success === true) did.push('포지션 종료');
    else missing.push('포지션 종료');
    if ((i.exec?.closeFailed ?? 0) > 0) missing.push(`심볼별 종료 실패 ${i.exec!.closeFailed}건`);
  }

  // 거래소 확인. **없으면 '완료'라고 못 적는다.**
  const lv = i.leftover ?? null;
  if (!lv || lv.code !== 'CLEAR') {
    missing.push(lv?.reason ?? '거래소 잔여를 확인하지 못했습니다');
  }

  if (missing.length > 0) {
    return {
      complete: false, intendedClose: intent.close, missing,
      message: `킬스위치는 켜졌지만(신규 주문 차단) 아직입니다 — ${missing.join(' · ')}. `
        + '거래소에서 직접 확인하세요',
    };
  }

  return {
    complete: true, intendedClose: intent.close, missing: [],
    // 포지션을 안 닫는 단계에서 "포지션 종료 완료"라고 적지 않는다.
    message: `킬스위치 발동 — ${did.join(' · ')} 완료 (거래소 확인됨)`
      + (intent.close ? '' : '. 이번 단계는 열린 포지션을 닫지 않습니다'),
  };
}

/**
 * 이미 발동 중인데 다시 눌렀다. 실행을 다시 할 것인가.
 *
 * **예전에는 무조건 건너뛰고 `ok: true`였다.** 그런데 사용자가 다시
 * 누르는 순간은 대부분 **첫 실행이 절반만 됐을 때**다. 그때 아무것도
 * 안 하고 성공이라고 답하면, 남은 포지션을 아무도 안 본다.
 */
export function retriggerPlan(i: {
  wasActive: boolean;
  leftover?: LeftoverVerdict | null;
}): { execute: boolean; reason: string } {
  if (!i.wasActive) {
    return { execute: true, reason: '첫 발동 — 취소·종료를 실행합니다' };
  }
  const lv = i.leftover ?? null;
  if (lv?.code === 'CLEAR') {
    return { execute: false, reason: '이미 발동 중이고 거래소에 남은 것이 없습니다 — 다시 낼 주문이 없습니다' };
  }
  // 남아 있거나 모르면 **다시 한다.** 취소·종료는 멱등에 가깝고,
  // 안 하는 쪽의 대가가 훨씬 크다.
  return {
    execute: true,
    reason: lv?.code === 'REMAINS'
      ? '이미 발동 중이지만 거래소에 남은 것이 있어 다시 실행합니다'
      : '이미 발동 중이고 잔여를 확인하지 못해 다시 실행합니다 — 모르는 것을 정리됨으로 두지 않습니다',
  };
}

export type ResetBlockCode =
  /** 총자산을 못 읽었다. 0을 기준선으로 저장하면 다음 평가가 전부 틀린다 */
  | 'EQUITY_UNKNOWN'
  /** 거래소 잔여를 못 읽었다 */
  | 'LEFTOVER_UNKNOWN'
  /** 아직 남아 있다 */
  | 'LEFTOVER_REMAINS';

export interface ResetVerdict {
  allowed: boolean;
  code: ResetBlockCode | 'OK';
  reason: string;
}

/**
 * 지금 잠금을 풀어도 되는가.
 *
 * **리셋은 신규 진입 잠금을 여는 동작이다.** 청산이 실패한 직후 누르면
 * 남은 포지션 위에서 새 주문이 나간다. 그리고 기준선을 다시 잡는
 * 동작이기도 하다 — 총자산을 0으로 저장하면 다음 평가의 낙폭이
 * 전부 틀린다.
 *
 * 그래서 둘 다 **확인된 뒤에만** 연다. 못 읽은 것은 통과가 아니다.
 */
export function resetVerdict(i: {
  equity: number | null;
  leftover?: LeftoverVerdict | null;
}): ResetVerdict {
  if (i.equity == null || !Number.isFinite(i.equity)) {
    return {
      allowed: false, code: 'EQUITY_UNKNOWN',
      reason: '총자산을 읽지 못해 기준선을 다시 잡을 수 없습니다 — '
        + '0으로 저장하면 다음 낙폭 판정이 전부 틀립니다',
    };
  }
  const lv = i.leftover ?? null;
  if (!lv || lv.code === 'UNKNOWN') {
    return {
      allowed: false, code: 'LEFTOVER_UNKNOWN',
      reason: `${lv?.reason ?? '거래소 잔여를 확인하지 못했습니다'} — `
        + '확인되지 않은 상태에서 신규 진입 잠금을 풀지 않습니다',
    };
  }
  if (lv.code === 'REMAINS') {
    return {
      allowed: false, code: 'LEFTOVER_REMAINS',
      reason: `${lv.reason} — 남은 것을 정리한 뒤에 잠금을 푸세요`,
    };
  }
  return { allowed: true, code: 'OK', reason: '총자산과 거래소 잔여를 확인했습니다' };
}

/**
 * 이 연결이 테스트넷인가.
 *
 * **저장소 전체 규칙: `is_testnet === false`만 실전이다.**
 * 킬스위치 라우트 셋은 `is_testnet === true`로 읽고 있었다 — 칸이
 * 비어 있으면(NULL) 실전으로 읽혀서, 테스트넷 키로 실전 호스트에
 * 물어보고 실패하고, 그 실패가 `equity = 0`이 되어 발동으로 이어졌다.
 */
export function isTestnetConn(conn: any): boolean {
  return (conn?.is_testnet) !== false;
}
