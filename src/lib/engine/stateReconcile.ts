// src/lib/engine/stateReconcile.ts
//
// 앱이 표시하는 상태와 거래소 실제 상태를 대조한다.
//
// 왜 이것이 먼저인가
// ─────────────────
// 화면·위험판·전략 판단이 모두 "앱이 알고 있는 포지션"을 전제로 돌아간다.
// 그 전제가 틀리면 나머지는 틀린 숫자를 정확하게 계산할 뿐이다.
// 예: 거래소에서 이미 청산됐는데 앱은 보유 중으로 알고 있으면, 계단식 게이트가
// "오늘 거래함"으로 판단해 다음 진입을 막고, 위험판은 없는 포지션의 청산가를 그린다.
//
// 설계
// ────
//  - 순수 함수다. 조회도 주문도 하지 않는다. 호출자가 양쪽 스냅샷을 넘긴다.
//    그래야 테스트에서 임의의 불일치를 만들어 검증할 수 있다.
//  - 판정만 하고 조치는 하지 않는다. 자동으로 포지션을 정리하면 일시적인
//    조회 실패가 실제 포지션을 닫아버릴 수 있다.
//  - 불일치의 심각도를 나눈다. 수량이 다른 것과 마진 모드가 다른 것은
//    같은 무게가 아니다.

export type MismatchCode =
  | 'POSITION_MISSING_ON_EXCHANGE'   // 앱엔 있는데 거래소엔 없음
  | 'POSITION_MISSING_IN_APP'        // 거래소엔 있는데 앱엔 없음
  | 'POSITION_SIDE_DIFFERS'
  | 'POSITION_QTY_DIFFERS'
  | 'LEVERAGE_DIFFERS'
  | 'MARGIN_TYPE_DIFFERS'
  | 'PROTECTIVE_ORDER_MISSING'
  | 'ORDER_MISSING_ON_EXCHANGE'
  | 'ORDER_MISSING_IN_APP'
  | 'BALANCE_DIFFERS';

export interface Mismatch {
  code: MismatchCode;
  severity: 'info' | 'warn' | 'critical';
  symbol?: string;
  detail: string;
  app?: string | number | null;
  exchange?: string | number | null;
}

export interface ReconcileVerdict {
  ok: boolean;
  /** critical이 하나라도 있으면 신규 주문을 막아야 한다 */
  blockNewOrders: boolean;
  mismatches: Mismatch[];
  summary: string;
  checkedAt: string;
}

export interface PositionView {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  leverage?: number | null;
  marginType?: string | null;
  hasProtectiveStop?: boolean;
}

export interface OrderView {
  clientOrderId: string;
  symbol: string;
}

export interface ReconcileInput {
  appPositions: PositionView[];
  exchangePositions: PositionView[];
  appOpenOrders?: OrderView[];
  exchangeOpenOrders?: OrderView[];
  appBalance?: number | null;
  exchangeBalance?: number | null;
  /** 수량 비교 허용 오차 (비율). 기본 0.5% — 부분 체결·반올림 차이를 흡수한다 */
  qtyTolerancePct?: number;
  /** 잔고 비교 허용 오차 (비율). 기본 1% — 미실현손익 반영 시점 차이가 있다 */
  balanceTolerancePct?: number;
}

const key = (p: { symbol: string }) => p.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function reconcileState(input: ReconcileInput): ReconcileVerdict {
  const qtyTol = (input.qtyTolerancePct ?? 0.5) / 100;
  const balTol = (input.balanceTolerancePct ?? 1) / 100;
  const m: Mismatch[] = [];

  const appMap = new Map(input.appPositions.map(p => [key(p), p]));
  const exMap = new Map(input.exchangePositions.map(p => [key(p), p]));

  // ── 포지션 대조 ──
  for (const [k, app] of appMap) {
    const ex = exMap.get(k);
    if (!ex) {
      m.push({
        code: 'POSITION_MISSING_ON_EXCHANGE', severity: 'critical', symbol: app.symbol,
        detail: `앱은 ${app.symbol} ${app.side} ${app.qty}를 보유 중으로 표시하지만 거래소에 없습니다 (이미 청산됐을 수 있습니다)`,
        app: `${app.side} ${app.qty}`, exchange: null,
      });
      continue;
    }

    if (app.side !== ex.side) {
      m.push({
        code: 'POSITION_SIDE_DIFFERS', severity: 'critical', symbol: app.symbol,
        detail: `${app.symbol} 방향 불일치 — 앱 ${app.side} / 거래소 ${ex.side}`,
        app: app.side, exchange: ex.side,
      });
    }

    const base = Math.max(Math.abs(app.qty), Math.abs(ex.qty), 1e-12);
    if (Math.abs(app.qty - ex.qty) / base > qtyTol) {
      m.push({
        code: 'POSITION_QTY_DIFFERS', severity: 'warn', symbol: app.symbol,
        detail: `${app.symbol} 수량 불일치 — 앱 ${app.qty} / 거래소 ${ex.qty}`,
        app: app.qty, exchange: ex.qty,
      });
    }

    if (app.leverage != null && ex.leverage != null && app.leverage !== ex.leverage) {
      m.push({
        code: 'LEVERAGE_DIFFERS', severity: 'warn', symbol: app.symbol,
        detail: `${app.symbol} 레버리지 불일치 — 앱 ${app.leverage}배 / 거래소 ${ex.leverage}배`,
        app: app.leverage, exchange: ex.leverage,
      });
    }

    // 마진 모드는 격리 전제가 걸린 값이라 critical이다.
    // 앱이 isolated로 알고 있는데 실제가 cross면 손실이 계좌 전체로 번진다.
    const appMt = String(app.marginType ?? '').toLowerCase();
    const exMt = String(ex.marginType ?? '').toLowerCase();
    if (appMt && exMt && appMt !== exMt) {
      m.push({
        code: 'MARGIN_TYPE_DIFFERS', severity: 'critical', symbol: app.symbol,
        detail: `${app.symbol} 마진 모드 불일치 — 앱 ${appMt} / 거래소 ${exMt}`,
        app: appMt, exchange: exMt,
      });
    }

    if (ex.hasProtectiveStop === false) {
      m.push({
        code: 'PROTECTIVE_ORDER_MISSING', severity: 'critical', symbol: app.symbol,
        detail: `${app.symbol} 손절 주문이 거래소에 없습니다 — 포지션 크기를 정당화하던 전제가 사라졌습니다`,
      });
    }
  }

  for (const [k, ex] of exMap) {
    if (appMap.has(k)) continue;
    m.push({
      code: 'POSITION_MISSING_IN_APP', severity: 'critical', symbol: ex.symbol,
      detail: `거래소에 ${ex.symbol} ${ex.side} ${ex.qty}가 있는데 앱이 모르고 있습니다 (앱이 관리하지 않는 포지션)`,
      app: null, exchange: `${ex.side} ${ex.qty}`,
    });
  }

  // ── 미체결 주문 대조 ──
  if (input.appOpenOrders && input.exchangeOpenOrders) {
    const appIds = new Set(input.appOpenOrders.map(o => o.clientOrderId));
    const exIds = new Set(input.exchangeOpenOrders.map(o => o.clientOrderId));
    for (const o of input.appOpenOrders) {
      if (!exIds.has(o.clientOrderId)) {
        m.push({
          code: 'ORDER_MISSING_ON_EXCHANGE', severity: 'warn', symbol: o.symbol,
          detail: `앱의 미체결 주문 ${o.clientOrderId}가 거래소에 없습니다 (체결·취소됐을 수 있습니다)`,
        });
      }
    }
    for (const o of input.exchangeOpenOrders) {
      if (!appIds.has(o.clientOrderId)) {
        m.push({
          code: 'ORDER_MISSING_IN_APP', severity: 'warn', symbol: o.symbol,
          detail: `거래소에 미체결 주문 ${o.clientOrderId}가 있는데 앱이 모르고 있습니다`,
        });
      }
    }
  }

  // ── 잔고 대조 ──
  if (input.appBalance != null && input.exchangeBalance != null) {
    const base = Math.max(Math.abs(input.appBalance), Math.abs(input.exchangeBalance), 1);
    if (Math.abs(input.appBalance - input.exchangeBalance) / base > balTol) {
      m.push({
        code: 'BALANCE_DIFFERS', severity: 'info',
        detail: `잔고 차이 — 앱 ${input.appBalance.toFixed(2)} / 거래소 ${input.exchangeBalance.toFixed(2)}`,
        app: input.appBalance, exchange: input.exchangeBalance,
      });
    }
  }

  const critical = m.filter(x => x.severity === 'critical');
  const warn = m.filter(x => x.severity === 'warn');

  return {
    ok: m.length === 0,
    blockNewOrders: critical.length > 0,
    mismatches: m,
    checkedAt: new Date().toISOString(),
    summary: m.length === 0
      ? '앱과 거래소 상태가 일치합니다'
      : `불일치 ${m.length}건 (심각 ${critical.length} · 경고 ${warn.length})` +
        (critical.length ? ' — 신규 주문을 차단합니다' : ''),
  };
}
