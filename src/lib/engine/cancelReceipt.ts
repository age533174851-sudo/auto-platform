// src/lib/engine/cancelReceipt.ts
//
// **취소 전사(transcription) 단계 — 아직 고치지 않았다.**
//
// 이 커밋의 목적은 화면·경로에 흩어져 있던 두 판단을 한 곳으로 옮기되
// **동작을 그대로 두는** 것이다. 바로 고치면 "원래 뭐였는지"가 사라져서
// RED를 실제로 돌려 보일 수 없다.
//
// 옮겨 온 두 곳:
//   · `src/components/SmokeTestPanel.tsx:477-478` 취소 응답 한 줄
//   · `src/app/api/autotrade/smoke-test/orphans/route.ts` describe()/POST의
//     "번호를 못 읽은 주문"과 "목록에 없으니 사라졌다" 판단
//
// 다음 커밋에서 고친다.

import { venueIdOf, isLostPrecisionId } from '../exchanges/losslessJson';
import { ownedOrderIds, orderIdOf } from './protectionLedger';

/** 주문 한 줄에서 **취소에 쓸 수 있는 번호**를 읽었는가 */
export interface IdEvidence {
  /** 취소에 쓸 번호. 못 읽었으면 '' */
  id: string;
  readable: boolean;
  /** 번호가 온 칸 이름. **값은 담지 않는다** */
  source: string | null;
  reason: string;
}

/** 취소 요청을 보낼 수 있는 상태인가 */
export type CancelPlanCode =
  | 'READY'
  | 'ORDERS_UNREADABLE'
  | 'NOTHING_ASKED'
  | 'ASKED_UNREADABLE';

export interface CancelPlan {
  code: CancelPlanCode;
  blocked: boolean;
  targets: string[];
  /** 목록에 없던 번호. **빈 배열과 "말할 수 없다"는 다르다** */
  notFound: string[];
  unreadableRows: number;
  reason: string;
}

export type RereadState = 'OK' | 'FAILED' | 'NONE';

export interface CancelReceipt {
  line: string;
  reachedVenue: boolean;
  rounds: number | null;
  reread: RereadState;
}

// ── 전사 1: 오늘의 describe()가 하는 것 ──
export function orderIdEvidence(row: any): IdEvidence {
  const id = orderIdOf(row);
  return { id, readable: !!id, source: null, reason: '' };
}

// ── 전사 2: 오늘의 POST가 하는 것 ──
export function cancelPlanOf(i: { asked: Array<string | null | undefined>; rows: any[] | null }): CancelPlan {
  const asked = ownedOrderIds({ placed: Array.isArray(i?.asked) ? i.asked : [] });
  if (asked.length === 0) {
    return { code: 'NOTHING_ASKED', blocked: true, targets: [], notFound: [], unreadableRows: 0,
      reason: '지울 주문 번호(ids)를 명시하세요 — 전체 취소는 지원하지 않습니다' };
  }
  if (!Array.isArray(i?.rows)) {
    return { code: 'ORDERS_UNREADABLE', blocked: true, targets: [], notFound: [], unreadableRows: 0,
      reason: '조건부 주문 목록을 읽지 못했습니다 — 무엇을 지우는지 확인하지 못한 채로 취소하지 않습니다' };
  }
  const seen = i.rows.map(orderIdOf);
  const targets = asked.filter(id => seen.includes(id));
  const notFound = asked.filter(id => !seen.includes(id));
  return { code: 'READY', blocked: false, targets, notFound, unreadableRows: 0,
    reason: '요청한 번호로 취소를 보냅니다' };
}

// ── 전사 3: 오늘의 화면 한 줄 ──
export function cancelReceiptOf(i: { httpStatus: number; body: any }): CancelReceipt {
  const rounds = Number(i?.body?.rounds ?? 0);
  const reread: RereadState = i?.body?.leftoverReadable === false ? 'FAILED' : 'OK';
  return {
    rounds,
    reread,
    reachedVenue: true,
    line: `HTTP ${i?.httpStatus} · ${rounds}바퀴 · 재조회 ${reread === 'FAILED' ? '실패(모름)' : '성공'}`,
  };
}

// 전사 단계에서는 쓰지 않지만 다음 커밋이 쓴다.
void venueIdOf; void isLostPrecisionId;
