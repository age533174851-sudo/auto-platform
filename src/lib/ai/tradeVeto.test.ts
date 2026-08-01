import { test, eq } from '../../test/harness';
import { judgeAiVeto, readVetoConfig, VETO_DEFAULTS, type ConsensusSnapshot } from './tradeVeto';

export function runTradeVetoTests() {
  console.log('[AI 거부권 — AI는 막을 수만 있다]');

  const NOW = 1_700_000_000_000;

  const con = (o: Partial<ConsensusSnapshot> = {}): ConsensusSnapshot => ({
    level: 'UNANIMOUS', direction: 'bearish', confidence: 90,
    responded: 3, asked: 3, asOfMs: NOW - 60_000, ...o,
  });

  // ── AI는 사지 않는다 ──────────────────────────────────────
  test('상승 합의가 아무리 강해도 진입을 만들지 않는다 — 판정은 ok(통과)일 뿐이다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW,
      consensus: con({ direction: 'bullish', confidence: 99, level: 'UNANIMOUS' }),
    });
    eq(r.status, 'ok');
    eq(r.opposes, false);
    // 화면에 "키우지 않는다"가 적혀야 한다. 안 적으면 사람이 키운다.
    eq(r.reason.includes('크기를 키우지 않습니다'), true);
  });

  test('같은 방향이면 확신도가 낮아도 막지 않는다', () => {
    const r = judgeAiVeto({
      side: 'SHORT', nowMs: NOW, consensus: con({ direction: 'bearish', confidence: 20 }),
    });
    eq(r.status, 'ok');
  });

  // ── 거부권 ────────────────────────────────────────────────
  test('강한 반대 합의는 진입을 막는다', () => {
    const r = judgeAiVeto({ side: 'LONG', nowMs: NOW, consensus: con() });
    eq(r.status, 'blocked');
    eq(r.opposes, true);
    eq(r.reason.includes('90%'), true);
  });

  test('SHORT에는 상승 합의가 반대다', () => {
    const r = judgeAiVeto({
      side: 'SHORT', nowMs: NOW, consensus: con({ direction: 'bullish' }),
    });
    eq(r.status, 'blocked');
  });

  test('반대여도 확신도가 기준 미만이면 막지 않는다 — 어중간한 반대로 전략을 덮지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ confidence: 69 }),
    }, { ...VETO_DEFAULTS, minConfidence: 70 });
    eq(r.status, 'abstain');
    eq(r.opposes, true);
  });

  test('기준과 정확히 같은 확신도는 막는다 — 경계에서 새지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ confidence: 70 }),
    }, { ...VETO_DEFAULTS, minConfidence: 70 });
    eq(r.status, 'blocked');
  });

  test('보합 합의는 어느 방향도 반대하지 않는다', () => {
    for (const side of ['LONG', 'SHORT'] as const) {
      const r = judgeAiVeto({
        side, nowMs: NOW, consensus: con({ direction: 'neutral', confidence: 95 }),
      });
      eq(r.status, 'ok');
    }
  });

  // ── 커버리지 ──────────────────────────────────────────────
  test('하나만 답했으면 합의가 아니다 — 단일 의견으로 막지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW,
      consensus: con({ responded: 1, asked: 5, level: 'UNANIMOUS' }),
    });
    eq(r.status, 'abstain');
    eq(r.reason.includes('5개에 물었습니다'), true);
  });

  test('물어본 수와 답한 수를 결과에 그대로 들고 다닌다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ responded: 2, asked: 5 }),
    });
    eq(r.coverage.responded, 2);
    eq(r.coverage.asked, 5);
    // 2/5가 만장일치여도 '5개가 동의'로 읽히면 안 된다
    eq(r.reason.includes('2/5'), true);
  });

  test('답한 수를 모르면 적용하지 않는다 — 0으로 치지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ responded: null }),
    });
    eq(r.status, 'abstain');
  });

  test('responded가 빈 문자열이어도 0으로 읽지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ responded: '' as any }),
    });
    eq(r.status, 'abstain');
    eq(r.coverage.responded, null);
  });

  // ── 갈림 · 미성립 ─────────────────────────────────────────
  test('의견이 갈리면 막지 않는다 — 갈린 것은 방향이 아니다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW,
      consensus: con({ level: 'SPLIT', direction: null, confidence: 40 }),
    });
    eq(r.status, 'abstain');
    eq(r.reason.includes('갈렸습니다'), true);
  });

  test('판단 보류(uncertain)를 보합으로 접지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW,
      consensus: con({ direction: 'uncertain', confidence: 95 }),
    });
    eq(r.status, 'abstain');
    eq(r.aiDirection, null);
  });

  // ── 신선도 ────────────────────────────────────────────────
  test('오래된 합의로 지금을 막지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW,
      consensus: con({ asOfMs: NOW - 31 * 60_000 }),
    }, { ...VETO_DEFAULTS, maxAgeMs: 30 * 60_000 });
    eq(r.status, 'abstain');
    eq(r.reason.includes('31분 전'), true);
  });

  test('허용 범위 안이면 그대로 막는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ asOfMs: NOW - 29 * 60_000 }),
    }, { ...VETO_DEFAULTS, maxAgeMs: 30 * 60_000 });
    eq(r.status, 'blocked');
  });

  test('시각이 없으면 신선도를 따지지 않는다 — 없는 것을 오래된 것으로 치지 않는다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ asOfMs: null }),
    });
    eq(r.status, 'blocked');
  });

  test('합의 시각이 미래면 시계를 의심한다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ asOfMs: NOW + 10 * 60_000 }),
    });
    eq(r.status, 'abstain');
    eq(r.reason.includes('미래'), true);
  });

  // ── 입력이 없을 때 ────────────────────────────────────────
  test('합의가 없으면 막지 않는다 — AI 장애가 매매 장애가 되면 안 된다', () => {
    const r = judgeAiVeto({ side: 'LONG', nowMs: NOW, consensus: null });
    eq(r.status, 'abstain');
  });

  test('진입 방향이 없으면 반대인지 판정할 수 없다', () => {
    const r = judgeAiVeto({ side: null, nowMs: NOW, consensus: con() });
    eq(r.status, 'abstain');
  });

  // ── strict ────────────────────────────────────────────────
  test('strict를 켜면 판단하지 못한 것이 확인 불가가 된다', () => {
    const r = judgeAiVeto({ side: 'LONG', nowMs: NOW, consensus: null },
      { ...VETO_DEFAULTS, strict: true });
    eq(r.status, 'unknown');
  });

  test('strict여도 "반대했지만 약함"은 막지 않는다 — 그건 판단을 못 한 것이 아니다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ confidence: 40 }),
    }, { ...VETO_DEFAULTS, strict: true, minConfidence: 70 });
    eq(r.status, 'abstain');
  });

  test('strict여도 동의는 그대로 통과다', () => {
    const r = judgeAiVeto({
      side: 'LONG', nowMs: NOW, consensus: con({ direction: 'bullish' }),
    }, { ...VETO_DEFAULTS, strict: true });
    eq(r.status, 'ok');
  });

  // ── 설정 읽기 ─────────────────────────────────────────────
  test('기본값은 꺼짐 — 어떤 거래를 할지 바꾸는 검사는 명시적으로 켜야 한다', () => {
    eq(readVetoConfig({}).enabled, false);
  });

  test('AI_VETO_ENABLED=1로 켜진다', () => {
    eq(readVetoConfig({ AI_VETO_ENABLED: '1' }).enabled, true);
    eq(readVetoConfig({ AI_VETO_ENABLED: 'on' }).enabled, true);
    eq(readVetoConfig({ AI_VETO_ENABLED: 'off' }).enabled, false);
  });

  test('최소 응답 수를 1로 내릴 수 없다 — 단일 의견이 전략을 덮으면 안 된다', () => {
    eq(readVetoConfig({ AI_VETO_MIN_PROVIDERS: '1' }).minResponded, 2);
    eq(readVetoConfig({ AI_VETO_MIN_PROVIDERS: '0' }).minResponded, 2);
    eq(readVetoConfig({ AI_VETO_MIN_PROVIDERS: '3' }).minResponded, 3);
  });

  test('말이 안 되는 값은 기본값으로 돌아간다', () => {
    eq(readVetoConfig({ AI_VETO_MIN_CONFIDENCE: '어어' }).minConfidence, 70);
    eq(readVetoConfig({ AI_VETO_MIN_CONFIDENCE: '120' }).minConfidence, 70);
    eq(readVetoConfig({ AI_VETO_MAX_AGE_MIN: '-5' }).maxAgeMs, 30 * 60_000);
  });

  test('AI_VETO_MIN_CONFIDENCE=0은 유효하다 — 0과 미설정은 다르다', () => {
    eq(readVetoConfig({ AI_VETO_MIN_CONFIDENCE: '0' }).minConfidence, 0);
  });


}
