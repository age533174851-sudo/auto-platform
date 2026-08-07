// src/lib/markets/quantityInput.ts
//
// **사용자가 적은 숫자를 거래소가 받는 수량으로 바꾼다.**
//
// 지금은 BTC ↔ USDT 토글 하나뿐이고, 그 USDT가 무엇인지 화면 어디에도
// 없다. 그런데 USDT에는 뜻이 최소 둘이다:
//
//   주문 총액 10,000 USDT  → 포지션 명목가 10,000 (배율과 무관)
//   초기 증거금 10,000 USDT → 5배면 명목가 50,000
//
// 다섯 배 차이다. 토글 하나로 두면 사용자가 어느 쪽을 적었는지 알 수
// 없고, **틀린 쪽이 다섯 배 큰 주문**이다.
//
// 그래서 뜻을 나눈다. 그리고 계좌 기준 두 가지를 더한다 —
// "BTC 몇 개 사지?"를 사람이 암산하지 않게 하는 것이 이 화면의 일이다.
//
// 무엇을 여기서 하지 않는가
// ─────────────────────────
// **계좌 위험(ACCOUNT_RISK) 계산은 여기서 안 한다.** `orderSizing.planSize`가
// 이미 그 산수를 갖고 있다(허용손실 ÷ 손절거리, 최소수량·수량단위·증거금
// 검사까지). 여기서 다시 적으면 같은 판정이 두 벌이 되고, 두 벌이 되면
// 한쪽만 고쳐진다 — 이 저장소에서 가장 자주 나는 고장이다.
//
// 규칙 하나: **못 구한 것은 0이 아니라 null이다.** 0을 돌려주면 화면에
// '수량 0'이 뜨고, 사용자는 자기가 잘못 적었다고 읽는다. 실제로는 가격이나
// 잔고를 못 읽은 것이다.

export type QuantityInputMode =
  /** 코인 개수 (0.2079 BTC) */
  | 'BASE_ASSET'
  /** USDT 주문 총액 — 포지션 명목가 기준 */
  | 'QUOTE_NOTIONAL'
  /** USDT 초기 증거금 — 실제로 넣는 돈 */
  | 'INITIAL_MARGIN'
  /** 가용자산의 % 를 증거금으로 */
  | 'ACCOUNT_PERCENT'
  /** 계좌 위험 % — 손절 거리로 역산 (orderSizing이 계산한다) */
  | 'ACCOUNT_RISK';

export const MODE_LABEL: Record<QuantityInputMode, string> = {
  BASE_ASSET: '코인 수량',
  QUOTE_NOTIONAL: 'USDT · 주문 총액',
  INITIAL_MARGIN: 'USDT · 초기 증거금',
  ACCOUNT_PERCENT: '가용자산 %',
  ACCOUNT_RISK: '계좌 위험 %',
};

export const MODE_HINT: Record<QuantityInputMode, string> = {
  BASE_ASSET: '코인 개수를 직접 적습니다',
  QUOTE_NOTIONAL: '포지션 명목가 기준입니다 — 배율과 무관합니다',
  INITIAL_MARGIN: '실제로 넣는 돈입니다 — 배율을 곱한 만큼이 포지션이 됩니다',
  ACCOUNT_PERCENT: '가용자산의 몇 %를 증거금으로 넣을지 정합니다',
  ACCOUNT_RISK: '손절에 닿았을 때 잃을 금액으로 수량을 역산합니다',
};

/** 이 모드가 계좌 잔고를 필요로 하는가 */
export function needsEquity(m: QuantityInputMode): boolean {
  return m === 'ACCOUNT_PERCENT' || m === 'ACCOUNT_RISK';
}
/** 이 모드가 손절 거리를 필요로 하는가 */
export function needsStop(m: QuantityInputMode): boolean {
  return m === 'ACCOUNT_RISK';
}

export interface QuantityConvertInput {
  mode?: QuantityInputMode;
  /** 사용자가 적은 숫자 */
  value?: number | string | null;
  /** 기준가. 지정가면 그 값, 아니면 현재가 */
  price?: number | null;
  leverage?: number | null;
  /** 쓸 수 있는 증거금. **못 읽었으면 null** */
  availableUsd?: number | null;
}

export type ConvertStatus =
  | 'OK'
  | 'NO_INPUT'
  | 'PRICE_UNKNOWN'
  | 'LEVERAGE_UNKNOWN'
  | 'EQUITY_UNKNOWN'
  | 'DELEGATED';

export interface QuantityConvertResult {
  status: ConvertStatus;
  ok: boolean;
  /** 거래소로 나갈 코인 수량. **못 구하면 null** */
  baseQty: number | null;
  /** 포지션 명목가 */
  notionalUsd: number | null;
  /** 실제로 묶이는 증거금 */
  marginUsd: number | null;
  /** 왜 못 구했는가. 구했으면 빈 문자열 */
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pos = (v: any): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

const fail = (status: ConvertStatus, reason: string): QuantityConvertResult =>
  ({ status, ok: false, baseQty: null, notionalUsd: null, marginUsd: null, reason });

/**
 * 사용자가 적은 값 → 코인 수량.
 *
 * **ACCOUNT_RISK는 여기서 계산하지 않는다.** `DELEGATED`를 돌려주고
 * 부르는 쪽이 `orderSizing.planSize`를 쓴다 — 그쪽에 최소수량·수량단위·
 * 증거금 초과 검사까지 들어 있고, 그 판정을 두 벌로 만들지 않는다.
 */
export function convertQuantity(
  input: QuantityConvertInput | null | undefined,
): QuantityConvertResult {
  const i = input ?? {};
  const mode = i.mode ?? 'BASE_ASSET';

  if (mode === 'ACCOUNT_RISK') {
    return {
      status: 'DELEGATED', ok: false, baseQty: null, notionalUsd: null, marginUsd: null,
      reason: '계좌 위험 기반 수량은 orderSizing.planSize가 계산합니다',
    };
  }

  const v = pos(i.value);
  if (v == null) return fail('NO_INPUT', '수량을 입력하세요');

  const price = pos(i.price);
  const lev = pos(i.leverage);

  // BASE_ASSET만 가격 없이도 수량이 나온다. 나머지는 전부 가격이 있어야
  // 코인 개수로 바뀐다 — **가격을 못 읽었으면 0이 아니라 모른다.**
  if (mode !== 'BASE_ASSET' && price == null) {
    return fail('PRICE_UNKNOWN',
      '가격을 확인하지 못해 수량으로 바꿀 수 없습니다 — 지정가를 입력하거나 단위를 코인 수량으로 바꾸세요');
  }

  let notional: number;

  switch (mode) {
    case 'BASE_ASSET':
      // 명목가는 가격을 알아야 나온다. 몰라도 수량 자체는 확정이다.
      return {
        status: 'OK', ok: true, baseQty: v,
        notionalUsd: price != null ? v * price : null,
        marginUsd: price != null && lev != null ? (v * price) / lev : null,
        reason: '',
      };

    case 'QUOTE_NOTIONAL':
      // 적은 금액이 곧 명목가다. 배율과 무관하다.
      notional = v;
      break;

    case 'INITIAL_MARGIN':
      // 적은 금액이 증거금이다. 배율을 곱한 만큼이 포지션이 된다.
      // **배율을 모르면 곱할 수 없다** — 1로 가정하면 5배 계좌에서
      // 실제 포지션이 다섯 배가 된다.
      if (lev == null) {
        return fail('LEVERAGE_UNKNOWN',
          '배율을 확인하지 못해 증거금을 포지션 크기로 바꿀 수 없습니다');
      }
      notional = v * lev;
      break;

    case 'ACCOUNT_PERCENT': {
      const avail = pos(i.availableUsd);
      // **0으로 치지 않는다.** 0이면 모든 수량이 0이 되고, 사용자는
      // 잔고가 없다고 읽는다 — 실제로는 못 읽은 것이다.
      if (avail == null) {
        return fail('EQUITY_UNKNOWN',
          '가용자산을 확인하지 못해 비율로 수량을 정할 수 없습니다');
      }
      if (lev == null) {
        return fail('LEVERAGE_UNKNOWN', '배율을 확인하지 못했습니다');
      }
      // 비율은 100을 넘을 수 없다. 넘겨 적으면 있는 돈보다 큰 증거금이 된다.
      const capped = Math.min(100, v);
      notional = (avail * (capped / 100)) * lev;
      break;
    }

    default:
      return fail('NO_INPUT', `알 수 없는 수량 단위입니다 (${mode})`);
  }

  const baseQty = notional / (price as number);
  return {
    status: 'OK', ok: true, baseQty,
    notionalUsd: notional,
    marginUsd: lev != null ? notional / lev : null,
    reason: '',
  };
}

// ── 손실 미리보기가 쓸 수량 ────────────────────────────────

export type QtySource = 'ORDER_INPUT' | 'CLOSE_SELECTION' | 'POSITION' | 'NONE';

export interface EffectiveQty {
  qty: number | null;
  source: QtySource;
  /** 화면에 적을 근거 — 어느 수량으로 계산했는지 */
  label: string;
}

/**
 * 손실을 **어느 수량으로** 계산할 것인가.
 *
 * 화면에 이 문구가 떠 있었다:
 *
 *   수량이 없어 손실을 계산하지 못했습니다
 *
 * 그런데 그때 포지션은 0.2079 BTC를 들고 있었다. 주문 입력칸만 보고
 * 계산했기 때문이다 — **들고 있는 것의 손실은 입력칸과 무관하게 계산할
 * 수 있다.** 오히려 그게 지금 가장 알고 싶은 숫자다.
 *
 * 우선순위:
 *   1. 지금 적고 있는 주문 수량 (그 주문의 손실을 보고 싶다)
 *   2. 부분청산으로 고른 수량
 *   3. 보유 포지션 수량 (아무것도 안 적었으면 이것)
 */
export function effectiveQtyFor(args: {
  orderQty?: number | null;
  closeQty?: number | null;
  positionQty?: number | null;
}): EffectiveQty {
  const order = pos(args?.orderQty);
  if (order != null) return { qty: order, source: 'ORDER_INPUT', label: '입력한 주문 수량 기준' };

  const close = pos(args?.closeQty);
  if (close != null) return { qty: close, source: 'CLOSE_SELECTION', label: '선택한 청산 수량 기준' };

  const held = pos(args?.positionQty == null ? null : Math.abs(args.positionQty));
  if (held != null) return { qty: held, source: 'POSITION', label: '보유 포지션 수량 기준' };

  return { qty: null, source: 'NONE', label: '' };
}

// ── 비율 버튼의 뜻 ────────────────────────────────────────

/**
 * 25/50/75/100이 **무엇의 비율인가.**
 *
 * 지금은 라벨이 없어서 잔고 비율인지 청산 비율인지 알 수 없다. 청산
 * 탭에서 100%를 눌렀는데 그게 잔고의 100%였다면, 그건 전량청산이
 * 아니라 계좌를 통째로 건 신규 주문이다.
 */
export function percentLabel(intent: 'ENTRY' | 'EXIT'): string {
  return intent === 'EXIT' ? '포지션 청산 비율' : '가용 증거금 비율';
}
