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

/**
 * 심볼 하나를 닫으려 한 결과.
 *
 * **주문 응답만으로는 닫혔다고 말할 수 없다.** `futuresClosePosition`이
 * `success: true`를 줘도 그건 접수다. 실제로 줄었는지는 **포지션을 다시
 * 읽어야** 안다 — 이 저장소가 `closeEvidence`에서 이미 정한 규칙이다.
 */
export interface TargetedClose {
  symbol: string;
  /** 주문이 접수됐는가 */
  ok: boolean;
  /** 닫기 전 수량 */
  before?: number | null;
  /** 닫은 뒤 **다시 읽은** 수량. **못 읽었으면 null이다 — 0이 아니다** */
  after?: number | null;
  /** 목표: 100이면 전량, 50이면 절반 */
  closePct?: number;
  message?: string;
}

export interface KillExecView {
  ran?: boolean;
  cancel?: { ran?: boolean; success?: boolean } | null;
  close?: { ran?: boolean; success?: boolean; remaining?: number | null } | null;
  closeFailed?: number | null;
  /**
   * 단계형 비상정지가 **심볼별로** 닫은 결과.
   *
   * `CLOSE_AUTOMATED`·`REDUCE_RISK`는 `D`가 없다 — `executeKillActions`의
   * 전량 종료를 쓰지 않고 심볼별로 따로 닫는다. 그래서 `intent.close`만
   * 보면 **이 실패를 통째로 놓친다.**
   */
  targeted?: TargetedClose[] | null;
}

export type TargetedCode =
  /** 목표만큼 줄어든 것이 재조회로 확인됐다 */
  | 'CONFIRMED'
  /** 주문이 거절됐다 */
  | 'ORDER_FAILED'
  /** 접수는 됐는데 **재조회를 못 했다.** 닫혔다는 뜻이 아니다 */
  | 'UNVERIFIED'
  /** 재조회했는데 목표만큼 안 줄었다 */
  | 'STILL_OPEN';

export interface TargetedVerdict {
  symbol: string;
  code: TargetedCode;
  reason: string;
}

/**
 * 이 심볼이 **정말** 목표만큼 줄었는가.
 *
 * **주문 응답이 아니라 재조회 결과로 판단한다.**
 */
export function targetedCloseVerdict(t: TargetedClose): TargetedVerdict {
  const sym = String(t?.symbol ?? '');
  if (t?.ok !== true) {
    return { symbol: sym, code: 'ORDER_FAILED',
      reason: `${sym}: 청산 주문이 거절됐습니다${t?.message ? ` — ${t.message}` : ''}` };
  }
  const after = t?.after;
  if (after == null || !Number.isFinite(Number(after))) {
    return { symbol: sym, code: 'UNVERIFIED',
      reason: `${sym}: 청산 주문은 접수됐지만 포지션을 다시 읽지 못했습니다 — `
        + '접수는 체결이 아닙니다' };
  }
  const pct = Number(t?.closePct ?? 100);
  const before = Number(t?.before);
  const left = Math.abs(Number(after));

  if (pct >= 100) {
    return left <= 0
      ? { symbol: sym, code: 'CONFIRMED', reason: `${sym}: 포지션 0 확인` }
      : { symbol: sym, code: 'STILL_OPEN', reason: `${sym}: 아직 ${left} 남아 있습니다` };
  }

  // 부분 청산. 기준 수량을 모르면 확인할 수 없다.
  if (!Number.isFinite(before) || before <= 0) {
    return { symbol: sym, code: 'UNVERIFIED',
      reason: `${sym}: 줄이기 전 수량을 몰라 목표만큼 줄었는지 확인할 수 없습니다` };
  }
  // 반올림·수량 단위 때문에 정확히 안 맞을 수 있다. 5% 여유를 준다.
  const want = Math.abs(before) * (1 - pct / 100);
  return left <= want * 1.05
    ? { symbol: sym, code: 'CONFIRMED', reason: `${sym}: ${pct}% 축소 확인 (${before} → ${left})` }
    : { symbol: sym, code: 'STILL_OPEN',
        reason: `${sym}: ${pct}%를 줄이려 했는데 ${left} 남아 있습니다 (목표 ${want.toFixed(6)} 이하)` };
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
  /**
   * **실행을 건너뛴 것이 정상인가.**
   *
   * `retriggerPlan`이 "이미 발동 중이고 거래소에 남은 것이 없다"고
   * 판정하면 실행을 안 한다. 그러면 `exec`가 `null`인데, 예전에는
   * 그걸 곧바로 "실행하지 못했습니다"로 읽어 **502를 냈다.**
   * 두 판정이 서로 모순됐다 — 깨끗해서 안 했는데 실패라고 답한 것이다.
   */
  skipped?: { reason: string } | null;
  /**
   * 줄일 대상을 **실제로 확인했는가.**
   *
   * `targeted`가 비어 있는 것은 두 가지다 — 줄일 게 정말 없었거나,
   * **못 찾았거나.** 예전에는 그 둘을 구분하지 않아서 한 건도 못 줄인
   * 채 완료라고 답할 수 있었다. REDUCE_RISK는 actionMode에 D도 C도
   * 없어서(actions: A·B) 다른 어떤 조건에도 걸리지 않는다.
   */
  discovery?: DiscoveryVerdict | null;
}): KillCompletion {
  const intent = intentOf(i.actionMode);
  const e = i.exec ?? null;
  const missing: string[] = [];
  const did: string[] = ['신규 주문 차단'];
  const lv0 = i.leftover ?? null;

  // ── 이미 깨끗해서 재실행을 생략했다 ──
  //
  // **거래소가 0을 확인해 줬을 때만** 성공이다. `skipped`가 있어도
  // 잔여가 CLEAR가 아니면 그건 건너뛰면 안 되는 상태였다는 뜻이므로
  // 아래 일반 경로로 내려가 미완료로 적힌다.
  if (!e && i.skipped && lv0?.code === 'CLEAR') {
    return {
      complete: true, intendedClose: intent.close, missing: [],
      message: `킬스위치 발동 중 — ${i.skipped.reason} (거래소 확인됨)`,
    };
  }

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
  }

  // ── 심볼별 청산은 **D와 무관하게** 검사한다 ──
  //
  // `CLOSE_AUTOMATED`(자동매매 것만)와 `REDUCE_RISK`(절반)는 `D`가 없다.
  // 그런데 실제로는 심볼별로 포지션을 닫거나 줄인다. 예전에는
  // `intent.close`일 때만 `closeFailed`를 봐서, **자동매매 포지션 청산이
  // 실패했는데 일반 주문이 0이면 완료로 적혔다.**
  const targeted = Array.isArray(e.targeted) ? e.targeted : null;
  if (targeted && targeted.length > 0) {
    const verdicts = targeted.map(targetedCloseVerdict);
    const bad = verdicts.filter(v => v.code !== 'CONFIRMED');
    if (bad.length === 0) did.push(`대상 ${verdicts.length}건 청산 확인`);
    else for (const b of bad) missing.push(b.reason);
  } else if ((e.closeFailed ?? 0) > 0) {
    // 재조회 근거가 없는 옛 모양. 실패 건수만이라도 놓치지 않는다.
    missing.push(`심볼별 종료 실패 ${e.closeFailed}건`);
  }

  // ── 대상이 비어 있는 이유를 묻는다 ──
  //
  // **`targeted: []`만 보고 넘어가면 한 건도 못 줄인 채 완료가 된다.**
  //
  // REDUCE_RISK는 `actions: ['A','B']`라 actionMode에 C도 D도 없다.
  // 그래서 위의 `intent.cancel`·`intent.close` 어느 쪽에도 안 걸리고,
  // leftover는 `expectedClosed=false`라 남은 포지션을 세지 않는다.
  // 즉 **거래소에 포지션이 둘 남아 있어도 complete=true**였다.
  //
  // 그래서 이 단계가 포지션을 줄이기로 한 것이면 **대상을 실제로
  // 확인했다는 근거**를 요구한다.
  const dv = i.discovery ?? null;
  if (dv && dv.code === 'UNKNOWN') {
    missing.push(dv.reason);
  } else if (dv && dv.code === 'VERIFIED_TARGETS') {
    // 찾았는데 실행 기록이 없으면 찾은 것과 한 것이 어긋난 것이다.
    if (!targeted || targeted.length === 0) {
      missing.push(`줄일 대상 ${dv.count}건을 찾았는데 청산 기록이 없습니다`);
    }
  } else if (dv && dv.code === 'VERIFIED_EMPTY') {
    did.push('줄일 포지션 없음(거래소 확인)');
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
  | 'LEFTOVER_REMAINS'
  /** 이번 발동의 포지션 축소·종료가 끝나지 않았다 (AB·ABC는 미체결 0으로 판단할 수 없다) */
  | 'TARGETED_INCOMPLETE'
  /** 끝났는지 기록이 없다. **끝난 것이 아니다** */
  | 'TARGETED_UNKNOWN';

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
  /**
   * 이번 발동의 targeted 작업이 끝났는가.
   *
   * **`leftover`만으로는 부족하다.** REDUCE_RISK(AB)·CLOSE_AUTOMATED(ABC)는
   * D가 없어 `expectedClosed=false`가 되고, 그러면 잔여 판정이 포지션을
   * 세지 않는다 — 절반 축소가 실패한 채로도 미체결 0이면 CLEAR다.
   */
  targeted?: TargetedState | null;
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

  // ── 끝나지 않은 targeted 작업 위에서 열지 않는다 ──
  const ts = i.targeted ?? null;
  if (ts === 'PENDING') {
    return {
      allowed: false, code: 'TARGETED_INCOMPLETE',
      reason: '이번 발동의 포지션 축소·종료가 끝나지 않았습니다 — '
        + '미체결이 0이어도 그 단계의 목표는 미체결이 아닙니다. 다시 발동해 정리한 뒤에 푸세요',
    };
  }
  if (ts === 'UNKNOWN') {
    return {
      allowed: false, code: 'TARGETED_UNKNOWN',
      reason: '이번 발동의 포지션 축소·종료가 끝났는지 기록이 없습니다 — '
        + '끝났다고 단정하지 않습니다. 킬스위치를 다시 발동해 거래소 확인을 받은 뒤에 푸세요',
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

// ── 대상을 못 찾은 것과 대상이 없는 것 ──────────────────────────
//
// **REDUCE_RISK는 "모든 열린 포지션을 절반으로"다.** 그런데 실제
// 실행은 `live_orders`에 있는 심볼만 후보로 만들었다. 거래소에는
// 포지션이 둘 있는데 그 표에 줄이 없으면 후보가 0이 되고, 아무것도
// 줄이지 않은 채 `targeted: []`로 끝났다.
//
// CLOSE_AUTOMATED도 같은 모양이다. `live_orders` 조회가 **실패**해도
// `rows`가 null이라 "자동매매 대상 0개"와 구분되지 않았다.
//
// 그리고 `killCompletion`은 `targeted`가 비어 있으면 아무것도 요구하지
// 않았다. 즉 **한 건도 못 줄였는데 complete=true**가 가능했다.
//
// 급할 때 누른 버튼이 "완료"라고 답하면 사람은 거래소를 안 본다.
// 그래서 "대상이 없다"와 "대상을 못 찾았다"를 갈라야 한다.

export type DiscoveryCode =
  | 'NOT_APPLICABLE'   // 이 단계는 포지션을 줄이지 않는다
  | 'VERIFIED_TARGETS' // 줄일 것을 찾았다
  | 'VERIFIED_EMPTY'   // **읽었고**, 줄일 것이 정말 없었다
  | 'UNKNOWN';         // 못 읽었다. **없다는 뜻이 아니다**

export interface DiscoveryVerdict {
  code: DiscoveryCode;
  /** 찾은 대상 수. 못 읽었으면 null */
  count: number | null;
  reason: string;
}

/**
 * 줄일 대상을 **실제로 확인했는가.**
 *
 * `positionsRead`는 거래소에서 열린 포지션 목록을 읽었는가다.
 * `ledgerRead`는 `live_orders`를 읽었는가로, **automatedOnly일 때만**
 * 필요하다 — "봇이 연 것만"을 가리려면 장부가 있어야 한다.
 *
 * 셋 중 하나라도 못 읽었으면 UNKNOWN이고, UNKNOWN은 완료가 아니다.
 */
export function discoveryVerdict(i: {
  spec: { closePct: number; automatedOnly: boolean } | null | undefined;
  /** 거래소 포지션 목록을 읽었는가 */
  positionsRead: boolean;
  /** live_orders를 읽었는가 (automatedOnly에서만 본다) */
  ledgerRead: boolean;
  /** 찾은 대상 수 */
  targetCount: number;
}): DiscoveryVerdict {
  const spec = i.spec ?? null;
  if (!spec || !(spec.closePct > 0)) {
    return { code: 'NOT_APPLICABLE', count: 0, reason: '이번 단계는 포지션을 줄이지 않습니다' };
  }
  if (!i.positionsRead) {
    return {
      code: 'UNKNOWN', count: null,
      reason: '거래소에서 열린 포지션을 읽지 못했습니다 — 줄일 것이 없다는 뜻이 아닙니다',
    };
  }
  if (spec.automatedOnly && !i.ledgerRead) {
    return {
      code: 'UNKNOWN', count: null,
      reason: '자동매매 장부(live_orders)를 읽지 못해 어느 포지션이 봇의 것인지 가리지 못했습니다 — '
        + '대상이 없다는 뜻이 아닙니다',
    };
  }
  const n = Math.max(0, Math.floor(Number(i.targetCount) || 0));
  if (n > 0) {
    return { code: 'VERIFIED_TARGETS', count: n, reason: `줄일 대상 ${n}건을 확인했습니다` };
  }
  return {
    code: 'VERIFIED_EMPTY', count: 0,
    reason: spec.automatedOnly
      ? '거래소와 장부를 읽었고, 자동매매가 연 열린 포지션이 없었습니다'
      : '거래소를 읽었고, 열린 포지션이 없었습니다',
  };
}

// ── 이번 발동을 만든 것이 무엇인가 ─────────────────────────────
//
// **설정값과 이번에 실제로 실행한 것은 다르다.**
//
// `body.level`로 CLOSE_ALL을 눌러도 저장되는 건 설정의 `actionMode`
// (예: 'BC')였다. 나중에 status·reset은 그 저장값으로 판단한다.
//
//   설정 BC → 수동 CLOSE_ALL(ABCD) 실행 → 포지션 일부 남음 → reset
//   → reset은 BC로 읽어 `expectedClosed = false`
//   → leftover가 포지션을 세지 않음 → CLEAR
//   → **남은 포지션 위에서 신규 진입 잠금이 풀린다**
//
// 그래서 이번 발동의 실제 조합을 따로 남긴다. 그리고 **남기지 못했을
// 때가 더 중요하다** — 칸이 없거나 쓰기가 실패하면 모르는 상태가 되고,
// 모르는 상태에서 약한 쪽(설정값)으로 판단하면 위 시나리오가 그대로
// 재현된다. 그래서 모르면 **가장 강한 쪽**으로 본다.

export interface EffectiveMode {
  /** 판단에 쓸 조합 */
  mode: string;
  /** 포지션을 닫았을 것으로 보고 확인해야 하는가 */
  expectedClosed: boolean;
  /** 어디서 온 값인가 */
  source: 'EFFECTIVE' | 'CONFIG' | 'ASSUMED_STRICT';
  reason: string;
}

/**
 * status·reset이 쓸 조합을 고른다.
 *
 * `effective`가 있으면 그것이다 — 이번 발동을 실제로 만든 값이다.
 * 없을 때가 갈림길이다:
 *
 *   발동 중이 아니다        설정값을 써도 위험하지 않다
 *   발동 중인데 모른다      **가장 강한 쪽으로 본다.** 무엇으로 켜졌는지
 *                           모르는 채 "포지션은 닫을 대상이 아니었다"고
 *                           단정하면 남은 포지션 위에서 잠금이 풀린다
 */
export function effectiveModeOf(i: {
  /** kill_switch_state에 남은 이번 발동의 조합. 없으면 null */
  effective?: string | null;
  /** 설정값 */
  config?: string | null;
  /** 지금 발동 중인가 */
  active: boolean;
}): EffectiveMode {
  const eff = String(i.effective || '').trim().toUpperCase();
  if (eff) {
    return {
      mode: eff, expectedClosed: intentOf(eff).close, source: 'EFFECTIVE',
      reason: '이번 발동을 만든 조합입니다',
    };
  }
  const cfg = String(i.config || '').trim().toUpperCase();
  if (!i.active) {
    return {
      mode: cfg, expectedClosed: intentOf(cfg).close, source: 'CONFIG',
      reason: '발동 중이 아니므로 설정값을 씁니다',
    };
  }
  // **발동 중인데 무엇으로 켜졌는지 모른다.**
  return {
    mode: cfg, expectedClosed: true, source: 'ASSUMED_STRICT',
    reason: '이번 발동의 조합이 기록돼 있지 않습니다 — '
      + '포지션까지 닫았을 수 있다고 보고 확인합니다 (설정값으로 느슨하게 풀지 않습니다)',
  };
}

// ── targeted 단계는 미체결만 보고 건너뛰면 안 된다 ──────────────
//
// REDUCE_RISK는 `AB`, CLOSE_AUTOMATED는 `ABC`다. **둘 다 D가 없다.**
// 그래서 `intentOf(mode).close === false`이고, 일반 잔여 판정은
// `expectedClosed=false`에서 **포지션을 세지 않는다** — 미체결이 0이면
// CLEAR다. 그 CLEAR를 재발동 근거로 쓰면:
//
//   REDUCE_RISK 발동 → 절반 축소 실패 → 포지션 그대로 · 미체결 0
//   → 다시 누름 → preLeftover = CLEAR → "이미 깨끗함"으로 건너뜀
//   → **대상 발굴은 그 뒤에 있어서 아예 실행되지 않는다**
//
// 즉 급해서 다시 누른 사람에게 "이미 정리됨"이라고 답한다.
//
// 그래서 targeted 단계의 건너뛰기는 **대상 확인 결과**로 판단한다.
// 미체결 0은 그 단계의 목표가 아니다.

export interface RetriggerDecision { execute: boolean; reason: string }

/**
 * 다시 눌렀을 때 실행할 것인가.
 *
 * targeted 단계(closePct > 0)에서는 **discovery가 근거다**:
 *
 *   VERIFIED_EMPTY   줄일 것이 정말 없다 → 미체결까지 깨끗하면 건너뛴다
 *   VERIFIED_TARGETS 줄일 것이 남아 있다 → **다시 한다**
 *   UNKNOWN          못 봤다 → **다시 한다.** 모르는 것은 깨끗한 것이 아니다
 *
 * targeted가 아닌 단계는 예전대로 잔여로 판단한다.
 */
export function retriggerDecision(i: {
  wasActive: boolean;
  leftover?: LeftoverVerdict | null;
  discovery?: DiscoveryVerdict | null;
}): RetriggerDecision {
  if (!i.wasActive) return { execute: true, reason: '첫 발동입니다' };

  const dv = i.discovery ?? null;
  if (dv && dv.code !== 'NOT_APPLICABLE') {
    if (dv.code === 'VERIFIED_TARGETS') {
      return { execute: true, reason: `줄일 대상이 ${dv.count}건 남아 있어 다시 실행합니다` };
    }
    if (dv.code === 'UNKNOWN') {
      return { execute: true, reason: `${dv.reason} — 모르는 상태에서 건너뛰지 않습니다` };
    }
    // VERIFIED_EMPTY — 대상은 없다. 미체결까지 확인돼야 건너뛴다.
    const lv = i.leftover ?? null;
    if (lv && lv.code === 'CLEAR') {
      return { execute: false, reason: '줄일 포지션도 미체결도 없다고 거래소가 확인했습니다' };
    }
    return { execute: true, reason: lv?.reason ?? '미체결을 확인하지 못했습니다' };
  }

  // targeted가 아닌 단계
  const lv = i.leftover ?? null;
  if (lv && lv.code === 'CLEAR') {
    return { execute: false, reason: '거래소에 남은 것이 없다고 확인했습니다' };
  }
  return { execute: true, reason: lv?.reason ?? '거래소 잔여를 확인하지 못했습니다' };
}

// ── 끝나지 않은 targeted 작업 위에서 잠금을 풀지 않는다 ────────
//
// `effective_action_mode`만으로는 부족하다. AB·ABC에는 D가 없어서
// `expectedClosed=false`가 되고, 그러면 잔여 판정이 포지션을 세지
// 않는다. **절반 축소가 실패한 채로도 미체결 0이면 잠금이 풀린다.**
//
// 그래서 그 단계가 **끝났는지**를 따로 남기고, 끝나지 않았으면 열지
// 않는다. 남기지 못했으면(칸 없음 등) 열지 않는다 — 모르는 것은
// 끝난 것이 아니다.

export type TargetedState = 'DONE' | 'PENDING' | 'UNKNOWN' | 'NONE';

/**
 * 저장된 값을 상태로 읽는다.
 *
 * `NONE`은 애초에 targeted 단계가 아니었다는 뜻이고, `UNKNOWN`은
 * **기록이 없다**는 뜻이다. 둘을 섞으면 안 된다.
 */
export function targetedStateOf(i: {
  /** kill_switch_state.targeted_pending. 칸이 없거나 안 남았으면 undefined */
  pending?: boolean | null;
  /** 이번 발동의 조합 */
  effective?: string | null;
  active: boolean;
}): TargetedState {
  if (!i.active) return 'NONE';
  if (i.pending === true) return 'PENDING';
  if (i.pending === false) return 'DONE';
  // 발동 중인데 기록이 없다.
  return 'UNKNOWN';
}
