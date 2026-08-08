// src/lib/exchanges/futuresAdapter.ts
//
// **USDⓈ-M 선물 주문 앞에서 읽어야 하는 것들을, 거래소와 무관하게.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 수동 주문 라우트(`/api/binance/futures/order`)는 이름 그대로 바이낸스
// 전용이었다. 첫 줄에서 `exchange_id !== 'binance'`면 거절했고, 안쪽에는
// `getFuturesServerTime` · `getSymbolPositionRiskEx` · `getFuturesBalance` ·
// `getSymbolFilters` 네 개의 바이낸스 전용 호출이 박혀 있었다.
//
// Gate 연결을 고른 사용자는 주문을 낼 방법이 아예 없었다. 자동매매
// (`executeOrder`)는 Gate 분기가 있는데, 손으로 누르는 경로만 없었다.
//
// **두 번째 라우트를 만들지 않는다.**
// 이 저장소에서 반복된 사고가 정확히 그 모양이었다 — 주문 경로가 여러 개인데
// 안전 검사는 일부에만 있는 것(현물·COIN-M이 오늘 손실 한도를 통째로
// 빠뜨리고 있던 것, 워커 경로에 생명주기 기록이 절반만 있던 것). 라우트를
// 하나로 두고 **읽는 쪽만** 거래소별로 갈라 놓으면, 점검·한도·멱등 키는
// 언제나 한 벌이다.
//
// 못 읽으면 null이다
// ──────────────────
// 여기 있는 함수는 전부 실패를 null로 돌려준다. 0이나 기본값으로 채우면
// 점검이 '확인함'으로 통과한다. 이 저장소의 규칙은 하나다 —
// **확인하지 못한 것은 통과가 아니다.**

import type { SymbolFilters } from './quantize';

import { normalizeExchange } from './connection';

export type FuturesExchange = 'binance' | 'gate';

/**
 * 연결의 `exchange_id`를 이 경로가 다루는 거래소로 좁힌다.
 *
 * Gate는 저장소 안에서 `gate`와 `gateio` 두 이름으로 돌아다닌다
 * (`tradeMode.ts`의 이름표도 둘 다 받는다). 여기서 한 이름으로 모은다.
 * 모르는 거래소는 **null**이다 — 바이낸스로 치면 Gate 키로 바이낸스에
 * 서명 요청을 보내게 된다.
 */
export function futuresExchangeOf(raw: any): FuturesExchange | null {
  // **이름 정규화는 connection.normalizeExchange 한 곳에서만 한다.**
  //
  // 예전에는 여기서 정확히 'gate'|'gateio'|'gate.io'만 봤다. 그런데
  // normalizeExchange는 `.includes('gate')`라 'gate futures' 같은 값을
  // 받아 준다. 두 해석기가 같은 문자열을 다르게 읽으면, 한쪽이 통과시킨
  // 연결을 다른 쪽이 막는다 — 그리고 그때 화면에는 이유가 안 남는다.
  //
  // 여기서 하는 판단은 하나뿐이다: **그 거래소로 선물을 낼 수 있는가.**
  const s = normalizeExchange(raw);
  if (s === 'binance') return 'binance';
  if (s === 'gate') return 'gate';
  // 모르는 거래소는 null이다. **binance로 떨어뜨리지 않는다** —
  // 그러면 남의 키로 바이낸스에 주문이 나간다.
  return null;
}

/** 사람이 읽는 거래소 이름 */
export function futuresExchangeName(ex: FuturesExchange): string {
  return ex === 'gate' ? '게이트아이오' : '바이낸스';
}

/**
 * 거래 전 점검이 읽는 포지션 상태. 두 거래소를 같은 모양으로 맞춘다.
 *
 * `positionAmt`는 **기초자산 수량**이다. Gate는 계약 수로 주는데, 그대로
 * 두면 주문 수량과 단위가 달라서 "기존 포지션 500, 주문 0.05"처럼 비교할
 * 수 없는 두 숫자가 한 화면에 뜬다. 배수를 못 읽으면 null로 둔다.
 */
export interface FuturesRiskView {
  symbol: string;
  /** 기초자산 수량. 부호 있음(롱 양수). 못 읽으면 null */
  positionAmt: number | null;
  /** 'isolated' | 'cross' | '' (모름) */
  marginType: string;
  leverage: number | null;
  liquidationPrice: number | null;
  entryPrice: number | null;
  markPrice: number | null;
}

/** 거래소 서버 시각(epoch ms). 못 읽으면 null — 0이 아니다 */
export async function futuresServerTime(
  ex: FuturesExchange, testnet: boolean,
): Promise<number | null> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    return gf.getGateServerTime(testnet);
  }
  const bf = await import('./binanceFutures');
  return bf.getFuturesServerTime(testnet);
}

/**
 * 수량·가격 규격. 못 읽으면 null — `quantizeOrder`가 "적용 안 함"으로 표시한다.
 *
 * Gate는 계약 배수(`quanto_multiplier`)를 수량 단위로 놓는다. 그래서 같은
 * `quantizeOrder`가 두 거래소를 처리한다 — 기초자산 수량을 배수로 내림하는
 * 일이 곧 "정수 계약으로 내림"이다.
 */
export async function futuresSymbolFilters(
  ex: FuturesExchange, symbol: string, testnet: boolean,
): Promise<SymbolFilters | null> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    const gp = await import('./gatePlan');
    const spec = await gf.getGateContractSpec(gp.toGateContract(symbol), testnet);
    return gp.gateFiltersOf(spec);
  }
  const bf = await import('./binanceFutures');
  return bf.getSymbolFilters(symbol, testnet);
}

/**
 * 이 심볼의 마진 모드·배율·청산가·마크가.
 *
 * 실패 이유를 삼키지 않는다. 값만 비우면 화면에는 '확인 못 함'까지만 뜨고
 * 왜 못 읽었는지는 아무도 모른다 — 그것 때문에 하루를 쓴 적이 있다.
 */
export async function futuresPositionRisk(
  ex: FuturesExchange, key: string, secret: string, symbol: string, testnet: boolean,
): Promise<{ risk: FuturesRiskView | null; error: string | null }> {
  if (ex === 'binance') {
    const bf = await import('./binanceFutures');
    const rr = await bf.getSymbolPositionRiskEx(key, secret, symbol, testnet);
    if (!rr.risk) return { risk: null, error: rr.error };
    return {
      risk: {
        symbol: rr.risk.symbol,
        positionAmt: Number.isFinite(rr.risk.positionAmt) ? rr.risk.positionAmt : null,
        marginType: rr.risk.marginType || '',
        leverage: rr.risk.leverage ?? null,
        liquidationPrice: rr.risk.liquidationPrice ?? null,
        entryPrice: rr.risk.entryPrice ?? null,
        markPrice: rr.risk.markPrice ?? null,
      },
      error: rr.error,
    };
  }

  const gf = await import('./gateFutures');
  const gp = await import('./gatePlan');
  const contract = gp.toGateContract(symbol);
  if (!contract) {
    return { risk: null, error: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` };
  }

  let pos: any = null;
  let posErr: string | null = null;
  try {
    pos = await gf.getPositionGateFutures(key, secret, contract, testnet);
    if (!pos) posErr = `Gate 포지션 조회가 비어 있습니다 (${contract})`;
  } catch (e: any) {
    posErr = `Gate 포지션 조회 실패: ${e?.message || e}`;
  }

  const view = gp.gatePositionToRisk(pos);
  if (!view) return { risk: null, error: posErr || 'Gate 포지션을 읽지 못했습니다' };

  // 계약 수 → 기초자산 수량. 배수를 못 읽으면 null로 둔다. 계약 수를 그대로
  // 수량 칸에 적으면 "기존 포지션 500 BTC"라는 거짓이 화면에 뜬다.
  const spec = await gf.getGateContractSpec(contract, testnet);
  const baseAmt = gp.gateBaseFromContracts(view.positionAmt, spec);

  // 마크가는 포지션 응답에 없다. 티커에서 읽는다 — 신규 진입이면 포지션이
  // 없어서 진입가도 없고, 기준가가 없으면 명목가·증거금·손절가를 전부
  // 계산할 수 없다.
  let mark: number | null = null;
  try {
    const t = await gf.getTickerGateFutures(contract, testnet);
    const m = Number(t?.mark_price ?? t?.last);
    mark = Number.isFinite(m) && m > 0 ? m : null;
  } catch { /* null — 기준가 없음으로 점검이 막는다 */ }

  return {
    risk: {
      symbol: contract,
      positionAmt: baseAmt,
      marginType: view.marginType,
      leverage: view.leverage,
      liquidationPrice: view.liquidationPrice,
      entryPrice: view.entryPrice,
      markPrice: mark,
    },
    // 배수를 못 읽었으면 그 사실을 들고 간다. 이게 없으면 주문 수량도
    // 만들 수 없어서 어차피 아래에서 막힌다 — 이유를 여기서 준다.
    error: spec ? posErr : (posErr ? `${posErr} / Gate 계약 규격을 읽지 못했습니다`
                                   : 'Gate 계약 규격(1계약당 수량)을 읽지 못했습니다'),
  };
}

/**
 * 주문에 쓸 수 있는 USDT. 못 읽으면 **null**이다.
 *
 * 0으로 두면 안 된다 — 1회 명목가 상한이 자산의 비율로도 걸려 있어서,
 * 0이면 비율 상한이 0이 되고 계좌가 아무리 커도 전부 막힌다. 0과 '모름'은
 * 다른 값이다.
 */
export async function futuresAvailableUsd(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean,
): Promise<number | null> {
  try {
    if (ex === 'gate') {
      const gf = await import('./gateFutures');
      const acct = await gf.getAccountGateFutures(key, secret, testnet);
      const v = Number(acct?.available);
      return Number.isFinite(v) ? v : null;
    }
    const bf = await import('./binanceFutures');
    const bal: any = await bf.getFuturesBalance(key, secret, testnet);
    if (!bal?.success) return null;
    const usdt = (bal.balances ?? []).find((b: any) => b.asset === 'USDT');
    const v = Number(usdt?.availableBalance);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

// ── 비상 정리 ────────────────────────────────────────
//
// **못 여는 것은 불편이고 못 닫는 것은 사고다.**
//
// [미체결 취소]·[전량 청산]·[KILL] 버튼이 부르는 자리다. 이 세 개가
// Gate에서 안 되면 열 수는 있는데 닫을 수 없는 상태가 된다.

export interface CancelAllResult {
  success: boolean;
  /** 취소한 건수. 못 세면 null — 0으로 적으면 '없었다'가 사실이 된다 */
  count: number | null;
  results: any[];
  message: string;
}

export async function futuresCancelAll(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean,
): Promise<CancelAllResult> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    return gf.cancelAllOpenOrdersGateFutures(key, secret, testnet);
  }
  const bf = await import('./binanceFutures');
  const r: any = await bf.cancelAllOpenOrders(key, secret, testnet);
  return {
    success: !!r?.success,
    count: r?.count ?? null,
    results: r?.results ?? [],
    message: r?.success ? `미체결 주문 취소 완료 (${r?.count ?? 0}건)`
                        : '취소 실패 — 거래소에서 직접 확인하세요',
  };
}

export interface CloseAllResult {
  success: boolean;
  /** 남은 포지션 수. **못 읽으면 null이다** — 0으로 적으면 '전부 닫혔다'가 된다 */
  remaining: number | null;
  retries: number | null;
  results: any[];
  message: string;
}

export async function futuresCloseAll(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean, retries = 5,
): Promise<CloseAllResult> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    return gf.closeAllPositionsGateFutures(key, secret, testnet, retries);
  }
  const bf = await import('./binanceFutures');
  const r: any = await bf.closeAllPositions(key, secret, testnet, retries);
  return {
    success: !!r?.success,
    remaining: r?.remaining ?? null,
    retries: r?.retries ?? null,
    results: r?.results ?? [],
    message: r?.success ? '포지션 전체 종료 완료'
                        : `포지션 ${r?.remaining ?? '?'}개가 남았습니다 — 거래소에서 직접 확인하세요`,
  };
}

/**
 * **포지션을 닫은 뒤 남은 보호 주문을 지운다.**
 *
 * 왜 필요한가
 * ───────────
 * 손절은 포지션을 닫는 주문이다. 그런데 포지션이 이미 없어진 뒤에도 그
 * 주문이 거래소에 남아 있으면, 가격이 트리거에 닿는 순간 **반대 방향으로
 * 새 포지션이 열린다.** 닫으려고 누른 버튼이 결과적으로 포지션을 여는 것이다.
 *
 * 바이낸스의 `closePosition: true` 주문은 포지션이 사라지면 거래소가
 * 알아서 취소한다. 그런데 이 저장소는 그게 거절될 때(-4120) **수량 기반
 * reduceOnly**로 한 번 더 시도한다 — 그쪽은 자동으로 안 없어진다.
 * Gate의 `price_orders`도 남는다.
 *
 * 언제 부르는가
 * ─────────────
 * **전량이 닫힌 것을 확인한 뒤에만.** 부분 청산 뒤에 지우면 남은 포지션이
 * 보호 없이 남는다 — 닫으려다 더 위험해진다.
 */
export interface ProtectiveOrdersResult {
  /** 조회 자체가 성공했는가. false면 수가 전부 null이고 '없음'이 아니다 */
  ok: boolean;
  /** 닫는 주문 총수(방향 무관). **못 읽으면 null이다** */
  count: number | null;
  /**
   * **지금 그 포지션을 지키는 손절 주문 수.** 이 값이 방어선의 유무다.
   *
   * 두 가지를 걸러서 센다:
   *   · 익절은 빼고 손절만 — 익절은 이익을 확정하는 주문이지 방어선이 아니다
   *   · **지금 포지션과 같은 방향을 닫는 것만** — 롱을 들고 있는데 숏용
   *     손절이 남아 있으면 그건 이 포지션을 아무것도 지키지 않는다
   *
   * 둘 중 하나라도 안 걸러 세면 화면에 "손절 있음"이 뜬 채로 아래쪽을
   * 막는 것이 없는 포지션이 남는다.
   */
  stopCount: number | null;
  /** 지금 포지션을 닫는 익절 주문 수. 사실 전달용 — 이것만으로는 통과시키지 않는다 */
  takeProfitCount: number | null;
  /** **반대 방향**을 닫는 손절 수. 사실 전달용 — 보호 증거로 인정하지 않는다 */
  oppositeStopCount: number;
  /** 손절·익절 중 어느 쪽인지 판별하지 못한 주문 수 */
  unclassified: number;
  /** 사람이 읽는 근거 한 줄 */
  detail: string;
  error: string | null;
}

/**
 * **지금 이 포지션을 지키는 손절이 거래소에 실제로 걸려 있는가.**
 *
 * 왜 따로 필요한가
 * ────────────────
 * 점검 목록의 `STOP_ATTACHED`는 **계획의 손절가**를 본다 — 즉 "우리가 손절을
 * 붙일 생각인가"다. 그건 "거래소에 손절이 붙어 있는가"와 다른 질문이다.
 * 진입은 성공했는데 손절 부착만 실패한 상황이 정확히 그 차이에 숨는다:
 * 계획에는 손절가가 있으니 점검은 통과하고, 거래소에는 아무것도 없다.
 *
 * 세 번 거른다
 * ────────────
 *  1. **닫는 주문만.** 사용자가 걸어 둔 진입 예약을 손절로 세지 않는다.
 *  2. **손절만.** 익절만 걸린 포지션은 가격이 반대로 갈 때 막을 것이 없다.
 *  3. **지금 포지션과 같은 방향만.** 롱을 들고 있는데 남아 있는 숏용 손절은
 *     이 포지션을 지키지 않는다 — 방향이 반대면 트리거돼도 열리는 쪽이다.
 *
 * **0과 모름을 구분한다.** 조회가 실패했는데 0으로 적으면 "손절이 없다"가
 * 사실이 되고, 판별을 못 했는데 1로 세면 없는 방어선을 있다고 적는다.
 *
 * @param positionSide 지금 열려 있는 포지션의 방향. **모르면 null** —
 *   그때는 어느 손절이 이 포지션을 지키는지 판별할 수 없으므로
 *   stopCount를 null로 돌려준다(포지션이 없으면 점검이 그 앞에서 통과시킨다).
 */
/** 분류가 끝난 조건부 주문 한 건 */
export interface ProtectiveItem {
  kind: 'STOP' | 'TAKE_PROFIT' | 'UNKNOWN';
  /** 이 주문이 닫는 방향. 모르면 null */
  closes: 'LONG' | 'SHORT' | null;
}

export interface ProtectiveTally {
  stopCount: number | null;
  takeProfitCount: number | null;
  oppositeStopCount: number;
  unclassified: number;
  count: number;
  error: string | null;
}

/**
 * 분류된 주문들 → 방어선이 있는가.
 *
 * **순수 함수다.** 네트워크를 안 탄다. 여기가 이 기능에서 틀리면 가장
 * 위험한 자리라(없는 손절을 있다고 적는 곳) 거래소 응답 없이 값으로
 * 검증할 수 있어야 한다.
 *
 * 두 번 거른다:
 *   · 익절은 방어선이 아니다
 *   · **지금 포지션과 같은 방향을 닫는 것만** 방어선이다 — 롱을 들고
 *     있는데 남아 있는 숏용 손절은 이 포지션을 아무것도 지키지 않는다
 */
export function protectiveTally(
  items: ProtectiveItem[], positionSide: 'LONG' | 'SHORT' | null,
): ProtectiveTally {
  let stop = 0, tp = 0, opposite = 0, unclassified = 0;
  for (const it of items) {
    if (it.kind === 'UNKNOWN') { unclassified++; continue; }
    if (positionSide != null && it.closes !== positionSide) {
      if (it.kind === 'STOP') opposite++;
      continue;
    }
    if (it.kind === 'STOP') stop++; else tp++;
  }
  const count = items.length;

  // **포지션 방향을 모르면 손절 수를 확정하지 않는다.** 어느 손절이 이
  // 포지션을 지키는지 가릴 수 없다. 포지션이 아예 없으면 점검 목록이
  // 이 값을 보기 전에 통과시킨다.
  if (positionSide == null) {
    return { stopCount: null, takeProfitCount: null, oppositeStopCount: opposite,
      unclassified, count,
      error: '현재 포지션 방향을 몰라 어느 손절이 이 포지션을 지키는지 판별할 수 없습니다' };
  }

  // **판별 못 한 것이 있고 손절이 0이면 확정하지 않는다.** 그 주문이 손절일
  // 수도 있는데 0으로 적으면 없는 것이 사실이 되고, 1로 세면 없는 방어선을
  // 있다고 적는다. 둘 다 안 되므로 모른다고 말한다.
  if (unclassified > 0 && stop === 0) {
    return { stopCount: null, takeProfitCount: tp, oppositeStopCount: opposite,
      unclassified, count,
      error: `조건부 주문 ${unclassified}건이 손절인지 익절인지 판별되지 않아 `
           + '손절 유무를 확정할 수 없습니다' };
  }

  return { stopCount: stop, takeProfitCount: tp, oppositeStopCount: opposite,
    unclassified, count, error: null };
}

export async function futuresProtectiveOrders(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean, symbol: string,
  positionSide: 'LONG' | 'SHORT' | null = null,
): Promise<ProtectiveOrdersResult> {
  const fail = (error: string): ProtectiveOrdersResult => ({
    ok: false, count: null, stopCount: null, takeProfitCount: null,
    oppositeStopCount: 0, unclassified: 0, detail: '', error,
  });

  try {
    const items: ProtectiveItem[] = [];
    let label = symbol;

    if (ex === 'gate') {
      const gf = await import('./gateFutures');
      const gp = await import('./gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return fail(`Gate 계약 이름을 만들 수 없습니다 (${symbol})`);
      label = contract;

      // Gate의 조건부 주문(price_orders)이 손절·익절이다. **null은 조회 실패다.**
      const rows = await gf.getPriceOrdersGateFutures(key, secret, contract, testnet);
      if (rows == null) return fail('Gate 조건부 주문(price_orders)을 읽지 못했습니다');

      for (const row of rows) {
        // 손절/익절 판정은 gatePlan 한 곳에만 둔다 — 거는 쪽과 세는 쪽이
        // 각자 부등호를 쓰면 한쪽만 고쳐지고, 그때 "손절 있음"이 거짓이 된다.
        const k = gp.gateProtectiveKind(row);
        // 진입 예약은 보호 주문이 아니다 — 사용자가 걸어 둔 지정가를 손절로 세지 않는다.
        if (k.kind === 'NOT_PROTECTIVE') continue;
        items.push({ kind: k.kind, closes: k.closes });
      }
    } else {
      const bf = await import('./binanceFutures');
      const { orders } = await bf.getFuturesOpenOrders(key, secret, testnet, symbol);
      if (!Array.isArray(orders)) return fail('미체결 주문을 읽지 못했습니다');

      for (const o of orders as any[]) {
        const t = String(o?.type || '').toUpperCase();
        // futuresCancelProtection이 지우는 것과 **같은 조건**으로 센다.
        // 세는 기준과 지우는 기준이 다르면 "1건 있다"고 적고 0건을 지운다.
        if (!(o?.closePosition === true || o?.reduceOnly === true)) continue;
        if (!t.includes('STOP') && !t.includes('TAKE_PROFIT')) continue;

        // 닫는 주문의 side가 곧 방향이다 — SELL이 롱을 닫는다.
        const side = String(o?.side || '').toUpperCase();
        const closes: 'LONG' | 'SHORT' | null =
          side === 'SELL' ? 'LONG' : side === 'BUY' ? 'SHORT' : null;
        if (!closes) { items.push({ kind: 'UNKNOWN', closes: null }); continue; }

        // **익절을 먼저 가른다.** TAKE_PROFIT 계열을 stop으로 세면 안 되고,
        // TRAILING_STOP_MARKET은 손절이 맞다.
        items.push({ kind: t.includes('TAKE_PROFIT') ? 'TAKE_PROFIT' : 'STOP', closes });
      }
    }

    const tally = protectiveTally(items, positionSide);
    if (tally.error) {
      return {
        ok: false, count: tally.count, stopCount: tally.stopCount,
        takeProfitCount: tally.takeProfitCount, oppositeStopCount: tally.oppositeStopCount,
        unclassified: tally.unclassified, detail: '', error: tally.error,
      };
    }
    return {
      ok: true, count: tally.count, stopCount: tally.stopCount,
      takeProfitCount: tally.takeProfitCount, oppositeStopCount: tally.oppositeStopCount,
      unclassified: tally.unclassified,
      detail: `${label} ${positionSide} 손절 ${tally.stopCount}건 · 익절 ${tally.takeProfitCount}건`
            + (tally.oppositeStopCount > 0
                ? ` (반대 방향 손절 ${tally.oppositeStopCount}건은 이 포지션을 지키지 않습니다)` : ''),
      error: null,
    };
  } catch (e: any) {
    return fail(String(e?.message || e));
  }
}

export interface CancelProtectionResult {
  /** 지운 건수. 못 세면 null */
  cancelled: number | null;
  /** 사람이 읽는 한 줄. 지운 것이 없으면 빈 문자열 */
  note: string;
}

export async function futuresCancelProtection(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean, symbol: string,
): Promise<CancelProtectionResult> {
  try {
    if (ex === 'gate') {
      const gf = await import('./gateFutures');
      const gp = await import('./gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return { cancelled: null, note: '' };
      const rows = await gf.gateReq<any[]>('DELETE', '/api/v4/futures/usdt/price_orders', {
        key, secret, qs: `contract=${contract}`, testnet,
      });
      const n = Array.isArray(rows) ? rows.length : 0;
      return { cancelled: n, note: n > 0 ? ` · 남은 보호 주문 ${n}건 취소` : '' };
    }

    const bf = await import('./binanceFutures');
    const { orders } = await bf.getFuturesOpenOrders(key, secret, testnet, symbol);
    // **포지션을 닫는 주문만** 지운다. 진입 예약(지정가)은 사용자가 일부러
    // 걸어 둔 것일 수 있어 건드리지 않는다.
    const targets = (orders || []).filter((o: any) => {
      const t = String(o?.type || '').toUpperCase();
      const isProtective = t.includes('STOP') || t.includes('TAKE_PROFIT');
      return isProtective && (o?.closePosition === true || o?.reduceOnly === true);
    });
    let n = 0;
    for (const o of targets) {
      try { await bf.cancelFuturesOrder(key, secret, symbol, o.orderId, testnet); n++; }
      catch { /* 개별 실패는 넘긴다 — 아래에서 몇 건 지웠는지 그대로 적는다 */ }
    }
    return {
      cancelled: n,
      note: targets.length === 0 ? ''
        : n === targets.length ? ` · 남은 보호 주문 ${n}건 취소`
        : ` · ⚠ 보호 주문 ${targets.length}건 중 ${n}건만 취소됐습니다 — 거래소에서 확인하세요`,
    };
  } catch (e: any) {
    // **지웠다고 말하지 않는다.** 남아 있으면 반대 포지션이 열릴 수 있으므로
    // 확인하지 못한 것은 그대로 알린다.
    return { cancelled: null, note: ` · ⚠ 남은 보호 주문을 정리하지 못했습니다 (${e?.message || e})` };
  }
}

/**
 * 주문 하나 취소 — 거래소를 가리지 않는다.
 *
 * 화면의 미체결 카드마다 [취소]가 붙으려면 이게 있어야 한다. 없을 때는
 * [전체 취소]뿐이었고, 그건 **손절 하나를 지우려다 전부 지우는** 버튼이다.
 *
 * 취소는 위험을 줄이는 동작이므로 거래소를 이유로 조용히 안 도는 일이
 * 없어야 한다 — 이 저장소에서 반복된 사고가 정확히 그 모양이었다.
 */
export async function futuresCancelOrder(
  ex: FuturesExchange,
  key: string, secret: string, testnet: boolean,
  args: { symbol?: string | null; orderId: string | number; bucket?: 'price' | 'normal' | null },
): Promise<{ success: boolean; message: string }> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    const r = await gf.cancelOrderGateFutures(key, secret, args.orderId, {
      bucket: args.bucket ?? null, testnet,
    });
    return { success: r.success, message: r.message };
  }
  const bf = await import('./binanceFutures');
  const sym = String(args.symbol || '').toUpperCase().replace('/', '');
  if (!sym) {
    // 바이낸스는 심볼 없이 주문을 못 지운다. **지웠다고 말하지 않는다.**
    return { success: false, message: '종목을 알 수 없어 취소하지 못했습니다' };
  }
  return await bf.cancelFuturesOrder(key, secret, sym, args.orderId, testnet);
}

/**
 * 이 심볼의 **계약 명세.** 금·원유·지수와 같은 모양으로 돌려준다.
 *
 * 왜 코인에도 이걸 두는가
 * ───────────────────────
 * Gate 선물은 **이미 계약형 상품**이다 — 수량이 정수 계약이고 1계약이
 * 0.0001 BTC다. 금 1계약이 100온스인 것과 구조가 같다. 다른 것은 숫자뿐이다.
 *
 * 그러니 금을 붙일 때 새 계산을 만들 이유가 없다. 지금 Gate가 쓰는 길에
 * 명세만 다르게 넣으면 된다. 반대로, 코인만 특별 취급하는 경로를 남겨
 * 두면 금이 들어올 때 경로가 둘이 되고 — 그게 이 저장소에서 반복된
 * 사고의 모양이다.
 *
 * **배수를 못 읽으면 multiplier가 null이다.** sizeByRisk가 그걸 보고
 * 수량을 안 만든다. 1로 채우면 Gate에서는 10,000배, 금에서는 100배
 * 크기가 조용히 나간다.
 */
export async function futuresContractSpec(
  ex: FuturesExchange, symbol: string, testnet: boolean,
): Promise<import('../markets/contractSpec').ContractSpec | null> {
  const cs = await import('../markets/contractSpec');
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    const gp = await import('./gatePlan');
    const contract = gp.toGateContract(symbol);
    if (!contract) return null;
    const spec = await gf.getGateContractSpec(contract, testnet);
    return {
      symbol: contract,
      // Gate는 정수 계약이다. 0.5계약은 없다.
      style: 'CONTRACT',
      // 못 읽으면 null 그대로 넘긴다 — 여기서 1로 채우면 1계약을 1 BTC로
      // 계산하고, 실제 크기가 10,000배가 된다.
      multiplier: spec?.quantoMultiplier ?? null,
      tickSize: spec?.orderPriceRound ?? null,
      tickValue: null,
      minQty: spec?.orderSizeMin ?? 1,
      qtyStep: 1,
      currency: 'USDT',
      timezone: '',
      expiry: null,
    };
  }

  // 바이낸스 USDⓈ-M은 연속 수량이다. stepSize가 곧 최소 증분이고,
  // 1계약 같은 개념이 없으므로 배수는 1이다.
  const bf = await import('./binanceFutures');
  const f = await bf.getSymbolFilters(symbol, testnet);
  if (!f) return null;
  return cs.continuousSpec(symbol, {
    tickSize: (f as any).tickSize ?? null,
    qtyStep: (f as any).stepSize ?? null,
    minQty: (f as any).minQty ?? null,
  });
}

/**
 * 배율 설정 — **되읽어 확인한다.**
 *
 * 두 거래소 다 "요청이 200을 받았다"와 "배율이 그 값이다"가 다르다.
 * 요청한 것보다 **높게** 설정돼 있으면 주문을 내면 안 된다 — 청산가가
 * 사용자가 계산한 자리보다 가까워져 있다.
 *
 * Gate는 leverage 0이 **교차 마진**이다. 격리를 확인하지 못하면
 * 성공으로 치지 않는다 — 교차에서는 이 계좌의 다른 포지션까지 물린다.
 */
/**
 * 이 계좌의 포지션 모드 — 단방향인가 헤지인가.
 *
 * **거래소마다 다른 자리에 있다.** 바이낸스는 전용 엔드포인트,
 * Gate는 계좌 응답의 칸 하나다. 부르는 쪽이 그걸 알 필요는 없다 —
 * 알아야 하면 라우트마다 분기가 생기고, 그 분기 중 하나는 언젠가
 * 안 고쳐진다.
 *
 * **못 읽으면 null이다.** 추측한 모드로 주문을 만들면, 틀렸을 때
 * 거부가 아니라 반대 포지션이 열릴 수 있다.
 */
export async function futuresPositionMode(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean,
): Promise<{ mode: 'ONE_WAY' | 'HEDGE' | null; error: string | null }> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    return gf.getPositionModeGateFutures(key, secret, testnet);
  }
  const bf = await import('./binanceFutures');
  return bf.getFuturesPositionMode(key, secret, testnet);
}

export async function futuresSetLeverage(
  ex: FuturesExchange, key: string, secret: string, symbol: string,
  leverage: number, testnet: boolean,
): Promise<{ success: boolean; leverage: number | null; message: string }> {
  if (ex === 'gate') {
    const gf = await import('./gateFutures');
    const gp = await import('./gatePlan');
    const contract = gp.toGateContract(symbol);
    if (!contract) {
      return { success: false, leverage: null,
        message: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` };
    }
    const r = await gf.setLeverageGateFutures(key, secret, contract, leverage, testnet);
    return { success: r.success, leverage: r.leverage, message: r.message };
  }
  const bf = await import('./binanceFutures');
  return bf.setFuturesLeverage(key, secret, symbol, leverage, testnet);
}

/**
 * 8시간 펀딩률(%). **못 읽으면 null이다 — 0이 아니다.**
 *
 * 0으로 떨어뜨리면 "펀딩이 없다"가 되고, 숏 검사는 그걸 중립으로 읽어
 * 통과시킨다. 실제로는 숏이 크게 내는 자리일 수 있다.
 *
 * 부호 규칙: **양수면 롱이 내고 숏이 받는다.** 두 거래소가 같은 규칙을
 * 쓰지만, 단위가 다르다 — 거래소는 비율(0.0001)로 주고 이 함수는
 * 퍼센트(0.01)로 돌려준다. 여기서 100을 곱하는 것을 잊으면 검사 문턱이
 * 100배 어긋난다.
 */
export async function futuresFundingRate(
  ex: FuturesExchange, symbol: string, testnet: boolean,
): Promise<number | null> {
  try {
    if (ex === 'gate') {
      const gf = await import('./gateFutures');
      const gp = await import('./gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const t = await gf.getTickerGateFutures(contract, testnet);
      const v = Number(t?.funding_rate);
      return Number.isFinite(v) ? v * 100 : null;
    }
    const bf = await import('./binanceFutures');
    const p = await bf.getPremiumIndex(symbol, testnet);
    const v = Number(p?.lastFundingRate);
    return Number.isFinite(v) ? v * 100 : null;
  } catch { return null; }
}

/**
 * 심볼 하나를 닫는다. 두 거래소 다.
 *
 * 왜 futuresCloseAll로 안 되는가
 * ──────────────────────────────
 * 그건 **계좌의 모든 포지션**을 닫는다. "자동매매가 연 것만" 또는
 * "절반만" 같은 단계에는 못 쓴다 — 손매매까지 나가면 그 단계를 만든
 * 이유의 정반대다.
 *
 * @param pct 닫을 비율(1~100). Gate는 부분 청산을 아직 지원하지 않아
 *            100 미만이면 거절한다 — 계약 수를 여기서 계산하면 배수
 *            오독이 그대로 수량 오류가 되고, 이미 한 번 밟은 자리다.
 */
export async function futuresClosePosition(
  ex: FuturesExchange, key: string, secret: string, testnet: boolean,
  symbol: string, pct = 100,
): Promise<{ success: boolean; message: string }> {
  const p = Number(pct);
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    return { success: false, message: `닫을 비율이 유효하지 않습니다 (${pct})` };
  }

  if (ex === 'gate') {
    if (p < 100) {
      return { success: false,
        message: `Gate는 아직 부분 청산(${p}%)을 지원하지 않습니다 — 전량으로 닫거나 거래소에서 직접 하세요` };
    }
    const gf = await import('./gateFutures');
    const gp = await import('./gatePlan');
    const contract = gp.toGateContract(symbol);
    if (!contract) return { success: false, message: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` };
    return gf.closePositionGateFutures(key, secret, contract, testnet);
  }

  // 바이낸스는 방향을 알아야 한다. **찍지 않는다** — 틀리면 청산이
  // 아니라 반대 진입이 된다.
  const rr = await futuresPositionRisk(ex, key, secret, symbol, testnet);
  if (!rr.risk || rr.risk.positionAmt == null) {
    return { success: false, message: `포지션을 확인하지 못해 닫지 않았습니다: ${rr.error || '사유 미상'}` };
  }
  const amt = Number(rr.risk.positionAmt) || 0;
  if (Math.abs(amt) === 0) return { success: true, message: '이미 포지션이 없습니다' };

  const bf = await import('./binanceFutures');
  const r = await bf.closePositionPercent(key, secret, symbol, amt > 0 ? 'LONG' : 'SHORT', p, testnet);
  return { success: !!r.success, message: r.message };
}
