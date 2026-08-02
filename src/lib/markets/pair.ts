// src/lib/markets/pair.ts
//
// **페어 이름을 베이스와 견적통화로 가른다.**
//
// 왜 따로 두는가
// ──────────────
// 이 두 줄이 목록에서 종목을 지운다. 지워진 종목은 화면에서 '없는 종목'과
// 똑같이 보이고, 그래서 틀려도 아무도 모른다. 실제로 그랬다:
//
//   `!symbol.includes('UP')`
//
// 레버리지 토큰(BTCUP·ETHDOWN)을 빼려던 줄인데, 페어 이름 **전체**에서
// 찾는다. 그래서 이름 안에 그 글자가 들어간 멀쩡한 코인이 같이 사라졌다 —
// SUPER('S-U-P-E-R'에 UP이 있다)와 JUP이 목록에 한 번도 나온 적이 없다.
// 에러도 안 났다. 그냥 없었다.
//
// 레버리지 토큰은 **베이스의 끝**이 UP/DOWN/BULL/BEAR다. 끝만 본다.

/** 목록에 띄울 수 있는 견적통화 */
export const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'BNB', 'ETH'] as const;
export type Quote = typeof QUOTES[number];

export function isSupportedQuote(q: string | null | undefined): boolean {
  return (QUOTES as readonly string[]).includes(String(q || '').toUpperCase());
}

/**
 * 이 견적통화는 달러에 준하는가.
 *
 * 아니면 **원화로 환산하면 안 된다.** BTC 페어의 0.00003에 환율을 곱하면
 * 완전히 다른 숫자가 나오는데, 화면에는 그냥 '원'으로 적힌다.
 */
export function isDollarQuote(q: string | null | undefined): boolean {
  const s = String(q || '').toUpperCase();
  return s === 'USDT' || s === 'USDC' || s === 'FDUSD';
}

/**
 * 레버리지 토큰인가 (BTCUP · ETHDOWN · XRPBULL …).
 *
 * 왜 끝 글자만으로는 부족한가
 * ───────────────────────────
 * 페어 전체에 `includes('UP')`을 걸면 SUPER('S-U-P-E-R')가 걸린다.
 * 그래서 끝으로 바꿨더니 이번엔 **JUP**이 걸렸다 — 목성(Jupiter)은 실제
 * 코인이고, 이름이 그냥 UP으로 끝난다.
 *
 * 레버리지 토큰의 진짜 규칙은 `<상장된 코인>UP` 형태라는 것이다. 그래서
 * 남은 앞부분이 **그 자체로 상장된 코인인지**를 본다.
 *
 * @param knownBases 같은 목록에 있는 베이스 전부. 주면 정확해진다.
 *   안 주면 앞부분 길이(3자 이상)로 어림잡는다 — BTCUP은 'BTC'가 남고
 *   JUP은 'J'만 남는다.
 */
export function isLeveragedToken(
  base: string | null | undefined,
  knownBases?: Set<string> | null,
): boolean {
  const s = String(base || '').toUpperCase();
  const m = s.match(/^(.+?)(UP|DOWN|BULL|BEAR)$/);
  if (!m) return false;
  const stem = m[1];
  // 목록을 받았으면 그것이 답이다. 'J'는 상장 코인이 아니므로 JUP은 통과.
  if (knownBases) return knownBases.has(stem);
  // 목록이 없으면 어림잡는다. 짧은 쪽(JUP)을 살리는 방향으로 틀린다 —
  // 없는 종목을 지우는 것보다 안 지우는 쪽이 낫다.
  return stem.length >= 3;
}

/**
 * `BTCUSDT` + `USDT` → `BTC`.
 *
 * **끝에서만 자른다.** `replace(quote, '')`는 첫 번째 자리를 지우므로,
 * 베이스 이름 안에 같은 글자가 있으면 엉뚱한 이름이 나온다.
 * 안 끝나면 null이다 — 억지로 자르지 않는다.
 */
export function baseOf(symbol: string | null | undefined, quote: string | null | undefined): string | null {
  const s = String(symbol || '').toUpperCase();
  const q = String(quote || '').toUpperCase();
  if (!s || !q || !s.endsWith(q)) return null;
  const base = s.slice(0, s.length - q.length);
  return base.length > 0 ? base : null;
}

/** 목록에 넣을 페어인가. 베이스를 돌려주고, 아니면 null. */
export function acceptPair(
  symbol: string | null | undefined,
  quote: string | null | undefined,
  knownBases?: Set<string> | null,
): string | null {
  const base = baseOf(symbol, quote);
  if (base == null) return null;
  return isLeveragedToken(base, knownBases) ? null : base;
}
