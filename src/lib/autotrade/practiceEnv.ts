// src/lib/autotrade/practiceEnv.ts
//
// **연습 장부에 실전 거래를 적지 않는다.**
//
// 무슨 일이 있었나
// ────────────────
// `tab:trading`은 브라우저 localStorage에 원화(KRW) 연습 장부를 갖고 있다
// (`tg_paper_balance_v1`). 그런데 TESTNET·LIVE 주문이 거래소에서 체결된
// 뒤에도 그 결과를 **같은 연습 장부에 적고 있었다**:
//
//   TradingPage  testnet/live 주문 체결 → paperBuy(...)
//   TradingPage  closePosition()        → 모드와 무관하게 closePaperPosition(...)
//   TradingPage  리버스                 → 거래소 리버스 뒤 reversePaperPosition(...)
//   TradingPage  추가 진입 · TP/SL 편집  → 모드 검사 없이 로컬 장부 수정
//
// 그래서 하나의 장부에 MOCK·TESTNET·LIVE가 섞여 쌓였다. 최상위 규칙
// (**MOCK / TESTNET / LIVE의 장부와 자산을 절대 합산하지 않는다**)에
// 정면으로 걸린다. 섞인 뒤에는 어느 줄이 연습이고 어느 줄이 실전인지
// 사후에 알 수 없다 — 각 줄에 환경이 적혀 있지 않기 때문이다.
//
// 왜 판정을 따로 두는가
// ─────────────────────
// 호출하는 자리마다 `if (tradeMode === 'mock')`을 적으면, **한 곳을 빠뜨린
// 순간 조용히 다시 섞인다.** 실제로 여섯 자리 중 다섯이 빠져 있었다.
// 그래서 "이 환경에서 로컬 장부를 건드려도 되는가"를 한 곳에서 답하고,
// 장부 자체가 그 답을 확인한 뒤에만 움직이게 한다.

/** 화면이 지금 어느 환경으로 주문하는가 */
export type TradeEnv = 'MOCK' | 'TESTNET' | 'LIVE';
export const TRADE_ENVS: TradeEnv[] = ['MOCK', 'TESTNET', 'LIVE'];

/**
 * 화면의 `tradeMode`를 환경으로 옮긴다.
 *
 * **모르는 값을 MOCK으로 읽지 않는다.** 그렇게 하면 오타 하나가
 * 실전 거래를 연습 장부에 적는 문으로 열린다. 확인하지 못한 것은
 * 통과가 아니다.
 */
export function tradeEnvOf(mode: unknown): TradeEnv | 'UNKNOWN' {
  if (mode === 'mock' || mode === 'MOCK') return 'MOCK';
  if (mode === 'testnet' || mode === 'TESTNET') return 'TESTNET';
  if (mode === 'live' || mode === 'LIVE') return 'LIVE';
  return 'UNKNOWN';
}

/**
 * 이 환경에서 브라우저 로컬 연습 장부를 바꿔도 되는가.
 *
 * **MOCK 하나만 참이다.** UNKNOWN도 거짓이다 — 모르는 환경에서 장부를
 * 건드리는 것은 확인하지 못한 것을 통과로 세는 것이다.
 */
export function mayMutatePracticeLedger(env: TradeEnv | 'UNKNOWN' | null | undefined): boolean {
  return env === 'MOCK';
}

/** 막았을 때 사람에게 보여 줄 한 줄 */
export function practiceBlockReason(env: TradeEnv | 'UNKNOWN' | null | undefined): string {
  if (env === 'TESTNET') return '테스트넷 거래는 연습 장부에 적지 않습니다 — 거래소 기록이 정본입니다';
  if (env === 'LIVE') return '실전 거래는 연습 장부에 적지 않습니다 — 거래소 기록이 정본입니다';
  return '어느 환경인지 확인하지 못해 연습 장부를 바꾸지 않았습니다';
}

/**
 * 로컬 장부 변경이 막혔을 때의 결과.
 *
 * 던지지 않고 돌려준다. 화면 한복판에서 예외가 나면 사용자는 무엇이
 * 막혔는지가 아니라 **앱이 고장 났다**고 읽는다.
 */
export interface PracticeBlocked {
  ok: false;
  /** 값이 틀린 것이 아니라 **환경 때문에 막힌 것**이다 */
  blocked: true;
  reason: string;
}

export function practiceBlocked(env: TradeEnv | 'UNKNOWN' | null | undefined): PracticeBlocked {
  return { ok: false, blocked: true, reason: practiceBlockReason(env) };
}

/**
 * 이미 쌓여 있는 것을 어떻게 볼 것인가.
 *
 * **과거 데이터는 자동으로 정리하지 않는다.** 각 줄에 환경이 적혀 있지
 * 않으므로 어느 것이 TESTNET/LIVE에서 흘러든 것인지 **사후에 알 수 없다.**
 * 추측해서 지우면 멀쩡한 연습 기록이 사라지고, 추측해서 남기면 실전
 * 거래가 연습 성과로 둔갑한다. 둘 다 조용하다.
 *
 * 그래서 지우지도 재분류하지도 않고, **성과·통계의 근거로 쓰지 않는다**는
 * 것만 못 박는다.
 */
export const LEGACY_LEDGER_STATUS = {
  status: 'LEGACY_CONTAMINATED' as const,
  canonical: false,
  /** 성과·순위·통계의 근거로 쓰지 않는다 */
  usableForStats: false,
  why: 'TESTNET·LIVE 체결이 섞여 들어갔고, 줄마다 환경이 적혀 있지 않아 '
    + '사후에 가려낼 수 없다. 추측 분류는 하지 않는다',
};
