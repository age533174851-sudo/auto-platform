// src/lib/risk/limitScope.ts
//
// **손실 한도를 실전과 연습에서 다르게 읽는다.**
//
// 왜 필요한가
// ───────────
// 주간 한도가 계좌의 7%다. 테스트넷 계좌가 121 USDT면 한도가 8.48 USDT이고,
// 손절 한 번이면 거기에 닿는다. 그러면 **자동매매를 한 번도 못 돌려 본다.**
//
// 실제로 그 상태였다. 화면에 이렇게 떠 있었다:
//
//   이번 주 손실 36.99 USDT / 주간 한도 8.48 USDT — 다음 주까지 잠김
//
// 그리고 그 36.99에는 사용자가 **거래소 앱에서 손으로** 낸 거래의 손실도
// 들어간다. 계좌가 하나이므로 그건 맞는 계산이다 — 한도는 전략이 아니라
// 계좌를 지킨다. 그런데 그 결과로 연습 환경까지 잠긴다.
//
// 무엇을 하지 않는가
// ──────────────────
// **한도를 없애지 않는다. 실전 한도는 손대지 않는다.**
//
// 규칙이 실전과 다르면 그 연습은 쓸모가 없다 — 연패해도 계속 넣어도 되는
// 화면에서 익힌 습관이 실계좌에서 그대로 나온다. 그래서 연습에서도 한도는
// 돈다. 다만 **닿는 지점이 다르다.**
//
// 그리고 실전 한도가 버튼 하나로 풀리지 않게, 여기서 하는 일은 오직
// "테스트넷일 때 다른 환경변수를 먼저 본다"뿐이다. LIVE는 코드 경로가
// 예전과 완전히 같다.

export type LimitScope = 'LIVE' | 'TESTNET';

/**
 * 연습 환경의 기본 한도.
 *
 * 실전보다 넉넉하되 **끄지는 않는다.** 여기 null을 두면 한도 없는 상태로
 * 자동매매가 도는데, 그건 이 파일이 막으려는 것의 반대다.
 *
 * 숫자의 근거: 연습에서 확인해야 하는 것은 "한도가 도는가"이지 "얼마에서
 * 멈추는가"가 아니다. 전체 사이클(진입→손절→기록→잠금)을 여러 번 돌릴 수
 * 있을 만큼은 열어 둔다.
 */
export const TESTNET_LIMIT_DEFAULTS = {
  /** 주간 손실 한도 (계좌 %) — 실전 기본값은 7 */
  weeklyMaxLossPct: 40,
  /** 일일 손실 한도 (계좌 %) — 실전 기본값은 3 */
  dailyMaxLossPct: 20,
  /** 연속 손실 잠금 — 실전 기본값은 5 */
  maxConsecutiveLosses: 12,
};

/**
 * 환경변수를 스코프에 맞게 읽는 함수를 만든다.
 *
 * TESTNET이면 `TESTNET_` 접두 키를 **먼저** 본다. 없으면 공용 키로 떨어진다 —
 * 그래야 지금까지 설정해 둔 값이 그대로 살아 있고, 테스트넷만 다르게
 * 하고 싶을 때 키 하나만 추가하면 된다.
 *
 *   TESTNET_WEEKLY_MAX_LOSS_PCT=40   ← 테스트넷에서만
 *   WEEKLY_MAX_LOSS_PCT=7            ← 둘 다 (테스트넷은 위가 우선)
 *
 * LIVE면 아무것도 바꾸지 않는다. **실전 경로는 예전과 완전히 같다.**
 */
export function scopedEnv(
  env: (k: string) => string | undefined,
  scope: LimitScope,
): (k: string) => string | undefined {
  if (scope !== 'TESTNET') return env;
  return (k: string) => {
    const scoped = env(`TESTNET_${k}`);
    if (scoped != null && String(scoped).trim() !== '') return scoped;
    return env(k);
  };
}

/**
 * 스코프에 맞는 기본값. 환경변수가 아무것도 없을 때 쓴다.
 *
 * 실전 기본값은 호출부가 갖고 있으므로 여기서는 테스트넷일 때만
 * 다른 숫자를 돌려준다.
 */
export function scopedDefault(
  scope: LimitScope,
  key: keyof typeof TESTNET_LIMIT_DEFAULTS,
  liveDefault: number | null,
): number | null {
  return scope === 'TESTNET' ? TESTNET_LIMIT_DEFAULTS[key] : liveDefault;
}

/** 연결의 is_testnet → 스코프. **false일 때만 실전이다** (저장소 공통 규칙) */
export function scopeOf(testnet: boolean | null | undefined): LimitScope {
  return testnet === false ? 'LIVE' : 'TESTNET';
}
