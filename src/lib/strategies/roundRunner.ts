// src/lib/strategies/roundRunner.ts
//
// **회차를 끝내는 길은 하나여야 한다.**
//
// 회차가 끝날 때 일어나야 하는 일이 셋이다: 장부에 한 줄 남기고,
// 계좌를 다음 판의 시작 잔고로 되돌리고, 회차 번호를 올린다.
//
// 이 셋이 화면 안에 흩어져 있으면 — 목표 달성으로 끝날 때와 사용자가
// '회차 종료'를 누를 때가 따로 적혀 있으면 — 언젠가 한쪽만 고쳐진다.
// 이 저장소에서 가장 자주 난 고장이 **경로가 둘인데 한쪽만 고친 것**이다.
// 그래서 여기 한 곳에 모은다. 화면은 이 함수만 부른다.

import type { StrategyType, StrategyProfile } from './profiles';
import { simSeedOf } from './profiles';
import type { RiskPresetId } from './profilePreset';
import type { RoundMode } from './roundLedger';
import {
  appendRound, loadBook, nextStartEquity, summarize,
  type LedgerBook, type LedgerSummary,
} from './roundLedger';
import {
  loadProfileRisk, completeCycle, roundStartEquityOf,
  type ProfileRiskState,
} from './profileRisk';

export interface FinishRoundInput {
  preset: RiskPresetId;
  reason: string;
  reached: boolean;
  /** 파산으로 끝났나. 목표 미달과 파산은 다른 결과다 */
  ruined: boolean;
}

export interface FinishRoundResult {
  book: LedgerBook;
  summary: LedgerSummary;
  state: ProfileRiskState;
  /** 이 회차에 새로 넣은 돈 */
  capitalInjected: number;
  /** 다음 회차가 시작할 잔고 */
  nextStart: number;
}

/**
 * 이 회차에 **새로 넣은 돈**이 얼마인가.
 *
 * 독립 회차는 매번 시작 금액만큼 새로 넣은 것이다.
 * 연속 복리는 이어받았으면 0이고, 이어받을 게 없어서(첫 판이거나 앞
 * 판이 파산해서) 다시 넣었으면 그 금액이다.
 *
 * 이걸 상태로 들고 다니지 않고 장부에서 되짚는 이유: 상태에 두면
 * 저장이 한 번 어긋났을 때 그 뒤로 영영 틀린 값이 쌓인다. 장부는
 * 이미 있는 사실이라 되짚으면 언제나 같은 답이 나온다.
 */
export function injectedFor(
  id: StrategyType, mode: RoundMode, roundStart: number,
): number {
  if (mode !== 'CONTINUOUS_COMPOUND') return roundStart;
  const rounds = loadBook(id, mode).rounds;
  if (rounds.length === 0) return roundStart;
  const prevEnd = Number(rounds[rounds.length - 1].endEquity);
  if (!Number.isFinite(prevEnd) || prevEnd <= 0) return roundStart;
  // 이어받았으면 새로 넣은 돈은 없다. 부동소수 오차는 이어받음으로 본다.
  return Math.abs(prevEnd - roundStart) < Math.max(1e-6, Math.abs(prevEnd) * 1e-9)
    ? 0
    : roundStart;
}

export function finishRound(
  p: StrategyProfile, mode: RoundMode, o: FinishRoundInput,
): FinishRoundResult {
  const id: StrategyType = p.id;
  const s = loadProfileRisk(id);
  const startEq = roundStartEquityOf(s, id);
  const capitalInjected = injectedFor(id, mode, startEq);

  const book = appendRound(id, mode, {
    preset: o.preset,
    startEquity: startEq,
    endEquity: s.equity,
    capitalInjected,
    trades: s.tradeCount,
    wins: s.winCount,
    reached: o.reached,
    ruined: o.ruined,
    reason: o.reason,
    simSeconds: s.simSeconds,
  });

  // 장부에 넣은 **뒤에** 다음 시작 잔고를 묻는다. 순서를 바꾸면 연속
  // 복리가 한 판 전의 잔고에서 다시 시작한다.
  const next = nextStartEquity(id, mode, simSeedOf(p));
  const state = completeCycle(id, o.reason, o.reached, next.equity);

  return { book, summary: summarize(book), state, capitalInjected, nextStart: next.equity };
}

/**
 * 지금 회차를 **버리고** 다시 시작한다.
 *
 * 장부에 남기지 않는다 — 돌리다 만 판을 성적으로 세면 성공률이
 * 거짓말이 된다. 남길 값이 있으면 finishRound를 부르는 것이 맞다.
 */
export function restartCurrentRound(p: StrategyProfile, mode: RoundMode): number {
  const next = nextStartEquity(p.id, mode, simSeedOf(p));
  return next.equity;
}
