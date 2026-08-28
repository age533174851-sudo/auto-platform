// src/lib/ledger/ingestPipeline.test.ts
//
// **원장 수집이 실제로 돌고, 돈 만큼만 손익을 말하는가.**
//
// 이 파일이 못 박는 사고
// ──────────────────────
// 확정된 root cause부터: 지갑은 `covered_to >= now`를 요구했다. 수집은
// 15분마다 돈다. 그래서 **연결이 정상이고 매 회차 성공해도 오늘 손익은
// 영원히 확인 불가**였다. 판정식이 원리적으로 만족될 수 없었다.
//
// 그리고 그 반대편 — 수집 증거가 없는데 0을 적는 것 — 은 더 나쁘다.
// 두 방향을 다 여기서 막는다.
import { test, eq, assert, close } from '../../test/harness';
import { ingestTargetsOf } from './ingestTargets';
import { ingestStatePatchOf } from './ingestState';
import { ledgerWindowOf, LEDGER_LAG_STALE_MS } from './coverageWindow';
import { ingestHealthOf, sanitizeReason } from './ingestHealth';
import { nextIngestFrom, incomeToEvents, OVERLAP_MS } from './incomeIngest';
import { idempotencyKeyOf } from './ledgerEvent';

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY_START = Date.parse('2026-08-28T00:00:00Z');
const NOW = DAY_START + 10 * HOUR;

export function runIngestPipelineTests() {
  console.log('\n🧪 원장 수집 파이프라인 (돈 만큼만 말한다)');

  // ══ ① 새 연결이 자동으로 수집 대상이 된다 ══
  test('새 TESTNET 연결은 등록 없이 수집 대상이 된다', () => {
    const t = ingestTargetsOf([
      { id: 'c-new', exchange_id: 'binance', is_testnet: true, is_active: true },
    ])!;
    eq(t.length, 1);
    eq(t[0].connectionId, 'c-new');
    eq(t[0].env, 'TESTNET');
    eq(t[0].supported, true);
  });

  test('꺼 둔 연결은 수집하지 않는다 — 다만 is_active가 null이면 끈 것이 아니다', () => {
    const t = ingestTargetsOf([
      { id: 'off', exchange_id: 'binance', is_testnet: true, is_active: false },
      { id: 'legacy', exchange_id: 'binance', is_testnet: true, is_active: null },
    ])!;
    eq(t.map(x => x.connectionId).join(','), 'legacy');
  });

  test('연결 목록을 못 읽으면 null이다 — 빈 배열로 바꾸면 조용히 통과한다', () => {
    eq(ingestTargetsOf(null), null);
    eq(ingestTargetsOf(undefined), null);
  });

  // ══ ② 거래소별로 다른 경로 ══
  test('binance 연결은 binance 경로 · gate 연결은 gate 경로', () => {
    const t = ingestTargetsOf([
      { id: 'b', exchange_id: 'binance', is_testnet: true, is_active: true },
      { id: 'g', exchange_id: 'gate', is_testnet: true, is_active: true },
    ])!;
    eq(t.find(x => x.connectionId === 'b')!.route, 'binance');
    eq(t.find(x => x.connectionId === 'g')!.route, 'gate');
  });

  test('모르는 거래소는 조용히 건너뛰지 않고 지원하지 않는다고 말한다', () => {
    const t = ingestTargetsOf([{ id: 'x', exchange_id: 'bybit', is_active: true }])!;
    eq(t[0].supported, false);
    eq(t[0].route, 'UNSUPPORTED');
    assert(t[0].reason.includes('지원하지 않습니다'), '이유를 남긴다');
  });

  // ══ ③ LIVE와 TESTNET을 섞지 않는다 ══
  test('is_testnet === false만 실전이다 — 모르면 테스트넷', () => {
    const t = ingestTargetsOf([
      { id: 'live', exchange_id: 'binance', is_testnet: false, is_active: true },
      { id: 'test', exchange_id: 'binance', is_testnet: true, is_active: true },
      { id: 'unk', exchange_id: 'binance', is_testnet: null, is_active: true },
    ])!;
    eq(t.find(x => x.connectionId === 'live')!.env, 'LIVE');
    eq(t.find(x => x.connectionId === 'test')!.env, 'TESTNET');
    // **모르는 것을 LIVE로 승격하지 않는다.**
    eq(t.find(x => x.connectionId === 'unk')!.env, 'TESTNET');
  });

  // ══ ④ 성공 + 0건도 coverage 증거다 ══
  test('성공했는데 이벤트가 0건이어도 덮인 지점이 전진한다', () => {
    const p = ingestStatePatchOf({
      userId: 'u', connectionId: 'c', env: 'TESTNET',
      coverage: { fromMs: NOW - 2 * HOUR, toMs: NOW - HOUR },
      planFromMs: NOW - HOUR - OVERLAP_MS,
      readOk: true, eventsFromMs: null, eventsToMs: null,
      written: 0, failed: 0, nowMs: NOW,
    });
    eq(p.advanced, true);
    eq(p.row.covered_to, new Date(NOW).toISOString());
    eq(p.row.last_error, null);
    assert(p.reason.includes('새 이벤트가 없습니다'), '무슨 뜻인지 남긴다');
  });

  test('거래가 없던 날에도 "한 번도 읽지 않음"이 되지 않는다', () => {
    // 0건 회차를 세 번 돌려도 covered_to는 계속 전진한다.
    let cov = { fromMs: NOW - 5 * HOUR, toMs: NOW - 3 * HOUR };
    for (const t of [NOW - 2 * HOUR, NOW - HOUR, NOW]) {
      const p = ingestStatePatchOf({
        userId: 'u', connectionId: 'c', env: 'TESTNET', coverage: cov,
        planFromMs: t - OVERLAP_MS, readOk: true, written: 0, failed: 0, nowMs: t,
      });
      cov = { fromMs: Date.parse(p.row.covered_from), toMs: Date.parse(p.row.covered_to) };
    }
    eq(cov.toMs, NOW);
  });

  // ══ ⑤ 실패는 절대 전진시키지 않는다 ══
  test('거래소 조회 실패면 덮인 지점을 옮기지 않는다', () => {
    const p = ingestStatePatchOf({
      userId: 'u', connectionId: 'c', env: 'TESTNET',
      coverage: { fromMs: NOW - 5 * HOUR, toMs: NOW - HOUR },
      planFromMs: NOW - HOUR, readOk: false, readError: 'HTTP 500', nowMs: NOW,
    });
    eq(p.advanced, false);
    // **덮인 구간을 아예 건드리지 않는다** — 줄이지도 늘리지도 않는다.
    eq(p.row.covered_to, undefined);
    eq(p.row.covered_from, undefined);
    assert(String(p.row.last_error).includes('HTTP 500'), '사유는 남는다');
    // 시도했다는 사실은 남아야 "한 번도 안 돌았다"와 구별된다.
    eq(p.row.last_run_at, new Date(NOW).toISOString());
  });

  test('장부 쓰기가 한 건이라도 실패하면 전진하지 않는다', () => {
    const p = ingestStatePatchOf({
      userId: 'u', connectionId: 'c', env: 'TESTNET',
      coverage: { fromMs: NOW - 5 * HOUR, toMs: NOW - HOUR },
      planFromMs: NOW - HOUR, readOk: true,
      eventsFromMs: NOW - 30 * MIN, eventsToMs: NOW - 10 * MIN,
      written: 3, failed: 1, nowMs: NOW,
    });
    eq(p.advanced, false);
    eq(p.row.covered_to, new Date(NOW - HOUR).toISOString());   // 그대로
    assert(String(p.row.last_error).includes('1건'), '몇 건인지 남는다');
  });

  test('시작 지점은 앞으로만 넓힌다 — 이미 읽은 옛 구간을 되돌리지 않는다', () => {
    const p = ingestStatePatchOf({
      userId: 'u', connectionId: 'c', env: 'TESTNET',
      coverage: { fromMs: NOW - 7 * 24 * HOUR, toMs: NOW - HOUR },
      planFromMs: NOW - HOUR - OVERLAP_MS, readOk: true, written: 0, failed: 0, nowMs: NOW,
    });
    eq(p.row.covered_from, new Date(NOW - 7 * 24 * HOUR).toISOString());
  });

  // ══ ⑥ 재시작 / 겹침 ══
  test('워커가 재시작해도 마지막 지점에서 겹쳐서 다시 읽는다', () => {
    const plan = nextIngestFrom({ coverage: { fromMs: NOW - 3 * HOUR, toMs: NOW - HOUR }, nowMs: NOW });
    // **겹침이 없으면 경계에 걸친 사건이 통째로 빠진다.**
    eq(plan.fromMs, NOW - HOUR - OVERLAP_MS);
    assert(plan.fromMs < NOW - HOUR, '반드시 지난 지점보다 앞에서 시작한다');
  });

  test('처음이면 7일 전부터 — 무한히 거슬러 올라가지 않는다', () => {
    const plan = nextIngestFrom({ coverage: null, nowMs: NOW });
    eq(plan.fromMs, NOW - 7 * 24 * HOUR);
  });

  // ══ ⑦ 겹쳐 읽어도 중복되지 않는다 ══
  test('같은 사건을 두 번 읽어도 열쇠가 같다 — 합계가 두 배가 되지 않는다', () => {
    const rows = [{ incomeType: 'COMMISSION', income: -0.42, time: NOW - 20 * MIN,
      symbol: 'BTCUSDT', tranId: '99887766' }];
    const a = incomeToEvents({ rows, userId: 'u', env: 'TESTNET', connectionId: 'c', exchange: 'binance' });
    const b = incomeToEvents({ rows, userId: 'u', env: 'TESTNET', connectionId: 'c', exchange: 'binance' });
    eq(a.events.length, 1); eq(b.events.length, 1);
    eq(idempotencyKeyOf(a.events[0] as any), idempotencyKeyOf(b.events[0] as any));
  });

  test('연결이 다르면 같은 거래소 사건이라도 열쇠가 다르다', () => {
    const row = { incomeType: 'COMMISSION', income: -0.42, time: NOW, symbol: 'BTCUSDT', tranId: '1' };
    const a = incomeToEvents({ rows: [row], userId: 'u', env: 'TESTNET', connectionId: 'A', exchange: 'binance' });
    const b = incomeToEvents({ rows: [row], userId: 'u', env: 'TESTNET', connectionId: 'B', exchange: 'binance' });
    assert(idempotencyKeyOf(a.events[0] as any) !== idempotencyKeyOf(b.events[0] as any),
      'connection A의 사건이 B의 장부에 섞이면 안 된다');
  });

  test('LIVE와 TESTNET은 같은 사건이라도 열쇠가 다르다', () => {
    const row = { incomeType: 'COMMISSION', income: -0.42, time: NOW, symbol: 'BTCUSDT', tranId: '1' };
    const l = incomeToEvents({ rows: [row], userId: 'u', env: 'LIVE', connectionId: 'c', exchange: 'binance' });
    const t = incomeToEvents({ rows: [row], userId: 'u', env: 'TESTNET', connectionId: 'c', exchange: 'binance' });
    assert(idempotencyKeyOf(l.events[0] as any) !== idempotencyKeyOf(t.events[0] as any),
      '실전과 테스트넷의 장부는 절대 섞이지 않는다');
  });

  // ══ ⑧ **root cause** — 판정이 원리적으로 만족 불가였다 ══
  const ONE = (toMs: number, fromMs = DAY_START - HOUR) =>
    [{ connectionId: 'c1', fromMs, toMs }];

  test('수집이 15분 전에 성공했으면 오늘 손익을 만들 수 있다', () => {
    // **예전 판정은 여기서 언제나 불완전이었다** — covered_to < now이므로.
    const w = ledgerWindowOf({
      expected: ['c1'], states: ONE(NOW - 15 * MIN), dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.code, 'COVERED');
    eq(w.usable, true);
    eq(w.asOfMs, NOW - 15 * MIN);
    eq(w.stale, false);
    assert(w.reason.includes('15분 전 기준'), `언제 기준인지 말한다 — ${w.reason}`);
  });

  test('많이 뒤처졌으면 값은 내되 부분 자료임을 명시한다', () => {
    const w = ledgerWindowOf({
      expected: ['c1'], states: ONE(NOW - 3 * HOUR), dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.usable, true);
    eq(w.stale, true);
    assert(w.reason.includes('아직 수집되지 않았습니다'), '덮이지 않은 구간이 있다고 말한다');
  });

  test('덮인 지점을 지금보다 앞으로 끌어올리지 않는다', () => {
    // 시계가 어긋나 covered_to가 미래로 적힌 경우.
    const w = ledgerWindowOf({
      expected: ['c1'], states: ONE(NOW + HOUR), dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.asOfMs, NOW);
  });

  test('여러 연결이면 가장 뒤처진 연결에 맞춘다', () => {
    const w = ledgerWindowOf({
      expected: ['c1', 'c2'],
      states: [
        { connectionId: 'c1', fromMs: DAY_START - HOUR, toMs: NOW - 5 * MIN },
        { connectionId: 'c2', fromMs: DAY_START - HOUR, toMs: NOW - 2 * HOUR },
      ],
      dayStartMs: DAY_START, nowMs: NOW,
    });
    // **빠른 쪽에 맞추면 느린 연결의 수수료가 빠진 채 확정된다.**
    eq(w.asOfMs, NOW - 2 * HOUR);
  });

  // ══ ⑨ 증거가 없으면 0으로 바꾸지 않는다 ══
  test('수집 상태 행이 없는 연결이 있으면 손익을 만들지 않는다', () => {
    const w = ledgerWindowOf({
      expected: ['c1', 'c2'], states: ONE(NOW - 10 * MIN), dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.code, 'MISSING_CONNECTIONS');
    eq(w.usable, false);
    eq(w.asOfMs, null);          // **0이 아니다**
    eq(w.missing.join(','), 'c2');
  });

  test('행은 있는데 한 번도 성공하지 못했으면 없는 것과 같다', () => {
    const w = ledgerWindowOf({
      expected: ['c1'],
      states: [{ connectionId: 'c1', fromMs: null, toMs: null }],
      dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.code, 'MISSING_CONNECTIONS');
    eq(w.usable, false);
  });

  test('연결 목록을 못 읽었으면 손익을 만들지 않는다', () => {
    const w = ledgerWindowOf({ expected: null, states: [], dayStartMs: DAY_START, nowMs: NOW });
    eq(w.code, 'CONNECTIONS_UNKNOWN');
    eq(w.usable, false);
  });

  test('수집 상태를 못 읽었으면 손익을 만들지 않는다', () => {
    const w = ledgerWindowOf({ expected: ['c1'], states: null, dayStartMs: DAY_START, nowMs: NOW });
    eq(w.code, 'INGEST_UNKNOWN');
    eq(w.usable, false);
    assert(w.reason.includes('0이라는 뜻도 아닙니다'), '0으로 읽지 말라고 적어 둔다');
  });

  test('오늘 앞부분이 안 덮였으면 오늘 손익을 만들지 않는다', () => {
    const w = ledgerWindowOf({
      expected: ['c1'],
      states: [{ connectionId: 'c1', fromMs: DAY_START + 2 * HOUR, toMs: NOW }],
      dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.code, 'BEFORE_DAY_START');
    eq(w.usable, false);
  });

  test('오늘 구간이 한 뼘도 안 덮였으면 만들지 않는다', () => {
    const w = ledgerWindowOf({
      expected: ['c1'], states: ONE(DAY_START - 30 * MIN, DAY_START - 5 * HOUR),
      dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.code, 'NOT_COVERED_TODAY');
    eq(w.usable, false);
  });

  test('활성 연결이 없으면 완전하다고 말하지 않는다', () => {
    const w = ledgerWindowOf({ expected: [], states: [], dayStartMs: DAY_START, nowMs: NOW });
    eq(w.code, 'NO_CONNECTION');
    eq(w.usable, false);
  });

  test('비활성이 된 옛 연결은 오늘 손익을 막지 않는다', () => {
    const w = ledgerWindowOf({
      expected: ['c1'],
      states: [
        { connectionId: 'c1', fromMs: DAY_START - HOUR, toMs: NOW - 5 * MIN },
        { connectionId: 'old', fromMs: DAY_START - 99 * HOUR, toMs: DAY_START - 90 * HOUR },
      ],
      dayStartMs: DAY_START, nowMs: NOW,
    });
    eq(w.usable, true);
    eq(w.inactive.join(','), 'old');
  });

  // ══ ⑩ 운영 화면 ══
  test('한 번도 성공하지 못한 연결을 정상으로 적지 않는다', () => {
    const targets = ingestTargetsOf([
      { id: 'c1', exchange_id: 'binance', is_testnet: true, is_active: true },
    ])!;
    const h = ingestHealthOf({ targets, states: [], nowMs: NOW });
    eq(h.ok, false);
    eq(h.rows[0].code, 'NEVER_COVERED');
    eq(h.rows[0].lastSuccessAt, null);
  });

  test('마지막 성공 시각은 covered_to다 — 칸을 새로 만들지 않는다', () => {
    const targets = ingestTargetsOf([
      { id: 'c1', exchange_id: 'binance', is_testnet: true, is_active: true },
    ])!;
    const h = ingestHealthOf({
      targets, nowMs: NOW,
      states: [{ connectionId: 'c1', env: 'TESTNET',
        coveredFromMs: DAY_START, coveredToMs: NOW - 5 * MIN,
        lastRunAtMs: NOW - 5 * MIN, lastWritten: 2, lastError: null }],
    });
    eq(h.ok, true);
    eq(h.rows[0].code, 'OK');
    eq(h.rows[0].lastSuccessAt, new Date(NOW - 5 * MIN).toISOString());
    eq(h.rows[0].lagMinutes, 5);
  });

  test('마지막 회차가 실패했으면 시도 시각과 성공 시각이 다르다', () => {
    const targets = ingestTargetsOf([
      { id: 'c1', exchange_id: 'binance', is_testnet: true, is_active: true },
    ])!;
    const h = ingestHealthOf({
      targets, nowMs: NOW,
      states: [{ connectionId: 'c1', env: 'TESTNET',
        coveredFromMs: DAY_START, coveredToMs: NOW - 2 * HOUR,
        lastRunAtMs: NOW - MIN, lastWritten: 0, lastError: 'HTTP 418' }],
    });
    eq(h.rows[0].code, 'FAILING');
    eq(h.rows[0].lastAttemptAt, new Date(NOW - MIN).toISOString());
    eq(h.rows[0].lastSuccessAt, new Date(NOW - 2 * HOUR).toISOString());
  });

  test('수집 상태를 못 읽었으면 정상이라고 하지 않는다', () => {
    const targets = ingestTargetsOf([{ id: 'c1', exchange_id: 'binance', is_active: true }])!;
    eq(ingestHealthOf({ targets, states: null, nowMs: NOW }).code, 'STATES_UNKNOWN');
    eq(ingestHealthOf({ targets: null, states: [], nowMs: NOW }).code, 'TARGETS_UNKNOWN');
  });

  test('실패 사유에서 키처럼 생긴 값을 지운다', () => {
    const s = sanitizeReason('auth failed for key AKIAIOSFODNN7EXAMPLEKEY1234567890 at host');
    assert(!String(s).includes('AKIAIOSFODNN7EXAMPLEKEY1234567890'), `가려져야 한다 — ${s}`);
    assert(String(s).includes('[가려짐]'), '가렸다는 사실은 보인다');
    eq(sanitizeReason(''), null);
    eq(sanitizeReason(null), null);
  });

  test('LEDGER_LAG_STALE_MS는 수집 주기의 배수다 — 한 회차 놓쳤다고 경보하지 않는다', () => {
    close(LEDGER_LAG_STALE_MS / (15 * MIN), 3, 1e-9);
  });
}
