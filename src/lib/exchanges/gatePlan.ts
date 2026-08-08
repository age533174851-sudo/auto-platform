// src/lib/exchanges/gatePlan.ts
//
// Gate 선물 주문에서 **틀리면 조용한** 계산들.
//
// 왜 따로 빼는가
// ──────────────
// orderExecutor의 Gate 분기에는 네 가지 문제가 있었다:
//
//  1. 수량을 `Math.round`했다. Gate 선물의 size는 **정수 계약 수**인데,
//     반올림이라 0.4가 0이 되고(주문이 안 나가거나 거부) 1.6이 2가 된다
//     (의도보다 25% 큰 포지션). COIN-M에서 겪은 '수량 단위가 계약'과 같은
//     함정이다 — 이번에는 반올림 방향까지 틀렸다
//  2. 마진 모드를 확인하지 않았다. 바이낸스 경로는 ISOLATED를 강제하고
//     실패하면 주문을 중단한다(감사 지적 2번). Gate는 아무것도 안 했다
//  3. `setLeverageGateFutures` 결과를 **버렸다**. 실패해도 주문이 나간다 —
//     계좌에 설정된 배율이 무엇이든 그대로
//  4. 손절을 붙이지 않았다. 포지션 크기는 손절이 있다는 전제로 계산됐는데
//     그 전제가 Gate에서는 존재하지 않았다
//
// 1·4의 방향 계산과 검증 규칙을 여기 모아 테스트를 붙인다. 네트워크는 타지 않는다.

import type { SymbolFilters } from './quantize';

/** getGateContractSpec가 돌려주는 모양 중 계산에 필요한 부분만 */
export interface GateSpecLike {
  quantoMultiplier: number;
  orderSizeMin?: number | null;
  orderSizeMax?: number | null;
  orderPriceRound?: number | null;
}

/** 심볼 → Gate 계약 이름. 'BTCUSDT' → 'BTC_USDT' */
export function toGateContract(symbol: string): string {
  const s = String(symbol || '').toUpperCase().replace('/', '').replace('_', '');
  if (!s) return '';
  // USDT로 끝나면 그 앞을 base로 자른다. 'USDT' 자체는 계약이 아니다.
  if (s.endsWith('USDT') && s.length > 4) return `${s.slice(0, -4)}_USDT`;
  return s;
}

export interface GateSizeResult {
  /** 부호 있는 계약 수. 롱 양수, 숏 음수. 0이면 주문하지 않는다 */
  size: number;
  ok: boolean;
  reason: string;
}

/**
 * 주문 수량을 Gate의 정수 계약 수로.
 *
 * **내림한다.** 올리면 의도보다 큰 포지션이 열리고, 그만큼 청산가가 가까워진다.
 * 내려서 0이 되면 주문하지 않는다 — 0을 보내면 거래소가 거부하거나(운이 좋으면)
 * 의미 없는 주문이 기록에 남는다.
 */
export function toGateSize(quantity: number, side: 'LONG' | 'SHORT'): GateSizeResult {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    return { size: 0, ok: false, reason: `수량이 유효하지 않습니다 (${quantity})` };
  }
  const contracts = Math.floor(q);
  if (contracts < 1) {
    return {
      size: 0, ok: false,
      reason: `수량 ${q}은 1계약 미만입니다. Gate 선물은 정수 계약 단위라 `
            + '주문할 수 없습니다 — 수량을 늘리세요',
    };
  }
  return {
    size: side === 'LONG' ? contracts : -contracts,
    ok: true,
    reason: contracts === q ? '' : `${q} → ${contracts}계약 (내림)`,
  };
}

/**
 * Gate 레버리지 응답이 격리(isolated)를 뜻하는가.
 *
 * Gate v4에서 포지션 레버리지 `0`은 **교차 마진**이다. 0이 아닌 값이 격리다.
 * 그래서 설정 후 실제 값을 되읽어 확인한다 — 설정 호출이 200을 줬다는 것과
 * 계좌가 격리라는 것은 다른 얘기다.
 *
 * 값을 읽지 못하면 `false`다. 모르는 것을 격리로 보면, 교차 계좌에서 첫 주문이
 * 그대로 나가고 한 종목의 손실이 지갑 전체로 번진다.
 */
export function isGateIsolated(leverageRaw: string | number | null | undefined): boolean {
  if (leverageRaw == null || leverageRaw === '') return false;
  const n = Number(leverageRaw);
  return Number.isFinite(n) && n > 0;
}

export interface GateFillView {
  /** 체결된 계약 수(절대값). 알 수 없으면 null */
  filledQty: number | null;
  avgPrice: number | null;
  /** 주문이 끝났는데 한 계약도 안 붙었다 — 포지션이 없다 */
  unfilled: boolean;
  reason: string;
}

/**
 * Gate 주문 응답에서 체결량을 읽는다.
 *
 * 왜 필요한가: 시장가 주문은 `tif: 'ioc'`로 나간다. 유동성이 없으면 Gate는
 * **200과 `status: 'finished'`를 주면서 `left`에 남은 수량을 그대로 담아
 * 돌려준다.** 즉 "정상 처리됐고, 하나도 안 붙었다"는 응답이다.
 *
 * 예전에는 이 응답을 그대로 ACKED로 기록하고 '주문 접수'라고 보고했다.
 * 그 다음에 손절을 붙이려 하면(없는 포지션에) 거래소가 거부하고, 화면에는
 * 엉뚱한 이유가 뜬다. 체결이 0이면 그 사실을 그 자리에서 말해야 한다.
 *
 * `left`가 없으면 **모르는 것**이다 — 미체결로 단정하지 않는다.
 */
export function gateFillOf(res: any | null | undefined): GateFillView {
  const size = Math.abs(Number(res?.size));
  const left = Math.abs(Number(res?.left));
  const px = Number(res?.fill_price);
  const status = String(res?.status ?? '').toLowerCase();

  const avgPrice = Number.isFinite(px) && px > 0 ? px : null;

  if (!Number.isFinite(size) || !Number.isFinite(left)) {
    return { filledQty: null, avgPrice, unfilled: false,
      reason: '체결량을 응답에서 읽지 못했습니다' };
  }
  const filled = Math.max(0, size - left);
  if (filled === 0 && (status === 'finished' || status === 'cancelled')) {
    return { filledQty: 0, avgPrice, unfilled: true,
      reason: `주문이 ${status}로 끝났는데 체결이 0계약입니다 (요청 ${size}, 미체결 ${left})` };
  }
  return { filledQty: filled, avgPrice, unfilled: false, reason: '' };
}

export interface GateRiskView {
  /** Gate는 격리/교차를 레버리지 값으로 표현한다 — isGateIsolated가 판정한다 */
  marginType: 'isolated' | 'cross';
  leverage: number | null;
  liquidationPrice: number | null;
  /** 부호 있는 계약 수. 롱 양수, 숏 음수 */
  positionAmt: number;
  entryPrice: number | null;
}

/**
 * Gate 포지션 응답 → 거래 전 점검이 읽는 모양.
 *
 * 왜 함수로 빼는가: 이 변환을 호출하는 곳이 네 군데다(거래 전 점검 수집,
 * 일일 사다리, 상태 대조, TradingView 웹훅). 각자 인라인으로 적으면
 * "레버리지 0은 교차"라는 판정이 네 벌이 되고, 한 곳만 고치면 나머지
 * 세 곳은 조용히 틀린 채로 남는다.
 *
 * **못 읽었으면 null이다.** 여기서 빈 값을 만들어 돌려주면 호출자가
 * `positionAmt: 0`(포지션 없음)과 `marginType: 'cross'`(교차 계좌)를
 * 사실로 받아들인다. 둘 다 확인한 적이 없는 값이다.
 */
export function gatePositionToRisk(pos: any | null | undefined): GateRiskView | null {
  if (!pos) return null;

  const lev = Number(pos.leverage);
  const liq = Number(pos.liq_price);
  const entry = Number(pos.entry_price);

  return {
    marginType: isGateIsolated(pos.leverage) ? 'isolated' : 'cross',
    // 0은 교차를 뜻하는 표식이라 '배율 0'으로 적지 않는다 — 배율은 모르는 것이다.
    leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
    liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : null,
    positionAmt: Number.isFinite(Number(pos.size)) ? Number(pos.size) : 0,
    entryPrice: Number.isFinite(entry) && entry > 0 ? entry : null,
  };
}

export interface GateStopSpec {
  /** 1 = 가격이 트리거 이상, 2 = 이하 */
  rule: 1 | 2;
  /** 포지션을 닫는 방향 */
  autoSize: 'close_long' | 'close_short';
  ok: boolean;
  reason: string;
  /**
   * 실제로 거래소에 보낼 트리거 가격. 호가 단위에 맞춰져 있다.
   *
   * **이걸 안 쓰면 손절이 안 걸린다.** Gate는 호가 단위의 정수배가 아닌
   * 트리거 가격을 거부한다:
   *   Gate 400: invalid argument: trigger.price price is not an integer
   *   multiple of a price unit
   * 진입 가격은 quantizeOrder가 맞춰 주는데 손절가는 아무도 안 맞추고
   * 있었다. 그래서 진입은 성공하고 손절만 실패했고, 규칙대로 방금 연
   * 포지션을 되돌렸다 — 안전하긴 하지만 **주문을 아예 낼 수 없다.**
   */
  triggerPrice: number | null;
  /** 호가 단위에 맞추느라 값이 바뀌었으면 그 사실. 조용히 바꾸지 않는다 */
  note: string;
}

/**
 * 손절 주문의 트리거 방향.
 *
 * 여기서 부호를 틀리면 **손절이 즉시 발동하거나 영원히 발동하지 않는다.**
 * 둘 다 화면에서는 '손절 걸림'으로 보인다.
 *
 *  - LONG  은 가격이 **내려갈 때** 닫는다 → rule 2 (이하) · close_long
 *  - SHORT 은 가격이 **올라갈 때** 닫는다 → rule 1 (이상) · close_short
 */
export function gateStopSpec(
  side: 'LONG' | 'SHORT',
  stopPrice: number | null | undefined,
  refPrice?: number | null,
  /** 계약 규격. 주면 트리거 가격을 호가 단위에 맞춘다 */
  spec?: GateSpecLike | null,
): GateStopSpec {
  const base: GateStopSpec = side === 'LONG'
    ? { rule: 2, autoSize: 'close_long', ok: true, reason: '', triggerPrice: null, note: '' }
    : { rule: 1, autoSize: 'close_short', ok: true, reason: '', triggerPrice: null, note: '' };

  const sp0 = Number(stopPrice);
  if (!Number.isFinite(sp0) || sp0 <= 0) {
    return { ...base, ok: false, reason: `손절가가 유효하지 않습니다 (${stopPrice})` };
  }

  // ── 호가 단위에 맞춘다 ──
  //
  // **반올림하지 않고 진입에서 멀어지는 쪽으로 민다.**
  // LONG 손절은 아래에 있으므로 내림, SHORT 손절은 위에 있으므로 올림.
  // 가까워지는 쪽으로 밀면 손절이 한 틱 일찍 터질 수 있고, 그건 사용자가
  // 정하지 않은 손절이다. 한 틱만큼 손실이 커지는 쪽이 낫다 —
  // 63912에서 0.1틱은 0.00016%다.
  const tick = Number(spec?.orderPriceRound);
  let sp = sp0;
  let note = '';
  if (Number.isFinite(tick) && tick > 0) {
    const n = sp0 / tick;
    // 부동소수 오차 보정. 이미 격자에 맞는 값이 한 틱 밀리면 안 된다.
    const eps = 1e-9;
    const k = side === 'LONG' ? Math.floor(n + eps) : Math.ceil(n - eps);
    // 소수 자릿수를 tick에서 뽑아 잘라 낸다. k*tick이 62653.90000000001이
    // 되면 거래소가 또 거부한다.
    const dec = Math.max(0, Math.min(12, Math.round(-Math.log10(tick))));
    sp = Number((k * tick).toFixed(dec));
    if (!(sp > 0)) {
      return { ...base, ok: false,
        reason: `손절가 ${sp0}을 호가 단위(${tick})에 맞추면 0이 됩니다` };
    }
    if (sp !== sp0) note = `손절가 ${sp0} → ${sp} (호가 단위 ${tick})`;
  }
  // 기준가를 알면 방향까지 본다. LONG 손절이 진입가 위면 걸자마자 발동한다.
  if (refPrice != null && Number.isFinite(Number(refPrice)) && Number(refPrice) > 0) {
    const ref = Number(refPrice);
    const badLong = side === 'LONG' && sp >= ref;
    const badShort = side === 'SHORT' && sp <= ref;
    if (badLong || badShort) {
      return {
        ...base, ok: false, triggerPrice: sp, note,
        reason: `${side} 기준가 ${ref} / 손절 ${sp} — 손절이 `
              + `${side === 'LONG' ? '위' : '아래'}에 있어 즉시 발동합니다`,
      };
    }
  }
  return { ...base, triggerPrice: sp, note };
}

// ── 기초자산 수량 ↔ 계약 수 ──────────────────────────
//
// 이 저장소 전체에서 `plan.quantity`는 **기초자산 수량**이다 (0.05 BTC).
// Gate만 주문 단위가 정수 계약이다. 그 변환을 여기 한 곳에 둔다 —
// 두 곳에 두면 한쪽만 고쳐지고, 그 실수는 '의도의 10000배 주문'으로 나온다.



/**
 * Gate 계약 규격 → 공용 `quantizeOrder`가 읽는 모양.
 *
 * 수량 단위를 `quantoMultiplier`로 놓으면, 기초자산 수량을 그 배수로 내림하는
 * 일이 그대로 "정수 계약으로 내림"이 된다. 바이낸스와 같은 함수를 쓰게 되어
 * 판정이 한 벌로 유지된다.
 *
 * **못 읽었으면 null을 그대로 넘긴다.** quantizeOrder는 null을 받으면
 * 규격을 적용하지 않았다고 표시한다.
 */
export function gateFiltersOf(spec: GateSpecLike | null | undefined): SymbolFilters | null {
  const m = Number(spec?.quantoMultiplier);
  if (!Number.isFinite(m) || m <= 0) return null;
  const minC = Number(spec?.orderSizeMin);
  const round = Number(spec?.orderPriceRound);
  return {
    stepSize: m,
    // 최소 계약 수를 기초자산으로 환산한다. 계약 수로 두면 단위가 섞인다.
    minQty: (Number.isFinite(minC) && minC > 0 ? minC : 1) * m,
    tickSize: Number.isFinite(round) && round > 0 ? round : null,
  };
}

/**
 * 기초자산 수량 → 부호 있는 계약 수.
 *
 * **배수를 모르면 주문하지 않는다.** 1로 가정하면 BTC_USDT에서 0.05 BTC 주문이
 * 0계약(거부)이나, 반대로 500 BTC(계좌 전체의 몇 백 배)로 나갈 수 있다.
 * 어느 쪽도 조용히 넘길 수 없다.
 *
 * 내림한다 — 올리면 의도보다 큰 포지션이 열리고 그만큼 청산가가 가까워진다.
 */
export function gateSizeFromBase(
  baseQty: number, side: 'LONG' | 'SHORT', spec: GateSpecLike | null | undefined,
): GateSizeResult {
  const q = Number(baseQty);
  if (!Number.isFinite(q) || q <= 0) {
    return { size: 0, ok: false, reason: `수량이 유효하지 않습니다 (${baseQty})` };
  }
  const m = Number(spec?.quantoMultiplier);
  if (!Number.isFinite(m) || m <= 0) {
    return {
      size: 0, ok: false,
      reason: 'Gate 계약 규격(1계약당 수량)을 읽지 못해 주문하지 않습니다 — '
            + '수량 단위를 모르는 채로 보내면 의도와 전혀 다른 크기가 나갑니다',
    };
  }

  // 부동소수 오차 보정. 0.05 / 0.0001이 499.99999…로 나오면 499계약이 된다.
  const contracts = Math.floor(q / m + 1e-9);
  if (contracts < 1) {
    return {
      size: 0, ok: false,
      reason: `수량 ${q}은 1계약(${m})보다 작습니다 — Gate 선물은 정수 계약 단위라 `
            + '주문할 수 없습니다. 수량을 늘리세요',
    };
  }
  const minC = Number(spec?.orderSizeMin);
  if (Number.isFinite(minC) && minC > 0 && contracts < minC) {
    return {
      size: 0, ok: false,
      reason: `${contracts}계약은 최소 주문 ${minC}계약보다 적습니다 (수량 ${q})`,
    };
  }
  const maxC = Number(spec?.orderSizeMax);
  if (Number.isFinite(maxC) && maxC > 0 && contracts > maxC) {
    return {
      size: 0, ok: false,
      reason: `${contracts}계약은 최대 주문 ${maxC}계약을 넘습니다 (수량 ${q})`,
    };
  }

  // 실제로 나가는 기초자산 수량. 요청과 다르면 그렇게 말한다.
  const actualBase = contracts * m;
  const changed = Math.abs(actualBase - q) > m * 1e-6;
  return {
    size: side === 'LONG' ? contracts : -contracts,
    ok: true,
    reason: changed ? `${q} → ${contracts}계약 (${actualBase}, 내림)` : `${contracts}계약`,
  };
}

/** 계약 수 → 기초자산 수량. 배수를 모르면 null — 계약 수를 수량으로 적지 않는다 */
export function gateBaseFromContracts(
  contracts: number, spec: GateSpecLike | null | undefined,
): number | null {
  const c = Number(contracts);
  const m = Number(spec?.quantoMultiplier);
  if (!Number.isFinite(c)) return null;
  if (!Number.isFinite(m) || m <= 0) return null;
  return c * m;
}

/**
 * Gate 익절 조건. **손절과 부등호가 반대다.**
 *
 * gateStopSpec을 그대로 못 쓰는 이유
 * ───────────────────────────────────
 * 손절은 LONG이면 아래(rule 2), SHORT면 위(rule 1)에서 발동한다.
 * 익절은 정확히 그 반대다 — LONG이면 위(rule 1), SHORT면 아래(rule 2).
 *
 * 이걸 손절 함수로 대신 쓰면 **익절이 손절 자리에 걸린다.** 롱의 익절을
 * 현재가 아래에 걸어 두는 셈이라, 오르지 않고 조금만 내려도 "익절"이라는
 * 이름으로 손실 확정된다. 화면에는 익절이 걸렸다고 뜬다.
 *
 * 호가 반올림 방향도 반대다. 손절은 진입에서 **멀어지는** 쪽으로 밀어
 * 한 틱 일찍 터지지 않게 하는데, 익절은 멀어지는 쪽으로 밀면 안 닿는다.
 * 익절도 같은 원칙(불리한 쪽)을 쓴다 — LONG 익절은 올림, SHORT는 내림.
 * 한 틱 늦게 익절되는 쪽이 안 익절되는 것보다 낫다.
 */
export function gateTakeProfitSpec(
  side: 'LONG' | 'SHORT',
  tpPrice: number | null | undefined,
  refPrice?: number | null,
  spec?: GateSpecLike | null,
): GateStopSpec {
  // autoSize는 손절과 같다 — 어느 쪽이든 **그 포지션을 닫는** 주문이다.
  // rule만 뒤집는다.
  const base: GateStopSpec = side === 'LONG'
    ? { rule: 1, autoSize: 'close_long', ok: true, reason: '', triggerPrice: null, note: '' }
    : { rule: 2, autoSize: 'close_short', ok: true, reason: '', triggerPrice: null, note: '' };

  const p0 = Number(tpPrice);
  if (!Number.isFinite(p0) || p0 <= 0) {
    return { ...base, ok: false, reason: `익절가가 유효하지 않습니다 (${tpPrice})` };
  }

  const tick = Number(spec?.orderPriceRound);
  let p = p0;
  let note = '';
  if (Number.isFinite(tick) && tick > 0) {
    const n = p0 / tick;
    const eps = 1e-9;
    // LONG 익절은 위에 있으므로 올림, SHORT는 아래이므로 내림 —
    // 손절과 반대 방향이다.
    const k = side === 'LONG' ? Math.ceil(n - eps) : Math.floor(n + eps);
    const dec = Math.max(0, Math.min(12, Math.round(-Math.log10(tick))));
    p = Number((k * tick).toFixed(dec));
    if (!(p > 0)) {
      return { ...base, ok: false,
        reason: `익절가 ${p0}을 호가 단위(${tick})에 맞추면 0이 됩니다` };
    }
    if (p !== p0) note = `익절가 ${p0} → ${p} (호가 단위 ${tick})`;
  }

  // 방향 검사. LONG 익절이 현재가 아래면 걸자마자 체결된다 — 익절이
  // 아니라 즉시 청산이고, 그건 사용자가 정한 것이 아니다.
  if (refPrice != null && Number.isFinite(Number(refPrice)) && Number(refPrice) > 0) {
    const ref = Number(refPrice);
    const badLong = side === 'LONG' && p <= ref;
    const badShort = side === 'SHORT' && p >= ref;
    if (badLong || badShort) {
      return {
        ...base, ok: false, triggerPrice: p, note,
        reason: `${side} 기준가 ${ref} / 익절 ${p} — 익절이 `
              + `${side === 'LONG' ? '아래' : '위'}에 있어 즉시 체결됩니다`,
      };
    }
  }
  return { ...base, triggerPrice: p, note };
}

// ── 걸려 있는 조건부 주문이 손절인가 익절인가 ────────────

export type ProtectiveKind = 'STOP' | 'TAKE_PROFIT' | 'NOT_PROTECTIVE' | 'UNKNOWN';

export interface ProtectiveClass {
  kind: ProtectiveKind;
  /** 이 주문이 닫는 포지션의 방향. 못 읽으면 null */
  closes: 'LONG' | 'SHORT' | null;
  reason: string;
}

/**
 * Gate의 `price_orders` 한 줄이 **손절인지 익절인지** 가른다.
 *
 * 왜 세는 것만으로는 안 되는가
 * ────────────────────────────
 * 처음에는 `price_orders`의 개수만 세서 "보호 주문 있음"으로 통과시켰다.
 * 그러면 **익절만 걸려 있고 손절은 없는 포지션이 통과한다.** 화면에는
 * "거래소에 보호 주문 1건"이 뜨는데, 가격이 반대로 가면 막을 것이 없다.
 * 익절은 이익을 확정하는 주문이지 방어선이 아니다.
 *
 * 어떻게 가르는가 — `gateStopSpec`·`gateTakeProfitSpec`의 표를 뒤집는다
 * ──────────────────────────────────────────────────────────────────
 * 두 함수가 만드는 조합이 정확히 넷이고, 그게 그대로 판별표가 된다:
 *
 *   close_long  + rule 2(이하)  → 손절   (LONG은 내려갈 때 닫는다)
 *   close_long  + rule 1(이상)  → 익절   (LONG은 올라갈 때 이익)
 *   close_short + rule 1(이상)  → 손절   (SHORT는 올라갈 때 닫는다)
 *   close_short + rule 2(이하)  → 익절
 *
 * **이 표를 여기 한 곳에만 둔다.** 거는 쪽과 세는 쪽이 각자 부등호를
 * 쓰면 한쪽만 고쳐지고, 그때 화면은 "손절 있음"이라고 적는데 실제로는
 * 익절이 걸려 있다.
 *
 * 닫는 주문이 아니면(진입 예약 등) NOT_PROTECTIVE다 — 사용자가 일부러
 * 걸어 둔 지정가를 손절로 세면 안 된다.
 *
 * 판별에 필요한 값이 없으면 **UNKNOWN이다.** 손절이라고 치지 않는다.
 */
export function gateProtectiveKind(row: any | null | undefined): ProtectiveClass {
  if (!row || typeof row !== 'object') {
    return { kind: 'UNKNOWN', closes: null, reason: '주문 내용을 읽지 못했습니다' };
  }
  const initial = row.initial ?? row;
  const trigger = row.trigger ?? {};

  // 1) 포지션을 **닫는** 주문인가.
  //    Gate는 응답 스키마에 따라 reduce_only / is_reduce_only / is_close가
  //    섞여 나온다. 셋 중 하나라도 참이면 닫는 주문이고, auto_size가
  //    붙어 있으면 그 자체가 전량 청산 주문이라는 뜻이다.
  const autoSize = String(initial.auto_size ?? '').toLowerCase();
  const closing =
    initial.reduce_only === true || initial.is_reduce_only === true
    || initial.is_close === true || initial.close === true
    || autoSize === 'close_long' || autoSize === 'close_short';
  if (!closing) {
    return { kind: 'NOT_PROTECTIVE', closes: null,
      reason: '포지션을 닫는 주문이 아닙니다 (진입 예약일 수 있습니다)' };
  }

  // 2) 어느 방향을 닫는가.
  //    auto_size가 있으면 그것이 답이다. 없으면 size의 부호로 읽는다 —
  //    닫는 주문의 size는 포지션과 반대 부호다(롱은 음수로 판다).
  let closes: 'LONG' | 'SHORT' | null = null;
  if (autoSize === 'close_long') closes = 'LONG';
  else if (autoSize === 'close_short') closes = 'SHORT';
  else {
    const size = Number(initial.size);
    if (Number.isFinite(size) && size < 0) closes = 'LONG';
    else if (Number.isFinite(size) && size > 0) closes = 'SHORT';
  }
  if (!closes) {
    return { kind: 'UNKNOWN', closes: null,
      reason: '어느 방향을 닫는 주문인지 읽지 못했습니다 (auto_size·size 없음)' };
  }

  // 3) 트리거 방향. rule이 없으면 손절인지 익절인지 알 수 없다.
  const rule = Number(trigger.rule);
  if (rule !== 1 && rule !== 2) {
    return { kind: 'UNKNOWN', closes,
      reason: `트리거 조건(rule)을 읽지 못했습니다 (${trigger.rule})` };
  }

  // gateStopSpec의 표를 그대로 뒤집은 것이다.
  const isStop = closes === 'LONG' ? rule === 2 : rule === 1;
  return {
    kind: isStop ? 'STOP' : 'TAKE_PROFIT',
    closes,
    reason: `${closes} ${isStop ? '손절' : '익절'} (rule ${rule})`,
  };
}
