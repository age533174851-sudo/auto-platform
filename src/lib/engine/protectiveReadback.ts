// src/lib/engine/protectiveReadback.ts
//
// **거래소에 실제로 걸려 있는지 다시 읽어서 확인한다.**
//
// 왜 생성 응답을 믿으면 안 되는가
// ───────────────────────────────
// 지금 Gate 경로는 `placeStopGateFutures`가 `{success: true, orderId}`를
// 돌려주면 손절이 걸린 것으로 적는다. 그런데 그 응답은 **접수**를 뜻하고,
// 그 뒤에 조건부 주문이 사라지는 경우가 있다:
//
//   · 트리거 가격이 현재가 반대편이면 즉시 발동해 사라진다
//   · 포지션이 없으면 auto_size 주문이 조용히 정리된다
//   · 계약 규격·트리거 방향이 어긋나면 접수만 되고 등록되지 않는다
//
// 그리고 오늘 확인된 것: **TP는 생성 자체가 안 되고 있었다.**
// `exitPlan`과 `takeProfit`이 Gate 분기에서 아무 데도 안 쓰였다 —
// 만들어 놓고 배선을 안 한 이 저장소의 대표 고장이다. 그 상태에서
// 화면은 "익절 +0.8%"라고 적고 있었다.
//
// 그래서 규칙
// ───────────
// 걸었다고 적으려면 **다시 읽어서 그 주문을 찾아야 한다.** 찾을 때
// 대조하는 것은 다섯이다: 종목 · 닫는 방향 · 청산 전용 · 트리거 가격 ·
// 주문 id. 하나라도 안 맞으면 그건 내가 건 그 주문이 아니다.
//
// 못 찾으면 `unprotected: true`로 적고 끝내지 않는다 — **진입 자체를
// 완료로 판정하지 않는다.** 보호되지 않은 100배 포지션을 '진입 성공'
// 이라고 적는 것이 이 저장소에서 가장 비싼 한 줄이다.

import { gateProtectiveKind, type ProtectiveClass } from '../exchanges/gatePlan';
import { venueIdOf } from '../exchanges/losslessJson';

/**
 * 바이낸스 미체결 주문 한 줄이 손절인가 익절인가.
 *
 * Gate의 판별표(`gateProtectiveKind`)와 **같은 결론 모양**을 돌려준다.
 * 거래소마다 판정 결과의 모양이 다르면 위쪽 판정이 거래소별로 갈리고,
 * 그때 한쪽만 고쳐진다.
 *
 *   STOP_MARKET · STOP           → 손절
 *   TAKE_PROFIT_MARKET · TAKE_PROFIT → 익절
 *   SELL이 LONG을 닫고, BUY가 SHORT를 닫는다
 */
export function binanceProtectiveKind(row: any | null | undefined): ProtectiveClass {
  if (!row || typeof row !== 'object') {
    return { kind: 'UNKNOWN', closes: null, reason: '주문 내용을 읽지 못했습니다' };
  }
  const type = String(row.type ?? row.origType ?? '').toUpperCase();
  const kind = /^STOP(_MARKET)?$/.test(type) ? 'STOP' as const
    : /^TAKE_PROFIT(_MARKET)?$/.test(type) ? 'TAKE_PROFIT' as const
      : type ? 'NOT_PROTECTIVE' as const : 'UNKNOWN' as const;
  if (kind === 'UNKNOWN') {
    return { kind, closes: null, reason: '주문 종류를 읽지 못했습니다' };
  }
  if (kind === 'NOT_PROTECTIVE') {
    return { kind, closes: null, reason: `보호 주문이 아닙니다 (${type})` };
  }
  // **닫는 주문인지 확인한다.** reduceOnly도 closePosition도 아니면
  // 그건 신규 진입 예약일 수 있다 — 손절로 세면 없는 방어선이 생긴다.
  if (row.reduceOnly !== true && row.closePosition !== true) {
    return { kind: 'NOT_PROTECTIVE', closes: null,
      reason: '청산 전용(reduceOnly/closePosition) 표시가 없습니다' };
  }
  const side = String(row.side ?? '').toUpperCase();
  const closes = side === 'SELL' ? 'LONG' as const : side === 'BUY' ? 'SHORT' as const : null;
  if (!closes) {
    return { kind: 'UNKNOWN', closes: null, reason: `어느 방향을 닫는지 읽지 못했습니다 (side=${side || '-'})` };
  }
  return { kind, closes, reason: '' };
}

export interface ProtectiveEvidence {
  /** **조회 자체가 성공했는가.** false면 found는 의미가 없다 */
  readOk: boolean;
  /** 기대한 그 주문을 찾았는가 */
  found: boolean;
  orderId: string | null;
  triggerPrice: number | null;
  closes: 'LONG' | 'SHORT' | null;
  reason: string;
}

const EMPTY = (reason: string): ProtectiveEvidence =>
  ({ readOk: false, found: false, orderId: null, triggerPrice: null, closes: null, reason });

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 트리거 가격이 기대한 값인가.
 *
 * 정확히 같기를 요구하지 않는다 — 호가 단위 보정으로 한 틱 차이가 날 수
 * 있다. 다만 **허용 폭은 좁다.** 넓게 잡으면 다른 목적의 주문을 내
 * 손절로 착각한다.
 */
export function triggerMatches(actual: any, expected: any, tolerancePct = 0.2): boolean {
  const a = num(actual); const e = num(expected);
  if (a == null || e == null || e <= 0) return false;
  return Math.abs(a - e) / e * 100 <= tolerancePct;
}

export interface ReadbackResult {
  /** 목록 조회가 성공했는가 */
  readOk: boolean;
  stop: ProtectiveEvidence;
  takeProfit: ProtectiveEvidence;
  /** 내 것이 아닌(또는 판별 불가) 조건부 주문 수. **취소 대상이 아니다** */
  otherCount: number;
  reason: string;
}

/**
 * 걸려 있는 조건부 주문에서 내 손절·익절을 찾는다.
 *
 * `orders`가 **null이면 '못 읽음'이고 `[]`는 '없음'이다.** 이 둘을 섞으면
 * 조회 실패가 "보호주문 0건"으로 그려지고, 사용자는 손절이 없다고 믿거나
 * (더 나쁘게는) 시스템이 다시 걸어서 손절이 두 개가 된다.
 */
export function readbackProtective(i: {
  orders: any[] | null;
  /** 지금 열려 있는 포지션의 방향. 이 포지션을 **닫는** 주문을 찾는다 */
  positionSide: 'LONG' | 'SHORT';
  expectedStop?: number | null;
  expectedTakeProfit?: number | null;
  tolerancePct?: number;
  error?: string | null;
  /** 기본은 Gate. 두 거래소의 판별표를 이 함수 하나가 고른다 */
  venue?: 'gate' | 'binance';
}): ReadbackResult {
  if (i?.orders == null) {
    const why = `조건부 주문 목록을 읽지 못했습니다${i?.error ? ` (${i.error})` : ''} — `
      + '0건과 다릅니다. 걸렸다고도 안 걸렸다고도 적지 않습니다';
    return { readOk: false, stop: EMPTY(why), takeProfit: EMPTY(why), otherCount: 0, reason: why };
  }

  const tol = num(i.tolerancePct) ?? 0.2;
  let stop = EMPTY('요청한 손절을 거래소 목록에서 찾지 못했습니다');
  let tp = EMPTY('요청한 익절을 거래소 목록에서 찾지 못했습니다');
  stop.readOk = true; tp.readOk = true;
  let other = 0;

  const binance = i.venue === 'binance';
  for (const row of i.orders) {
    // 손절인지 익절인지의 판별표는 거래소마다 한 곳씩만 있다.
    // 여기서 부등호를 다시 쓰면 거는 쪽과 세는 쪽이 갈린다.
    const cls = binance ? binanceProtectiveKind(row) : gateProtectiveKind(row);
    const trigger = num(binance
      ? (row?.stopPrice ?? row?.triggerPrice)
      : (row?.trigger?.price ?? row?.triggerPrice));
    // **번호는 십진 문자열이다.** 숫자로 읽혀 반올림된 int64를 여기서
    // 받아 적으면, 그 번호로 나가는 취소가 전부 "그런 주문 없다"가 된다.
    const id = venueIdOf(binance ? (row?.orderId ?? row?.id) : row?.id);

    // **이 포지션을 닫는 주문만 센다.** 반대 방향을 닫는 주문은 남의
    // 것이거나 옛 포지션의 고아다.
    if (cls.kind === 'NOT_PROTECTIVE' || cls.closes !== i.positionSide) { other++; continue; }

    if (cls.kind === 'STOP' && !stop.found
        && (i.expectedStop == null || triggerMatches(trigger, i.expectedStop, tol))) {
      stop = { readOk: true, found: true, orderId: id, triggerPrice: trigger, closes: cls.closes,
        reason: `손절 확인 — 트리거 ${trigger} (${cls.closes} 청산)` };
      continue;
    }
    if (cls.kind === 'TAKE_PROFIT' && !tp.found
        && (i.expectedTakeProfit == null || triggerMatches(trigger, i.expectedTakeProfit, tol))) {
      tp = { readOk: true, found: true, orderId: id, triggerPrice: trigger, closes: cls.closes,
        reason: `익절 확인 — 트리거 ${trigger} (${cls.closes} 청산)` };
      continue;
    }
    // 종류를 못 가른 것(UNKNOWN)이나 가격이 안 맞는 것은 **내 주문이
    // 아니다.** 있는 것을 내 것으로 세면 없는 보호를 있다고 적게 된다.
    other++;
  }

  return {
    readOk: true, stop, takeProfit: tp, otherCount: other,
    reason: `조건부 주문 ${i.orders.length}건 조회 · 손절 ${stop.found ? '확인' : '없음'}`
      + ` · 익절 ${tp.found ? '확인' : '없음'}`
      + (other ? ` · 이 포지션과 무관/판별불가 ${other}건` : ''),
  };
}
