// src/lib/trading/challengeDisplay.test.ts
//
// **UI가 동결된 사유를 뒤집지 못하게 고정한다.**
//
// 제일 중요한 것: 목표를 달성한 뒤 강제청산 손실로 최종 잔고가 목표 아래로
// 내려가도 **달성은 달성이다.** DB가 애써 얼려 둔 사실을 화면이 다시
// 판단하면 사용자는 달성한 챌린지를 실패로 본다.
import { test, eq, assert } from '../../test/harness';
import {
  challengeStatusView, intentTone, challengeProgressPct, challengeDaysLeft,
} from './challengeDisplay';
import { CLOSE_INTENTS } from '../engine/paperChallenge';

export function runChallengeDisplayTests() {
  // ── 동결 의미 보존 ──
  test('★ 잔고가 목표 아래여도 TARGET_REACHED는 성공으로 표시된다', () => {
    const v = challengeStatusView({ status: 'CLOSED', terminalStatus: 'TARGET_REACHED' });
    eq(v.tone, 'WIN');
    eq(v.intentLabel, '목표 달성');
    assert(!/실패/.test(v.detail), '달성인데 실패라고 적었습니다');
  });

  test('★ 표시 함수에 잔고를 넣을 자리가 없다 — 통로 자체를 없앴다', () => {
    const v = challengeStatusView({
      status: 'CLOSED', terminalStatus: 'TARGET_REACHED',
      // 잔고를 억지로 넣어도 판정이 바뀌지 않는다
      balance: 1, initialEquity: 10000, targetEquity: 12000,
    } as any);
    eq(v.tone, 'WIN');
  });

  test('최종 사유가 있으면 그것이 정본이다 (close_intent보다 우선)', () => {
    const v = challengeStatusView({
      status: 'CLOSED', closeIntent: 'CANCELLED', terminalStatus: 'TARGET_REACHED',
    });
    eq(v.intentLabel, '목표 달성');
  });

  // ── 사유의 성격 ──
  test('달성은 성공, 실패선은 실패, 만료·취소는 중립이다', () => {
    eq(intentTone('TARGET_REACHED'), 'WIN');
    eq(intentTone('FAILED'), 'LOSS');
    eq(intentTone('EXPIRED'), 'NEUTRAL');
    eq(intentTone('CANCELLED'), 'NEUTRAL');
  });

  test('★ 모르는 사유를 성공으로도 실패로도 적지 않는다', () => {
    for (const v of ['WAT', 'target_reached', 'SUCCESS']) {
      eq(intentTone(v), 'UNKNOWN');
    }
  });

  test('083의 사유 네 가지에 전부 이름이 있다', () => {
    for (const i of CLOSE_INTENTS) {
      const v = challengeStatusView({ status: 'CLOSED', terminalStatus: i });
      assert(v.intentLabel != null && !/알 수 없는/.test(v.intentLabel),
        `${i}에 이름이 없습니다`);
    }
  });

  // ── 상태 ──
  test('★ 주문은 RUNNING에서만 열린다', () => {
    eq(challengeStatusView({ status: 'RUNNING' }).ordersAllowed, true);
    for (const s of ['READY', 'CLOSING', 'CLOSED', 'WAT', '', null]) {
      eq(challengeStatusView({ status: s as any }).ordersAllowed, false);
    }
  });

  test('모르는 상태는 모른다고 적는다', () => {
    const v = challengeStatusView({ status: 'PAUSED' });
    eq(v.tone, 'UNKNOWN');
    assert(/알 수 없음/.test(v.label), '모르는 상태를 아는 것처럼 적었습니다');
  });

  test('정리 중에도 이미 정해진 사유를 보여 준다', () => {
    const v = challengeStatusView({ status: 'CLOSING', closeIntent: 'TARGET_REACHED' });
    eq(v.tone, 'WIN');
    assert(/목표 달성/.test(v.detail), '정리 중 사유가 안 보입니다');
  });

  // ── 진행률 (표시 전용) ──
  test('진행률은 0~100으로 자른다 — 성적이 아니라 막대다', () => {
    eq(challengeProgressPct({ balance: 11000, initialEquity: 10000, targetEquity: 12000 }), 50);
    eq(challengeProgressPct({ balance: 99999, initialEquity: 10000, targetEquity: 12000 }), 100);
    eq(challengeProgressPct({ balance: 1, initialEquity: 10000, targetEquity: 12000 }), 0);
  });

  test('★ 못 읽은 값이 있으면 0%가 아니라 null이다', () => {
    eq(challengeProgressPct({ balance: null, initialEquity: 10000, targetEquity: 12000 }), null);
    eq(challengeProgressPct({ balance: 11000, initialEquity: null, targetEquity: 12000 }), null);
    eq(challengeProgressPct({ balance: 11000, initialEquity: 10000, targetEquity: null }), null);
  });

  test('목표가 시작금 이하이면 진행률을 만들지 않는다 — 0으로 나누지 않는다', () => {
    eq(challengeProgressPct({ balance: 11000, initialEquity: 10000, targetEquity: 10000 }), null);
    eq(challengeProgressPct({ balance: 11000, initialEquity: 10000, targetEquity: 9000 }), null);
  });

  // ── 남은 기간 ──
  test('남은 기간을 못 읽으면 0일로 적지 않는다', () => {
    eq(challengeDaysLeft(null), null);
    eq(challengeDaysLeft(''), null);
    eq(challengeDaysLeft('not a date'), null);
  });

  test('지난 기간은 0일이다 (음수로 적지 않는다)', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    eq(challengeDaysLeft('2026-05-01T00:00:00.000Z', now), 0);
    eq(challengeDaysLeft('2026-06-11T00:00:00.000Z', now), 10);
  });
}
