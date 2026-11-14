// src/test/integration/runnerStaleConnectionIntegration.test.ts
//
// **실행기가 판정 함수를 실제로 부르는가.**
//
// `runSummary.test.ts`는 "막힌 줄이 있으면 막힘으로 센다"는 **판정**을
// 못 박는다. 그것만으로는 **실행기가 그 판정을 쓰는지**를 모른다 —
// 이 저장소에서 가장 자주 난 고장이 "만들어 놓고 배선을 안 함"이다.
//
// 실제로 #633을 만들 때 변이를 돌렸더니 순수 함수 시험이 전부 초록인
// 채로 이런 변이들이 **살아남았다**:
//
//   · 라우트가 `blockedByConnection`을 아예 안 부름
//   · 라우트가 부르되 결과를 버림
//
// 그 PR 본문에 "라우트 글루에는 자동 시험이 없습니다"라고 적어 뒀다.
// 이 파일이 그 구멍이다.
//
// **거래소·DB 두 경계만 가짜다.** 예약 읽기 · 연결 조회 · 막힘 판정 ·
// 집계 문장 · 크론 기록은 전부 실제 코드가 돈다.
import { test, eq, assert, flushAsync } from '../harness';
import { FakeDb, FakeVenue } from './venueHarness';

const ADMIN = 'test-admin-secret-0123456789';
const USER = 'u-1';
const LIVE_CONN = 'c-alive';
const DEAD_CONN = 'c-gone';

function req(): any {
  const h = new Map([['x-admin-secret', ADMIN]]);
  return {
    json: async () => ({}),
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    nextUrl: new URL('https://x.test/api/autotrade/daily-ladder'),
    url: 'https://x.test/api/autotrade/daily-ladder',
  };
}

function schedule(over: Record<string, any> = {}) {
  return {
    id: 's-1', user_id: USER, symbol: 'BTCUSDT', mode: 'TESTNET',
    connection_id: DEAD_CONN, enabled: true, interval_min: 60,
    last_run_at: null, strategy_id: 'my-original-v1',
    ...over,
  };
}

async function runGet(db: FakeDb) {
  const serverPath = require.resolve('../../lib/supabase/server');
  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/daily-ladder/route');

  const venue = new FakeVenue();
  // **아무 호출도 매핑하지 않는다.** 막힌 줄은 평가까지 가면 안 되므로,
  // 거래소나 전략 라우트로 한 번이라도 나가면 그 자체가 실패 증거다.
  venue.on('/', { status: 599, json: { msg: 'this run must not call out' } });
  const restoreVenue = venue.install();

  const prevServer = require.cache[serverPath];
  const prevAdmin = require.cache[adminPath];
  const prevAdminSecret = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = ADMIN;
  require.cache[serverPath] = {
    id: serverPath, filename: serverPath, loaded: true, exports: {
      getSupabaseAdmin: () => db,
      resolveUserId: async () => null,
      getUserIdFromRequest: async () => null,
      serviceRoleKeyRole: () => 'service_role',
    },
  } as any;
  delete require.cache[adminPath];
  delete require.cache[routePath];
  try {
    const mod = require(routePath);
    const res = await mod.GET(req());
    return { status: res.status, json: await res.json(), venue, db };
  } finally {
    if (prevAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = prevAdminSecret;
    delete require.cache[routePath];
    delete require.cache[adminPath];
    if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
    restoreVenue();
  }
}

export async function runRunnerStaleConnectionTests() {
  console.log('[통합 — 실행기가 막힌 예약을 실제로 가르는가]');

  // **앞서 등록된 async 시험을 먼저 비운다.** 하네스는 async 본문을
  // 동시에 시작하므로, 전역 fetch를 갈아 끼우기 전에 비우지 않으면
  // 남의 시험이 이 가짜 거래소를 받는다. 실제로 한 번 그렇게 24개를
  // 같이 붉혔다.
  await flushAsync();

  // ── ① 연결이 사라진 예약 ──
  // **시험 등록 전에 순차로 끝낸다.** 설치·복원이 겹치면 안 된다.
  const staleCase = await runGet(new FakeDb()
    .seed('autotrade_schedules', [schedule()])
    // 연결 목록은 **읽힌다**. 다만 그 안에 이 예약의 id가 없다.
    .seed('exchange_connections', [
      { id: LIVE_CONN, user_id: USER, exchange_id: 'binance', is_testnet: true, label: '살아있음' },
    ]));
  const unreadableCase = await runGet(
    new FakeDb({ failSelectsOn: 'exchange_connections' })
      .seed('autotrade_schedules', [schedule()]));

  test('★★ 연결이 사라진 예약은 막힘으로 세고, 평가까지 가지 않는다', () => {
    const r = staleCase;
    const row = (r.json.results || [])[0];
    assert(row, `결과 줄이 없다: ${JSON.stringify(r.json).slice(0, 300)}`);
    eq(row.blocked, true,
      `막힘으로 세지 않았다 — 라우트가 판정을 안 쓴다. 받은 줄: ${JSON.stringify(row)}`);
    eq(row.ok, false);
    eq(row.code, 'STALE_CONNECTION');
    assert(/연결/.test(String(row.detail || '')), `왜 막혔는지가 없다: ${row.detail}`);
    // **밖으로 한 번도 나가지 않았어야 한다.** 간격 검사에 맡겼다면
    // 전략 라우트로 POST가 나간다.
    eq(r.venue.calls.length, 0, `막힌 줄인데 밖으로 나갔다: ${JSON.stringify(r.venue.calls)}`);
    // **한 줄은 한 결과다.** 막힌 뒤에도 평가로 넘어가면 같은 예약이
    // 두 번 집계되고, 그러면 "막힘 1건 · 확인 1건"처럼 앞뒤가 안 맞는
    // 숫자가 나온다.
    eq((r.json.results || []).length, 1,
      `예약 한 줄인데 결과가 ${(r.json.results || []).length}줄이다 — 막힌 뒤에도 계속 갔다`);
  });

  test('★★ 크론 기록에 "막힘"이 남는다 — "실패 0건"으로 끝내지 않는다', () => {
    const r = staleCase;
    // FakeDb는 모든 쓰기를 `writes`에 남긴다 — 통합 시험이 보는 곳이다.
    const runs = r.db.writes.filter(w => w.table === 'cron_runs');
    assert(runs.length > 0, `크론 실행 기록이 없다: ${JSON.stringify(r.db.writes.map(w => w.table))}`);
    const detail = String(runs[runs.length - 1].patch?.detail ?? '');
    assert(/막힘 1건/.test(detail), `막힘이 집계에 없다: ${detail}`);
    assert(/연결/.test(detail), `무엇을 고쳐야 하는지가 없다: ${detail}`);
  });

  // ── ② 연결 목록을 못 읽은 경우 ──
  //
  // **모름은 막힘이 아니다.** 못 읽은 것을 막힘으로 적으면 멀쩡한 예약이
  // 전부 빨개지고, 사용자는 멀쩡한 연결을 다시 고른다.
  test('★★ 연결 목록을 못 읽으면 막힘으로 적지 않는다', () => {
    const r = unreadableCase;
    const row = (r.json.results || [])[0];
    assert(row, '결과 줄이 없다');
    assert(row.blocked !== true, `못 읽은 것을 막혔다고 적었다: ${JSON.stringify(row)}`);
    const runs = r.db.writes.filter(w => w.table === 'cron_runs');
    const detail = String(runs.length ? (runs[runs.length - 1].patch?.detail ?? '') : '');
    assert(!/막힘/.test(detail), `모름을 막힘으로 집계했다: ${detail}`);
  });

}
