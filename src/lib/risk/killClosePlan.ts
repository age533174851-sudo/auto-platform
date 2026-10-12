// src/lib/risk/killClosePlan.ts
//
// **긴급 종료의 순서와 범위 — 하나의 순수 판정.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 긴급 킬스위치의 순서가 이랬다:
//
//     Cancel All (계좌 전체)  →  Close All (계좌 전체)
//
// 여기에 두 가지 고장이 겹쳐 있었다.
//
//   ① **포지션 모드를 묻지 않았다.** 종료 주문은 단방향 전용 조합
//      (`reduceOnly`만, `positionSide` 없음)으로 나간다. 양방향(헤지)
//      계좌에 그 조합을 보내면 거부가 아니라 **반대 방향 신규 진입**이
//      될 수 있다. 판정 정본(`closeModeVerdict`)은 이미 있었고, 종료 권한
//      경로는 그것을 반드시 지난다. **킬 경로만 그 관문 밖에 있었다.**
//
//   ② **보호주문을 먼저 지웠다.** 그래서 ①을 고쳐 "모드를 모르면 닫지
//      않는다"로 만들면, 더 나쁜 상태가 만들어진다:
//
//          보호주문은 지워졌는데 포지션은 열린 채 남는다
//
//      긴급 버튼을 누른 사람은 정리됐다고 믿고 손을 뗀다. 이 앱에서
//      가장 비싼 실패의 모양이다.
//
// 그래서 이 파일의 **단 하나의 불변식**
// ─────────────────────────────────────
//
//     ★ 닫을 수 없으면 **취소하지도 않는다.**
//
//       mayCancel === true  ⇒  mayClose === true
//
// 분기마다 적지 않는다 — 마지막에 **한 번 조인다**(`clamp`). 분기에
// 흩어 적으면 새 분기가 생길 때 한 곳만 고쳐지고, 그때 보호주문이
// 벗겨진다. 이 저장소가 반복한 "경로가 둘인데 한쪽만 고침"이다.
//
// 그리고 **범위를 좁힌다**
// ────────────────────────
// 계좌 전체 취소는 같은 계좌의 **다른 전략이 걸어 둔 손절까지 지운다**
// (`venuePositionOps.cancelExact`의 주석이 이미 그렇게 적고 있다).
// 그래서 이 판정은 **닫을 대상 심볼의, id를 읽은 주문만** 취소 목록에
// 넣는다. 식별하지 못한 주문은 **지우지 않고 수를 적는다** — 모르는
// 것을 "내 것"으로 치지 않는다.
//
// ★ 이 파일은 거래소를 모른다. 주문을 낼 수단이 타입에 없다.
//   조회 결과를 받아 **무엇을 해도 되는가**만 답한다.

/** 긴급 종료가 지켜야 하는 순서. 검사기·시험이 이 목록으로 센다 */
export const KILL_CLOSE_SEQUENCE = [
  /** ① 포지션 모드를 먼저 읽는다 */
  'GATE',
  /** ② 닫을 포지션과 그 심볼의 주문을 식별한다 */
  'DISCOVER',
  /** ③ 닫을 수 있을 때에만, 대상 심볼의 주문만 취소한다 */
  'CANCEL',
  /** ④ 축소 전용으로 닫는다 */
  'CLOSE',
  /** ⑤ 거래소에 다시 물어 잔여를 확정한다 */
  'VERIFY',
] as const;
export type KillCloseStep = typeof KILL_CLOSE_SEQUENCE[number];

export type KillClosePlanCode =
  /** 모드 확인됨 · 대상 확인됨 — 취소 후 종료를 진행해도 된다 */
  | 'PROCEED'
  /** 계좌의 포지션 모드를 읽지 못했다 */
  | 'BLOCKED_MODE_UNKNOWN'
  /** 양방향(헤지) 계좌의 청산 규격을 확정하지 못했다 */
  | 'BLOCKED_HEDGE'
  /** 닫을 포지션의 방향을 읽지 못했다 */
  | 'BLOCKED_NO_DIRECTION'
  /** 모드 판정 자체가 없다 (관문을 지나지 않았다) */
  | 'BLOCKED_NO_GATE'
  /** 거래소 포지션을 읽지 못했다. **없다는 뜻이 아니다** */
  | 'BLOCKED_POSITIONS_UNREAD'
  /** 읽은 것 중 닫을 수 있는 것이 **하나도** 없다 (수량·종목을 못 읽었다) */
  | 'BLOCKED_TARGET_UNUSABLE'
  /**
   * 일부는 닫을 수 있고 일부는 못 읽었다.
   *
   * **읽은 것은 닫는다** — 긴급 버튼이 한 줄의 이상한 응답 때문에
   * 아무것도 못 하게 되면 그게 더 나쁘다. 대신 못 읽은 수를 적어
   * "정리됐다"로 읽히지 않게 한다.
   */
  | 'PROCEED_PARTIAL'
  /** 미체결 주문을 읽지 못해 **어느 것이 대상인지** 모른다 */
  | 'BLOCKED_ORDERS_UNREAD'
  /** 닫을 노출이 없다. 주문 0건 */
  | 'NOTHING_TO_DO';

export interface KillPositionRow {
  symbol: string | null;
  /**
   * 수량. **부호가 있을 수도, 없을 수도 있다.**
   *
   * ★ `futuresListPositions`가 주는 `ExecPosition.amount`는 **절댓값**
   *   이고 방향은 `side` 칸에 따로 있다. 부호만 보고 방향을 정하면
   *   SHORT 포지션이 전부 LONG으로 읽힌다 — 그러면 종료 주문의 방향
   *   검증이 매번 불일치로 떨어져 **SHORT는 영원히 닫히지 않는다.**
   *   이 저장소가 `qty`/`amount` 칸 이름으로 한 번 당한 그 모양이다.
   */
  amount: number | null;
  /**
   * 거래소가 적어 준 방향. **있으면 이것이 정본이다.**
   *
   * 없으면 수량의 부호에서 정하고, 둘 다 없으면 **방향을 모르는 것**이다 —
   * 짐작하지 않는다(짐작하면 반대 방향 신규 진입이 된다).
   */
  side?: 'LONG' | 'SHORT' | null;
}

export interface KillOpenOrderRow {
  /** 거래소 주문 id. **못 읽으면 null이고 그건 "내 것"이 아니다** */
  id: string | null;
  symbol: string | null;
}

export interface KillModeVerdictLike {
  ok: boolean;
  code: string;
  mode: 'ONE_WAY' | 'HEDGE' | null;
  message: string;
}

export interface KillClosePlanInput {
  /** `closeModeGate`/`closeModeVerdict`의 결과. **null이면 관문을 안 지났다** */
  modeVerdict: KillModeVerdictLike | null | undefined;
  /** 거래소 포지션. `ok:false`면 **못 읽었다** */
  positions: { ok: boolean; rows?: KillPositionRow[] | null };
  /** 미체결 주문. `ok:false`면 **못 읽었다** */
  openOrders: { ok: boolean; rows?: KillOpenOrderRow[] | null };
  /**
   * 닫기로 한 심볼. **주면 그것만** 대상이다.
   *
   * 비거나 null이면 읽은 포지션 전체가 대상이다(계좌 전체 종료 B).
   */
  targetSymbols?: readonly string[] | null;
}

export interface KillCloseTarget {
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** 부호 없는 수량 */
  qty: number;
}

export interface KillClosePlan {
  code: KillClosePlanCode;
  /** 미체결 주문을 취소해도 되는가. **`mayClose`가 거짓이면 반드시 거짓** */
  mayCancel: boolean;
  /** 종료 주문을 보내도 되는가 */
  mayClose: boolean;
  /** 취소해도 되는 주문 id — 대상 심볼의, id를 읽은 것만 */
  cancelIds: string[];
  /** 식별하지 못해 **남기는** 주문 수. 0이 아니면 운영자가 알아야 한다 */
  unidentifiedOrders: number;
  /**
   * 포지션 줄을 읽었지만 **닫을 수 없던** 수.
   *
   * 0이 아니면 이 회차는 어떤 경우에도 "정리 완료"가 아니다.
   */
  unusableTargets: number;
  closes: KillCloseTarget[];
  /**
   * 보호주문을 **남겼는가.**
   *
   * 닫을 수 없는 상태에서 참이어야 한다. 거짓이면 포지션이 무방비로
   * 남았다는 뜻이고, 그건 이 파일이 막으려는 바로 그 상태다.
   */
  protectionRetained: boolean;
  /** 사람이 거래소에서 직접 닫아야 하는가 */
  manualInterventionRequired: boolean;
  reason: string;
}

const num = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const sym = (v: unknown): string => String(v ?? '').trim().toUpperCase();

/**
 * ★ **불변식을 조이는 단 하나의 자리.**
 *
 * 닫을 수 없으면 취소 목록을 비우고 `mayCancel`을 내린다. 분기마다
 * 적지 않는 이유는 이 파일 머리글에 있다.
 *
 * ★ 왜 **내보내는가** (`clampKillClosePlan`)
 * ──────────────────────────────────────────
 * 지금 이 함수는 **아무 분기도 의존하지 않는다.** 위의 `blocked()`와
 * 각 반환 자리가 이미 `mayCancel: false`를 직접 적고 있어서, 이 조임을
 * 떼어내도 오늘의 동작은 바뀌지 않는다 — 변이 검사에서 그것이 그대로
 * 드러났다(KC-1이 새 나갔다).
 *
 * 그렇다고 지우지 않는다. 이 함수가 막으려는 것은 **오늘의 분기가
 * 아니라 내일 생길 분기**다. 닫을 수 있는지 모르는 채 `mayCancel`을
 * 참으로 적는 새 경로가 들어오면, 다른 어떤 시험도 그것을 막지 못하고
 * 보호주문이 벗겨진다.
 *
 * 그래서 **직접 시험한다.** 불변식을 어긴 입력을 넣어 조여지는지 보는
 * 시험이 붙어 있고(`killClosePlan.test.ts`), 그 시험이 이 조임을
 * 지켜 준다. 지켜지지 않는 방어는 방어가 아니다.
 */
export function clampKillClosePlan(p: KillClosePlan): KillClosePlan {
  if (p.mayClose === true) return p;
  return {
    ...p,
    mayCancel: false,
    cancelIds: [],
    // 취소하지 않았으므로 보호주문은 그대로 남아 있다.
    protectionRetained: true,
  };
}

const clamp = clampKillClosePlan;

const blocked = (
  code: KillClosePlanCode, reason: string,
  over: Partial<KillClosePlan> = {},
): KillClosePlan => clamp({
  code, mayCancel: false, mayClose: false,
  cancelIds: [], unidentifiedOrders: 0, unusableTargets: 0, closes: [],
  protectionRetained: true, manualInterventionRequired: true,
  reason, ...over,
});

/**
 * **긴급 종료로 무엇을 해도 되는가.**
 *
 * 순서가 계약이다 (`KILL_CLOSE_SEQUENCE`):
 *
 *   ① 모드 관문을 지났는가        — 못 지났으면 주문 0건·취소 0건
 *   ② 포지션을 읽었는가           — 못 읽었으면 flat이 아니다
 *   ③ 닫을 노출이 있는가          — 없으면 할 일이 없다
 *   ④ 대상이 쓸 수 있는가         — 방향·수량을 못 읽으면 막는다
 *   ⑤ 주문을 식별했는가           — 못 했으면 **취소하지 않는다**
 *   ⑥ 취소 범위를 대상 심볼로 좁힌다
 */
export function planKillClose(i: KillClosePlanInput | null | undefined): KillClosePlan {
  // ── ① 모드 관문 ──
  //
  // **취소보다 앞이다.** 뒤로 밀면 보호주문을 지운 뒤에 "닫을 수 없다"를
  // 알게 된다 — 그 순서가 이 파일을 만든 이유다.
  const v = i?.modeVerdict ?? null;
  if (v == null) {
    return blocked('BLOCKED_NO_GATE',
      '포지션 모드 관문을 지나지 않았습니다 — 확인하지 않은 계좌에 청산 주문을 보내지 않습니다'
      + ' (보호주문도 그대로 둡니다)');
  }
  if (v.ok !== true) {
    const code: KillClosePlanCode =
      v.code === 'HEDGE_UNVERIFIED' ? 'BLOCKED_HEDGE'
        : v.code === 'NO_DIRECTION' ? 'BLOCKED_NO_DIRECTION'
          : 'BLOCKED_MODE_UNKNOWN';
    return blocked(code,
      `${v.message || '포지션 모드를 확인하지 못했습니다'}`
      + ' — 종료 주문 0건, 기존 보호주문도 취소하지 않습니다 (수동 개입 필요)');
  }

  // ── ② 포지션 조회 ──
  if (i?.positions?.ok !== true) {
    return blocked('BLOCKED_POSITIONS_UNREAD',
      '거래소 포지션을 읽지 못했습니다 — 없다는 뜻이 아니므로 주문도 취소도 하지 않습니다');
  }
  const rows = Array.isArray(i.positions.rows) ? i.positions.rows : [];

  // ── ③ 대상 범위 ──
  const scope = (i?.targetSymbols ?? null);
  const wanted = scope == null ? null
    : new Set(scope.map(sym).filter(Boolean));

  // ── ③-a 읽은 줄을 **셋으로** 가른다 ──
  //
  //   닫을 수 있는 것 · 플랫인 것 · **읽을 수 없는 것**
  //
  //   셋째를 조용히 버리면 열려 있는 포지션이 "없음"으로 집계된다. 그래서
  //   수를 세어 들고 간다 — 하나라도 있으면 이 회차는 "정리 완료"가 아니다.
  const closes: KillCloseTarget[] = [];
  let unusable = 0;
  for (const r of rows) {
    const s = sym(r?.symbol);
    const amt = num(r?.amount);
    if (!s) {
      // 종목을 못 읽었다. 수량이 0이 아니면 **열려 있을 수 있다**.
      if (amt == null || Math.abs(amt) > 0) unusable += 1;
      continue;
    }
    if (wanted != null && !wanted.has(s)) continue;   // 범위 밖 — 건드리지 않는다
    if (amt == null) { unusable += 1; continue; }      // 플랫이라고 말할 수 없다
    if (Math.abs(amt) === 0) continue;                 // 플랫

    // ── 방향 ──
    //
    //   `side`가 있으면 그것이 정본이다. 없으면 부호에서 정한다.
    //   **둘이 어긋나면 막는다** — 어느 쪽이 맞는지 알 수 없고, 틀린
    //   방향으로 보내면 청산이 아니라 반대 진입이 된다.
    const declared = r?.side === 'LONG' || r?.side === 'SHORT' ? r.side : null;
    const signed = amt > 0 ? 'LONG' : 'SHORT';
    const side: 'LONG' | 'SHORT' | null = declared == null
      ? (Math.abs(amt) === amt || amt < 0 ? signed : null)
      : (Math.abs(amt) !== amt && declared !== signed ? null : declared);
    if (side == null) { unusable += 1; continue; }
    closes.push({ symbol: s, side, qty: Math.abs(amt) });
  }

  if (closes.length === 0 && unusable > 0) {
    // 닫을 수 있는 것이 하나도 없는데 플랫이라고도 말할 수 없다.
    return blocked('BLOCKED_TARGET_UNUSABLE',
      `포지션 ${unusable}줄을 읽지 못했습니다 — 플랫이라고 적지 않고 막습니다`,
      { unusableTargets: unusable });
  }

  if (closes.length === 0) {
    // 닫을 것이 없다. **그렇다고 남의 주문을 지우지 않는다** — 고아 주문
    // 정리는 다른 경로(`orphanSweep`)의 일이고, 긴급 버튼이 할 일이 아니다.
    return clamp({
      code: 'NOTHING_TO_DO', mayCancel: false, mayClose: false,
      cancelIds: [], unidentifiedOrders: 0, unusableTargets: 0, closes: [],
      protectionRetained: true, manualInterventionRequired: false,
      reason: '닫을 노출이 없습니다 (거래소 확인) — 주문 0건·취소 0건',
    });
  }

  // ── ④⑤ 취소 범위 ──
  //
  // **대상 심볼의, id를 읽은 주문만.** 다른 심볼의 주문은 다른 전략의
  // 것일 수 있고, id를 못 읽은 주문은 "내 것"이라고 말할 수 없다.
  const closeSymbols = new Set(closes.map(c => c.symbol));
  if (i?.openOrders?.ok !== true) {
    // 식별하지 못했다. **전체 취소로 대신하지 않는다.**
    //
    // 닫기는 계속한다 — 종료는 위험을 줄이는 방향이고, 취소를 건너뛰면
    // 보호주문이 남을 뿐이다(축소 전용이라 반대 포지션이 되지 않고,
    // 고아는 `orphanSweep`이 번호로 정리한다).
    return clamp({
      code: 'BLOCKED_ORDERS_UNREAD', mayCancel: false, mayClose: true,
      cancelIds: [], unidentifiedOrders: 0, unusableTargets: unusable, closes,
      protectionRetained: true, manualInterventionRequired: true,
      reason: '미체결 주문을 읽지 못해 어느 것이 대상인지 확인하지 못했습니다'
        + ' — 계좌 전체 취소로 대신하지 않고, 취소 없이 종료만 진행합니다',
    });
  }
  const orders = Array.isArray(i.openOrders.rows) ? i.openOrders.rows : [];
  const cancelIds: string[] = [];
  let unidentified = 0;
  for (const o of orders) {
    const s = sym(o?.symbol);
    const id = String(o?.id ?? '').trim();
    if (!s || !closeSymbols.has(s)) continue;   // 다른 심볼 — 건드리지 않는다
    if (!id) { unidentified += 1; continue; }   // 번호를 못 읽었다 — 남긴다
    cancelIds.push(id);
  }

  return clamp({
    code: unusable > 0 ? 'PROCEED_PARTIAL' : 'PROCEED',
    mayCancel: true, mayClose: true,
    cancelIds, unidentifiedOrders: unidentified, unusableTargets: unusable, closes,
    // 취소를 진행하므로 대상 심볼의 보호주문은 남지 않는다. **그 사실을
    // 그대로 적는다** — 닫기가 실패하면 운영자가 이 칸을 봐야 한다.
    protectionRetained: false,
    // 못 읽은 줄이 하나라도 있으면 이 회차는 "정리 완료"가 아니다.
    manualInterventionRequired: unusable > 0,
    reason: `모드 단방향 확인 · 대상 ${closes.length}종목`
      + ` · 취소 ${cancelIds.length}건`
      + (unidentified > 0 ? ` (번호를 못 읽은 ${unidentified}건은 남깁니다)` : '')
      + (unusable > 0 ? ` · 포지션 ${unusable}줄을 읽지 못해 남았습니다` : ''),
  });
}

// ══════════════════════════════════════════════════════════════
// ★ 취소했는데 종료가 실패했다 — **별도의 위험이다**
// ══════════════════════════════════════════════════════════════
//
// `PROCEED`로 취소까지 한 뒤 종료가 실패하면, 그 포지션은 **보호 없이
// 열린 채** 남는다. 이것은 "실패"와 다른 상태다 — 되돌릴 수 없고 사람이
// 즉시 개입해야 한다. 그래서 따로 판정한다.

export type KillProtectionCode =
  /** 닫혔다. 보호가 필요 없다 */
  | 'CLOSED'
  /** 취소도 종료도 하지 않았다 — 보호주문이 그대로 있다 */
  | 'PROTECTION_INTACT'
  /** **취소했는데 포지션이 남았다.** 무방비 노출 */
  | 'UNPROTECTED_EXPOSURE'
  /** 잔여를 읽지 못했다. 닫혔다는 뜻이 아니다 */
  | 'UNKNOWN';

export interface KillProtectionVerdict {
  code: KillProtectionCode;
  /** 지금 보호 없이 열려 있는가 */
  unprotected: boolean;
  manualInterventionRequired: boolean;
  reason: string;
}

/**
 * 긴급 종료가 끝난 뒤 **보호 상태**를 판정한다.
 *
 * `leftoverPositions`가 `null`이면 **못 읽은 것이다.** 0으로 읽지 않는다 —
 * 그러면 무방비 노출이 "정리됨"으로 적힌다.
 */
export function killProtectionVerdict(i: {
  plan: Pick<KillClosePlan, 'mayCancel' | 'mayClose' | 'cancelIds' | 'protectionRetained'>;
  /** 취소를 **실제로 보냈는가** */
  cancelAttempted: boolean;
  /** 종료 뒤 남은 포지션 수. **못 읽으면 null** */
  leftoverPositions: number | null;
}): KillProtectionVerdict {
  const strippedProtection = i?.cancelAttempted === true
    && (i?.plan?.cancelIds?.length ?? 0) > 0;
  const left = num(i?.leftoverPositions);

  if (left == null) {
    return { code: 'UNKNOWN', unprotected: strippedProtection,
      manualInterventionRequired: true,
      reason: '종료 뒤 잔여를 읽지 못했습니다 — 닫혔다는 뜻이 아닙니다'
        + (strippedProtection
          ? '. 보호주문은 이미 취소했으므로 무방비일 수 있습니다 (즉시 확인 필요)'
          : '') };
  }
  if (left <= 0) {
    return { code: 'CLOSED', unprotected: false, manualInterventionRequired: false,
      reason: '포지션 0을 거래소에서 확인했습니다' };
  }
  if (strippedProtection) {
    return { code: 'UNPROTECTED_EXPOSURE', unprotected: true,
      manualInterventionRequired: true,
      reason: `보호주문 ${i.plan.cancelIds.length}건을 취소한 뒤 포지션 ${left}개가 남았습니다`
        + ' — 무방비 노출입니다. 거래소에서 즉시 닫거나 보호주문을 다시 걸어야 합니다' };
  }
  return { code: 'PROTECTION_INTACT', unprotected: false,
    manualInterventionRequired: true,
    reason: `포지션 ${left}개가 남았지만 보호주문은 취소하지 않았습니다`
      + ' — 기존 보호가 그대로 있습니다 (수동 확인 필요)' };
}

// ══════════════════════════════════════════════════════════════
// ★ "주문만 중지" 단계 — 보호주문을 벗기지 않고 문을 잠근다
// ══════════════════════════════════════════════════════════════
//
// `actionMode`에 `C`만 있고 `D`가 없는 단계(진입 중지·계좌 잠금)는
// **포지션을 닫지 않는다.** 그런데 예전 구현은 계좌 전체 Cancel All을
// 불렀다. 그러면:
//
//     포지션은 열린 채로 두고 **그 포지션의 손절만 지운다**
//
// 닫지도 않으면서 보호만 벗기는 것이고, P1이 금지한 바로 그 상태다.
//
// 그래서 범위를 뒤집는다. 취소해도 되는 것은 **열린 포지션이 없는
// 심볼의 주문**뿐이다 — 그건 아직 진입하지 않은 대기 주문이고, 지우면
// 새 노출이 생기는 것을 막는다(= 문을 잠그는 일). 열린 포지션이 있는
// 심볼의 주문은 **그 포지션의 보호일 수 있으므로 건드리지 않는다.**
//
// 포지션을 못 읽었으면 어느 심볼이 비어 있는지 말할 수 없다 → 0건.

export type KillCancelOnlyCode =
  /** 취소할 대기 주문을 찾았다 */
  | 'CANCEL_PENDING_ONLY'
  /** 취소할 것이 없다 */
  | 'NOTHING_TO_CANCEL'
  /** 포지션을 못 읽어 어느 심볼이 비어 있는지 모른다 */
  | 'BLOCKED_POSITIONS_UNREAD'
  /** 미체결 주문을 못 읽었다 */
  | 'BLOCKED_ORDERS_UNREAD';

export interface KillCancelOnlyPlan {
  code: KillCancelOnlyCode;
  /** 취소해도 되는 주문 id — **열린 포지션이 없는 심볼의 것만** */
  cancelIds: string[];
  /** 열린 포지션이 있어서 **남긴** 주문 수 (= 보호일 수 있는 것) */
  retainedProtective: number;
  /** 번호를 못 읽어 남긴 주문 수 */
  unidentifiedOrders: number;
  reason: string;
}

/**
 * **포지션을 닫지 않는 단계에서 무엇을 취소해도 되는가.**
 *
 * 열린 포지션이 있는 심볼의 주문은 **하나도** 넣지 않는다. 그 주문이
 * 보호인지 아닌지 이 판정은 알 수 없고, 모르는 것을 지우면 그 포지션이
 * 무방비가 된다.
 */
export function planKillCancelOnly(i: {
  positions: { ok: boolean; rows?: KillPositionRow[] | null };
  openOrders: { ok: boolean; rows?: KillOpenOrderRow[] | null };
} | null | undefined): KillCancelOnlyPlan {
  if (i?.positions?.ok !== true) {
    return { code: 'BLOCKED_POSITIONS_UNREAD', cancelIds: [],
      retainedProtective: 0, unidentifiedOrders: 0,
      reason: '포지션을 읽지 못해 어느 심볼이 비어 있는지 확인할 수 없습니다'
        + ' — 보호주문을 지울 위험이 있어 취소하지 않습니다' };
  }
  if (i?.openOrders?.ok !== true) {
    return { code: 'BLOCKED_ORDERS_UNREAD', cancelIds: [],
      retainedProtective: 0, unidentifiedOrders: 0,
      reason: '미체결 주문을 읽지 못했습니다 — 계좌 전체 취소로 대신하지 않습니다' };
  }

  // 열려 있는(또는 플랫이라고 말할 수 없는) 심볼
  const occupied = new Set<string>();
  for (const r of (i.positions.rows ?? [])) {
    const s = sym(r?.symbol);
    if (!s) continue;
    const amt = num(r?.amount);
    // **못 읽은 수량은 "비어 있다"가 아니다.** 점유로 센다.
    if (amt == null || Math.abs(amt) > 0) occupied.add(s);
  }

  const cancelIds: string[] = [];
  let retained = 0;
  let unidentified = 0;
  for (const o of (i.openOrders.rows ?? [])) {
    const s = sym(o?.symbol);
    const id = String(o?.id ?? '').trim();
    if (!s) { unidentified += 1; continue; }
    if (occupied.has(s)) { retained += 1; continue; }   // 보호일 수 있다 — 남긴다
    if (!id) { unidentified += 1; continue; }
    cancelIds.push(id);
  }

  return {
    code: cancelIds.length > 0 ? 'CANCEL_PENDING_ONLY' : 'NOTHING_TO_CANCEL',
    cancelIds, retainedProtective: retained, unidentifiedOrders: unidentified,
    reason: `열린 포지션이 없는 심볼의 대기 주문 ${cancelIds.length}건만 취소합니다`
      + (retained > 0
        ? ` · 포지션이 있는 심볼의 주문 ${retained}건은 보호일 수 있어 남깁니다`
        : '')
      + (unidentified > 0 ? ` · 식별 못 한 ${unidentified}건은 남깁니다` : ''),
  };
}
