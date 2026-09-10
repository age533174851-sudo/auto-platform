// src/lib/engine/sizing100x.ts
//
// **고정 손절이 없는 프로필의 주문 크기를 정한다.**
//
// 왜 riskManager.planPosition을 쓸 수 없는가
// ─────────────────────────────────────────
// 그 함수의 구조는 하나다.
//
//     수량 = 허용 손실 ÷ 실효 손절 거리
//
// 손절 거리가 분모다. 그래서 손절이 0이면 `INVALID_STOP`으로 거부한다
// (`riskManager.planPosition`의 손절 거리 검사). 그 거부는 옳다 — 손절이
// 없는데 그 식을 쓰면 수량이 무한대가 된다.
//
// 여기서 하면 안 되는 일은 **분모를 만들어 넣는 것**이다. `stopLossPct`에
// 0.5나 1을 적어 두고 그 값으로 역산하면, 그 숫자는 어디에도 걸리지 않는
// 손절인데 크기만 정한다. 화면에도 장부에도 "손절 0.5%"가 남고, 거래소에는
// 없다. 그건 이 저장소가 반복해서 없애 온 고장 그 자체다.
//
// 그래서 크기를 다른 근거에서 만든다
// ──────────────────────────────────
//     배정 증거금 = 가용 잔고 × 증거금 배정 비율
//     목표 명목가 = 배정 증거금 × 배율
//     수량        = 목표 명목가 ÷ 기준가
//
// 네 입력 중 **하나라도 모르면 주문하지 않는다.** 모르는 값을 0이나
// 기본값으로 눕히는 순간, 사용자가 고른 적 없는 크기로 100배가 나간다.
//
// 특히 조심한 것
// ──────────────
// · `availableUsd`가 null이면 BLOCK이다. 0이 아니다 — 0으로 읽으면 수량이
//   0이 되어 "주문 실패"로 보이지만, 원인이 잔고 없음인지 조회 실패인지
//   구분되지 않는다
// · `marginAllocationPct`가 null이면 BLOCK이다. 화면의 기본값(현재 10%)을
//   여기서 빌려 오지 않는다 — 그 값은 사용자가 이 프로필을 위해 고른 값이
//   아니다
// · `referencePrice`는 **서버가 읽은 시세**여야 한다. 신호가 들고 온
//   `entryPrice`를 거래소 관측가처럼 쓰지 않는다. 시장가 100배는 참고가에서
//   밀리고, 그 차이가 그대로 명목가 오차가 된다
//
// 이 함수는 순수하다. 네트워크를 타지 않는다 — 값을 읽어 오는 것은
// 호출부의 일이고, 여기서는 읽어 온 값이 쓸 수 있는 값인지만 판정한다.

export type Sizing100xCode =
  /** 통과 */
  | 'OK'
  /** 배율이 정확히 요구값이 아니다 */
  | 'LEVERAGE_NOT_EXACT'
  /** 가용 잔고를 읽지 못했다 (0이 아니라 모름) */
  | 'BALANCE_UNKNOWN'
  /** 가용 잔고가 0 이하다 */
  | 'BALANCE_EMPTY'
  /** 증거금 배정 비율이 정해지지 않았다 */
  | 'MARGIN_ALLOCATION_UNSET'
  /** 증거금 배정 비율이 범위를 벗어났다 */
  | 'MARGIN_ALLOCATION_INVALID'
  /** 기준가를 읽지 못했다 */
  | 'PRICE_UNKNOWN'
  /** 계산 결과 수량이 0 이하다 */
  | 'QTY_ZERO';

export interface Sizing100xInput {
  /** 이 프로필이 요구하는 정확한 배율 (100X면 100) */
  requiredLeverage: number;
  /**
   * **거래소에서 되읽어 확인한** 배율. 못 읽었으면 null.
   *
   * 설정 응답이 아니라 되읽은 값이어야 한다 — `futuresApplyLeverage`가
   * 돌려주는 `observed`가 그것이다.
   */
  observedLeverage: number | null;
  /** 주문에 쓸 수 있는 잔고(USD). **못 읽었으면 null** */
  availableUsd: number | null;
  /** 가용 잔고 대비 이 주문에 배정할 증거금 비율(%). **미지정이면 null** */
  marginAllocationPct: number | null;
  /** 서버가 읽은 기준가(마크가 우선). 못 읽었으면 null */
  referencePrice: number | null;
}

export interface Sizing100xVerdict {
  ok: boolean;
  code: Sizing100xCode;
  /** 통과일 때만 값이 있다 */
  quantity: number | null;
  allocatedMargin: number | null;
  targetNotional: number | null;
  /** 실제로 쓸 배율. 통과일 때 requiredLeverage와 같다 */
  leverage: number | null;
  message: string;
}

const block = (code: Sizing100xCode, message: string): Sizing100xVerdict => ({
  ok: false, code, quantity: null, allocatedMargin: null,
  targetNotional: null, leverage: null, message,
});

const finitePos = (v: unknown): boolean => Number.isFinite(Number(v)) && Number(v) > 0;

/**
 * 배정 비율이 쓸 수 있는 값인가. **문제가 없으면 null**이다.
 *
 * 왜 따로 빼는가
 * ──────────────
 * 이 검사는 거래소에 아무것도 묻지 않는다 — 사용자가 넣은 숫자 하나만
 * 본다. 그런데 `planSize100x` 안에만 있으면 **배율을 건 뒤에야** 불린다.
 * 배정 비율이 비어 있는 요청은 어차피 막힐 요청인데, 그 전에 거래소
 * 계좌의 배율이 이미 바뀐다.
 *
 * 그래서 호출부(`entry100x`)가 쓰기 전에 먼저 물어볼 수 있게 뺀다.
 * **규칙은 여전히 한 벌이다** — `planSize100x`도 이 함수를 쓴다.
 */
export function validateMarginAllocation(
  pct: number | null | undefined,
): { code: Sizing100xCode; message: string } | null {
  if (pct == null) {
    return {
      code: 'MARGIN_ALLOCATION_UNSET',
      message: '이 프로필의 증거금 배정 비율이 아직 정해지지 않았습니다 — '
        + '화면의 기본값을 대신 쓰지 않습니다. 값을 정해야 주문할 수 있습니다',
    };
  }
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    return {
      code: 'MARGIN_ALLOCATION_INVALID',
      message: `증거금 배정 비율이 범위를 벗어났습니다 (${String(pct)}) — 0 초과 100 이하여야 합니다`,
    };
  }
  return null;
}

/**
 * 이 주문의 수량.
 *
 * **fallback이 없다.** 어떤 입력이 없어도 "대신 이 값을 쓴다"는 가지가
 * 없고, 그것이 이 함수의 요점이다.
 */
export function planSize100x(i: Sizing100xInput): Sizing100xVerdict {
  const req = Number(i.requiredLeverage);
  if (!finitePos(req)) {
    return block('LEVERAGE_NOT_EXACT', '요구 배율이 유효하지 않습니다');
  }

  // ── ① 배율이 정확히 그 값인가 ──
  //
  // 상한이 아니라 **요청값**이다. 거래소가 낮춘 것도 통과가 아니다 —
  // 75배로 나가면 같은 증거금에 명목가가 4분의 3이고, 그건 사용자가
  // 검증한 것과 다른 크기다.
  const obs = i.observedLeverage == null ? null : Number(i.observedLeverage);
  if (obs == null || !Number.isFinite(obs)) {
    return block('LEVERAGE_NOT_EXACT',
      `배율 ${req}배가 실제로 걸렸는지 되읽어 확인하지 못했습니다 — 주문하지 않습니다`);
  }
  if (obs !== req) {
    return block('LEVERAGE_NOT_EXACT',
      `요청 ${req}배인데 거래소 실제 배율은 ${obs}배입니다(되읽음) — `
      + '요청과 다른 배율로는 이 프로필의 크기를 정당화할 수 없어 주문하지 않습니다');
  }

  // ── ② 잔고 ──
  if (i.availableUsd == null || !Number.isFinite(Number(i.availableUsd))) {
    return block('BALANCE_UNKNOWN',
      '가용 잔고를 읽지 못했습니다 — 0으로 두지 않고 주문하지 않습니다');
  }
  const avail = Number(i.availableUsd);
  if (avail <= 0) {
    return block('BALANCE_EMPTY', `가용 잔고가 ${avail}입니다 — 배정할 증거금이 없습니다`);
  }

  // ── ③ 증거금 배정 비율 ──
  const alloc = validateMarginAllocation(i.marginAllocationPct);
  if (alloc) return block(alloc.code, alloc.message);
  const pct = Number(i.marginAllocationPct);

  // ── ④ 기준가 ──
  if (i.referencePrice == null || !finitePos(i.referencePrice)) {
    return block('PRICE_UNKNOWN',
      '기준가를 읽지 못했습니다 — 명목가와 수량을 계산할 수 없어 주문하지 않습니다');
  }
  const price = Number(i.referencePrice);

  // ── ⑤ 크기 ──
  const allocatedMargin = avail * (pct / 100);
  const targetNotional = allocatedMargin * req;
  const quantity = targetNotional / price;

  if (!finitePos(quantity)) {
    return block('QTY_ZERO',
      `계산된 수량이 ${quantity}입니다 — 배정 증거금 $${allocatedMargin.toFixed(2)}, 기준가 ${price}`);
  }

  return {
    ok: true, code: 'OK',
    quantity, allocatedMargin, targetNotional, leverage: req,
    message: `가용 $${avail.toFixed(2)} × ${pct}% = 증거금 $${allocatedMargin.toFixed(2)}`
      + ` × ${req}배 = 명목가 $${targetNotional.toFixed(2)} ÷ 기준가 ${price} = ${quantity}`,
  };
}
