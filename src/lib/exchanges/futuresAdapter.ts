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
