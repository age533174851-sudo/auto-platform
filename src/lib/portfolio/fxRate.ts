// src/lib/portfolio/fxRate.ts
//
// **없는 환율을 지어내지 않는다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 지갑 화면에는 `const fxRate = null`이 박혀 있었다. 주석은 정직했다 —
// "환율 공급원이 아직 없다. null은 '1:1'이 아니라 '모른다'이다."
// 그래서 KRW 버튼이 잠겨 있었고, 그건 **맞는 상태**였다.
//
// 그런데 저장소 다른 곳에는 이런 것이 있었다:
//
//   src/lib/currency.ts:  const FALLBACK_USDKRW = 1375;
//
// 환율을 못 읽으면 1375를 쓴다. 그 값이 언제 것인지는 아무도 모르고,
// 화면에는 **그냥 원화 금액**으로 보인다. 못 읽었다는 표시가 없다.
// 이 저장소가 계속 잡아 온 고장과 같은 모양이다 —
// **모르는 것을 그럴듯한 숫자로 채운다.**
//
// 이 파일의 규칙
// ──────────────
//   · 못 읽으면 null이다. **폴백 상수를 두지 않는다**
//   · 말이 안 되는 값은 안 읽은 것으로 친다(1 USD = 3 KRW는 없다)
//   · 언제 것인지 같이 들고 다닌다. 오래되면 화면이 그렇게 말한다
//
// 못 바꾸는 것은 불편이고, 잘못 바꾼 숫자는 사고다.

import type { FxRate } from './walletMoney';

/** 이 밖의 값은 읽은 것으로 치지 않는다. 1 USD는 이 범위를 벗어난 적이 없다 */
export const USDKRW_MIN = 500;
export const USDKRW_MAX = 3000;

/** 이보다 오래된 환율은 "지금 환율"이라고 하지 않는다 */
export const FX_STALE_MS = 24 * 3600_000;

/**
 * 공급원이 준 것을 환율로 받아들일지.
 *
 * **범위를 벗어나면 null이다.** 공급원이 고장 나서 0이나 1을 주면,
 * 그대로 쓰는 순간 5,000 USDT가 ₩5,000으로 보인다.
 */
export function parseUsdKrw(raw: any, asOfMs: any, source?: string): FxRate | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < USDKRW_MIN || n > USDKRW_MAX) return null;
  const t = Number(asOfMs);
  if (!Number.isFinite(t) || t <= 0) return null;
  return { rate: n, currency: 'KRW', source: String(source || 'open.er-api.com'), asOfMs: t };
}

export interface FxFreshness {
  usable: boolean;
  stale: boolean;
  reason: string;
}

/**
 * 이 환율을 지금 쓸 수 있는가.
 *
 * 오래된 환율로 바꾼 값도 **바꾼 값**이다 — 다만 사용자가 그 사실을
 * 알아야 한다. 그래서 막지는 않고 말한다.
 */
export function fxFreshness(fx: FxRate | null | undefined, nowMs: any): FxFreshness {
  if (!fx) {
    return { usable: false, stale: false,
      reason: '환율을 읽지 못했습니다 — 숫자를 그대로 두고 원화 기호만 붙이지 않습니다' };
  }
  const now = Number(nowMs);
  if (!Number.isFinite(now)) {
    return { usable: true, stale: false, reason: `${fx.source} 환율` };
  }
  const age = now - fx.asOfMs;
  if (age > FX_STALE_MS) {
    return { usable: true, stale: true,
      reason: `${Math.floor(age / 3600_000)}시간 전 환율입니다 — 지금 환율이 아닙니다` };
  }
  return { usable: true, stale: false,
    reason: `${fx.source} · ${Math.max(0, Math.round(age / 60_000))}분 전` };
}
