// src/lib/autotrade/practiceActions.ts
//
// **연습 포지션으로 거래소에 주문을 내지 않는다.**
//
// 반대 방향 오염
// ──────────────
// 앞서 TESTNET·LIVE 체결이 브라우저 연습 장부에 적히는 것을 막았다
// (`practiceEnv.ts`). 그런데 **반대 방향 통로가 남아 있었다.**
//
// 화면의 '모의 포지션' 카드는 `getOpenPositions()`가 돌려주는 **로컬 연습
// 포지션**을 그린다. 그런데 그 카드의 종료·리버스 버튼이 이렇게 돼 있었다:
//
//   closePosition(p, …)  전역 tradeMode가 testnet/live면
//                        p.asset · p.qty로 /api/binance/futures/order 호출
//   리버스               같은 값으로 거래소 청산 + 반대방향 신규 진입
//
// 즉 **연습 장부에 있는 수량으로 실제 거래소 주문이 나갔다.** 거래소에
// 그 포지션이 있는지조차 확인하지 않는다. 실포지션은 이미 `realPos`와
// `closeReal`/`submitTpsl`이라는 별도 경로를 갖고 있는데도 그랬다.
//
// 목적지를 모드로 고르지 않는다
// ─────────────────────────────
// 문제의 뿌리는 **하나의 핸들러가 `tradeMode`를 보고 목적지를 골랐다**는
// 것이다. 그러면 입력이 어느 장부에서 왔는지와 무관하게 목적지가 정해진다.
//
// 그래서 **출처가 실행 경로를 정한다.** 연습 포지션은 연습 장부만 건드리고,
// 거래소 포지션은 거래소 경로만 탄다. 이 파일이 답하는 것은 연습 쪽뿐이고,
// **여기서 나올 수 있는 결과에 '거래소를 부른다'는 선택지가 아예 없다.**
// 그것이 이 격리의 증거다 — 부르지 않기로 한 것이 아니라 부를 수 없다.
import { mayMutatePracticeLedger, practiceBlockReason } from './practiceEnv';
import type { TradeEnv } from './practiceEnv';

/**
 * 연습 포지션에 할 수 있는 일.
 *
 * **거래소를 부르는 종류가 없다.** 새로 더하지 않는다 — 더하는 순간
 * 이 파일의 목적이 사라진다. `practiceActions.test.ts`가 그것을 막는다.
 */
export type PracticeAction =
  /** 연습 장부에서만 닫는다 */
  | { kind: 'PRACTICE_CLOSE'; asset: string; ratio: number }
  /** 연습 장부에서만 뒤집는다 */
  | { kind: 'PRACTICE_REVERSE'; asset: string }
  /** 이 환경에서는 아무것도 하지 않는다 */
  | { kind: 'BLOCKED'; reason: string };

/** 이 목록에 거래소를 부르는 것이 들어오면 격리가 깨진 것이다 */
export const PRACTICE_ACTION_KINDS = ['PRACTICE_CLOSE', 'PRACTICE_REVERSE', 'BLOCKED'] as const;

function assetOf(p: unknown): string {
  const a = (p as any)?.asset;
  return typeof a === 'string' ? a : '';
}

/**
 * 연습 포지션 종료.
 *
 * MOCK이 아니면 **아무 일도 하지 않는다.** 예전처럼 "그럼 거래소로 보내자"가
 * 아니다 — 이 포지션은 거래소에 없을 수도 있다.
 */
export function planPracticeClose(
  env: TradeEnv | 'UNKNOWN' | null | undefined,
  position: unknown,
  ratio: number,
): PracticeAction {
  if (!mayMutatePracticeLedger(env)) return { kind: 'BLOCKED', reason: practiceBlockReason(env) };
  const asset = assetOf(position);
  if (!asset) return { kind: 'BLOCKED', reason: '어느 종목인지 확인하지 못했습니다' };
  const r = Math.max(0.01, Math.min(1, Number(ratio)));
  if (!Number.isFinite(r)) return { kind: 'BLOCKED', reason: '청산 비율이 숫자가 아닙니다' };
  return { kind: 'PRACTICE_CLOSE', asset, ratio: r };
}

/** 연습 포지션 리버스. 거래소 리버스와 **같은 버튼이 아니다** */
export function planPracticeReverse(
  env: TradeEnv | 'UNKNOWN' | null | undefined,
  position: unknown,
): PracticeAction {
  if (!mayMutatePracticeLedger(env)) return { kind: 'BLOCKED', reason: practiceBlockReason(env) };
  const asset = assetOf(position);
  if (!asset) return { kind: 'BLOCKED', reason: '어느 종목인지 확인하지 못했습니다' };
  return { kind: 'PRACTICE_REVERSE', asset };
}

/**
 * 연습 카드의 버튼을 눌러도 되는가.
 *
 * MOCK이 아니면 화면은 이 카드를 **읽기 전용**으로 둔다. 버튼을 눌렀을 때
 * 조용히 아무 일도 안 하는 것보다, 누를 수 없게 두고 왜인지 적는 편이 낫다.
 */
export function practiceCardEditable(env: TradeEnv | 'UNKNOWN' | null | undefined): boolean {
  return mayMutatePracticeLedger(env);
}
