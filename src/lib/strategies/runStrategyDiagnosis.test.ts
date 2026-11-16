import { test, assert, eq } from '../../test/harness';
import { outcomeOf, runStrategy } from './runStrategy';
import { recordEvaluation, evaluateSchedule } from '../autotrade/evaluationRunner';

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

// ── 왜 **강제 진입도** 안 했는지가 장부에 남는가 (#450) ──
//
// `scalp` 라우트는 신호가 없을 때 09:00 KST 강제 진입을 한 번 더 시도하고,
// 안 되면 그 이유를 응답에 **값으로** 싣는다. 그 자리의 주석은 이렇게 적는다:
//
//   "**왜 강제 진입도 안 했는지**가 여기 남아야 한다. 없으면
//    '신호가 없었다'와 '창 밖이었다'와 '이미 냈다'가 구분되지 않는다."
//     — src/app/api/autotrade/scalp/route.ts:294
//
// 그런데 **장부 문장을 만드는 이 함수가 그 값을 통째로 버리고 있었다.**
// 그래서 운영에서 읽히는 줄은 이것뿐이다:
//
//   진입 안 함: 정상 평가 완료 · 진입 조건 없음 · 사유코드 VOLUME_BELOW_THRESHOLD
//
// 이 줄만 보면 09:00 창이 열렸는데 안 들어간 것인지, 창 밖이라 아예 안 본
// 것인지, 오늘 이미 냈는지 **구분할 수 없다.** 라우트가 적어 보낸 증거를
// 읽는 쪽에서 버리는 모양 — `CLAUDE.md` 의 "경로가 둘인데 한쪽만 고침"이다.
test('★ NO_SIGNAL: 창 밖이어서 강제 진입을 안 했다는 것이 남는다', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false,
    reasonCode: 'VOLUME_BELOW_THRESHOLD',
    forcedEntry: { due: false, code: 'AFTER_WINDOW', tradingDay: '2026-11-13', reason: '창이 지났습니다' } } });
  eq(v.outcome, 'NO_SIGNAL');
  eq(v.summary,
    '정상 평가 완료 · 진입 조건 없음 · 사유코드 VOLUME_BELOW_THRESHOLD · 강제진입 AFTER_WINDOW');
  eq(v.forcedEntryCode, 'AFTER_WINDOW');
});

test('★ NO_SIGNAL: 오늘 이미 냈다는 것이 남는다', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false,
    reasonCode: 'NO_BREAKOUT',
    forcedEntry: { due: false, code: 'ALREADY_TODAY', tradingDay: '2026-11-13', reason: 'x' } } });
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음 · 사유코드 NO_BREAKOUT · 강제진입 ALREADY_TODAY');
  eq(v.forcedEntryCode, 'ALREADY_TODAY');
});

test('★ NO_SIGNAL: 못 읽은 것은 못 읽었다고 남는다 — 0 으로 적지 않는다', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false,
    forcedEntry: { due: false, code: 'HISTORY_UNKNOWN', tradingDay: null, reason: 'x' } } });
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음 · 강제진입 HISTORY_UNKNOWN');
  eq(v.forcedEntryCode, 'HISTORY_UNKNOWN');
});

test('★ NO_SIGNAL: 계약이 아니어서 창이 아예 안 열린 것도 남는다', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false,
    forcedEntry: { due: false, code: 'NOT_EXACT100X', tradingDay: null, reason: 'x' } } });
  eq(v.forcedEntryCode, 'NOT_EXACT100X');
});

test('NO_SIGNAL: 화이트리스트 밖 강제진입 코드는 싣지 않는다', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false,
    reasonCode: 'NO_BREAKOUT',
    forcedEntry: { due: false, code: 'INJECTED:secret', tradingDay: null, reason: 'x' } } });
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음 · 사유코드 NO_BREAKOUT');
  eq(v.forcedEntryCode, undefined);
});

test('NO_SIGNAL: `forcedEntry` 가 없는 옛 응답은 문장이 그대로다', () => {
  const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: 'NO_BREAKOUT' } });
  eq(v.summary, '정상 평가 완료 · 진입 조건 없음 · 사유코드 NO_BREAKOUT');
  eq(v.forcedEntryCode, undefined);
});

test('★ recordEvaluation 이 강제진입 코드도 장부 칸에 적는다', async () => {
  const saved: any[] = [];
  const sb = { from: () => ({ update: (p: any) => ({ eq: async () => { saved.push(p); return { error: null }; } }) }) };
  const r = await recordEvaluation(sb as any, 'sch-1',
    { outcome: 'NO_SIGNAL', summary: 'x', reasonCode: 'NO_BREAKOUT', forcedEntryCode: 'AFTER_WINDOW' });
  eq(r.saved, true);
  eq(saved[0].last_decision.forcedEntryCode, 'AFTER_WINDOW',
    '칸이 안 적히면 "09:00 창이 왜 안 열렸나"를 집계할 수 없다');
  eq(saved[0].last_decision.reasonCode, 'NO_BREAKOUT');
});

test('★ 강제진입 코드가 없으면 칸을 만들지 않는다', async () => {
  const saved: any[] = [];
  const sb = { from: () => ({ update: (p: any) => ({ eq: async () => { saved.push(p); return { error: null }; } }) }) };
  for (const fc of [undefined, null, '', '   '] as any[]) {
    saved.length = 0;
    await recordEvaluation(sb as any, 'sch-1',
      { outcome: 'NO_SIGNAL', summary: 'x', forcedEntryCode: fc });
    assert(!('forcedEntryCode' in saved[0].last_decision),
      '없는 것을 빈 값으로 채우면 "없다"와 "모른다"가 같아진다');
  }
});

// 라우트가 실제로 돌려주는 모양. 아래 세 시험이 **같은 몸체**를 쓴다 —
// 한 군데서 끊겨도 어디서 끊겼는지 바로 보이게.
const ROUTE_BODY = { ok: true, executed: false, symbol: 'BTCUSDT', mode: 'TESTNET',
  signal: null, reason: '거래량 부족', reasonCode: 'VOLUME_BELOW_THRESHOLD',
  forcedEntry: { due: false, code: 'ALREADY_TODAY', tradingDay: '2026-11-13',
    reason: '오늘 이미 냈습니다' } };

const FAKE_SB = (saved: any[]) =>
  ({ from: () => ({ update: (p: any) => ({ eq: async () => { saved.push(p); return { error: null }; } }) }) });

test('★ 배선 ①: `runStrategy` 결과에 강제진입 칸이 실려 나온다', async () => {
  // **조립부를 손으로 흉내 내지 않는다.** 진짜 함수를 부른다 — 전에
  // 이 시험을 손으로 전개해 두었더니 조립부에서 칸을 빼도 통과했다.
  const r = await runStrategy('scalp', '1',
    { symbol: 'BTCUSDT', connectionId: 'c1', mode: 'TESTNET', env: 'TESTNET' as const },
    { call: async () => ({ httpOk: true, body: ROUTE_BODY }) });
  eq(r.outcome, 'NO_SIGNAL');
  eq(r.reasonCode, 'VOLUME_BELOW_THRESHOLD');
  eq(r.forcedEntryCode, 'ALREADY_TODAY', '조립부가 칸을 떨어뜨리면 장부까지 못 간다');
});

test('★ 배선 ②: `evaluateSchedule` 기록에 강제진입 칸이 남는다', async () => {
  const rec = await evaluateSchedule(
    { id: 'sch-1', user_id: 'u1', symbol: 'BTCUSDT', mode: 'TESTNET',
      strategy_id: 'scalp', strategy_version: '1', connection_id: 'c1',
      interval_min: 60 } as any,
    { fetchImpl: (async () => ({ ok: true, status: 200,
      json: async () => ROUTE_BODY })) as any } as any);
  eq(rec.outcome, 'NO_SIGNAL');
  eq(rec.forcedEntryCode, 'ALREADY_TODAY', '러너 조립부가 칸을 떨어뜨렸다');
});

test('★ 배선 ③: 그 칸이 실제로 장부 줄과 칸에 적힌다', async () => {
  const saved: any[] = [];
  const o = outcomeOf({ httpOk: true, body: ROUTE_BODY });
  await recordEvaluation(FAKE_SB(saved) as any, 'sch-1', {
    outcome: o.outcome, summary: o.summary,
    reasonCode: o.reasonCode, forcedEntryCode: o.forcedEntryCode,
  });
  eq(saved[0].last_decision.reasonCode, 'VOLUME_BELOW_THRESHOLD');
  eq(saved[0].last_decision.forcedEntryCode, 'ALREADY_TODAY');
  eq(saved[0].last_result,
    '진입 안 함: 정상 평가 완료 · 진입 조건 없음 · 사유코드 VOLUME_BELOW_THRESHOLD · 강제진입 ALREADY_TODAY',
    '사람이 읽는 줄에도 왜 강제 진입을 안 했는지가 있어야 한다');
});

test('NO_SIGNAL: 강제 진입이 실제로 났으면 NO_SIGNAL 이 아니다', () => {
  // `due: true` 면 라우트가 그 신호로 진입을 시도하므로 여기 올 때는
  // 이미 ENTERED·BLOCKED 쪽이다. 혹시 와도 결론을 바꾸지 않는다.
  eq(outcomeOf({ httpOk: true, body: { executed: true,
    forcedEntry: { due: true, code: 'DUE', tradingDay: '2026-11-13', reason: 'x' } } }).outcome, 'ENTERED');
});

}
