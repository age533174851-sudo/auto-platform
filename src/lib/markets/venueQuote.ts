// src/lib/markets/venueQuote.ts
//
// **주문이 나갈 그 거래소의 선물 가격을 읽는 단 하나의 경로.**
//
// 왜 한 곳인가
// ────────────
// 이 값은 두 순간에 필요하다:
//
//   확인창을 열기 전  사용자가 보고 판단할 **예상** 수량
//   확인 버튼을 누를 때  실제로 나갈 수량을 정하는 **정본**
//
// 두 곳이 각자 fetch를 적으면 언젠가 한쪽만 고쳐진다 — 화면은 Gate 가격을
// 보여 주고 주문은 바이낸스 가격으로 나가는 식이다. 그래서 읽기는 여기
// 하나뿐이고, 두 순간 모두 이 함수를 부른다.
//
// 못 읽으면 null이다
// ──────────────────
// 다른 거래소로 대신 읽지 않고, 현물로 내려가지 않고, 환율로 만들지 않는다.
// **가격을 모르는 것은 수량을 만들 수 없다는 뜻이다.** 부른 쪽이 막는다.
//
// 값은 연결에 묶여 돌아온다. A 연결에서 읽은 가격이 B 연결 화면에 남으면
// 다른 계좌의 시세로 판단하게 된다.

import type { ConnectionScoped } from './orderCurrency';

export interface VenueQuote {
  /** 거래소 원본 가격 (USDT) */
  price: number;
  exchange: string;
  /** 어느 값에서 왔는가 — binance_mark · gate_mark · gate_last */
  source: string | null;
  asOf: string | null;
}

/**
 * 화면의 종목 표기를 거래소 심볼로 바꾼다.
 *
 * 화면은 `BTC`·`btc`·`BTCUSDT`를 섞어 쓴다. 시세를 읽는 심볼과 주문을 내는
 * 심볼이 다르면 **다른 종목의 가격으로 수량을 만든다.** 그래서 한 함수다.
 */
export function toVenueSymbol(raw: string | null | undefined): string {
  const s = String(raw ?? '').toUpperCase().replace('/', '').trim();
  if (!s) return '';
  return s.replace(/USDT$/, '') + 'USDT';
}

/**
 * 연결이 정한 거래소·환경에서 선물 가격을 읽는다.
 *
 * 성공하면 연결에 묶인 값, 실패하면 `null`. **지어낸 값을 돌려주지 않는다.**
 */
export async function fetchVenueQuote(i: {
  connectionId: string | null | undefined;
  symbol: string | null | undefined;
  authHeader?: string | null;
  timeoutMs?: number;
  /** 테스트에서 주입한다. 실제 화면은 전역 fetch를 쓴다 */
  fetchImpl?: (input: any, init?: any) => Promise<any>;
}): Promise<ConnectionScoped<VenueQuote> | null> {
  const connectionId = String(i?.connectionId ?? '');
  const symbol = toVenueSymbol(i?.symbol);
  // 연결이 없으면 거래소도 환경도 정해지지 않는다 — 읽지 않는다.
  if (!connectionId || !symbol) return null;

  const f: any = i?.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;

  let signal: any;
  try {
    const AS: any = typeof AbortSignal !== 'undefined' ? AbortSignal : null;
    if (AS && typeof AS.timeout === 'function') signal = AS.timeout(i?.timeoutMs ?? 6000);
  } catch { /* 타임아웃 없이 진행 */ }

  try {
    const r = await f(
      `/api/binance/futures/quote?connectionId=${encodeURIComponent(connectionId)}`
      + `&symbol=${encodeURIComponent(symbol)}`,
      { headers: i?.authHeader ? { Authorization: i.authHeader } : {}, signal },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d?.ok) return null;
    const price = Number(d.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      connectionId,
      value: {
        price,
        exchange: String(d.exchange || ''),
        source: d.priceSource ?? null,
        asOf: d.asOf ?? null,
      },
    };
  } catch {
    return null;
  }
}
