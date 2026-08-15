// src/lib/engine/entryEvidence.ts
//
// **`exec.ok === true`는 진입이 아니다.**
//
// 지금 원본 v1 라우트가 하는 판정은 이 한 줄이다:
//
//     const entered = exec?.ok === true;
//
// 그런데 `ok: true`는 실행기 안에서 여러 뜻이다. 접수만 됐어도 true고,
// 체결이 확정되지 않아 `settled: false`여도 true고, 포지션이 없어서
// 손절을 안 걸었을 때도 true다(그 분기가 실제로 있다). 그리고 오늘
// 확인된 대로 **Gate에서는 TP가 아예 안 걸리는데도** true다.
//
// 그 결과가 어제 장부다: `last_outcome = ENTERED`, `entries + 1`.
// 그런데 실제로는 기존 SHORT 위에 겹쳐 들어가 수량이 2배가 됐거나
// (BTCUSDT), 상계되어 찌꺼기만 남았다(ETHUSDT). **장부는 성공이라고
// 적혀 있고 거래소는 다른 말을 하고 있었다.**
//
// 그래서 이 파일이 요구하는 것
// ────────────────────────────
// ENTERED라고 적으려면 증거가 전부 있어야 한다:
//
//   1. 체결이 확정됐다 (settled)
//   2. 체결 수량이 0보다 크다
//   3. 방향이 요청한 것과 같다
//   4. **거래소 재조회**에서 그 방향·그 수량의 포지션이 보인다
//   5. 배율·포지션 모드가 요청대로 확인됐다
//   6. 손절이 **거래소 목록에서 다시 읽혀** 존재한다
//   7. 전략이 익절을 필수로 하면 익절도 다시 읽혀 존재한다
//
// 하나라도 '모른다'면 ENTERED가 아니라 **UNKNOWN**이다. 그리고
// UNKNOWN은 FAILED와도 다르다 — FAILED로 적으면 재시도가 열리고,
// 그 재시도가 그대로 중복 진입이 된다.

import type { OpenPosition } from './positionLifecycle';
import type { ProtectiveEvidence } from './protectiveReadback';

export type EnteredCode =
  /** 증거가 전부 있다 */
  | 'ENTERED'
  /** 들어가지 않은 것이 확인됐다 (체결 0 · 거절) */
  | 'NOT_ENTERED'
  /** **모른다.** 재시도를 열지 않는다 — 중복 진입이 된다 */
  | 'UNKNOWN'
  /** 들어가긴 했는데 보호가 없다. 되돌리거나 즉시 손을 써야 한다 */
  | 'ENTERED_UNPROTECTED';

export interface EnteredVerdict {
  /** **장부에 ENTERED로 적어도 되는가.** 이 값만 그 판단을 한다 */
  entered: boolean;
  code: EnteredCode;
  /** 확인된 증거 */
  have: string[];
  /** 빠진 증거. 사람이 읽고 무엇을 볼지 알 수 있어야 한다 */
  missing: string[];
  /** 재시도해도 되는가. **UNKNOWN이면 안 된다** */
  retryable: boolean;
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface EntryEvidenceInput {
  expectedSide: 'LONG' | 'SHORT';
  /** 실행기가 돌려준 것 */
  settled?: boolean | null;
  filledQty?: any;
  avgPrice?: any;
  /** 진입 주문 자체가 거절됐는가 */
  rejected?: boolean | null;
  /** **거래소 재조회** 결과. 주문 응답이 아니다 */
  position: OpenPosition | null;
  /** 요청한 배율이 거래소에서 확인됐는가. null은 모름 */
  leverageConfirmed?: boolean | null;
  /** 포지션 모드(ONE_WAY/HEDGE)를 읽었는가. null은 모름 */
  positionModeConfirmed?: boolean | null;
  /** 되읽기로 확인한 손절 */
  stop: ProtectiveEvidence | null;
  /** 되읽기로 확인한 익절 */
  takeProfit?: ProtectiveEvidence | null;
  /** 이 전략이 익절을 필수로 하는가 */
  takeProfitRequired?: boolean;
}

/**
 * 이 진입을 ENTERED로 적어도 되는가.
 *
 * 순서가 곧 의미다. **먼저 '안 들어갔다'가 확정되는지 보고**, 그 다음에
 * 증거를 모으고, 마지막에 보호 여부를 본다. 순서를 바꾸면 보호 없는
 * 포지션이 '진입 실패'로 적혀서 아무도 안 닫는다.
 */
export function enteredVerdict(i: EntryEvidenceInput): EnteredVerdict {
  const have: string[] = [];
  const missing: string[] = [];

  const qty = num(i?.filledQty);
  const pos = i?.position ?? null;

  // ── 0. 안 들어간 것이 확정됐는가 ──
  //
  // 거절 + 재조회에서 포지션 없음. **둘 다 있어야 한다** — 거절
  // 응답만으로 없다고 적으면, 실제로는 체결됐는데 응답만 놓친
  // 경우에 보호 없는 포지션이 방치된다.
  if (i?.rejected === true && pos?.ok === true && pos.found === false) {
    return {
      entered: false, code: 'NOT_ENTERED', have: ['거래소 재조회에서 포지션 없음'],
      missing: [], retryable: true,
      reason: '진입 주문이 거절됐고 거래소에도 포지션이 없습니다 — 들어가지 않았습니다',
    };
  }
  if (i?.settled === true && qty != null && qty <= 0 && pos?.ok === true && pos.found === false) {
    return {
      entered: false, code: 'NOT_ENTERED', have: ['체결 확정 · 체결 수량 0', '거래소 재조회에서 포지션 없음'],
      missing: [], retryable: true,
      reason: '체결이 확정됐고 수량이 0이며 거래소에도 포지션이 없습니다 — 들어가지 않았습니다',
    };
  }

  // ── 1~3. 체결 ──
  if (i?.settled === true) have.push('체결 확정'); else missing.push('체결 확정(settled)');
  if (qty != null && qty > 0) have.push(`체결 수량 ${qty}`); else missing.push('0보다 큰 체결 수량');
  if (num(i?.avgPrice) != null) have.push('평균 체결가'); else missing.push('평균 체결가');

  // ── 4. 거래소 재조회 ──
  //
  // **여기가 가장 중요하다.** 주문 응답은 우리가 보낸 것에 대한 답이고,
  // 포지션 조회는 계좌의 사실이다. 어제 둘이 갈렸다.
  if (!pos || pos.ok !== true) {
    missing.push('거래소 포지션 재조회');
  } else if (!pos.found) {
    missing.push('재조회에서 포지션이 보이지 않음');
  } else if (pos.side !== i.expectedSide) {
    missing.push(`재조회 방향 불일치 (요청 ${i.expectedSide} / 거래소 ${pos.side ?? '불명'})`);
  } else {
    have.push(`거래소 포지션 ${pos.side} ${pos.qty ?? '수량불명'}`);
    if (pos.qty == null) missing.push('재조회 수량');
  }

  // ── 5. 배율·포지션 모드 ──
  if (i?.leverageConfirmed === true) have.push('배율 확인');
  else missing.push('요청 배율이 거래소에서 확인되지 않음');
  if (i?.positionModeConfirmed === true) have.push('포지션 모드 확인');
  else missing.push('포지션 모드 확인');

  // ── 6~7. 보호주문 ──
  //
  // 되읽기 결과만 본다. 생성 응답(orderId)은 증거가 아니다.
  const stopOk = i?.stop?.readOk === true && i.stop.found === true;
  const tpRequired = i?.takeProfitRequired === true;
  const tpOk = i?.takeProfit?.readOk === true && i.takeProfit.found === true;
  if (stopOk) have.push(`손절 되읽기 확인 (${i.stop!.triggerPrice})`);
  else missing.push(i?.stop?.readOk === false ? '손절 되읽기 실패(조회 불가)' : '거래소에 손절이 없음');
  if (tpRequired) {
    if (tpOk) have.push(`익절 되읽기 확인 (${i.takeProfit!.triggerPrice})`);
    else missing.push(i?.takeProfit?.readOk === false ? '익절 되읽기 실패(조회 불가)' : '거래소에 익절이 없음');
  } else if (tpOk) {
    have.push(`익절 되읽기 확인 (${i.takeProfit!.triggerPrice})`);
  }

  // ── 판정 ──
  const positionConfirmed = pos?.ok === true && pos.found === true
    && pos.side === i.expectedSide && pos.qty != null;
  const protectionMissing = !stopOk || (tpRequired && !tpOk);

  if (missing.length === 0) {
    return {
      entered: true, code: 'ENTERED', have, missing, retryable: false,
      reason: `진입 확인 — ${have.join(' · ')}`,
    };
  }

  // 포지션은 확실히 있는데 보호가 없다. **이건 '모른다'가 아니다** —
  // 지금 보호되지 않은 포지션이 열려 있고, 그 사실을 정확히 말해야 한다.
  if (positionConfirmed && protectionMissing) {
    return {
      entered: false, code: 'ENTERED_UNPROTECTED', have, missing, retryable: false,
      reason: '⚠ 포지션은 열렸는데 보호주문이 확인되지 않았습니다 — '
        + `${missing.join(' · ')}. 재진입하지 말고 이 포지션을 정리하거나 보호주문을 거세요`,
    };
  }

  return {
    entered: false, code: 'UNKNOWN', have, missing,
    // **재시도를 열지 않는다.** 여기서 retry를 허용하면 앞 주문이
    // 붙는 사이에 한 번 더 나가고, 그게 어제의 2배 포지션이다.
    retryable: false,
    reason: `진입을 확정하지 못했습니다 — 빠진 증거: ${missing.join(' · ')}. `
      + '확정되지 않은 상태에서 다시 주문하지 않습니다(중복 진입이 됩니다). '
      + '거래소와 대조가 필요합니다',
  };
}

/** 장부의 `last_outcome`에 적을 값 */
export function outcomeOf(v: EnteredVerdict): 'ENTERED' | 'FAILED' | 'RECONCILE_REQUIRED' | 'UNPROTECTED' {
  if (v.code === 'ENTERED') return 'ENTERED';
  if (v.code === 'NOT_ENTERED') return 'FAILED';
  if (v.code === 'ENTERED_UNPROTECTED') return 'UNPROTECTED';
  return 'RECONCILE_REQUIRED';
}
