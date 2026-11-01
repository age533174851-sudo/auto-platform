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
import { ownedOrderIds, orphanCancelGate } from './protectionLedger';

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

/**
 * 취소할 번호를 **하나도 받지 못했는가.**
 *
 * 라우트의 이른 400(`ids_required`)과 아래 합성 판정이 **같은 함수로**
 * 묻는다. 둘이 따로 세면 화면이 보낸 것과 서버가 센 것이 갈린다.
 */
export function asksNothing(asked: Array<string | null | undefined> | null | undefined): boolean {
  return ownedOrderIds({ placed: Array.isArray(asked) ? asked : [] }).length === 0;
}

export const IDS_REQUIRED_REASON =
  '지울 주문 번호(ids)를 명시하세요 — 전체 취소는 지원하지 않습니다';

/** 합성 판정 — 취소를 보낼 수 있는가, 그리고 무엇을 말할 수 있는가 */
export interface OrphanCancelDecision {
  /** **이것이 true일 때만 cancelExact를 부른다** */
  allowed: boolean;
  code: string;
  targets: string[];
  /** 목록에 없던 번호. 관문이 단건 일치를 요구하므로 허용 경로에서는 항상 빈 배열 */
  notFound: string[];
  unreadableRows: number;
  reason: string;
}

/**
 * **#553의 사전 관문과 #554의 번호 증거를 한 번에 합성한다.**
 *
 * 라우트가 `orphanCancelGate`와 `cancelPlanOf`를 각자 부르면 같은 판단이
 * 두 곳에 생기고 언젠가 한쪽만 고쳐진다 — 상습 고장 ②. 그래서 라우트는
 * **이 함수 하나만** 부른다.
 *
 * 순서가 계약이다:
 *   ① 번호를 하나도 받지 못했다           → NOTHING_ASKED
 *   ② 한 번에 두 건 이상을 요청했다         → TOO_MANY_IDS
 *   ③ 포지션 0 · 장부 · 목록 · 단건 · 소유권 · namespace (#553 관문)
 *   ④ 관문이 단건 일치에서 막혔고 번호를 못 읽은 줄이 있다 →
 *      ASKED_UNREADABLE (왜 못 찾았는지를 "없다"로 적지 않는다)
 *   ⑤ 거래소 번호가 **이 연결·이 환경의 장부**에 없다 →
 *      OWNERSHIP_PREFIX_ONLY (전략 이름만 같은 주문은 취소하지 않는다)
 *
 * ⑤를 ③보다 뒤에 두는 것도 계약이다. 앞에 두면 포지션이 열려 있는
 * 경우까지 "장부에 없다"로 보고되어 **실제 원인이 가려진다.**
 *
 * `allowed`가 false면 **거래소로 나가는 호출은 없다.**
 */
export function orphanCancelDecision(i: {
  position: { ok: boolean; found: boolean; qty: number | null } | null;
  ledgerReadable: boolean;
  orders: Array<{ id: string; ownership: string; namespace: string; idReadable?: boolean }> | null;
  asked: Array<string | null | undefined>;
  /**
   * 이 **연결·환경**의 장부에 적힌 주문 번호. 거래소가 걸 때 준 번호다 —
   * `CLAUDE.md`가 말하는 가장 강한 소유 증거. 주지 않으면 빈 목록으로
   * 본다(= prefix만으로는 취소하지 않는다).
   */
  ownedIds?: string[] | null;
  /** 장부를 다 읽지 못했는가(LIMIT에 꽉 차서 왔는가) */
  ledgerTruncated?: boolean;
}): OrphanCancelDecision {
  const unreadableRows = Array.isArray(i?.orders)
    ? i.orders.filter(o => o?.idReadable === false).length : 0;

  if (asksNothing(i?.asked)) {
    return { allowed: false, code: 'NOTHING_ASKED', targets: [], notFound: [],
      unreadableRows, reason: IDS_REQUIRED_REASON };
  }

  const asked = ownedOrderIds({ placed: i.asked });

  // **한 번에 한 건만 취소한다.** 화면의 버튼은 '이 주문만 취소'이고
  // 관문의 문구도 '단건'인데, 배열을 그대로 넘기면 번호를 여러 개 적은
  // 요청이 통째로 통과한다 — 적어 둔 계약과 코드가 갈린 자리다.
  // 여러 건을 지워야 하면 한 건씩 눌러서 매번 재조회로 확인한다.
  if (asked.length > 1) {
    return { allowed: false, code: 'TOO_MANY_IDS', targets: [], notFound: [], unreadableRows,
      reason: `한 번에 한 건만 취소합니다 — ${asked.length}건을 받았습니다`
        + ' (여러 건은 한 건씩, 매번 재조회로 확인합니다)' };
  }

  const gate = orphanCancelGate({
    position: i?.position ?? null,
    ledgerReadable: i?.ledgerReadable === true,
    orders: Array.isArray(i?.orders)
      ? i.orders.map(o => ({ id: String(o?.id ?? ''), ownership: String(o?.ownership ?? ''), namespace: String(o?.namespace ?? '') }))
      : null,
    asked,
  });

  if (!gate.ok) {
    // **"요청한 번호를 못 찾았다"의 이유가 '내가 못 읽어서'일 수 있다.**
    // 그걸 "없다"로 적으면 거래소에 주문이 남은 채로 통과가 된다.
    if (gate.code === 'TARGET_NOT_UNIQUE' && unreadableRows > 0) {
      return { allowed: false, code: 'ASKED_UNREADABLE', targets: [], notFound: [], unreadableRows,
        reason: `번호를 읽지 못한 조건부 주문이 ${unreadableRows}건 있습니다 — `
          + `${asked.join(', ')}이 거래소에 없다고 말할 수 없습니다 (그 줄이 이 주문일 수 있습니다)` };
    }
    return { allowed: false, code: gate.code, targets: [], notFound: [], unreadableRows,
      reason: gate.reason };
  }

  // **전략 prefix만 맞는 주문은 취소하지 않는다.** 그 주문은 같은
  // 사용자의 **다른 연결·다른 회차**의 것일 수 있고, prefix는 그것을
  // 구분하지 못한다. 취소에는 거래소가 준 번호가 장부에 있어야 한다.
  const owned = (Array.isArray(i?.ownedIds) ? i.ownedIds : []).map(v => String(v ?? '').trim()).filter(Boolean);
  const unproven = asked.filter(id => !owned.includes(id));
  if (unproven.length > 0) {
    return { allowed: false, code: 'OWNERSHIP_PREFIX_ONLY', targets: [], notFound: [], unreadableRows,
      reason: `${unproven.join(', ')}은 이 연결·이 환경의 장부에 적힌 주문 번호가 아닙니다`
        + ' — 전략 이름만 같은 주문은 취소하지 않습니다'
        + (i?.ledgerTruncated === true ? ' (장부를 다 읽지 못했습니다 — 없다는 뜻이 아닙니다)' : '') };
  }

  return { allowed: true, code: gate.code, targets: gate.targets, notFound: [], unreadableRows,
    reason: gate.reason };
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
