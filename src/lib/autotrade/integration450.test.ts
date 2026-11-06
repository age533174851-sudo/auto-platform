// src/lib/autotrade/integration450.test.ts
//
// **세 Draft 를 한 트리에 올려 놓고, 경계가 서로 맞는지 확인한다 (#450).**
//
//   #581  dueDiagnostics — 조회·화면이 보는 판정
//   #583  claimedAtMs    — 기록이 선점 시각을 덮지 않는다
//   #584  maxAgeIntervals — 오래된 봉을 돌려주지 않는다 (기본 꺼짐)
//
// 각 PR 의 시험은 자기 파일 안에서 초록이다. 이 파일은 **그 셋이 만나는
// 자리**만 본다 — 개별 초록이 통합 초록은 아니기 때문이다.
//
// 무엇을 하지 않는가
// ──────────────────
// **주문을 만들지 않는다.** 전략 호출은 FakeVenue 로 받고, 실제 주문
// 경로(`executeOrder`)는 한 번도 부르지 않는다. 마지막 시험이 그것을
// 값으로 확인한다. 신호를 억지로 만들지도, 안전 관문을 우회하지도 않는다.
//
// 라우트의 HTTP 한 홉은 타지 않는다
// ────────────────────────────────
// `/api/autotrade/scalp` 는 Next 라우트라 인증·DB 가 필요하다. 그래서
// 봉 → 신호 → 사유코드 → 결과 판정까지 **정본 함수들을 직접 이어서**
// 확인한다. HTTP 한 홉이 빠진 것을 숨기지 않고 적는다.

import { test, eq, assert } from '../../test/harness';
import { dueCheck, dueDiagnostics, MIN_GAP_MS } from './evaluationLoop';
import { evaluateIfDue, type ScheduleRow } from './evaluationRunner';
import { fetchVenueBars, STALE_MAX_AGE_INTERVALS } from '../markets/venueBars';
import { scalpSignal, SCALP_DEFAULTS } from '../strategies/scalpSignal';
import { diagnoseScalpSignal } from '../strategies/scalpSignalDiagnosis';
import { outcomeOf } from '../strategies/runStrategy';

const MIN = 60_000;
/** 실제 시계와 확실히 다른 시각 — 밀리초 차이로 갈리는 시험을 만들지 않는다 */
const NOW = Date.UTC(2026, 2, 10, 4, 0, 0);
const INTERVAL_MIN = 60;

/** `autotrade_schedules` 한 줄만 있는 FakeDB. CAS 를 진짜로 흉내 낸다 */
function fakeSb(row: any) {
  const state = { row, writes: [] as any[] };
  const sb = {
    from(_t: string) {
      const b: any = {
        _patch: null as any, _id: null as any,
        _guards: [] as Array<{ col: string; val: any }>,
        update(patch: any) { b._patch = patch; return b; },
        eq(col: string, val: any) {
          if (col === 'id') b._id = val; else b._guards.push({ col, val });
          return b;
        },
        is(col: string, val: any) { b._guards.push({ col, val }); return b; },
        select(_c: string) { return b; },
        _run() {
          if (b._id !== state.row.id) return { data: [], error: null };
          for (const g of b._guards) {
            const cur = state.row[g.col] ?? null;
            if (cur !== (g.val ?? null)) return { data: [], error: null };
          }
          state.writes.push({ patch: b._patch, guarded: b._guards.length > 0 });
          Object.assign(state.row, b._patch);
          return { data: [{ id: b._id }], error: null };
        },
        then(res: any, rej: any) {
          return Promise.resolve().then(() => b._run()).then(res, rej);
        },
      };
      return b;
    },
  };
  return { sb, state };
}

function row(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sch-int', user_id: 'u1', symbol: 'BTCUSDT',
    connection_id: 'conn-1', mode: 'TESTNET', enabled: true,
    last_run_at: null, interval_min: INTERVAL_MIN,
    strategy_id: 'scalp', strategy_version: '1',
    ...over,
  } as ScheduleRow;
}

/** 실행기 응답을 값으로 주는 FakeVenue. 주문 경로를 타지 않는다 */
function fakeStrategy(calls: any[], body: any, httpOk = true, status = 200) {
  return (async (url: any, init?: any) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: httpOk, status, json: async () => body };
  }) as any;
}

const deps = (calls: any[], body: any = { ok: true, executed: false, reasonCode: 'NO_BREAKOUT' }) => ({
  origin: 'https://example.invalid', adminSecret: 'x',
  fetchImpl: fakeStrategy(calls, body), source: 'FLY_WORKER' as const,
});

/** 바이낸스 klines 모양. 마지막 봉이 `lastCloseMs` 에 닫히게 놓는다 */
function klines(lastCloseMs: number, step: number, n: number, mode: 'flat' | 'breakout') {
  return Array.from({ length: n }, (_, i) => {
    const open = lastCloseMs - (n - i) * step;
    // 평평: 전부 같은 값 → 돌파 없음. 돌파: 마지막 봉만 크게 위로.
    const last = i === n - 1 && mode === 'breakout';
    const base = 100;
    const hi = last ? base * 1.5 : base + 1;
    const cl = last ? base * 1.45 : base;
    return [open, String(base), String(hi), String(base - 1), String(cl),
      last ? '9999' : '10', open + step - 1, '0', 0, '0', '0', '0'];
  });
}
const fakeFetch = (rows: any) => (async () => ({ ok: true, status: 200, json: async () => rows })) as any;

export function runIntegration450Tests() {
  console.log('[#450 통합 — #581 + #583 + #584 가 한 트리에서 서로 맞는가]');

  // ── (a) 선점 → 기록 → 다음 due 의 **정확한** 간격 ──

  test('★ (a) 차례가 아니면 아무것도 쓰지 않고 전략도 안 부른다', async () => {
    const calls: any[] = [];
    const fresh = row({ last_run_at: new Date(NOW - 10 * MIN).toISOString() });
    const { sb, state } = fakeSb(fresh);
    const r = await evaluateIfDue(sb as any, { ...fresh }, deps(calls), NOW);
    eq(r.due.due, false);
    eq(r.due.code, 'WAITING');
    eq(state.writes.length, 0, '건너뛰었는데 썼다');
    eq(calls.length, 0, '건너뛰었는데 전략을 불렀다');
  });

  test('★ (a) 선점한 회차의 다음 창은 **설정 간격 그대로** 뒤에 열린다', async () => {
    const calls: any[] = [];
    const start = row({ last_run_at: new Date(NOW - (INTERVAL_MIN + 5) * MIN).toISOString() });
    const { sb, state } = fakeSb(start);
    // 1회차: 차례다 → 선점 + 전략 1회
    const r1 = await evaluateIfDue(sb as any, { ...start }, deps(calls), NOW);
    eq(r1.due.due, true, r1.due.reason);
    eq(calls.length, 1, '전략을 한 번 불러야 한다');
    eq(state.row.last_run_at, new Date(NOW).toISOString(),
      `기록이 선점 시각이 아니다 — ${state.row.last_run_at} (#583)`);

    // 간격 1ms 전: 아직 아니다
    const before = dueCheck({ nowMs: NOW + INTERVAL_MIN * MIN - 1, enabled: true,
      lastRunAtMs: state.row.last_run_at, intervalMin: INTERVAL_MIN });
    eq(before.due, false, '간격 직전인데 열렸다');
    eq(before.code, 'WAITING');
    // 간격 정각: 열린다
    const at = dueCheck({ nowMs: NOW + INTERVAL_MIN * MIN, enabled: true,
      lastRunAtMs: state.row.last_run_at, intervalMin: INTERVAL_MIN });
    eq(at.due, true, '간격이 지났는데 안 열렸다 — 평가 소요시간이 더해진 것이다');
    eq(at.code, 'DUE');
  });

  test('★ (a) 10회차를 돌려도 밀림이 누적되지 않는다', async () => {
    const calls: any[] = [];
    let cur = row({ last_run_at: new Date(NOW - (INTERVAL_MIN + 1) * MIN).toISOString() });
    const { sb, state } = fakeSb(cur);
    let t = NOW;
    for (let i = 0; i < 10; i += 1) {
      const r = await evaluateIfDue(sb as any, { ...state.row }, deps(calls), t);
      eq(r.due.due, true, `${i + 1}회차가 안 열렸다: ${r.due.reason}`);
      eq(state.row.last_run_at, new Date(t).toISOString(), `${i + 1}회차 기록이 선점 시각이 아니다`);
      t += INTERVAL_MIN * MIN;          // 정확히 간격 뒤에 다시 온다
    }
    eq(calls.length, 10, '10회 전부 전략을 불러야 한다');
  });

  // ── (b) 조회(#581)와 실행(정본)이 같은 판정을 말한다 ──

  test('★ (b) dueDiagnostics 와 dueCheck 의 판정이 같다 — 화면과 실행이 갈리지 않는다', () => {
    const cases: Array<{ last: number | null; iv: number | null; enabled: boolean; conn: string }> = [
      { last: null, iv: 60, enabled: true, conn: 'c1' },
      { last: NOW - 10 * MIN, iv: 60, enabled: true, conn: 'c1' },
      { last: NOW - 61 * MIN, iv: 60, enabled: true, conn: 'c1' },
      { last: NOW - 30_000, iv: 60, enabled: true, conn: 'c1' },   // MIN_GAP 안
      { last: NOW - 10 * MIN, iv: null, enabled: true, conn: 'c1' }, // 기본값
      { last: NOW - 10 * MIN, iv: 60, enabled: false, conn: 'c1' },
      { last: NOW - 10 * MIN, iv: 60, enabled: true, conn: '' },     // 연결 없음
    ];
    eq(MIN_GAP_MS, 60_000);
    for (const c of cases) {
      const v = dueCheck({ nowMs: NOW, enabled: c.enabled, connectionId: c.conn,
        lastRunAtMs: c.last, intervalMin: c.iv });
      const d = dueDiagnostics({ nowMs: NOW, enabled: c.enabled, connectionId: c.conn,
        lastRunAtMs: c.last, intervalMin: c.iv });
      eq(d.due.code, v.code, `code 가 갈렸다 (${JSON.stringify(c)})`);
      eq(d.due.due, v.due, `due 가 갈렸다 (${JSON.stringify(c)})`);
      eq(d.due.leftMin, v.leftMin, `leftMin 이 갈렸다 (${JSON.stringify(c)})`);
      eq(d.due.reason, v.reason, `문구가 갈렸다 (${JSON.stringify(c)})`);
    }
  });

  test('★ (b) 기본값이 적용된 간격을 조회가 **구분해서** 말한다', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: true, connectionId: 'c1',
      lastRunAtMs: NOW - 10 * MIN, intervalMin: null });
    eq(d.intervalMinRaw, null, '설정값이 없으면 null 이다 — 0 으로 적지 않는다');
    eq(d.intervalMin, 1440, '기본값');
    eq(d.intervalMinDefaulted, true, '기본값이 적용된 사실을 말해야 한다');
    const d2 = dueDiagnostics({ nowMs: NOW, enabled: true, connectionId: 'c1',
      lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 });
    eq(d2.intervalMinDefaulted, false);
    eq(d2.intervalMinRaw, 60);
  });

  // ── (c) 오래된 봉 · 정상 봉 · 명시 과거 구간이 갈린다 (#584) ──

  test('★ (c) 정상 봉 → 신호 판정까지 간다 (NO_BREAKOUT)', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW, MIN, 40, 'flat')),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 30,
      testnet: true, nowMs: NOW, maxAgeIntervals: STALE_MAX_AGE_INTERVALS,
    } as any);
    assert(r.bars != null, `신선한 봉이 막혔다: ${r.error}`);
    const sig = scalpSignal(r.bars as any, SCALP_DEFAULTS);
    eq(sig.signal, null, '평평한 봉에서 신호가 났다');
    const diag = diagnoseScalpSignal(sig);
    eq(diag.code, 'NO_BREAKOUT', `사유코드: ${diag.code} · ${sig.reason}`);
    // 라우트가 그 모양으로 응답하면 장부에는 NO_SIGNAL + 코드가 남는다
    const v = outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: diag.code } });
    eq(v.outcome, 'NO_SIGNAL');
    eq(v.reasonCode, 'NO_BREAKOUT');
  });

  test('★ (c) 오래된 봉 → 신호 판정에 **가지도 못한다** (데이터 실패)', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN, 40, 'breakout')),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 30,
      testnet: true, nowMs: NOW, maxAgeIntervals: STALE_MAX_AGE_INTERVALS,
    } as any);
    eq(r.bars, null, '72시간 지연된 봉이 신호 판정으로 넘어갔다');
    assert(/오래/.test(String(r.error)), r.error ?? '');
    // 봉이 없으면 라우트는 502 를 준다 → 장부는 FAILED + 산문
    const v = outcomeOf({ httpOk: false, status: 502, body: { ok: false, error: r.error } });
    eq(v.outcome, 'FAILED');
    eq(v.reasonCode, undefined, '실패에 사유 코드를 붙이지 않는 불변식은 그대로다');
    assert(v.summary.includes('오래됐습니다'), v.summary);
  });

  test('★ (c) 명시 과거 구간은 오래돼도 통과한다 — 백테스트·신호 장부', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN, 40, 'flat')),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 30,
      testnet: true, nowMs: NOW, maxAgeIntervals: STALE_MAX_AGE_INTERVALS,
      startTimeMs: NOW - 80 * 60 * MIN, endTimeMs: NOW - 70 * 60 * MIN,
    } as any);
    assert(r.bars != null, `과거 구간 조회가 막혔다: ${r.error}`);
    // 그 봉으로도 신호 판정은 돈다 — '오래됐다'가 아니라 '요청대로 받았다'다
    const sig = scalpSignal(r.bars as any, SCALP_DEFAULTS);
    eq(diagnoseScalpSignal(sig).code, 'NO_BREAKOUT');
  });

  test('★ (c) 세 경우가 **서로 다른 결론**이다 — 뭉개지지 않는다', async () => {
    const mk = (lastClose: number, extra: any = {}) => fetchVenueBars({
      fetchImpl: fakeFetch(klines(lastClose, MIN, 40, 'flat')),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 30,
      testnet: true, nowMs: NOW, maxAgeIntervals: STALE_MAX_AGE_INTERVALS, ...extra,
    } as any);
    const fresh = await mk(NOW);
    const stale = await mk(NOW - 72 * 60 * MIN);
    const past = await mk(NOW - 72 * 60 * MIN, { startTimeMs: NOW - 80 * 60 * MIN });
    assert(fresh.bars != null && stale.bars == null && past.bars != null,
      `정상=${fresh.bars != null} 오래됨=${stale.bars != null} 과거구간=${past.bars != null}`);
  });

  // ── 네 상태가 서로 구별된다 (지시 3) ──

  test('★ WAITING · NO_SIGNAL · FAILED · BLOCKED 가 서로 다른 값이다', async () => {
    // due 대기
    const w = dueCheck({ nowMs: NOW, enabled: true, connectionId: 'c1',
      lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 });
    eq(w.code, 'WAITING');
    // 신호 없음
    eq(outcomeOf({ httpOk: true, body: { ok: true, executed: false, reasonCode: 'NO_BREAKOUT' } }).outcome,
      'NO_SIGNAL');
    // 데이터 실패
    eq(outcomeOf({ httpOk: false, status: 502, body: { ok: false, error: '봉이 오래됐습니다' } }).outcome,
      'FAILED');
    // 실행 차단
    eq(outcomeOf({ httpOk: true, body: { ok: false, checklist: { allowed: false, blockers: ['포지션 모드'] } } }).outcome,
      'BLOCKED');
    // 연결 없음은 BLOCKED 로 장부에 남는다 (evaluateIfDue 경로)
    const calls: any[] = [];
    const noConn = row({ connection_id: '' });
    const { sb } = fakeSb(noConn);
    const r = await evaluateIfDue(sb as any, { ...noConn }, deps(calls), NOW);
    eq(r.due.code, 'NO_CONNECTION');
    eq(calls.length, 0, '연결이 없는데 전략을 불렀다');
  });

  test('★ 이 파일은 **주문을 만들지 않는다** — 전략 주소만 부르고 거래소는 안 탄다', async () => {
    const calls: any[] = [];
    const start = row({ last_run_at: new Date(NOW - (INTERVAL_MIN + 5) * MIN).toISOString() });
    const { sb } = fakeSb(start);
    await evaluateIfDue(sb as any, { ...start }, deps(calls), NOW);
    eq(calls.length, 1);
    assert(calls[0].url.endsWith('/api/autotrade/scalp'),
      `예약의 전략 주소를 불러야 한다: ${calls[0].url}`);
    eq(calls[0].method, 'POST');
    // 거래소 주소를 부른 흔적이 없다
    for (const c of calls) {
      assert(!/binance|gateio|fapi/i.test(c.url), `거래소를 불렀다: ${c.url}`);
    }
  });
}
