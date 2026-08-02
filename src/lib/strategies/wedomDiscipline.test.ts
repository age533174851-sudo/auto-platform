import { test, eq, assert } from '../../test/harness';
import {
  checkDiscipline, checkIntervention, idleHeadline,
  WEDOM_DEFAULTS, type DisciplineState,
} from './wedomDiscipline';

export function runWedomDisciplineTests() {
  console.log('[웨돔 규율 — 안 하는 것도 전략이다]');

  const now = 1_800_000_000_000;
  const HOUR = 3_600_000;

  const ok = (o: Partial<DisciplineState> = {}): DisciplineState => ({
    score: 97, tradesToday: 1, recentEntryMs: [], riskPct: 1, rewardPct: 3,
    hasOpenPosition: false, unsure: false, ...o,
  });

  test('모두 만족하면 통과', () => {
    const v = checkDiscipline(ok(), now);
    eq(v.allowed, true);
    eq(v.blocks.length, 0);
  });

  // ── 애매하면 안 한다 ────────────────────────────────────
  test('애매하다고 하면 다른 조건이 좋아도 막는다', () => {
    const v = checkDiscipline(ok({ unsure: true }), now);
    eq(v.allowed, false);
    assert(v.blocks[0].includes('애매'), v.blocks[0]);
  });

  // ── 점수 ────────────────────────────────────────────────
  test('기준 점수 미만이면 막는다', () => {
    eq(checkDiscipline(ok({ score: 94 }), now).allowed, false);
    eq(checkDiscipline(ok({ score: 95 }), now).allowed, true);
  });

  test('점수를 못 매기면 막는다', () => {
    // 판단 못 한 자리에 들어가는 것이 정확히 이 전략이 금지하는 것이다.
    const v = checkDiscipline(ok({ score: null }), now);
    eq(v.allowed, false);
    assert(v.blocks.some(b => b.includes('판단 못 한')), v.blocks.join(' '));
  });

  test('기준이 높다는 것이 핵심이다', () => {
    // 낮추면 다른 전략이 된다.
    eq(WEDOM_DEFAULTS.minScore, 95);
  });

  // ── 하루 횟수 ───────────────────────────────────────────
  test('하루 최대 횟수를 넘기면 막는다', () => {
    eq(checkDiscipline(ok({ tradesToday: 3 }), now).allowed, false);
    eq(checkDiscipline(ok({ tradesToday: 2 }), now).allowed, true);
  });

  test('오늘 0회는 문제가 아니라 정상이다', () => {
    // 포지션 없는 것을 실패로 그리면 사람은 자리를 만들어서라도 들어간다.
    const v = checkDiscipline(ok({ tradesToday: 0 }), now);
    eq(v.allowed, true);
    assert(v.notes.some(n => n.includes('정상')), v.notes.join(' '));
  });

  test('오늘 횟수를 모르면 막는다', () => {
    eq(checkDiscipline(ok({ tradesToday: null }), now).allowed, false);
  });

  // ── 회전율 ──────────────────────────────────────────────
  test('짧은 시간에 너무 많이 하면 강제 휴식', () => {
    // 롱 숏 롱 숏 반복을 막는 규칙이다.
    const recent = Array.from({ length: 10 }, (_, i) => now - i * 10 * 60_000);
    const v = checkDiscipline(ok({ recentEntryMs: recent }), now);
    eq(v.allowed, false);
    assert(v.restUntilMs != null, '휴식 종료 시각을 알려줘야 한다');
    assert(v.blocks.some(b => b.includes('휴식')), v.blocks.join(' '));
  });

  test('휴식이 끝나면 다시 된다', () => {
    const recent = Array.from({ length: 10 }, (_, i) => now - 20 * HOUR - i * 60_000);
    // 창(3시간) 밖이라 애초에 안 세어진다
    const v = checkDiscipline(ok({ recentEntryMs: recent }), now);
    eq(v.allowed, true);
    eq(v.restUntilMs, null);
  });

  test('창 안이어도 횟수가 적으면 안 막는다', () => {
    const recent = Array.from({ length: 5 }, (_, i) => now - i * 10 * 60_000);
    eq(checkDiscipline(ok({ recentEntryMs: recent }), now).allowed, true);
  });

  test('시각이 깨진 기록은 세지 않는다', () => {
    const recent = Array.from({ length: 12 }, () => NaN);
    eq(checkDiscipline(ok({ recentEntryMs: recent }), now).allowed, true);
  });

  // ── 손익비 ──────────────────────────────────────────────
  test('손익비가 낮으면 막는다', () => {
    // 1:1짜리를 여러 번 하는 것이 이 전략이 없애려는 행동이다.
    const v = checkDiscipline(ok({ riskPct: 1, rewardPct: 1.5 }), now);
    eq(v.allowed, false);
    assert(v.blocks.some(b => b.includes('손익비')), v.blocks.join(' '));
  });

  test('손익비를 계산 못 하면 막는다', () => {
    eq(checkDiscipline(ok({ riskPct: null }), now).allowed, false);
    eq(checkDiscipline(ok({ rewardPct: 0 }), now).allowed, false);
  });

  test('손익비가 충분하면 적어 준다', () => {
    const v = checkDiscipline(ok({ riskPct: 1, rewardPct: 3 }), now);
    assert(v.notes.some(n => n.includes('3.00')), v.notes.join(' '));
  });

  // ── 이미 들고 있으면 ────────────────────────────────────
  test('포지션이 있으면 새로 안 들어간다', () => {
    // 들고 있는 채로 또 들어가는 것은 계획을 중간에 바꾸는 것이다.
    const v = checkDiscipline(ok({ hasOpenPosition: true }), now);
    eq(v.allowed, false);
    assert(v.blocks.some(b => b.includes('그대로 둡니다')), v.blocks.join(' '));
  });

  // ── 여러 개면 여러 개 다 적는다 ─────────────────────────
  test('막는 이유를 하나만 적지 않는다', () => {
    // 하나 고쳤더니 또 막히는 것보다, 한 번에 다 보여주는 편이 낫다.
    const v = checkDiscipline(ok({ score: 10, tradesToday: 9, riskPct: 1, rewardPct: 1 }), now);
    assert(v.blocks.length >= 3, `${v.blocks.length}개만 적혔다`);
    assert(v.headline.includes('3'), v.headline);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(checkDiscipline({} as any, now).allowed, false);
    eq(checkDiscipline(null as any, now).allowed, false);
  });

  // ── 진입 후 개입 ────────────────────────────────────────
  test('롱에서 손절을 올리는 것은 허용', () => {
    // 위험을 줄이는 방향이다 — 본전 이동·트레일링.
    eq(checkIntervention('LONG', 100, 105).allowed, true);
  });

  test('롱에서 손절을 내리는 것은 막는다', () => {
    // 계획을 중간에 바꿔 손실을 키우는 행동이다.
    const r = checkIntervention('LONG', 100, 95);
    eq(r.allowed, false);
    assert(r.reason.includes('그대로 둡니다'), r.reason);
  });

  test('숏은 방향이 반대다', () => {
    eq(checkIntervention('SHORT', 100, 95).allowed, true);
    eq(checkIntervention('SHORT', 100, 105).allowed, false);
  });

  test('같은 값이면 그냥 통과', () => {
    eq(checkIntervention('LONG', 100, 100).allowed, true);
  });

  test('값을 모르면 안 옮긴다', () => {
    // 모르는 채로 손절을 움직이는 것이 가장 위험하다.
    eq(checkIntervention('LONG', null, 105).allowed, false);
    eq(checkIntervention('LONG', 100, null).allowed, false);
  });

  // ── 화면 문구 ───────────────────────────────────────────
  test('안 하고 있다는 것을 적극적으로 보여준다', () => {
    // 화면이 비어 있으면 사람은 고장 났다고 생각하고 다른 데서 매매한다.
    assert(idleHeadline(ok({ tradesToday: 0, score: 10 }), now).includes('기다리는'),
      idleHeadline(ok({ tradesToday: 0, score: 10 }), now));
  });

  test('휴식 중이면 언제까지인지 말한다', () => {
    const recent = Array.from({ length: 10 }, (_, i) => now - i * 60_000);
    assert(idleHeadline(ok({ recentEntryMs: recent }), now).includes('휴식'),
      idleHeadline(ok({ recentEntryMs: recent }), now));
  });

  test('통과하면 그렇게 말한다', () => {
    assert(idleHeadline(ok(), now).includes('진입할 수 있는'), idleHeadline(ok(), now));
  });
}
