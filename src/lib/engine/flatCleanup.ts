// src/lib/engine/flatCleanup.ts
//
// **포지션이 이미 0이 된 뒤에 남은 보호주문을 치운다.**
//
// 무엇이 빠져 있었나
// ──────────────────
// 실제 my-original-v1 자동매매에서 재현됐다: Gate에 **Positions 0 / Orders 1**.
//
// 정리 코드는 있었다. 그런데 `entryGate()`가 반대 방향 포지션을 발견했을
// 때(`needsReversal`)의 **분기 안에만** 있었다. 그리고 entryGate는
// `read.ok === true && found === false`면 곧바로 `PROCEED`를 준다 —
// 그 길에는 정리 코드가 한 줄도 없다.
//
// 그래서 **거래소 SL이나 TP가 포지션을 닫아 준 경우**, 남은 형제 주문
// (SL이 맞았으면 TP, TP가 맞았으면 SL)이 아무에게도 청구되지 않고 그대로
// 남는다. 다음 날 신규 진입이 그 위에 새 SL/TP를 얹는다.
//
// 스모크는 자기 settle 경로에서 이걸 하고 있었고, 실제 자동매매는 안 하고
// 있었다. **경로가 둘인데 한쪽만 고친 것** — 이 저장소의 대표 고장이다.
// 그래서 판정을 여기 하나로 모은다.
//
// 규칙
// ────
//   · 포지션이 0으로 **확인됐을 때만** 고아다 (조회 실패는 0이 아니다)
//   · **내 것으로 증명된 정확한 번호만** 취소한다 — Cancel All 금지
//   · FOREIGN은 절대 안 지운다. 남의 손절을 지우는 것이 가장 큰 사고다
//   · 목록을 못 읽었거나 취소를 확인 못 했으면 **신규 진입을 막는다**
//     — 모르는 보호주문 위로 새 포지션을 열면 그게 다음 날 사고다

import { orphanCleanupPlan, type CleanupPlan } from './orderOwnership';
import type { CancelLedger } from './protectionLedger';

export type FlatCleanupCode =
  /** 포지션이 아직 있다 — 이 주문들은 고아가 아니라 방어선이다 */
  | 'NOT_FLAT'
  /** 포지션을 못 읽었다 — 0인지 아닌지 모른다 */
  | 'POSITION_UNKNOWN'
  /** 조건부 주문 목록을 못 읽었다. **0건과 다르다** */
  | 'ORDERS_UNKNOWN'
  /** 포지션 0 · 치울 것 없음 */
  | 'NOTHING_TO_DO'
  /** 내 것을 지웠고 재조회로 확인했다 */
  | 'CLEAN'
  /** 취소했는데 아직 있다 */
  | 'STILL_PRESENT'
  /** 취소가 됐는지 확인하지 못했다 */
  | 'CANCEL_UNKNOWN';

export interface FlatCleanupPlan {
  code: Extract<FlatCleanupCode, 'NOT_FLAT' | 'POSITION_UNKNOWN' | 'ORDERS_UNKNOWN' | 'NOTHING_TO_DO' | 'CLEAN'>;
  /** 취소할 **정확한** 거래소 주문 번호 */
  cancel: string[];
  /** 손대지 않는 주문들 (FOREIGN · 판별 못 한 것) */
  keep: CleanupPlan['keep'];
  /** 지금 신규 진입을 내도 되는가 — false면 막는다 */
  blockEntry: boolean;
  reason: string;
}

/**
 * 포지션이 0인 지금, 무엇을 치워야 하는가.
 *
 * `orphanCleanupPlan`을 감싸되 **신규 진입을 막을지**를 같이 정한다.
 * 그 판단이 호출부마다 흩어져 있으면 한쪽만 고쳐진다 — 실제로 그래서
 * 이 고장이 났다.
 */
export function flatCleanupPlan(i: {
  position: { ok: boolean; found: boolean; qty?: number | null };
  /** 조건부 주문 목록. **null은 '못 읽음'이고 []는 '없음'이다** */
  orders: any[] | null;
  myStrategyId: string;
  /** 걸 때 받아 적어 둔 거래소 주문 번호 — 가장 강한 소유 증거 */
  ownedIds?: string[] | null;
  /**
   * **적어 둔 번호와 일치하는 것만** 내 것으로 본다.
   *
   * 부르는 쪽이 어느 전략의 주문인지 확정하지 못할 때 쓴다(청산 감시가
   * 그렇다 — 거래는 알지만 전략 id까지는 들고 있지 않다). 식별자 파싱
   * 결과가 우연히 같은 접두사를 갖는 일을 아예 없앤다.
   */
  ownedOnly?: boolean;
}): FlatCleanupPlan {
  const none: CleanupPlan['keep'] = [];

  if (!i?.position || i.position.ok !== true) {
    return {
      code: 'POSITION_UNKNOWN', cancel: [], keep: none, blockEntry: true,
      reason: '포지션을 조회하지 못했습니다 — 0인지 알 수 없으므로 아무것도 취소하지 않고 '
        + '신규 진입도 내지 않습니다',
    };
  }
  if (i.position.found) {
    // 여기는 이 함수가 다룰 자리가 아니다. 반전 판단은 `entryGate`가 한다.
    return {
      code: 'NOT_FLAT', cancel: [], keep: none, blockEntry: false,
      reason: `포지션이 남아 있습니다${i.position.qty != null ? ` (${i.position.qty})` : ''} — `
        + '이 조건부 주문들은 고아가 아니라 그 포지션의 방어선입니다',
    };
  }
  if (i.orders == null) {
    return {
      code: 'ORDERS_UNKNOWN', cancel: [], keep: none, blockEntry: true,
      reason: '조건부 주문 목록을 읽지 못했습니다 — 0건과 다릅니다. '
        + '남아 있을 수 있는 보호주문 위로 신규 진입을 내지 않습니다',
    };
  }

  const plan = orphanCleanupPlan({
    position: i.position, orders: i.orders,
    myStrategyId: i.myStrategyId, ownedIds: i.ownedIds ?? null,
  });

  // **번호로만 증명하라고 했으면 번호로만 증명한다.**
  // 식별자 파싱으로 MINE이 된 것도 여기서는 손대지 않고 남긴다 —
  // 지우지 않아 남는 것은 다음 주기에 또 보이지만, 잘못 지운 손절은
  // 되돌릴 방법이 없다.
  const known = (Array.isArray(i.ownedIds) ? i.ownedIds : []).map(v => String(v ?? '')).filter(Boolean);
  if (i.ownedOnly === true) {
    const dropped = plan.cancel.filter(id => !known.includes(id));
    plan.cancel = plan.cancel.filter(id => known.includes(id));
    for (const id of dropped) {
      plan.keep.push({ id, class: 'UNKNOWN',
        reason: '적어 둔 주문 번호와 일치하지 않습니다 — 번호로 증명된 것만 취소합니다' });
    }
  }

  if (plan.cancel.length === 0) {
    return {
      code: 'NOTHING_TO_DO', cancel: [], keep: plan.keep, blockEntry: false,
      // **남의 주문이 있다고 내 진입을 막지 않는다.** 그건 영원히 못 여는
      // 상태가 되고, 못 여는 것을 못 닫는 것과 같이 취급하면 안 된다.
      // 다만 무엇을 두고 가는지는 반드시 적는다.
      reason: plan.keep.length
        ? `포지션 0 · 이 전략이 만든 조건부 주문은 없습니다 — 다른 소유/불명 ${plan.keep.length}건은 그대로 둡니다`
        : '포지션 0 · 남은 조건부 주문 없음',
    };
  }

  return {
    code: 'CLEAN', cancel: plan.cancel, keep: plan.keep, blockEntry: false,
    reason: `포지션 0 확인 — 이 전략이 만든 조건부 주문 ${plan.cancel.length}건을 정확한 번호로 취소합니다`
      + (plan.keep.length ? ` · 다른 소유/불명 ${plan.keep.length}건은 그대로 둡니다` : ''),
  };
}

export interface FlatCleanupVerdict {
  code: FlatCleanupCode;
  /** 정리가 끝났는가 */
  ok: boolean;
  /** 신규 진입을 막아야 하는가 */
  blockEntry: boolean;
  cancelled: string[];
  stillPresent: string[];
  unknown: string[];
  kept: CleanupPlan['keep'];
  reason: string;
}

/**
 * 취소까지 마친 결과를 판정한다.
 *
 * **재조회가 판정한다.** 거래소가 200을 준 것은 접수이지 삭제가 아니다.
 * 조건부 주문은 200 뒤에도 남아 있을 수 있고, 실제로 남아 있었다.
 *
 * 남았거나 확인 못 했으면 **신규 진입을 막는다.** 그 주문이 다음 진입을
 * 예상치 못하게 닫는다 — 그게 이 고장의 실제 피해다.
 */
export function flatCleanupVerdict(i: {
  plan: FlatCleanupPlan;
  /** `cancelLedger`의 결과. 취소를 아예 안 했으면 null */
  ledger: CancelLedger | null;
}): FlatCleanupVerdict {
  const plan = i?.plan;
  const base = { cancelled: [] as string[], stillPresent: [] as string[], unknown: [] as string[],
    kept: plan?.keep ?? [] };

  if (!plan || plan.code === 'POSITION_UNKNOWN' || plan.code === 'ORDERS_UNKNOWN') {
    return {
      ...base, code: plan?.code ?? 'POSITION_UNKNOWN', ok: false, blockEntry: true,
      reason: plan?.reason ?? '정리 계획을 세우지 못했습니다',
    };
  }
  if (plan.code === 'NOT_FLAT') {
    return { ...base, code: 'NOT_FLAT', ok: false, blockEntry: false, reason: plan.reason };
  }
  if (plan.code === 'NOTHING_TO_DO' || plan.cancel.length === 0) {
    return { ...base, code: 'NOTHING_TO_DO', ok: true, blockEntry: false, reason: plan.reason };
  }

  const led = i?.ledger;
  if (!led) {
    return {
      ...base, code: 'CANCEL_UNKNOWN', ok: false, blockEntry: true,
      reason: `취소 결과가 기록되지 않았습니다 (${plan.cancel.length}건) — `
        + '지워졌는지 모르는 상태에서 신규 진입을 내지 않습니다',
    };
  }

  const cancelled = led.entries.filter(e => e.state === 'CANCEL_CONFIRMED').map(e => e.id);
  const out = { ...base, cancelled, stillPresent: led.stillPresent, unknown: led.unknown };

  if (led.stillPresent.length > 0) {
    return {
      ...out, code: 'STILL_PRESENT', ok: false, blockEntry: true,
      reason: `${led.reason} — 이 주문이 다음 진입을 예상치 못하게 닫습니다. 신규 진입을 내지 않습니다`,
    };
  }
  if (led.unknown.length > 0) {
    return {
      ...out, code: 'CANCEL_UNKNOWN', ok: false, blockEntry: true,
      reason: `${led.reason} — 확인하지 못한 것은 0이 아닙니다. 신규 진입을 내지 않습니다`,
    };
  }
  return {
    ...out, code: 'CLEAN', ok: true, blockEntry: false,
    reason: `포지션 0 · 이 전략의 보호주문 ${cancelled.length}건 취소 확인 (재조회로 확인함)`
      + (plan.keep.length ? ` · 다른 소유/불명 ${plan.keep.length}건은 그대로 둡니다` : ''),
  };
}
