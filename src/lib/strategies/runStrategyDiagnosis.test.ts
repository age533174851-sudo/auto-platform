import { test, assert, eq } from '../../test/harness';
import { outcomeOf } from './runStrategy';
import { resultLineOf, verdictOfOutcome, runtimeStateOf } from '../autotrade/evaluationLoop';
import { migrationGate } from '../system/migrationGate';
import { MIGRATION_MANIFEST } from '../system/migrationManifest';
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

// ══════════════════════════════════════════════════════════
// 안전장치가 막은 것을 "실행기 고장"이나 "정상"으로 적지 않는다
// ══════════════════════════════════════════════════════════
//
//   2026-11-10 운영에서 100X 예약 2개의 `last_result`가 이랬다:
//
//     실패: 실행기가 응답하지 못했습니다 — 적용되지 않은 마이그레이션이
//     2개 있습니다 (097_ten_slot_atomic_claim.sql, 098_…)
//
//   그 문장을 읽은 사람은 **워커·호스팅·결제를 의심한다.** 실제로 그
//   질문이 나왔다("Railway 결제하면 돌아가?"). 그런데 워커는 살아 있었고
//   (tick 39645), 막은 것은 마이그레이션 기록이었다. 문장이 사람을
//   엉뚱한 곳으로 보냈다.
//
//   원인은 한 곳이다: 라우트는 거부를 `blocked` 칸의 코드로 말하는데
//   `outcomeOf`는 그 칸을 읽지 않았다. **보내는 어휘와 읽는 어휘가 갈렸다.**

test('★ 097·098 미기록 → 명시적 차단이다 (실행기 고장이 아니다)', async () => {
  // 운영과 같은 상태를 가짜 DB로 만든다: 097·098만 schema_migrations에 없다.
  const PENDING = ['097_ten_slot_atomic_claim.sql', '098_ten_slot_apply_event.sql'];
  const rows = MIGRATION_MANIFEST
    .filter(m => !PENDING.includes(m.name))
    .map(m => ({ filename: m.name, checksum: m.checksum, status: 'SUCCESS', verified: true }));
  const sb: any = { from: () => ({ select: async () => ({ data: rows, error: null }) }) };

  // 판정 문장을 손으로 적지 않는다 — 실제 관문에서 받아 온다.
  const mg = await migrationGate(sb);
  eq(mg.entryAllowed, false, '097·098이 없으면 진입을 막아야 한다');
  eq(mg.pending.join(','), PENDING.join(','));

  // `scalp/route.ts`가 실제로 보내는 본문 모양 (preBase에 checklist·blockers가 없다).
  const v = outcomeOf({ httpOk: false, status: 503, body: {
    ok: false, executed: false, blocked: 'MIGRATION_PENDING', error: mg.entryReason,
  } });
  eq(v.outcome, 'BLOCKED', '안전장치가 막은 것을 실행기 고장으로 적으면 사람이 워커를 고치러 간다');

  const line = resultLineOf(v.outcome, v.summary);
  assert(line.startsWith('차단됨'), line);
  assert(!line.includes('실행기가 응답하지 못했습니다'),
    `실행기를 의심하게 만드는 문장이 남아 있다: ${line}`);
  assert(line.includes('097_ten_slot_atomic_claim.sql'),
    `무엇이 막았는지가 사라졌다: ${line}`);
  eq(verdictOfOutcome(v.outcome), 'BLOCKED');
});

test('★ 실행기가 정말 죽은 것은 여전히 FAILED다', () => {
  // 이 대조군이 없으면 위 수정이 모든 고장을 '차단됨'으로 삼킬 수 있다.
  const dead = outcomeOf({ httpOk: false, status: 500, body: { error: 'boom' } });
  eq(dead.outcome, 'FAILED');
  assert(dead.summary.includes('실행기가 응답하지 못했습니다'), dead.summary);
  // 본문이 아예 없는 경우도 같다.
  eq(outcomeOf({ httpOk: false, status: 502, body: null }).outcome, 'FAILED');
});

test('★ 손절 규칙이 없어 거부한 것을 "정상"으로 적지 않는다', () => {
  // `my-original-v1`은 이 거부를 **200 · ok:true**로 보낸다. 그래서 예전에는
  // NO_SIGNAL → WATCHING → 화면 색 **초록**이 됐다. 100배 전략이 손절 없이
  // 들어가지 않겠다고 막아 둔 상태가 '정상 감시 중'으로 보이는 것이다.
  const why = '진입 방향은 LONG로 정해졌지만 손절·익절 규칙이 아직 입력되지 않아 '
    + '주문을 만들지 않습니다 — 손절 없이 100배로 들어가지 않습니다';
  const v = outcomeOf({ httpOk: true, status: 200, body: {
    ok: true, executed: false, strategyId: 'my-original-v1',
    outcome: 'BLOCKED', blocked: 'EXIT_RULE_NOT_CONFIGURED', message: why,
  } });
  eq(v.outcome, 'BLOCKED');
  // 이유 문장이 버려지면 화면은 '차단됨'이라고만 하고 왜인지는 못 적는다.
  eq(v.summary, why);

  const now = 1_762_800_000_000;
  const st = runtimeStateOf({
    nowMs: now, enabled: true, lastRunAtMs: now - 60_000, intervalMin: 60,
    lastOutcome: verdictOfOutcome(v.outcome), lastReason: resultLineOf(v.outcome, v.summary),
    workerLastSeenMs: now - 1_000, runnerLastSeenMs: now - 1_000,
  });
  eq(st.state, 'BLOCKED');
  assert(st.tone !== 'good', `막혀 있는데 화면이 초록이면 사람이 안심한다: ${st.tone}`);
});

test('★ 나간 주문을 "차단됨"으로 덮지 않는다', () => {
  // 주문이 실제로 나갔는데 본문에 blocked가 섞여 오면, 진입 사실이 이긴다.
  for (const body of [
    { executed: true, blocked: 'KILL_SWITCH', message: '막혔습니다' },
    { entered: true, outcome: 'BLOCKED', message: '막혔습니다' },
    { orderId: '77', blocked: 'MIGRATION_PENDING', message: '막혔습니다' },
  ] as any[]) {
    eq(outcomeOf({ httpOk: true, status: 200, body }).outcome, 'ENTERED',
      '나간 주문을 장부에서 지우는 쪽이 더 위험하다');
  }
});

test('★ 거부 코드 값 자체는 요약에 싣지 않는다', () => {
  // 코드는 라우트가 주는 임의 문자열이 될 수 있다. 장부에는 사람 문장만 남긴다.
  const v = outcomeOf({ httpOk: false, status: 503, body: {
    ok: false, executed: false, blocked: 'INJECTED:secret-value',
  } });
  eq(v.outcome, 'BLOCKED');
  eq(v.summary, '안전장치가 막았습니다');
  assert(!v.summary.includes('secret-value'), v.summary);
});

test('★ blocked 칸이 없는 옛 응답은 지금까지와 똑같다', () => {
  // 이 수정이 기존 경로의 바이트를 바꾸지 않는다는 것을 고정한다.
  eq(outcomeOf({ httpOk: true, body: { ok: true, executed: false } }).outcome, 'NO_SIGNAL');
  eq(outcomeOf({ httpOk: true, body: { ok: false, message: '실행 실패' } }).outcome, 'FAILED');
  eq(outcomeOf({ httpOk: false, status: 400, body: {
    ok: false, checklist: { allowed: false }, message: '배율 확인 실패',
  } }).outcome, 'BLOCKED');
  // 빈 문자열·공백만 있는 blocked는 거부가 아니다 — 모름을 차단으로 적지 않는다.
  eq(outcomeOf({ httpOk: false, status: 500, body: { ok: false, blocked: '   ', error: 'boom' } }).outcome,
    'FAILED');
  eq(outcomeOf({ httpOk: true, body: { ok: true, executed: false, blocked: '' } }).outcome, 'NO_SIGNAL');
});

test('★ blocked 칸 없이 outcome만 적어 보내는 라우트도 알아본다', () => {
  // `my-original-v1`에는 `blocked` 코드 없이 `outcome:'BLOCKED'`만 실어
  // 보내는 자리가 있다(창 밖·시세 조회 실패). 그 모양도 거부다.
  const v = outcomeOf({ httpOk: true, status: 200, body: {
    ok: false, executed: false, outcome: 'BLOCKED', message: '판단 창이 아닙니다',
  } });
  eq(v.outcome, 'BLOCKED', '한 모양만 알아보면 나머지 자리는 계속 실패로 적힌다');
  eq(v.summary, '판단 창이 아닙니다');
});


// ══════════════════════════════════════════════════════════
// 2026-11-14 Gate 실측 — `ok: true`를 달고 오는 차단
// ══════════════════════════════════════════════════════════

test('★ 차단 응답이 ok:true로 와도 FAILED로 적지 않는다 (Gate 실측)', () => {
  // **운영에서 실제로 나온 본문이다.** daily-ladder·scalp의 차단 응답은
  // `...base`를 펼치면서 `ok: true`를 그대로 달고 409로 나간다.
  //
  // Gate TESTNET ETHUSDT 예약의 자동 평가(FLY_WORKER)가 이렇게 적혔다:
  //
  //   FAILED · 실행기가 응답하지 못했습니다 — 3개 항목이 주문을 막습니다: …
  //
  // 실행기는 응답했다. 사람은 워커와 네트워크를 보러 가고, 정작 고쳐야
  // 할 세 항목(STATE_RECONCILE · UNRESOLVED_ORDERS · LIQUIDATION_DISTANCE)은
  // 아무도 안 본다.
  const summary = '3개 항목이 주문을 막습니다: 거래소와 앱 상태 일치, 결과 미확정 주문 없음, 손절이 청산보다 먼저';
  const v = outcomeOf({ httpOk: false, status: 409, body: {
    ok: true, executed: false, blocked: 'CHECKLIST_BLOCKED', error: summary,
    checklist: { allowed: false, blockers: [
      { id: 'STATE_RECONCILE', label: '거래소와 앱 상태 일치' },
      { id: 'UNRESOLVED_ORDERS', label: '결과 미확정 주문 없음' },
      { id: 'LIQUIDATION_DISTANCE', label: '손절이 청산보다 먼저' },
    ] },
  } });
  eq(v.outcome, 'BLOCKED');
  eq(v.summary, summary);
  assert(!v.summary.includes('응답하지 못했습니다'),
    `실행기가 응답했는데 안 했다고 적으면 안 된다: ${v.summary}`);
});

test('★ blocked 코드가 없어도 점검 목록이 막았으면 차단이다', () => {
  // `blocked` 칸 하나만 보면 이 모양을 놓친다 — 그러면 또 갈린다.
  const v = outcomeOf({ httpOk: false, status: 409, body: {
    ok: true, executed: false,
    checklist: { allowed: false, blockers: [{ id: 'LEVERAGE_MATCH', label: '배율 일치' }] },
  } });
  eq(v.outcome, 'BLOCKED');
  assert(v.summary.includes('배율 일치'), v.summary);
});

test('★ 막은 항목 이름을 [object Object]로 적지 않는다', () => {
  // `preTradeChecklist`의 blockers는 객체 배열이다.
  const v = outcomeOf({ httpOk: true, body: {
    ok: true, executed: false,
    checklist: { allowed: false, blockers: [
      { id: 'STATE_RECONCILE', label: '거래소와 앱 상태 일치' },
      { id: 'UNRESOLVED_ORDERS', label: '결과 미확정 주문 없음' },
    ] },
  } });
  eq(v.outcome, 'BLOCKED');
  assert(!v.summary.includes('[object'), v.summary);
  assert(v.summary.includes('거래소와 앱 상태 일치'), v.summary);
});

test('★ 반대로 새지 않는다 — 진짜 실패는 여전히 FAILED다', () => {
  // 이 수정이 넓게 새면 **진짜 실패가 차단으로 숨는다.** 방향만 반대인 같은 고장이다.
  eq(outcomeOf({ httpOk: false, status: 502, body: { ok: false, error: 'bad gateway' } }).outcome, 'FAILED');
  eq(outcomeOf({ httpOk: false, status: 500, body: null }).outcome, 'FAILED');
  eq(outcomeOf({ httpOk: false, status: 500, body: { ok: false, code: 'ECONNREFUSED' } }).outcome,
    'FAILED', 'code 칸은 차단 증거가 아니다');
  eq(outcomeOf({ httpOk: false, status: 504, body: { ok: false, rejectCode: 'TIMEOUT' } }).outcome,
    'FAILED', 'rejectCode도 아니다');
});

}
