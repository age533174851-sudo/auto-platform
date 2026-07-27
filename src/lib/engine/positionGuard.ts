// src/lib/engine/positionGuard.ts
//
// 기술적 사고에만 반응하는 포지션 보호 감시.
//
// ⚠️ 이 모듈은 방향 판단을 하지 않는다.
//
// "다음 날 09:00까지 보유"가 전략의 규칙이다. 가격이 잠깐 반대로 갔다는
// 이유로 임의 청산하면 그건 다른 전략이 된다. 그래서 이 모듈은 미실현손익을
// 입력으로 받지도 않는다 — 받으면 언젠가 그것으로 판단하게 된다.
//
// 여기서 다루는 것은 "포지션을 계속 들고 있는 것이 기술적으로 위험하거나
// 불가능해진 상태"뿐이다:
//
//   1. 청산가 접근      — 남은 거리가 초기의 일부만 남았다. 버티는 게 아니라
//                         증거금 전액을 잃기 직전이다.
//   2. Mark Price 급변  — 짧은 구간에 비정상적으로 움직였다. 청산 판단은
//                         체결가가 아니라 Mark Price로 이뤄진다.
//   3. 거래소 연결 끊김 — 상태를 확인할 수 없으면 보호 장치도 동작을 보장할 수 없다.
//   4. 보호주문 소실    — 손절이 사라졌다. 포지션 크기는 손절이 있다는 전제로
//                         계산된 값이다.
//   5. 마진 모드 변경   — ISOLATED가 Cross로 바뀌면 손실이 계좌 전체로 번진다.
//                         계단식 증거금 상한이 의미를 잃는다.

export type GuardFault =
  | 'LIQUIDATION_PROXIMITY'
  | 'MARK_PRICE_SHOCK'
  | 'EXCHANGE_UNREACHABLE'
  | 'PROTECTIVE_ORDER_LOST'
  | 'MARGIN_MODE_CHANGED';

export interface GuardFinding {
  code: GuardFault;
  severity: 'warn' | 'critical';
  detail: string;
}

export interface GuardVerdict {
  faults: GuardFinding[];
  /** CLOSE는 즉시 청산, ALERT는 알림만, NONE은 이상 없음 */
  action: 'NONE' | 'ALERT' | 'CLOSE';
  reason: string;
}

export interface PositionSnapshot {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  /** 거래소가 보고한 마진 타입. 'isolated'가 아니면 사고다. */
  marginType?: string | null;
  /** 손절 주문이 거래소에 살아 있는가 */
  hasProtectiveStop: boolean;
  /** 거래소 조회가 성공했는가 */
  exchangeReachable: boolean;
  /** 최근 Mark Price 시계열 (오래된 것 → 최신). 급변 감지용. */
  recentMarks?: number[];
}

export interface GuardConfig {
  /**
   * 청산까지 남은 거리가 초기 거리의 이 비율 이하로 줄면 위험으로 본다.
   * 0.35면 "초기 거리의 65%를 이미 소진"이라는 뜻이다.
   * 값을 크게 잡으면 방향이 조금만 흔들려도 청산하게 되므로 전략이 바뀐다.
   */
  liquidationProximityRatio?: number;
  /** 최근 구간 Mark Price 변동폭이 이 %를 넘으면 급변으로 본다 */
  markShockPct?: number;
  /** 보호주문 소실을 즉시 청산 사유로 볼지 */
  closeOnMissingStop?: boolean;
}

const DEFAULTS: Required<GuardConfig> = {
  liquidationProximityRatio: 0.35,
  markShockPct: 1.5,
  closeOnMissingStop: true,
};

/**
 * 포지션 상태를 점검한다. 순수 함수 — 주문을 내지 않고 판단만 한다.
 *
 * 입력에 미실현손익이 없는 것은 의도적이다. 방향으로 판단하지 않기 위함이다.
 */
export function checkPositionGuard(
  pos: PositionSnapshot,
  cfg: GuardConfig = {},
): GuardVerdict {
  const c = { ...DEFAULTS, ...cfg };
  const faults: GuardFinding[] = [];

  // ── 3. 거래소 연결 ──
  // 가장 먼저 본다. 연결이 끊겼으면 나머지 정보를 믿을 수 없다.
  if (!pos.exchangeReachable) {
    faults.push({
      code: 'EXCHANGE_UNREACHABLE', severity: 'critical',
      detail: '거래소 조회 실패 — 포지션 상태와 보호주문 동작을 확인할 수 없습니다',
    });
    // 연결이 없으면 청산 주문도 못 낸다. 알림만 올린다.
    return {
      faults, action: 'ALERT',
      reason: '거래소에 접근할 수 없어 상태를 확인할 수 없습니다. 청산 주문도 나가지 않으므로 수동 확인이 필요합니다.',
    };
  }

  // ── 5. 마진 모드 ──
  if (pos.marginType && String(pos.marginType).toLowerCase() !== 'isolated') {
    faults.push({
      code: 'MARGIN_MODE_CHANGED', severity: 'critical',
      detail: `마진 모드가 ${pos.marginType} — ISOLATED가 아닙니다. 손실이 계좌 전체로 번집니다`,
    });
  }

  // ── 4. 보호주문 ──
  if (!pos.hasProtectiveStop) {
    faults.push({
      code: 'PROTECTIVE_ORDER_LOST', severity: 'critical',
      detail: '손절 주문이 거래소에 없습니다 — 포지션 크기를 정당화하던 전제가 사라졌습니다',
    });
  }

  // ── 1. 청산가 접근 ──
  const isLong = pos.side === 'LONG';
  const initialDist = Math.abs(pos.entryPrice - pos.liquidationPrice);
  const remainingDist = isLong
    ? pos.markPrice - pos.liquidationPrice
    : pos.liquidationPrice - pos.markPrice;

  if (initialDist > 0 && pos.liquidationPrice > 0) {
    const ratio = remainingDist / initialDist;
    if (ratio <= 0) {
      faults.push({
        code: 'LIQUIDATION_PROXIMITY', severity: 'critical',
        detail: `Mark Price가 청산가를 지났습니다 (${pos.markPrice} vs ${pos.liquidationPrice})`,
      });
    } else if (ratio <= c.liquidationProximityRatio) {
      faults.push({
        code: 'LIQUIDATION_PROXIMITY', severity: 'critical',
        detail: `청산까지 초기 거리의 ${(ratio * 100).toFixed(0)}%만 남았습니다 ` +
                `(Mark ${pos.markPrice.toFixed(2)} · 청산 ${pos.liquidationPrice.toFixed(2)})`,
      });
    }
  }

  // ── 2. Mark Price 급변 ──
  const marks = pos.recentMarks;
  if (marks && marks.length >= 2) {
    const lo = Math.min(...marks);
    const hi = Math.max(...marks);
    if (lo > 0) {
      const swingPct = ((hi - lo) / lo) * 100;
      if (swingPct >= c.markShockPct) {
        faults.push({
          code: 'MARK_PRICE_SHOCK', severity: 'warn',
          detail: `최근 구간 Mark Price가 ${swingPct.toFixed(2)}% 흔들렸습니다 (기준 ${c.markShockPct}%)`,
        });
      }
    }
  }

  if (faults.length === 0) {
    return { faults, action: 'NONE', reason: '이상 없음' };
  }

  // 청산 사유 판정 — 보호주문 소실은 설정에 따른다
  const closeWorthy = faults.filter(f => {
    if (f.severity !== 'critical') return false;
    if (f.code === 'PROTECTIVE_ORDER_LOST') return c.closeOnMissingStop;
    return true;
  });

  if (closeWorthy.length > 0) {
    return {
      faults, action: 'CLOSE',
      reason: closeWorthy.map(f => f.detail).join(' / '),
    };
  }

  return {
    faults, action: 'ALERT',
    reason: faults.map(f => f.detail).join(' / '),
  };
}
