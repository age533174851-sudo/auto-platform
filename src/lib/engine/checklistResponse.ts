// src/lib/engine/checklistResponse.ts
//
// **서버는 왜 막았는지 다 보내고 있었는데 화면이 버리고 있었다.**
//
// 주문이 점검에 막히면 `/api/binance/futures/order`는 409와 함께
// 이것을 보낸다:
//
//   { ok: false, error: 'checklist_blocked', message: <요약>,
//     checklist: { allowed, market, intent, passed, total,
//                  unknownCount, results, blockers } }
//
// 여덟 항목이 각각 통과·차단·확인불가 중 무엇인지, 무엇이 막고 있는지가
// 전부 들어 있다. 그런데 화면은 이렇게 받았다:
//
//   const errMsg = d.message || errorTextOf(d, '주문 실패');
//   showToast(`주문 실패 · ${errMsg}`, false);
//
// **토스트 한 줄로 줄여 버렸다.** 사용자는 "주문 실패"만 보고, 시계가
// 어긋났는지·배율이 다른지·미결 주문이 남았는지·손절이 청산가보다
// 먼 건지 알 수 없다. 그래서 같은 실패를 반복한다.
//
// `PreTradeChecklist.tsx`는 그걸 그리려고 만들어진 화면인데 **어디에도
// 붙어 있지 않았다** — 만들어 놓고 배선을 안 한 것이다.
//
// 이 파일은 그 사이를 잇는다. 응답을 화면이 쓰는 모양으로 바꾸기만 한다.

import type { ChecklistVerdict } from './preTradeChecklist';

/**
 * 주문 응답에서 점검 결과를 꺼낸다.
 *
 * **없으면 null이다.** 빈 verdict를 만들어 주면 화면이 "0개 항목 통과"
 * 같은 것을 그리게 되고, 그건 점검을 안 한 것과 통과한 것을 섞는다.
 */
export function checklistFromResponse(body: any): ChecklistVerdict | null {
  const c = body?.checklist;
  if (!c || typeof c !== 'object') return null;
  if (!Array.isArray(c.results)) return null;

  const n = (v: any, fallback: number): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  };

  return {
    // 이 경로로 오는 응답은 막힌 것이다. 그래도 서버 값을 우선한다 —
    // 나중에 통과한 결과도 같은 모양으로 보내게 되면 그대로 쓴다.
    allowed: c.allowed === true,
    market: c.market ?? 'FUTURES',
    intent: c.intent ?? 'ENTRY',
    results: c.results,
    blockers: Array.isArray(c.blockers) ? c.blockers : [],
    passed: n(c.passed, 0),
    total: n(c.total, Array.isArray(c.results) ? c.results.length : 0),
    // **확인하지 못한 항목 수를 지우지 않는다.** 0으로 떨어뜨리면
    // "전부 확인했는데 막혔다"로 읽힌다.
    unknownCount: n(c.unknownCount, 0),
    // 요약은 응답 최상위에 있다. 그쪽이 없으면 점검 안쪽 것을 쓴다.
    summary: String(body?.message ?? c.summary ?? '주문 전 점검에 막혔습니다'),
  } as ChecklistVerdict;
}

/** 이 응답이 점검 때문에 막힌 것인가 */
export function isChecklistBlocked(body: any): boolean {
  return body?.error === 'checklist_blocked' || (!!body?.checklist && body?.ok === false);
}
