// src/lib/engine/cancelReceipt.ts
//
// **취소 한 번에 대해 화면이 할 수 있는 말을 여기서만 정한다.**
//
// 왜 이 파일이 생겼나 (#552)
// ──────────────────────────
// 2026-11-02 00:36(KST) 화면: 포지션 0 · 조건부 주문 1건 · 판정 MINE ·
// `이 주문만 취소 (#)` 를 누르자 `취소 응답 · HTTP 400 · 0바퀴 ·
// 재조회 성공`. 재조회에도 그 주문은 그대로 있었다.
//
// 그 줄에는 거래소가 등장하지 않는다. 앱이 **자기 요청을 스스로**
// 거절한 것이다(`ids_required`). 그런데 화면은
//
//   · 응답에 `rounds`가 없으니 `?? 0` 으로 **0바퀴**라고 적었고
//   · `leftoverReadable`이 없으니 `=== false`가 거짓이라 **재조회 성공**
//     이라고 적었다
//
// 재조회는 일어나지 않았다. **못 읽은 것을 0과 성공으로 적은 것**이고,
// 그 한 줄 때문에 "바이낸스가 400을 돌려줬다"는 추측이 생겼다.
//
// 그래서 규칙 셋
// ──────────────
//  1. **필드가 없으면 모름이다.** 0바퀴도 아니고 성공도 아니다.
//  2. **번호를 못 읽은 주문에는 취소 번호를 넘기지 않는다.** 넘기면 앱이
//     자기 400을 돌려주고, 그 400이 거래소 거부처럼 보인다.
//  3. **번호를 못 읽은 줄이 섞인 목록으로 "사라졌다"고 말하지 않는다.**
//     내가 못 읽은 그 줄이 바로 그 주문일 수 있다. 확인하지 못한 것은
//     통과가 아니다.
//
// 그리고 **추측하지 않는다.** 번호 칸이 아예 없는 줄은 "어떤 칸이
// 있었는지"만 적는다(값은 적지 않는다) — 그 namespace의 취소 경로가
// 확인되기 전에 일반 취소를 보내는 것이 #552에서 금지된 바로 그 일이다.

import { venueIdOf, isLostPrecisionId } from '../exchanges/losslessJson';
import { ownedOrderIds } from './protectionLedger';

/** 취소에 쓸 수 있는 번호가 어느 칸에서 왔는가. **순서가 우선순위다** */
const ID_KEYS = ['id', 'orderId', 'order_id'] as const;

/**
 * 번호처럼 보이지만 **취소에 쓸 수 있는지 확인되지 않은** 칸들.
 * 이름만 보고 "이걸 쓰면 되겠지"로 취소를 보내지 않는다 — 어떤 칸이
 * 있었는지 사람에게 보여 주는 데만 쓴다.
 */
const HINT_KEYS = [
  'algoId', 'clientAlgoId', 'algo_id', 'client_algo_id',
  'clientOrderId', 'client_order_id', 'origClientOrderId',
  'strategyId', 'strategy_id', 'text', 'label',
] as const;

/** 주문 한 줄에서 **취소에 쓸 수 있는 번호**를 읽었는가 */
export interface IdEvidence {
  /** 취소에 쓸 번호. 못 읽었으면 '' */
  id: string;
  readable: boolean;
  /** 번호가 온 칸 이름. **값은 담지 않는다** */
  source: string | null;
  reason: string;
}

export type CancelPlanCode =
  /** 보낼 수 있다 */
  | 'READY'
  /** 목록을 못 읽었다 */
  | 'ORDERS_UNREADABLE'
  /** 보낼 번호를 받지 못했다 */
  | 'NOTHING_ASKED'
  /** 번호를 못 읽은 줄이 있어 "없다"고 말할 수 없다 */
  | 'ASKED_UNREADABLE';

export interface CancelPlan {
  code: CancelPlanCode;
  blocked: boolean;
  targets: string[];
  /** 목록에 없던 번호. **모든 줄을 읽었을 때만 채운다** */
  notFound: string[];
  unreadableRows: number;
  reason: string;
}

/** 재조회를 **했는가**. `NONE`은 안 한 것이고 그건 성공이 아니다 */
export type RereadState = 'OK' | 'FAILED' | 'NONE';

export interface CancelReceipt {
  line: string;
  /** 요청이 거래소까지 갔다고 말할 수 있는가 */
  reachedVenue: boolean;
  /** 실제로 돈 바퀴. **모르면 null이다 — 0이 아니다** */
  rounds: number | null;
  reread: RereadState;
}

/**
 * 주문 줄에서 취소에 쓸 번호를 읽는다.
 *
 * `protectionLedger.orderIdOf`가 뽑는 값과 **같은 번호를 돌려준다.**
 * 다른 것은 "왜 못 읽었는가"를 같이 돌려준다는 점이다 — 화면이 그
 * 이유를 보여 주지 못해서 사용자가 거래소를 의심했다.
 */
export function orderIdEvidence(row: any): IdEvidence {
  if (!row || typeof row !== 'object') {
    return { id: '', readable: false, source: null, reason: '주문 줄이 아닙니다' };
  }
  for (const k of ID_KEYS) {
    const raw = (row as any)[k];
    if (raw == null) continue;
    if (isLostPrecisionId(raw)) {
      // **String(2089…400)을 쓰면 복구가 아니라 위조다.** 그 번호로
      // 취소를 보내면 거래소는 "그런 주문 없다"고 답하고 원본은 남는다.
      return { id: '', readable: false, source: k,
        reason: `${k} 칸이 숫자로 읽혀 정밀도를 잃었습니다 — 이 값으로 취소하면 없는 주문을 지우라고 보내는 것입니다` };
    }
    const s = venueIdOf(raw) ?? '';
    if (s) return { id: s, readable: true, source: k, reason: '' };
  }
  const hints = HINT_KEYS.filter(k => (row as any)[k] != null);
  return {
    id: '', readable: false, source: null,
    reason: hints.length > 0
      // **값은 적지 않는다.** 칸 이름만으로 충분하고, 값은 비밀일 수 있다.
      ? `취소에 쓸 수 있는 번호 칸(${ID_KEYS.join(' · ')})이 없습니다 (있는 칸: ${hints.join(', ')})`
        + ' — 이 식별자로 취소가 되는지 확인되지 않아 일반 취소를 보내지 않습니다'
      : `취소에 쓸 수 있는 번호 칸(${ID_KEYS.join(' · ')})이 없습니다`,
  };
}

/**
 * **무엇을 보낼 수 있고 무엇을 말할 수 없는지**를 한 곳에서 정한다.
 *
 * 가장 중요한 줄은 `ASKED_UNREADABLE`이다. 목록은 읽혔는데 그 안에
 * 번호를 못 읽은 줄이 있으면, 요청한 번호가 "목록에 없다"는 사실은
 * **아무것도 증명하지 않는다** — 못 읽은 그 줄이 그 주문일 수 있다.
 * 그런 상태에서 `notFound`로 적고 ok를 돌려주면, 거래소에 주문이
 * 그대로 있는데 화면에는 "사라진 것을 재조회로 확인했습니다"가 뜬다.
 */
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

  const ev = i.rows.map(orderIdEvidence);
  const unreadableRows = ev.filter(e => !e.readable).length;
  const present = ev.filter(e => e.readable).map(e => e.id);

  const targets = asked.filter(id => present.includes(id));
  const absent = asked.filter(id => !present.includes(id));

  if (absent.length > 0 && unreadableRows > 0) {
    return { code: 'ASKED_UNREADABLE', blocked: true, targets, notFound: [], unreadableRows,
      reason: `번호를 읽지 못한 조건부 주문이 ${unreadableRows}건 있습니다 — `
        + `${absent.join(', ')}이 거래소에서 사라졌다고 말할 수 없습니다 (그 줄이 이 주문일 수 있습니다)` };
    }

  return { code: 'READY', blocked: false, targets, notFound: absent, unreadableRows,
    reason: targets.length > 0
      ? '요청한 번호로 취소를 보냅니다'
      : '요청한 번호가 목록에 없습니다 — 모든 줄의 번호를 읽었으므로 없는 것이 맞습니다' };
}

/** 0 이상의 안전한 정수만 바퀴 수로 인정한다. 나머지는 **모름**이다 */
function roundsOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * 취소 응답 한 줄을 화면 문구로 바꾼다.
 *
 * **필드가 없으면 모름이다.** `?? 0`과 `=== false`가 사용자를 거래소
 * 쪽으로 보낸 자리다. 앱의 거절 코드(`error`)도 같이 보여 준다 —
 * 그게 안 보여서 `ids_required`가 바이낸스 400으로 읽혔다.
 */
export function cancelReceiptOf(i: { httpStatus?: number | null; body: any }): CancelReceipt {
  const body = i?.body;
  const rounds = roundsOf(body?.rounds);
  const flag = body?.leftoverReadable;
  const reread: RereadState = flag === true ? 'OK' : flag === false ? 'FAILED' : 'NONE';
  // **거래소까지 갔다고 말하려면 바퀴가 돌았어야 한다.** 0바퀴는
  // "요청을 보내지 못했다"이고, 그것도 거래소 응답이 아니다.
  const reachedVenue = rounds != null && rounds > 0;

  const err = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null;
  // **HTTP가 없는 자리도 있다.** 스모크가 남긴 정리 증거는 응답이 아니라
  // 저장된 장부다 — 같은 "모름" 규칙을 쓰되 HTTP 칸만 비운다.
  const parts = [
    ...(typeof i?.httpStatus === 'number' ? [`HTTP ${i.httpStatus}`] : []),
    rounds == null ? '취소 요청 안 됨(모름)' : `${rounds}바퀴`,
    `재조회 ${reread === 'OK' ? '성공' : reread === 'FAILED' ? '실패(모름)' : '안 함(모름)'}`,
  ];
  // 앱이 거절한 것인지 거래소가 거절한 것인지를 이 코드가 가른다.
  if (err) parts.push(`앱 거절 코드 ${err}`);

  return { line: parts.join(' · '), reachedVenue, rounds, reread };
}
