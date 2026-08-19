// src/lib/portfolio/walletMoney.ts
//
// **환율이 없으면 통화를 바꾸지 않는다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 지갑 화면에 `USDT · USD · KRW` 버튼이 있고, 누르면 숫자는 그대로 둔 채
// 표시만 바뀌었다. 5,000 USDT가 버튼 한 번에 **₩5,000**으로 보일 수 있는
// 구조다. 실제로는 더 나빴다 — 공용 `cvt()`는 **입력이 KRW라고 가정**하고
// 만들어져 있어서, USD 값을 넣으면 원화 기호만 붙거나(1,000배 축소) 반대로
// 환율로 나눠 버린다(1,000배 확대). 어느 쪽이든 사용자는 자기 돈이
// 몇 배 늘거나 준 것으로 본다.
//
// 규칙
// ────
// 지갑의 모든 숫자는 **USD 기준**이다. 그 사실을 지우지 않는다.
//   · USD  그대로 보여준다
//   · USDT 그대로 보여준다 — 다만 **1 USDT = 1 USD로 가정**한 값이다
//   · KRW  **환율이 있어야만** 보여준다. 없으면 바꾸지 않고 그 이유를 말한다
//
// 환산할 때는 `rate`·`source`·`asOf`를 같이 들고 다닌다. 어느 환율로
// 언제 바꾼 값인지 모르면 그 숫자도 나중에 검증할 수 없다.

export type WalletCurrency = 'USDT' | 'USD' | 'KRW';

export interface FxRate {
  /** 1 USD가 몇 단위인가 */
  rate: number;
  currency: WalletCurrency;
  source: string;
  asOfMs: number;
}

export interface MoneyView {
  /** 화면에 그대로 찍는 문자열 */
  text: string;
  /** 환산된 값. 못 바꿨으면 null */
  value: number | null;
  currency: WalletCurrency;
  /** 통화를 실제로 바꿨는가 */
  converted: boolean;
  /** 이 통화로 볼 수 있는가. false면 버튼을 잠근다 */
  available: boolean;
  /** 어떤 환율로 바꿨는지 (없으면 null) */
  rate: FxRate | null;
  reason: string;
}

const isNum = (v: any): v is number => v != null && Number.isFinite(Number(v));

function fmt(n: number, currency: WalletCurrency): string {
  const abs = Math.abs(n);
  if (currency === 'KRW') return '₩' + Math.round(n).toLocaleString('ko-KR');
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  const body = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency === 'USD' ? `$${body}` : `${body} USDT`;
}

/**
 * USD 값을 고른 통화로.
 *
 * **환율이 없으면 숫자를 그대로 두고 라벨만 바꾸지 않는다.** 못 바꾸는
 * 것은 불편이고, 잘못 바꾼 숫자는 사고다.
 */
export function moneyView(
  valueUsd: number | null | undefined,
  currency: WalletCurrency,
  fx?: FxRate | null,
): MoneyView {
  const cur: WalletCurrency = currency === 'USD' || currency === 'KRW' || currency === 'USDT'
    ? currency : 'USDT';

  if (!isNum(valueUsd)) {
    return { text: '확인 불가', value: null, currency: cur, converted: false,
      available: true, rate: null, reason: '값을 읽지 못했습니다 — 0이 아닙니다' };
  }
  const usd = Number(valueUsd);

  // USD·USDT는 환산이 아니다. 표시 단위만 다르다.
  if (cur === 'USD') {
    return { text: fmt(usd, 'USD'), value: usd, currency: cur, converted: false,
      available: true, rate: null, reason: '지갑 값은 USD 기준입니다' };
  }
  if (cur === 'USDT') {
    return { text: fmt(usd, 'USDT'), value: usd, currency: cur, converted: false,
      available: true, rate: null,
      reason: '1 USDT = 1 USD로 가정한 값입니다 — 디페그 시 실제와 다를 수 있습니다' };
  }

  // KRW는 환율이 있어야 한다.
  if (!fx || fx.currency !== 'KRW' || !isNum(fx.rate) || Number(fx.rate) <= 0) {
    return {
      text: '환율 확인 불가', value: null, currency: cur, converted: false,
      available: false, rate: null,
      reason: '원화 환율을 읽지 못했습니다 — 달러 금액에 ₩만 붙이지 않습니다',
    };
  }
  const won = usd * Number(fx.rate);
  return {
    text: fmt(won, 'KRW'), value: won, currency: cur, converted: true,
    available: true, rate: fx,
    reason: `${fx.source} 환율 ${fx.rate}로 환산했습니다`,
  };
}

/**
 * 이 통화 버튼을 누를 수 있는가.
 *
 * 화면이 직접 판단하면 화면마다 달라진다 — 그리고 그때 한 화면이
 * "환율 없어도 그냥 보여주자"를 택한다.
 */
export function currencyAvailable(currency: WalletCurrency, fx?: FxRate | null): boolean {
  if (currency !== 'KRW') return true;
  return !!fx && fx.currency === 'KRW' && isNum(fx.rate) && Number(fx.rate) > 0;
}
