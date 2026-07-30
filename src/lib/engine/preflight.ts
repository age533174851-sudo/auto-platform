// src/lib/engine/preflight.ts
//
// 거래 전 점검에 넣을 **실제 값**을 모은다.
//
// preTradeChecklist는 순수 함수라 네트워크를 모른다. 이 파일이 그 사이를
// 잇는다 — 거래소·DB를 읽어 ChecklistInput을 만들고, 판정은 순수 함수에
// 맡긴다. 이렇게 나눠야 판정 규칙에 테스트가 붙는다.
//
// 실패를 기본값으로 덮지 않는다
// ─────────────────────────────
// 조회가 실패한 항목은 **넣지 않는다**(undefined로 둔다). 그러면 체크리스트가
// `unknown`으로 잡고, 필수 항목이면 주문을 막는다. 여기서 0이나 'isolated'
// 같은 기본값을 채우면 그 순간 점검이 거짓말을 시작한다.

import type { ChecklistInput } from './preTradeChecklist';
import type { OperatingMode } from './operatingMode';

export interface PreflightOptions {
  sb: any;
  userId: string;
  testnet: boolean;
  /** 'BTCUSDT' 형태 */
  symbol: string;
  side: 'LONG' | 'SHORT';
  mode: OperatingMode;
  /** 주문 명목가 (모드 상한 판단에 쓴다) */
  notionalUsd: number;
  /** 이 주문에 붙일 손절가. 없으면 점검이 막는다 */
  stopPrice?: number | null;
  /** 의도한 배율 */
  intendedLeverage?: number | null;
  /** 이 주문에 필요한 증거금 */
  requiredMargin?: number | null;
  /**
   * 오늘 이미 진입했는가.
   *
   * **여기서 직접 조회하지 않는다.** ladderGate의 openLadderGate는 판정과
   * 동시에 오늘의 슬롯을 **예약**한다(동시 요청 두 건이 같이 통과하는 것을
   * 막기 위한 설계다). 점검하려고 그것을 부르면 점검만으로 하루치 슬롯이
   * 소모되고, 정작 주문할 때 "오늘 이미 거래했습니다"로 막힌다.
   * 그래서 호출자가 이미 알고 있을 때만 넘긴다. 모르면 `unknown`이고,
   * 이 항목은 막지 않는다.
   */
  alreadyTradedToday?: boolean | null;
}

export async function collectChecklistInput(opts: PreflightOptions): Promise<ChecklistInput> {
  const {
    sb, userId, testnet, symbol, side, mode, notionalUsd,
    stopPrice, intendedLeverage, requiredMargin, alreadyTradedToday,
  } = opts;

  const input: ChecklistInput = { side, stopPrice: stopPrice ?? null };

  // 1. 운영 모드 — 순수 함수라 실패할 수 없다
  try {
    const { gateOrder } = await import('./operatingMode');
    const g = gateOrder(mode, notionalUsd);
    input.mode = { disposition: g.disposition, reason: g.reason };
  } catch {
    /* 넣지 않는다 → unknown */
  }

  // 2. 시계. 공개 엔드포인트라 키 없이도 읽는다.
  //
  // 로컬 시각을 **호출 직후**에 찍는다. 응답을 기다린 뒤에 찍으면 왕복
  // 지연이 그대로 오차로 계산돼, 시계가 정확해도 실패로 뜬다.
  try {
    const { getFuturesServerTime } = await import('@/lib/exchanges/binanceFutures');
    const localMs = Date.now();
    const serverMs = await getFuturesServerTime(testnet);
    if (serverMs != null) input.clock = { localMs, serverMs };
  } catch {
    /* unknown */
  }

  // 3. 상태 대조 + 미확정 주문 + 심볼별 사실 (한 번의 조회를 나눠 쓴다)
  try {
    const { gatherAndReconcile } = await import('./reconcileCheck');
    const g = await gatherAndReconcile(sb, userId, testnet);

    input.reconcile = {
      reachable: g.reachable,
      blockNewOrders: !!g.verdict?.blockNewOrders,
      summary: g.verdict?.summary || g.error,
    };
    // 조회가 안 됐으면 미확정 주문 수도 신뢰할 수 없다 — 0으로 적으면
    // "없음"이 되고, 그게 중복 체결로 이어진다.
    if (g.reachable) input.unresolvedOrderCount = g.unresolvedOrders.length;

  } catch {
    /* unknown */
  }

  // 3-b. 이 심볼의 위험 정보 — 마진 모드·배율·청산가·현재 수량
  //
  // gatherAndReconcile의 목록을 쓰지 않는다. 그쪽은 수량 0을 걸러내므로
  // **신규 진입 심볼이 목록에 없다.** 그러면 마진 모드가 unknown이 되어
  // 모든 첫 주문이 막힌다. 마진 모드는 포지션이 아니라 심볼별 계좌 설정이라
  // 수량이 0이어도 존재하고, getSymbolPositionRisk가 그걸 읽는다.
  //
  // 주문 경로(daily-ladder)도 같은 함수를 쓴다. 여기서 다른 방법으로 읽으면
  // 미리 본 결과와 실제로 막히는 근거가 갈린다 — 이 프로젝트가 상태 대조를
  // 공용화한 것과 같은 이유다.
  try {
    const { data: conn } = await sb.from('exchange_connections')
      .select('api_key, api_secret_enc, encrypted_secret')
      .eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
    if (conn) {
      const bf = await import('@/lib/exchanges/binanceFutures');
      const { decryptSecret } = await import('@/lib/exchanges/crypto');
      const secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      const risk = await bf.getSymbolPositionRisk(conn.api_key, secret, symbol, testnet);
      if (risk) {
        input.marginType = risk.marginType || null;
        input.existingPositionQty = Math.abs(risk.positionAmt);
        if (risk.liquidationPrice != null) input.liquidationPrice = risk.liquidationPrice;
        if (risk.leverage != null && intendedLeverage != null) {
          input.leverage = { actual: risk.leverage, intended: intendedLeverage };
        }
      }
      // 못 읽었으면 넣지 않는다 → unknown → 필수 항목이라 막는다.
      // 여기서 'isolated'로 가정하면 CROSS 계좌의 첫 주문이 그대로 나간다.
    }
  } catch {
    /* unknown */
  }

  // 4. 증거금
  try {
    const { data: conn } = await sb.from('exchange_connections')
      .select('api_key, api_secret_enc, encrypted_secret')
      .eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
    if (conn && requiredMargin != null) {
      const bf = await import('@/lib/exchanges/binanceFutures');
      const { decryptSecret } = await import('@/lib/exchanges/crypto');
      const secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      const bal: any = await bf.getFuturesBalance(conn.api_key, secret, testnet);
      if (bal?.success) {
        const usdt = (bal.balances ?? []).find((b: any) => b.asset === 'USDT');
        if (usdt) {
          input.margin = { required: requiredMargin, available: usdt.availableBalance };
        }
      }
    }
  } catch {
    /* unknown */
  }

  // 5. 오늘 진입 — 호출자가 알 때만 (위 주석 참조)
  if (alreadyTradedToday != null) {
    input.todayEntry = { alreadyTraded: alreadyTradedToday };
  }

  return input;
}
