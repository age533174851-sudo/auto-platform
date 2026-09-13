// src/lib/engine/paperChallengeSweep.test.ts
//
// **DB가 한 일을 보고하는 쪽이 스스로를 한 번 더 본다.**
//
// 판정의 권위는 `086`의 SQL에 있다. 이 모듈은 그 보고가 상태 머신 계약 안에
// 있는지 대조하고, 한 회차를 값으로 요약한다. 여기서 지키는 것은 둘이다.
//
//   · 모르는 동작을 조용히 넘기지 않는다 — 넘기면 새 전이가 검토 없이 들어온다
//   · 못 한 것을 0으로 적지 않는다 — "닫힌 것 0건"과 "볼 것이 없었다"는 다르다
import { test, eq, assert } from '../../test/harness';
import {
  sweepTransition, checkSweepRows, terminalMatchesFrozenIntent, summarizeSweep,
} from './paperChallengeSweep';

const ROW = (action: string) => ({
  challenge: 'c1', account: 'a1', owner: 'u1', action,
});

export function runPaperChallengeSweepTests() {
  console.log('[챌린지 생명주기 스윕 — 보고가 계약 안에 있는가]');

  // ── 전이 대조 ──

  test('STARTED는 READY → RUNNING이다', () => {
    eq(JSON.stringify(sweepTransition('STARTED')), JSON.stringify({ from: 'READY', to: 'RUNNING' }));
  });

  test('EXPIRED는 CLOSING으로 간다', () => {
    eq(sweepTransition('EXPIRED')?.to, 'CLOSING');
  });

  test('모르는 동작은 null이다 — 추측해서 통과시키지 않는다', () => {
    eq(sweepTransition('CANCELLED'), null);      // 취소는 PR4다
    eq(sweepTransition(''), null);
    eq(sweepTransition('CLOSED'), null);         // 마감은 스윕 동작이 아니다
  });

  test('모르는 동작은 받아들이지 않고 이유와 함께 남긴다', () => {
    const r = checkSweepRows([ROW('STARTED'), ROW('WAT')]);
    eq(r.accepted.length, 1);
    eq(r.rejected.length, 1);
    assert(r.rejected[0].reason.includes('모르는 스윕 동작'), r.rejected[0].reason);
  });

  test('챌린지나 계좌를 모르는 보고는 받아들이지 않는다', () => {
    const r = checkSweepRows([{ challenge: '', account: 'a1', owner: 'u1', action: 'EXPIRED' }]);
    eq(r.accepted.length, 0);
    eq(r.rejected.length, 1);
  });

  test('빈 입력·null은 빈 결과다 — 터지지 않는다', () => {
    eq(checkSweepRows(null).accepted.length, 0);
    eq(checkSweepRows(undefined as any).rejected.length, 0);
  });

  // ── 최종 상태는 동결된 사유의 복사 ──

  test('최종 상태는 동결된 사유와 같아야 한다', () => {
    eq(terminalMatchesFrozenIntent('TARGET_REACHED', 'TARGET_REACHED'), true);
    eq(terminalMatchesFrozenIntent('EXPIRED', 'EXPIRED'), true);
  });

  test('★ 달성을 실패로 바꾼 보고는 받아들이지 않는다', () => {
    // 강제청산 손실로 잔고가 목표 아래로 내려가도 사유는 그대로다(083).
    eq(terminalMatchesFrozenIntent('TARGET_REACHED', 'FAILED'), false);
  });

  test('사유가 없는데 최종 상태가 있으면 어긋난 것이다', () => {
    eq(terminalMatchesFrozenIntent(null, 'EXPIRED'), false);
    eq(terminalMatchesFrozenIntent(null, null), true);
  });

  // ── 요약 ──

  test('한 회차를 값으로 요약한다', () => {
    const s = summarizeSweep({
      sweep: checkSweepRows([ROW('STARTED'), ROW('EXPIRED'), ROW('EXPIRED')]),
      finalizes: [
        { challenge: 'c1', code: 'CLOSED', openCount: 0 },
        { challenge: 'c2', code: 'POSITIONS_OPEN', openCount: 2 },
      ],
      unknownMarks: 3,
    });
    eq(s.started, 1);
    eq(s.expired, 2);
    eq(s.closed, 1);
    eq(s.waiting, 1);
    eq(s.unknownMarks, 3);
  });

  test('★ 원장 불일치는 따로 센다 — 사고를 "정리 중"에 섞지 않는다', () => {
    const s = summarizeSweep({
      sweep: checkSweepRows([]),
      finalizes: [{ challenge: 'c1', code: 'RECONCILE_MISMATCH', openCount: 0 }],
      unknownMarks: 0,
    });
    eq(s.mismatched, 1);
    eq(s.waiting, 0);
    eq(s.closed, 0);
    assert(s.reason.includes('원장 불일치'), s.reason);
  });

  test('★ 아무것도 못 한 회차와 볼 것이 없던 회차를 구별한다', () => {
    const nothing = summarizeSweep({ sweep: checkSweepRows([]), finalizes: [], unknownMarks: 0 });
    eq(nothing.reason, '밀 것이 없었습니다');

    const blocked = summarizeSweep({
      sweep: checkSweepRows([]),
      finalizes: [{ challenge: 'c1', code: 'POSITIONS_OPEN', openCount: 1 }],
      unknownMarks: 2,
    });
    assert(blocked.reason !== '밀 것이 없었습니다', blocked.reason);
    assert(blocked.reason.includes('시세 미확인 2건'), blocked.reason);
  });

  test('열린 포지션 수를 모르면 null이다 — 0으로 적지 않는다', () => {
    const s = summarizeSweep({
      sweep: checkSweepRows([]),
      finalizes: [{ challenge: 'c1', code: 'POSITIONS_UNREADABLE', openCount: null }],
      unknownMarks: 0,
    });
    // 읽지 못한 것은 정리 중으로도 마감으로도 세지 않는다.
    eq(s.waiting, 0);
    eq(s.closed, 0);
  });
}
