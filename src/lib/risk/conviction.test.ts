// src/lib/risk/conviction.test.ts
//
// 막으려는 것:
//  1. **"확신 있는 기회에 집중"이 한 종목 몰빵으로 읽히는 것.** 등급이
//     좋다고 위험이 커지면 안 된다 — 등급은 상한 안에서 줄이는 손잡이다
//  2. 사람이 느끼는 확신이 곧 크기가 되는 것. 기분 좋은 날 큰돈이 나간다
//  3. 객관 점수를 못 구했는데 '나쁜 신호'(0점)로 읽는 것 — 모름과 다르다
//  4. 규칙이 막은 것을 실패로 적어, 사용자가 규칙을 끄고 싶어지는 것
//  5. 신호가 하나도 없던 날을 '규칙 준수 100%'로 적는 것 — 뜻 없는 숫자
import { test, assert, eq, close } from '../../test/harness';
import {
  gradeOf, riskBudgetFor, overtradingGate, patienceScore,
  GRADE_MIN, DEFAULT_GRADE_FACTOR,
} from './conviction';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

export function runConvictionTests() {
  console.log('[확신 등급 — 느낌이 크기가 되지 않는다]');

  test('객관 점수로 A/B/C가 나온다', () => {
    eq(gradeOf({ objective: 90 }).grade, 'A');
    eq(gradeOf({ objective: 60 }).grade, 'B');
    eq(gradeOf({ objective: 40 }).grade, 'C');
    eq(gradeOf({ objective: GRADE_MIN.A }).grade, 'A', '경계값은 포함이다');
    eq(gradeOf({ objective: GRADE_MIN.B }).grade, 'B');
  });

  test('주관 확신이 등급을 올리지 못한다', () => {
    // 올릴 수 있으면 기분이 곧 크기가 되고, 이 파일이 있는 이유가 사라진다.
    const r = gradeOf({ objective: 40, subjective: 100 });
    eq(r.grade, 'C');
    eq(r.divergent, true);
    assert(r.reason.includes('집중 투자 불가'), r.reason);
  });

  test('주관이 낮으면 등급이 내려간다 — 낮은 쪽이 정한다', () => {
    const r = gradeOf({ objective: 90, subjective: 50 });
    eq(r.grade, 'C', '90점 신호여도 확신이 50이면 크게 가지 않는다');
    eq(r.divergent, true);
  });

  test('주관을 안 주면 객관만으로 정한다', () => {
    eq(gradeOf({ objective: 80 }).grade, 'A');
    eq(gradeOf({ objective: 80 }).divergent, false);
  });

  test('객관 점수를 못 구하면 C다 — 0점이 아니라 모름이다', () => {
    for (const v of [null, undefined, 'abc', NaN]) {
      const r = gradeOf({ objective: v as any });
      eq(r.grade, 'C', String(v));
      eq(r.score, null, String(v));
      eq(r.tradable, false, String(v));
      assert(r.reason.includes('확인 못 한 신호'), r.reason);
    }
  });

  test('빈 입력도 C다', () => {
    eq(gradeOf(null).grade, 'C');
    eq(gradeOf({}).tradable, false);
  });

  console.log('[위험 예산 — 등급은 상한을 열지 못한다]');

  test('A급도 상한을 넘지 않는다', () => {
    // 이것이 이 함수의 유일한 존재 이유다.
    const r = riskBudgetFor(gradeOf({ objective: 100 }), { maxRiskPct: 1 });
    close(r.riskPct, 1, 1e-9);
    assert(r.riskPct <= 1, '상한을 뚫었다');
  });

  test('B급은 절반 이하다', () => {
    const r = riskBudgetFor(gradeOf({ objective: 60 }), { maxRiskPct: 1 });
    close(r.riskPct, DEFAULT_GRADE_FACTOR.B, 1e-9);
    assert(r.riskPct < 1, "'조금 애매한데 그냥 간다'가 정상 크기로 나가면 안 된다");
  });

  test('C급은 0이다', () => {
    const r = riskBudgetFor(gradeOf({ objective: 30 }), { maxRiskPct: 1 });
    eq(r.riskPct, 0);
    eq(r.paperOnly, true);
  });

  test('설정 실수로 배수가 1을 넘어도 상한을 못 뚫는다', () => {
    const r = riskBudgetFor(gradeOf({ objective: 100 }), {
      maxRiskPct: 1, gradeFactor: { A: 5 },
    });
    close(r.riskPct, 1, 1e-9, '배수 5가 상한을 다섯 배로 만들었다');
  });

  test('상한이 없으면 자금을 싣지 않는다', () => {
    for (const cap of [0, -1, null, undefined]) {
      const r = riskBudgetFor(gradeOf({ objective: 100 }), { maxRiskPct: cap as any });
      eq(r.riskPct, 0, String(cap));
      eq(r.paperOnly, true, String(cap));
    }
  });

  test('주관·객관이 어긋나면 한 번 더 줄인다', () => {
    // 느낌으로 커지는 것을 막는 자리.
    //
    // 큰 괴리는 **대개 등급 자체를 내린다**(낮은 쪽이 정하므로). 이 벌점은
    // 등급이 안 내려간 경우에 남는 마지막 한 겹이다 — 같은 B급 안에서도
    // 근거보다 느낌이 앞선 쪽이 더 작게 나간다.
    const plain = riskBudgetFor(gradeOf({ objective: 60, subjective: 60 }), { maxRiskPct: 1 });
    const gap = riskBudgetFor(gradeOf({ objective: 60, subjective: 100 }), { maxRiskPct: 1 });
    eq(plain.reason.includes('괴리'), false);
    assert(gap.riskPct < plain.riskPct, `${gap.riskPct} vs ${plain.riskPct}`);
    assert(gap.reason.includes('괴리'), gap.reason);
  });

  console.log('[과매매 차단 — 막는 것이 실패가 아니다]');

  test('하루 상한을 다 쓰면 막는다', () => {
    const r = overtradingGate({ maxEntriesPerDay: 1 }, { nowMs: NOW, entriesToday: 1 });
    eq(r.allowed, false);
    eq(r.blocked, 'DAILY_CAP');
    assert(r.reason.includes('내일'), r.reason);
  });

  test('같은 종목 재진입 냉각', () => {
    const r = overtradingGate({ sameSymbolCooldownMin: 60 },
      { nowMs: NOW, lastEntryOnSymbolMs: NOW - 10 * MIN });
    eq(r.blocked, 'SYMBOL_COOLDOWN');
    eq(r.retryAtMs, NOW - 10 * MIN + 60 * MIN);
    // 시간이 지나면 풀린다
    eq(overtradingGate({ sameSymbolCooldownMin: 60 },
      { nowMs: NOW, lastEntryOnSymbolMs: NOW - 61 * MIN }).allowed, true);
  });

  test('손절 직후에는 쉰다', () => {
    const r = overtradingGate({ afterLossCooldownMin: 30 },
      { nowMs: NOW, lastLossMs: NOW - 5 * MIN });
    eq(r.blocked, 'LOSS_COOLDOWN');
    assert(r.reason.includes('25분'), r.reason);
  });

  test('연속 손실이면 자동 중지 — 사람이 풀어야 한다', () => {
    const r = overtradingGate({ maxConsecutiveLosses: 3 },
      { nowMs: NOW, consecutiveLosses: 3 });
    eq(r.blocked, 'LOSS_STREAK');
    eq(r.retryAtMs, null, '시간이 지난다고 풀리면 안 된다');
    assert(r.reason.includes('사람이 확인'), r.reason);
  });

  test('연속 손실이 가장 먼저 걸린다', () => {
    // 여러 개가 동시에 걸리면 제일 심각한 것을 말해야 한다.
    const r = overtradingGate(
      { maxConsecutiveLosses: 3, maxEntriesPerDay: 1, afterLossCooldownMin: 30 },
      { nowMs: NOW, consecutiveLosses: 5, entriesToday: 9, lastLossMs: NOW });
    eq(r.blocked, 'LOSS_STREAK');
  });

  test('정책이 없으면 막지 않는다 — 없는 규칙을 지어내지 않는다', () => {
    eq(overtradingGate(null, { nowMs: NOW, entriesToday: 99 }).allowed, true);
    eq(overtradingGate({}, { nowMs: NOW, consecutiveLosses: 99 }).allowed, true);
  });

  test('0이나 음수는 제한 없음이다', () => {
    eq(overtradingGate({ maxEntriesPerDay: 0 }, { nowMs: NOW, entriesToday: 5 }).allowed, true);
    eq(overtradingGate({ sameSymbolCooldownMin: -1 },
      { nowMs: NOW, lastEntryOnSymbolMs: NOW }).allowed, true);
  });

  console.log('[관망 점수 — 안 들어간 날도 성과다]');

  test('A급이 없던 날의 0건은 정답이라고 적는다', () => {
    // "아무것도 안 했으니 손해 봤다"는 느낌이 과매매의 시작이다.
    const r = patienceScore({ signalsSeen: 4, aGrade: 0, bGrade: 1, cGrade: 3, entries: 0 });
    assert(r.summary.includes('관망이 정답입니다'), r.summary);
    eq(r.avoided, 3);
  });

  test('규칙이 막은 것도 피한 것으로 센다', () => {
    const r = patienceScore({ signalsSeen: 2, cGrade: 1, entries: 1, blockedByGate: 2 });
    eq(r.avoided, 3);
  });

  test('신호가 하나도 없으면 100%가 아니라 기록 없음이다', () => {
    // 아무 신호도 없던 날을 '완벽한 준수'로 적으면 그 숫자는 뜻이 없다.
    const r = patienceScore({});
    eq(r.disciplineRate, null);
    assert(r.summary.includes('기록할 것이 없습니다'), r.summary);
  });

  test('규칙대로 들어간 날은 준수율이 높다', () => {
    const r = patienceScore({ signalsSeen: 5, aGrade: 2, bGrade: 1, cGrade: 2, entries: 2 });
    assert(r.disciplineRate != null && r.disciplineRate >= 0.9, String(r.disciplineRate));
  });

  test('C급에 들어간 날은 준수율이 내려간다', () => {
    const clean = patienceScore({ signalsSeen: 5, aGrade: 1, bGrade: 0, cGrade: 4, entries: 1 });
    const dirty = patienceScore({ signalsSeen: 5, aGrade: 1, bGrade: 0, cGrade: 4, entries: 4 });
    assert((dirty.disciplineRate as number) < (clean.disciplineRate as number),
      `${dirty.disciplineRate} vs ${clean.disciplineRate}`);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(patienceScore(null).disciplineRate, null);
    eq(patienceScore({ entries: -5 }).avoided, 0);
  });
}
