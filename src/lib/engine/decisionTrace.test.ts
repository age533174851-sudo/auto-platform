// src/lib/engine/decisionTrace.test.ts
//
// 실제로 찍힌 화면:
//
//   LONG 58.23 / SHORT 41.77          ← 차이 16.46점
//   "최소차이 12점보다 부족해 관망"     ← 16.46 > 12인데?
//   차단 이유: 전체 위험 한도 초과      ← 진짜 이유는 이것
//
// 신호는 통과했는데 위험엔진에서 막힌 것이다. 맨 위 문구가 "신호가
// 부족하다"고 하니 **사용자는 신호를 고치려 들고, 고쳐도 계속 막힌다.**
//
// 막으려는 것:
//  1. 같은 순간에 화면이 서로 다른 차단 이유를 말하는 것
//  2. 명목가치와 손실한도를 비교하는 것 — 단위가 다르면 조용히 틀린다
//  3. 통과 불가능한 설정을 "한도 초과"로만 알리는 것 — 포지션이 0이어도
//     막히는데 사용자는 포지션을 줄이려 한다
//  4. 0배를 '의도 배율'로 적는 것
//  5. '해당 없음'을 '미확정'으로 세는 것 — 점검 목록에 안 지워지는
//     항목이 영원히 남는다
//  6. 예약이 있다는 것과 돌고 있다는 것을 뭉개는 것
import { test, assert, eq } from '../../test/harness';
import {
  signalGate, riskGate, traceOf, configContradiction,
  leverageDisplay, scheduleDisplay,
} from './decisionTrace';

export function runDecisionTraceTests() {
  console.log('[판정 추적 — 진짜 막은 곳을 가리킨다]');

  test('신호가 통과했으면 통과라고 적는다', () => {
    // 58.23 vs 41.77 = 16.46점 차이. 최소 12점을 넘었다.
    const g = signalGate(58.23, 41.77, 12);
    eq(g.status, 'PASS');
    assert(g.detail!.includes('16.46'), g.detail);
    assert(g.detail!.includes('12'), g.detail);
  });

  test('신호는 통과했는데 위험에서 막히면 그렇게 적는다', () => {
    // 이게 이 파일이 있는 이유다.
    const t = traceOf([
      signalGate(58.23, 41.77, 12),
      riskGate(
        { notionalExposure: 54090, marginUsed: 5409, maxLossAtStop: 5409, accountRiskPct: 10 },
        { riskPerTradePct: 10, maxAccountRiskPct: 5, currentOpenRisk: 0, accountEquity: 54090 },
      ),
    ]);
    eq(t.blockedBy, 'risk', '신호가 아니라 위험이 막았다');
    assert(t.headline.includes('위험'), t.headline);
    assert(!t.headline.includes('관망'), t.headline);
    // 통과한 관문의 근거도 남아야 한다.
    assert(t.lines.some(l => l.includes('신호: 통과')), t.lines.join('|'));
    eq(t.canOrder, false);
  });

  test('신호가 못 넘었으면 신호가 원인이다', () => {
    const t = traceOf([signalGate(55, 50, 12)]);
    eq(t.blockedBy, 'signal');
    assert(t.headline.includes('신호'), t.headline);
  });

  test('둘 다 막으면 신호가 먼저다', () => {
    const t = traceOf([
      signalGate(55, 50, 12),
      { gate: 'risk', status: 'BLOCK', summary: '한도 초과' },
    ]);
    eq(t.blockedBy, 'signal');
    assert(t.lines.some(l => l.includes('위험: 차단')), '둘 다 적혀야 한다');
  });

  test('다 통과하면 주문 가능이다', () => {
    const t = traceOf([
      signalGate(58, 42, 12),
      { gate: 'risk', status: 'PASS', summary: '위험 한도 안' },
      { gate: 'runtime', status: 'PASS', summary: '실행기 정상' },
      { gate: 'execution', status: 'PASS', summary: '배율 일치' },
    ]);
    eq(t.canOrder, true);
    eq(t.blockedBy, null);
    eq(t.headline, '주문 가능');
  });

  test('확인 못 한 관문이 있으면 주문하지 않는다', () => {
    const t = traceOf([
      signalGate(58, 42, 12),
      { gate: 'risk', status: 'UNKNOWN', summary: '위험을 계산하지 못했습니다' },
    ]);
    eq(t.canOrder, false);
    eq(t.hasUnknown, true);
    assert(t.headline.includes('확인하지 못'), t.headline);
  });

  test('해당 없음은 차단이 아니다', () => {
    // 포지션이 없을 때 "손절이 청산보다 먼저인가"는 문제가 아니다.
    // 이걸 미확정으로 세면 점검 목록에 안 지워지는 항목이 남는다.
    const t = traceOf([
      signalGate(58, 42, 12),
      { gate: 'risk', status: 'PASS', summary: 'ok' },
      { gate: 'runtime', status: 'PASS', summary: 'ok' },
      { gate: 'execution', status: 'NOT_APPLICABLE', summary: '포지션이 없습니다' },
    ]);
    eq(t.canOrder, true);
    eq(t.hasUnknown, false);
    eq(t.blockedBy, null);
  });

  test('아직 판정 안 했으면 주문 가능이라고 하지 않는다', () => {
    eq(traceOf([]).canOrder, false);
    eq(traceOf(null).canOrder, false);
  });

  console.log('[판정 추적 — 통과 불가능한 설정을 지목한다]');

  test('1회 위험이 전체 상한보다 크면 그것부터 말한다', () => {
    // 자산 $54,090 · 1회 10%($5,409) · 전체 5%($2,704).
    // 열린 포지션이 0이어도 첫 주문부터 막힌다.
    const c = configContradiction({
      riskPerTradePct: 10, maxAccountRiskPct: 5, currentOpenRisk: 0, accountEquity: 54090,
    });
    eq(c.found, true);
    assert(c.message.includes('첫 주문부터 막힙니다'), c.message);
    assert(c.fix.includes('5% 이하로 낮추거나'), c.fix);
  });

  test('설정 모순이면 위험 관문이 그 사실을 앞세운다', () => {
    // "한도 초과"라고만 적으면 사용자는 포지션을 줄이려 하는데,
    // 0이어도 안 된다.
    const g = riskGate(
      { notionalExposure: 54090, marginUsed: 0, maxLossAtStop: 5409, accountRiskPct: 10 },
      { riskPerTradePct: 10, maxAccountRiskPct: 5, currentOpenRisk: 0, accountEquity: 54090 },
    );
    eq(g.status, 'BLOCK');
    assert(g.summary.includes('설정이 스스로 모순'), g.summary);
    assert(g.detail!.includes('낮추거나'), g.detail);
  });

  test('설정이 온전하면 숫자로만 설명한다', () => {
    const g = riskGate(
      { notionalExposure: 10000, marginUsed: 1000, maxLossAtStop: 3000, accountRiskPct: 3 },
      { riskPerTradePct: 1, maxAccountRiskPct: 2, currentOpenRisk: 0, accountEquity: 100000 },
    );
    eq(g.status, 'BLOCK');
    assert(!g.summary.includes('모순'), g.summary);
    assert(g.detail!.includes('손절 시 손실'), g.detail);
  });

  test('한도 안이면 통과하고 근거를 남긴다', () => {
    const g = riskGate(
      { notionalExposure: 10000, marginUsed: 1000, maxLossAtStop: 500, accountRiskPct: 0.5 },
      { riskPerTradePct: 1, maxAccountRiskPct: 2, currentOpenRisk: 300, accountEquity: 100000 },
    );
    eq(g.status, 'PASS');
    assert(g.detail!.includes('800'), g.detail);
  });

  test('한쪽을 못 읽으면 통과로 치지 않는다', () => {
    const g = riskGate(
      { notionalExposure: null, marginUsed: null, maxLossAtStop: null, accountRiskPct: null },
      { riskPerTradePct: 1, maxAccountRiskPct: 2, currentOpenRisk: 0, accountEquity: 100000 },
    );
    eq(g.status, 'UNKNOWN');
    assert(g.detail!.includes('통과가 아닙니다'), g.detail);
  });

  test('비교하는 것이 손실 금액이라고 문장에 적는다', () => {
    // "$5,409"만 보여 주면 명목가치인지 손실한도인지 알 수 없다.
    const g = riskGate(
      { notionalExposure: 99999, marginUsed: 1, maxLossAtStop: 500, accountRiskPct: 0.5 },
      { riskPerTradePct: 1, maxAccountRiskPct: 2, currentOpenRisk: 0, accountEquity: 100000 },
    );
    assert(g.detail!.includes('손절 시 손실'), g.detail);
    assert(!g.detail!.includes('99999'), '명목가치를 한도와 나란히 적지 않는다');
  });

  console.log('[판정 추적 — 0배는 배율이 아니다]');

  test('의도 배율 0은 설정 없음이다', () => {
    // 화면에 "거래소 5배 / 의도 0배"가 떴다. 0배는 배율이 아니다.
    const d = leverageDisplay(0, 5);
    eq(d.status, 'NOT_APPLICABLE');
    eq(d.text, '설정 없음');
    assert(d.note.includes('주문 계획이 없어'), d.note);
    assert(d.note.includes('5배'), d.note);
  });

  test('불일치는 차단이다', () => {
    const d = leverageDisplay(20, 5);
    eq(d.status, 'BLOCK');
    assert(d.note.includes('다른 크기로 나갑니다'), d.note);
  });

  test('거래소 배율을 못 읽으면 미확정이다', () => {
    eq(leverageDisplay(20, null).status, 'UNKNOWN');
  });

  test('같으면 통과다', () => {
    const d = leverageDisplay(13, 13);
    eq(d.status, 'PASS');
    eq(d.text, '13배');
  });

  console.log('[판정 추적 — 예약 있음과 돌고 있음은 다르다]');

  test('예약은 있는데 전부 꺼져 있으면 그렇게 적는다', () => {
    // 사용자는 "지금 도는 건지"를 알아야 한다.
    const d = scheduleDisplay({
      scheduleCount: 1, enabledCount: 0,
      lastRunAtMs: 1000 - 26 * 60_000, nowMs: 1000,
    });
    eq(d.running, false);
    assert(d.text.includes('현재 비활성'), d.text);
    assert(d.text.includes('26분 전'), d.text);
    assert(d.note.includes('예전에 켜져 있었기'), d.note);
  });

  test('켜져 있으면 켜짐 개수를 적는다', () => {
    const d = scheduleDisplay({ scheduleCount: 3, enabledCount: 2, lastRunAtMs: 0, nowMs: 30_000 });
    eq(d.running, true);
    assert(d.text.includes('켜짐 2개'), d.text);
  });

  test('켜짐 여부를 못 읽으면 꺼졌다고 하지 않는다', () => {
    const d = scheduleDisplay({ scheduleCount: 1, enabledCount: null });
    assert(d.note.includes('꺼져 있다는 뜻이 아닙니다'), d.note);
  });

  test('예약이 없으면 그렇다고 한다', () => {
    eq(scheduleDisplay({ scheduleCount: 0 }).text, '등록된 예약이 없습니다');
    eq(scheduleDisplay(null).running, false);
  });
}
