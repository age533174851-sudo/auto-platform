// src/lib/engine/paperChallenge.test.ts
//
// **끝난 이유가 나중에 바뀌지 않는다는 것을, 회계를 쓰기 전에 고정한다.**
//
// 무엇을 지키는가
// ───────────────
// 이 챌린지의 가장 불쾌한 고장은 이렇게 생긴다: 유효기간 안에 목표에 닿아
// 달성이 확정됐는데, 정리(CLOSING) 중 강제청산 손실로 최종 잔고가 목표 아래로
// 내려간다. 그때 finalizer가 **마지막 잔고를 다시 보고** 사유를 판단하면
// 달성이 실패로 뒤집힌다. 사용자 입장에서는 통과했던 것이 사라진다.
//
// 그래서 사유는 **처음 정해진 순간 얼어붙는다.** 여기서는 그 규칙을 코드
// 쪽에서 고정하고, DB 쪽 절반(`terminal_status = close_intent` CHECK)은
// supabase-replay의 제약 시험이 실제 Postgres에서 확인한다.
//
// 여기서 확인하지 않는 것
// ───────────────────────
// SQL 파일의 내용은 보지 않는다. 시험은 `src`를 임시 디렉터리로 복사해서
// 돌기 때문에 `supabase/migrations`를 읽을 수 없다. **TS 목록과 SQL CHECK가
// 같은 집합인가**는 `scripts/check-paper-challenge-core.mjs`가 본다.

import { test, eq, assert } from '../../test/harness';
import {
  CHALLENGE_STATUSES,
  ACTIVE_CHALLENGE_STATUSES,
  isActiveChallengeStatus,
  CLOSE_INTENTS,
  freezeCloseIntent,
  terminalStatusFor,
  transitionAllowed,
  allowedNextStatuses,
  CASHFLOW_TYPES,
  SOURCE_EVENT_TYPES,
  cashflowSignOk,
  cashflowIdempotencyKey,
  sumCashflowAmounts,
} from './paperChallenge';

export function runPaperChallengeTests() {
  // ── 상태 ──

  test('상태는 네 가지뿐이고, 활성은 그중 끝나지 않은 셋이다', () => {
    eq(CHALLENGE_STATUSES.length, 4);
    eq(ACTIVE_CHALLENGE_STATUSES.length, 3);
    // 활성 집합은 상태 집합의 부분집합이어야 한다 — 오타 하나면 부분 유니크
    // 인덱스가 지키는 집합과 코드가 보는 집합이 갈린다.
    for (const s of ACTIVE_CHALLENGE_STATUSES) {
      assert(CHALLENGE_STATUSES.indexOf(s) >= 0, `${s}가 상태 목록에 없다`);
    }
    // **CLOSED는 활성이 아니다.** 여기 들어가면 "지난 챌린지가 새 챌린지를
    // 막는다"가 된다.
    eq(isActiveChallengeStatus('CLOSED'), false);
    eq(isActiveChallengeStatus('READY'), true);
    eq(isActiveChallengeStatus('RUNNING'), true);
    // **CLOSING도 활성이다.** 여기서 빠지면 정리 중인 챌린지 옆에 새 챌린지가
    // 생기고, 두 챌린지가 같은 사용자의 돈을 동시에 만진다.
    eq(isActiveChallengeStatus('CLOSING'), true);
  });

  test('모르는 값은 활성이 아니다 — null도 0도 아니다', () => {
    eq(isActiveChallengeStatus(null), false);
    eq(isActiveChallengeStatus(undefined), false);
    eq(isActiveChallengeStatus(''), false);
    eq(isActiveChallengeStatus('running'), false, '대소문자가 다르면 다른 값이다');
  });

  // ── 사유 고정 (TARGET_REACHED 불가역) ──

  test('사유가 없으면 제안한 사유로 정해진다', () => {
    const r = freezeCloseIntent(null, 'TARGET_REACHED');
    eq(r.intent, 'TARGET_REACHED');
    eq(r.frozen, false);
  });

  // ★ 이 시험 하나가 이 PR의 핵심 계약이다.
  test('목표 달성 뒤 실패가 도착해도 사유는 TARGET_REACHED로 남는다', () => {
    const r = freezeCloseIntent('TARGET_REACHED', 'FAILED');
    eq(r.intent, 'TARGET_REACHED', '달성이 실패로 뒤집혔다');
    eq(r.frozen, true);
  });

  test('만료·취소도 뒤에 온 사유로 덮이지 않는다', () => {
    eq(freezeCloseIntent('EXPIRED', 'FAILED').intent, 'EXPIRED');
    eq(freezeCloseIntent('CANCELLED', 'TARGET_REACHED').intent, 'CANCELLED');
    eq(freezeCloseIntent('FAILED', 'TARGET_REACHED').intent, 'FAILED');
  });

  test('같은 사유가 다시 와도 고정으로 보고한다 — 재시도는 전이가 아니다', () => {
    const r = freezeCloseIntent('EXPIRED', 'EXPIRED');
    eq(r.intent, 'EXPIRED');
    eq(r.frozen, true, '같은 값이어도 새로 정한 것이 아니다');
  });

  test('최종 상태는 고정된 사유를 그대로 옮긴 것이다', () => {
    for (const i of CLOSE_INTENTS) eq(terminalStatusFor(i), i);
    // 사유가 없으면 끝낼 수 없다. 임의의 값을 만들어 내지 않는다.
    eq(terminalStatusFor(null), null);
    eq(terminalStatusFor(undefined), null);
  });

  // ── 전이 ──

  test('갈 수 있는 길은 넷뿐이다', () => {
    assert(transitionAllowed('READY', 'RUNNING'));
    assert(transitionAllowed('READY', 'CLOSING'));
    assert(transitionAllowed('RUNNING', 'CLOSING'));
    assert(transitionAllowed('CLOSING', 'CLOSED'));
  });

  test('되돌아가는 길이 없다', () => {
    eq(transitionAllowed('RUNNING', 'READY'), false);
    eq(transitionAllowed('CLOSING', 'RUNNING'), false);
    eq(transitionAllowed('CLOSED', 'CLOSING'), false, '끝난 것을 다시 열지 않는다');
    eq(transitionAllowed('CLOSED', 'RUNNING'), false);
  });

  test('정리를 건너뛰고 끝낼 수 없다', () => {
    // CLOSING을 거치지 않으면 "사유가 이미 정해졌다"는 보장이 없다.
    // `083`의 paper_challenges_closing_needs_intent_chk와 짝을 이룬다.
    eq(transitionAllowed('READY', 'CLOSED'), false);
    eq(transitionAllowed('RUNNING', 'CLOSED'), false);
  });

  test('제자리 전이는 전이가 아니다 — 중복 사건은 멱등 키가 다룬다', () => {
    for (const s of CHALLENGE_STATUSES) {
      eq(transitionAllowed(s, s), false, `${s}→${s}가 허용됐다`);
    }
  });

  test('끝난 챌린지에서 나가는 길이 하나도 없다', () => {
    eq(allowedNextStatuses('CLOSED').length, 0);
    eq(allowedNextStatuses('READY').length, 2);
    eq(allowedNextStatuses('RUNNING').length, 1);
    eq(allowedNextStatuses('CLOSING').length, 1);
  });

  test('모르는 상태에서는 아무 데도 못 간다', () => {
    eq(allowedNextStatuses('PAUSED').length, 0);
    eq(transitionAllowed('', 'RUNNING'), false);
  });

  // ── 돈 사건 ──

  test('돈 사건은 네 종류, 원인도 네 종류다', () => {
    eq(CASHFLOW_TYPES.length, 4);
    eq(SOURCE_EVENT_TYPES.length, 4);
  });

  test('시작금은 양수여야 한다 — 0도 아니다', () => {
    eq(cashflowSignOk('INITIAL_DEPOSIT', 1000), true);
    eq(cashflowSignOk('INITIAL_DEPOSIT', 0), false);
    eq(cashflowSignOk('INITIAL_DEPOSIT', -1000), false);
  });

  // **수수료는 음수다.** 양수로 적으면 수수료를 낼수록 잔고가 는다.
  test('수수료는 음수 계약이다', () => {
    eq(cashflowSignOk('TRADING_FEE', -0.5), true);
    eq(cashflowSignOk('TRADING_FEE', 0), true, '수수료 0은 있을 수 있다');
    eq(cashflowSignOk('TRADING_FEE', 0.5), false, '수수료가 잔고를 늘렸다');
  });

  test('실현손익과 펀딩은 양쪽 부호를 다 가진다', () => {
    eq(cashflowSignOk('REALIZED_PNL', 120), true);
    eq(cashflowSignOk('REALIZED_PNL', -120), true);
    eq(cashflowSignOk('FUNDING', 3), true);
    eq(cashflowSignOk('FUNDING', -3), true);
  });

  test('모르는 종류와 읽을 수 없는 금액은 통과시키지 않는다', () => {
    eq(cashflowSignOk('WITHDRAWAL', 10), false, '목록에 없는 종류가 통과했다');
    eq(cashflowSignOk('REALIZED_PNL', NaN), false);
    eq(cashflowSignOk('REALIZED_PNL', Infinity), false);
  });

  // ★ 멱등 키에 종류가 들어 있어야 한 체결의 손익과 수수료가 둘 다 남는다.
  test('같은 체결의 실현손익과 수수료는 서로 다른 멱등 키를 갖는다', () => {
    const base = {
      challengeId: 'ch-1',
      sourceEventType: 'POSITION_CLOSE' as const,
      sourceEventId: 'pos-9',
    };
    const pnl = cashflowIdempotencyKey({ ...base, cashflowType: 'REALIZED_PNL' });
    const fee = cashflowIdempotencyKey({ ...base, cashflowType: 'TRADING_FEE' });
    assert(pnl !== fee, '한 체결의 손익과 수수료가 같은 키를 가지면 하나가 사라진다');
  });

  test('같은 사건이 두 번 오면 같은 멱등 키다', () => {
    const k = (id: string) => cashflowIdempotencyKey({
      challengeId: 'ch-1', cashflowType: 'REALIZED_PNL',
      sourceEventType: 'POSITION_CLOSE', sourceEventId: id,
    });
    eq(k('pos-9'), k('pos-9'));
    assert(k('pos-9') !== k('pos-10'), '다른 체결이 같은 키가 됐다');
  });

  test('챌린지가 다르면 같은 체결 id여도 다른 키다', () => {
    const k = (ch: string) => cashflowIdempotencyKey({
      challengeId: ch, cashflowType: 'REALIZED_PNL',
      sourceEventType: 'POSITION_CLOSE', sourceEventId: 'pos-9',
    });
    assert(k('ch-1') !== k('ch-2'));
  });

  // ── 원장 합계 ──

  test('원장 합계가 잔고를 설명한다', () => {
    const rows = [
      { amount: 1000 },      // INITIAL_DEPOSIT
      { amount: 120 },       // REALIZED_PNL (수수료 차감 전 gross)
      { amount: -0.6 },      // TRADING_FEE (음수)
      { amount: -2 },        // FUNDING
    ];
    eq(sumCashflowAmounts(rows), 1117.4);
  });

  // NUMERIC은 드라이버에 따라 문자열로 온다. 그때 문자열을 이어 붙이면
  // "1000120-0.6"이 된다 — 조용히 틀린 잔고다.
  test('문자열 NUMERIC을 이어 붙이지 않고 더한다', () => {
    eq(sumCashflowAmounts([{ amount: '1000' }, { amount: '-0.5' }] as any), 999.5);
  });

  // **UNKNOWN을 0으로 적지 않는다.**
  test('읽을 수 없는 금액이 하나라도 있으면 합계는 NaN이다 — 0이 아니다', () => {
    assert(Number.isNaN(sumCashflowAmounts([{ amount: 100 }, { amount: 'abc' }] as any)),
      '읽지 못한 줄을 0으로 세면 잔고가 맞는 것처럼 보인다');
    assert(Number.isNaN(sumCashflowAmounts([{ amount: null }] as any)));
    assert(Number.isNaN(sumCashflowAmounts([null] as any)));
  });

  test('원장이 비어 있으면 0이다', () => {
    eq(sumCashflowAmounts([]), 0);
    eq(sumCashflowAmounts(null as any), 0);
  });
}
