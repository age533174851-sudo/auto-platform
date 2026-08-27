// src/lib/engine/orphanSweep.ts
//
// **포지션이 0인데 남아 있는 보호주문을, 전략을 가리지 않고 치운다.**
//
// 무엇이 비어 있었나
// ──────────────────
// 청산 감시(`/api/autotrade/exit-monitor`)는 `decideExits`가 준 목록만
// 본다. 그 함수가 읽는 표는 `ladder_daily_trades` **하나뿐**이고, 그건
// 계단식(`daily-ladder`) 전용 표다. `ladderGate.ts` 말고는 아무도 안 쓴다.
//
// 그래서 `scalp`과 `my-original-v1`으로 들어간 포지션은 청산 감시의
// 어느 단계에도 오르지 않았다:
//
//   · 거래소 SL/TP가 포지션을 닫아 준 뒤 남은 형제 주문을 아무도 안 치웠다
//   · 그 사실이 응답 어디에도 안 적혔다 — **처리 0건과 구분되지 않았다**
//
// `my-original-v1`에는 정리가 있다. 다만 **다음 진입 직전**에만 돈다.
// 하루 1회 전략이므로 최소 하루는 남고, 예약을 끄면 영원히 남는다.
// 실제 Gate 계정에 Positions 0 / Orders 1이 남았던 것이 이 경로다.
//
// 어떻게 고치는가
// ───────────────
// 전략별 표가 아니라 **모든 전략이 함께 쓰는 `live_orders`**를 본다.
// 거기에는 걸 때 받아 적은 `sl_order_id` · `tp_order_id`와 그 주문이
// 어느 연결로 나갔는지(`connection_id`)가 같이 있다.
//
// 절대 하지 않는 것
// ─────────────────
// · **Cancel All을 부르지 않는다.** 적어 둔 번호와 일치하는 것만 지운다
//   (`cleanupOwnedProtectionWhenFlat`의 `ownedOnly`).
// · **연결을 추측하지 않는다.** `connection_id`가 없는 줄은 대상에서
//   빼고 그 사실을 남긴다. 사용자의 활성 연결 중 아무거나 골라 쓰면
//   실계좌 포지션을 테스트넷에 물어보게 된다.
// · **조회 실패를 '포지션 0'으로 읽지 않는다.** 0이 아니라 모르는 것이다.

/** `live_orders`에서 이 파일이 쓰는 칸만 */
export interface ProtectionRow {
  connection_id?: any;
  user_id?: any;
  symbol?: any;
  sl_order_id?: any;
  tp_order_id?: any;
  strategy_id?: any;
  created_at?: any;
}

/** 한 번 볼 (연결 · 종목) 한 쌍 */
export interface SweepTarget {
  connectionId: string;
  symbol: string;
  userId: string | null;
  /** 이 쌍에 대해 적어 둔 보호주문 번호가 있는 줄 수. 기록용 */
  rows: number;
}

export type SweepSkipCode =
  /** 걸어 둔 보호주문 번호가 적혀 있지 않다 */
  | 'NO_PROTECTION_ID'
  /** 어느 연결로 나갔는지 안 적혀 있다 — **추측하지 않는다** */
  | 'NO_CONNECTION'
  /** 종목을 못 읽었다 */
  | 'NO_SYMBOL'
  /** 이번 회차 상한을 넘었다 */
  | 'OVER_LIMIT';

export interface SweepSelection {
  targets: SweepTarget[];
  skipped: Array<{ code: SweepSkipCode; count: number; reason: string }>;
}

const SKIP_REASON: Record<SweepSkipCode, string> = {
  NO_PROTECTION_ID: '걸어 둔 보호주문 번호가 적혀 있지 않아 남의 주문과 구분할 수 없습니다',
  NO_CONNECTION: '어느 연결로 나간 주문인지 적혀 있지 않습니다 — 연결을 추측하지 않습니다',
  NO_SYMBOL: '종목을 읽지 못했습니다',
  OVER_LIMIT: '이번 회차 상한을 넘어 다음 회차로 미뤘습니다',
};

/** 번호가 실제로 있는가. `String()`으로 만든 빈 값·'null'·'undefined'는 없는 것이다 */
function hasId(v: any): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && s !== 'null' && s !== 'undefined' && s !== '0';
}

/**
 * 이번 회차에 볼 (연결 · 종목) 목록.
 *
 * **건너뛴 것을 세어서 돌려준다.** 조용히 빼면 "볼 것이 없었다"와
 * "볼 수 있는 모양이 아니었다"가 응답에서 같아진다.
 */
export function sweepTargets(
  rows: ProtectionRow[] | null | undefined,
  opts?: { limit?: number },
): SweepSelection {
  const limit = Math.max(1, opts?.limit ?? 40);
  const byKey = new Map<string, SweepTarget>();
  const skips = new Map<SweepSkipCode, number>();
  const bump = (c: SweepSkipCode) => skips.set(c, (skips.get(c) ?? 0) + 1);

  for (const r of Array.isArray(rows) ? rows : []) {
    if (!hasId(r?.sl_order_id) && !hasId(r?.tp_order_id)) { bump('NO_PROTECTION_ID'); continue; }
    const symbol = String(r?.symbol ?? '').trim();
    if (!symbol) { bump('NO_SYMBOL'); continue; }
    const conn = String(r?.connection_id ?? '').trim();
    if (!conn) { bump('NO_CONNECTION'); continue; }

    const key = `${conn}:${symbol.toUpperCase()}`;
    const hit = byKey.get(key);
    if (hit) { hit.rows += 1; continue; }
    byKey.set(key, {
      connectionId: conn, symbol,
      userId: String(r?.user_id ?? '').trim() || null,
      rows: 1,
    });
  }

  const all = [...byKey.values()];
  const targets = all.slice(0, limit);
  if (all.length > limit) skips.set('OVER_LIMIT', all.length - limit);

  return {
    targets,
    skipped: [...skips.entries()].map(([code, count]) => ({ code, count, reason: SKIP_REASON[code] })),
  };
}

export type SweepDecisionCode =
  /** 포지션이 0으로 **확인됐고** 내 번호가 있다 — 치운다 */
  | 'CLEANUP'
  /** 아직 포지션이 있다 — 보호주문은 남아 있어야 한다 */
  | 'HAS_POSITION'
  /** 조회에 실패했다. **0이라는 뜻이 아니다** */
  | 'UNREADABLE'
  /** 적어 둔 번호를 못 찾았다 — 식별자만으로 남의 것과 못 가른다 */
  | 'NO_OWNED_IDS';

export interface SweepDecision {
  code: SweepDecisionCode;
  /** 거래소에 취소를 보낼 것인가 */
  cleanup: boolean;
  reason: string;
}

/**
 * 이 (연결 · 종목)을 지금 치울 것인가.
 *
 * **판단을 라우트에 적지 않는다.** 같은 판단이 두 곳에 있으면 언젠가
 * 한쪽만 바뀌고, 이 판단이 갈리면 남의 손절이 지워지거나 내 고아가
 * 영원히 남는다.
 */
export function sweepDecision(i: {
  position: { ok: boolean; found: boolean } | null | undefined;
  ownedIdCount: number;
}): SweepDecision {
  const p = i.position;
  // **순서가 곧 의미다.** 못 읽은 것을 먼저 가른다 — 그 뒤 값은 사실이 아니다.
  if (!p || p.ok !== true) {
    return {
      code: 'UNREADABLE', cleanup: false,
      reason: '포지션을 읽지 못했습니다 — 0이라는 뜻이 아니므로 보호주문을 건드리지 않습니다',
    };
  }
  if (p.found) {
    return { code: 'HAS_POSITION', cleanup: false, reason: '포지션이 아직 있습니다 — 보호주문은 남아 있어야 합니다' };
  }
  if (!(i.ownedIdCount > 0)) {
    return {
      code: 'NO_OWNED_IDS', cleanup: false,
      reason: '적어 둔 주문 번호가 없어 내 보호주문인지 증명할 수 없습니다 — 지우지 않습니다',
    };
  }
  return { code: 'CLEANUP', cleanup: true, reason: '포지션 0 확인 · 적어 둔 번호와 일치하는 것만 취소합니다' };
}

/**
 * 회차 결과 한 줄.
 *
 * **아무것도 안 한 것과 못 한 것을 같은 문장으로 적지 않는다.**
 */
export function sweepSummary(i: {
  targets: number;
  cleaned: number;
  stillPresent: number;
  unreadable: number;
  skipped: number;
}): string {
  if (i.targets === 0 && i.skipped === 0) return '치울 보호주문 후보가 없습니다';
  const parts = [`후보 ${i.targets}곳`];
  if (i.cleaned > 0) parts.push(`정리 ${i.cleaned}건`);
  if (i.stillPresent > 0) parts.push(`아직 남음 ${i.stillPresent}건`);
  if (i.unreadable > 0) parts.push(`확인 못 함 ${i.unreadable}곳`);
  if (i.skipped > 0) parts.push(`대상 아님 ${i.skipped}줄`);
  return parts.join(' · ');
}
