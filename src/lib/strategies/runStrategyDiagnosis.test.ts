import { test, assert, eq } from '../../test/harness';
import { outcomeOf } from './runStrategy';
import { recordEvaluation } from '../autotrade/evaluationRunner';

export function runRunStrategyDiagnosisTests(): void {

// ══════════════════════════════════════════════════════════
// 사유 코드가 **구조화된 칸으로** 남는가
// ══════════════════════════════════════════════════════════
//
//   2026-10-15 운영 감사(run 38693493034, READ_ONLY=on)에서 활성
//   MAX_LEV_100X 예약 2개가 `NO_SIGNAL / reasonCode NOT_RECORDED`였다.
//   코드는 요약 **문장 안에만** 있었고, 그래서 집계가 불가능했다.
//   "NO_SIGNAL인데 왜인지 모른다"가 그 상태다.

test('★ 사유 코드를 요약 문장이 아니라 칸으로도 돌려준다', () => {
  const v = outcomeOf({ httpOk: true,
    body: { ok: true, executed: false, reasonCode: 'VOLUME_BELOW_THRESHOLD' } });
  eq(v.outcome, 'NO_SIGNAL');
  eq(v.reasonCode, 'VOLUME_BELOW_THRESHOLD',
    '문장에만 있으면 운영 감사가 집계할 수 없다');
});

test('★ 화이트리스트에 없는 값은 칸에도 싣지 않는다', () => {
  for (const bad of ['INJECTED:secret', '', 'nope', 'drop table'] as any[]) {
    const v = outcomeOf({ httpOk: true,
      body: { ok: true, executed: false, reasonCode: bad } });
    eq(v.reasonCode, undefined, `${bad}가 장부에 들어가면 경계가 사라진다`);
  }
  // 코드가 아예 없는 옛 응답도 칸을 만들지 않는다.
  eq(outcomeOf({ httpOk: true, body: { ok: true, executed: false } }).reasonCode, undefined);
});

test('★ 진입·차단·실패에는 사유 코드를 붙이지 않는다', () => {
  const entered = outcomeOf({ httpOk: true,
    body: { executed: true, reasonCode: 'NO_BREAKOUT' } });
  eq(entered.outcome, 'ENTERED'); eq(entered.reasonCode, undefined);
  const blocked = outcomeOf({ httpOk: true,
    body: { checklist: { allowed: false, blockers: ['x'] }, reasonCode: 'NO_BREAKOUT' } });
  eq(blocked.outcome, 'BLOCKED'); eq(blocked.reasonCode, undefined);
});

test('Exact100X: 주문 실패 응답에 order 객체가 있어도 ENTERED가 아니다', () => {
  // scalp 라우트는 executeOrder 실패 때도 order: {status,...}를 돌려준다.
  // executed:false가 명시됐는데 order 객체 존재만으로 ENTERED로 쓰면
  // 실제 주문 0건을 진입 성공으로 기록한다.
  for (const status of ['REJECTED', 'UNKNOWN', 'ACKED']) {
    const v = outcomeOf({ httpOk: true, body: {
      ok: true, executed: false, order: { status, clientOrderId: 'attempt-1' },
    } });
    eq(v.outcome, 'FAILED', `status=${status}: 주문 실패를 진입 성공으로 오인했다`);
  }
});

test('Exact100X: 명시적 executed:false는 orderId와 entered보다 우선한다', () => {
  const v = outcomeOf({ httpOk: true, body: {
    ok: true, executed: false, orderId: 'attempt-1', entered: true,
  } });
  eq(v.outcome, 'FAILED');
});

test('Exact100X: 실제 성공과 구형 orderId 성공 응답은 유지한다', () => {
  eq(outcomeOf({ httpOk: true, body: {
    ok: true, executed: true, order: { status: 'FILLED' },
  } }).outcome, 'ENTERED');
  eq(outcomeOf({ httpOk: true, body: {
    ok: true, orderId: 'legacy-order',
  } }).outcome, 'ENTERED');
});

test('★ recordEvaluation이 그 칸을 장부에 적는다', async () => {
  const saved: any[] = [];
  const sb = { from: () => ({ update: (p: any) => ({ eq: async () => { saved.push(p); return { error: null }; } }) }) };
  const r = await recordEvaluation(sb as any, 'sch-1',
    { outcome: 'NO_SIGNAL', summary: 'x', reasonCode: 'ATR_UNAVAILABLE' });
  eq(r.saved, true);
  eq(saved[0].last_decision.reasonCode, 'ATR_UNAVAILABLE',
    '칸이 안 적히면 감사가 다시 NOT_RECORDED를 본다');
  eq(saved[0].last_decision.outcome, 'NO_SIGNAL');
});

test('★ 코드가 없으면 칸을 만들지 않는다 (UNKNOWN으로 메우지 않는다)', async () => {
  const saved: any[] = [];
  const sb = { from: () => ({ update: (p: any) => ({ eq: async () => { saved.push(p); return { error: null }; } }) }) };
  for (const rc of [undefined, null, '', '   '] as any[]) {
    saved.length = 0;
    await recordEvaluation(sb as any, 'sch-1',
      { outcome: 'NO_SIGNAL', summary: 'x', reasonCode: rc });
    assert(!('reasonCode' in saved[0].last_decision),
      `${String(rc)}에서 칸이 만들어졌다 — "없다"와 "UNKNOWN이다"는 다른 사실이다`);
  }
});
test('NO_SIGNAL: known reason code is persisted without changing outcome', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: 'NO_BREAKOUT' } });
  eq(v.outcome, 'NO_SIGNAL');
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음 · 사유코드 NO_BREAKOUT');
});

test('NO_SIGNAL: unknown or malicious code is not persisted', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: 'INJECTED:secret' } });
  eq(v.outcome, 'NO_SIGNAL');
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음');
});

test('NO_SIGNAL: old response remains backward compatible', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false } });
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음');
});

test('NO_SIGNAL: diagnostic never overrides blocked or entered outcomes', () => {
  eq(outcomeOf({ httpOk: true, body: { executed: true, reasonCode: 'NO_BREAKOUT' } }).outcome, 'ENTERED');
  eq(outcomeOf({ httpOk: true, body: { checklist: { allowed: false }, reasonCode: 'NO_BREAKOUT' } }).outcome, 'BLOCKED');
});

}
