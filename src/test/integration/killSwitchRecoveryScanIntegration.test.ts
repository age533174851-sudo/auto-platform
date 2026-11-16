// src/test/integration/killSwitchRecoveryScanIntegration.test.ts
//
// **Issue #514 — 킬스위치 자가복구의 조회 완전성.**
//
// 이 시험은 순수 판정기(`killSwitchRecoveryVerdict`)를 다시 묻지 않는다.
// 그쪽은 이미 "배열이 아니면 모른다"고 바르게 답한다. 여기서 묻는 것은
// **그 정본에 무엇을 먹이는가**다.
//
//   · `kill_switch_state`를 `.limit(50)`으로 끊으면 51번째 연결은
//     자가복구 대상에서 **영구히** 빠진다. 다음 회차도 같은 50줄이다.
//   · `jobs`를 `.limit(200)`으로 끊으면 201번째에 있던 기존 잡이
//     안 보인다. 그 연결은 `mine = []`이 되어 **전량청산 잡이 둘**이 된다.
//   · `{ data: null, error: null }`은 PostgREST가 돌려줄 수 있는 정상
//     코드 응답이다. `Array.isArray(x) ? x : []`는 그것을 **0건**으로
//     접는다 — 경고 한 줄 없이 자가복구가 멈춘다.
//
// 앞의 둘은 누락, 뒤는 중복이다. 방향이 반대인데 원인은 하나다 —
// **잘린 정상 응답을 완전한 목록으로 둔갑시킨 것.**
//
// 전부 FakeDb다. 실제 DB·거래소·주문은 없다.

import { test, eq, assert } from '../harness';
import { FakeDb, type FakeDbOptions } from './venueHarness';
import { killSwitchRecoveryVerdict } from '../../lib/engine/killSwitchRecovery';
import { EXCHANGE_CONNECTION_COLUMNS } from '../../lib/supabase/exchangeConnectionRead';
import { runKillSwitchRecovery } from '../../lib/engine/killSwitchRecoveryRun';

const cid = (n: number) => `c${String(n).padStart(4, '0')}`;

const ksRow = (n: number) => ({ connection_id: cid(n), active: true, action_mode: 'BC' });
const connRow = (n: number) => ({
  id: cid(n), user_id: 'u1', exchange_id: 'binance', is_testnet: true,
  api_key: 'k', api_secret_enc: '', encrypted_secret: 'enc', has_withdrawal: false,
});
const jobRow = (id: string, n: number) => ({
  id, connection_id: cid(n), action: 'KILL_SWITCH_EXECUTE', status: 'PENDING',
});

/** 활성 n건 + 연결 n건을 깐 장부 */
function seeded(n: number, opts: FakeDbOptions = {}): FakeDb {
  const db = new FakeDb(opts);
  const ks: any[] = [];
  const conns: any[] = [];
  for (let i = 1; i <= n; i++) { ks.push(ksRow(i)); conns.push(connRow(i)); }
  return db.seed('kill_switch_state', ks).seed('exchange_connections', conns);
}

/** 훅이 자기 장부를 봐야 할 때 (페이지 사이 삽입·삭제) */
function seededWith(n: number, mk: (ref: () => FakeDb) => FakeDbOptions): FakeDb {
  let db!: FakeDb;
  db = seeded(n, mk(() => db));
  return db;
}

/**
 * 한 연결에 기존 잡을 몰아 깐다.
 *
 * `jobs` 조회가 `.limit(200)`에서 끊기면 **뒤쪽 연결의 잡이 통째로 안
 * 보인다.** 그 연결은 `mine = []`이 되어 "살아 있는 잡 없음"으로 읽히고,
 * 전량청산 잡이 하나 더 들어간다. 그 모양을 만들려면 앞의 한 연결이
 * 페이지를 다 먹어야 한다.
 */
function jobsHeavy(db: FakeDb, bulkFor: number, bulk: number, tailFor: number): FakeDb {
  const jobs: any[] = [];
  for (let i = 1; i <= bulk; i++) jobs.push(jobRow(`a${String(i).padStart(5, '0')}`, bulkFor));
  jobs.push(jobRow('zzzzz', tailFor));
  return db.seed('jobs', jobs);
}

interface RunOut {
  rep: Awaited<ReturnType<typeof runKillSwitchRecovery>>;
  alerts: { sev: string; title: string; fields: Record<string, any> }[];
  /** 이 회차에 **새로 넣은** 잡 (씨드 잡은 명시 id, 신규는 row-N) */
  madeFor: string[];
}

async function run(db: FakeDb): Promise<RunOut> {
  const alerts: RunOut['alerts'] = [];
  const before = new Set(db.table('jobs').map((j) => String(j.id)));
  const rep = await runKillSwitchRecovery({
    db: db as any,
    verdict: killSwitchRecoveryVerdict,
    alert: async (_ch, sev, title, fields) => {
      alerts.push({ sev, title, fields: (fields ?? {}) as any });
      return { ok: true };
    },
    noteDb: () => {},
    connectionColumns: EXCHANGE_CONNECTION_COLUMNS,
  });
  const madeFor = db.table('jobs')
    .filter((j) => !before.has(String(j.id)))
    .map((j) => String(j.connection_id));
  return { rep, alerts, madeFor };
}

const warned = (o: RunOut) => o.alerts.filter((a) => a.sev !== 'info').length;

export async function runKillSwitchRecoveryScanTests() {
  console.log('\n[#514 킬스위치 자가복구 — 조회 완전성 (FakeDb)]');

  // ══════════ ① 경계 50 — 잘리지 않는 쪽 ══════════
  {
    const db = seeded(50);
    const o = await run(db);
    test('활성 50건은 전부 자가복구 잡을 받는다', () => {
      eq(o.rep.actives, 50, '활성 건수를 50으로 못 셌다');
      eq(o.rep.created, 50, '50건 중 일부가 보호를 못 받았다');
      eq(new Set(o.madeFor).size, 50, '연결별로 1건씩이 아니다');
    });
  }

  // ══════════ ② 경계 51 — 한 건이 영구히 빠진다 ══════════
  {
    const db = seeded(51);
    const o = await run(db);
    test('★★ 활성 51건에서 51번째 연결이 빠지지 않는다', () => {
      eq(o.rep.actives, 51, `활성 ${o.rep.actives}건만 봤다 — 나머지는 다음 회차에도 안 보인다`);
      eq(o.rep.created, 51, `${o.rep.created}건만 보호했다 — 51번째 킬스위치는 실행되지 않는다`);
      assert(o.madeFor.includes(cid(51)), '51번째 연결의 자가복구 잡이 없다');
      eq(o.rep.stateComplete, true, '활성 목록을 끝까지 읽었다고 증명하지 못했다');
    });
  }

  // ══════════ ③ 활성 100건 ══════════
  {
    const db = seeded(100);
    const o = await run(db);
    test('★★ 활성 100건도 한 회차에 전부 처리한다', () => {
      eq(o.rep.actives, 100, `활성 ${o.rep.actives}건만 봤다`);
      eq(o.rep.created, 100, `${o.rep.created}건만 보호했다`);
      eq(new Set(o.madeFor).size, 100, '연결별 1건씩이 아니다');
    });
  }

  // ══════════ ④ 비배열 정상 응답 — 조용한 0건 ══════════
  for (const [label, bad] of [
    ['data:null error:null', { data: null, error: null }],
    ['객체', { data: {}, error: null }],
    ['문자열', { data: 'kill_switch_state', error: null }],
  ] as [string, any][]) {
    const db = seeded(3, {
      selectHook: (c) => (c.table === 'kill_switch_state' ? bad : undefined),
    });
    const o = await run(db);
    test(`★★ 활성 상태 응답이 ${label}이면 0건으로 접지 않고 경고한다`, () => {
      eq(o.rep.created, 0, '모르는 상태에서 잡을 만들었다');
      eq(o.rep.stateComplete, false, '비배열 응답을 완전한 목록으로 읽었다');
      assert(warned(o) > 0, '조용히 0건으로 접었다 — 자가복구가 멈춘 것을 아무도 모른다');
    });
  }

  // ══════════ ⑤ jobs 199 / 200 / 201 ══════════
  //
  // 앞 연결(c0001)이 페이지를 먹고, 마지막 연결(c0050)의 기존 잡 1건이
  // 201번째에 놓인다. 200에서 끊으면 **c0050의 잡이 통째로 안 보인다.**
  //
  // c0002~c0049는 **정말로** 기존 잡이 없다 — 그 48건은 만들어야 맞다.
  // 틀리면 안 되는 것은 c0050이다. 199·200은 보이므로 지금도 맞고,
  // 201에서만 잘려서 중복이 된다. 세 경우를 같은 모양으로 둔다.
  for (const bulk of [198, 199, 200]) {
    const total = bulk + 1;
    const db = jobsHeavy(seeded(50), 1, bulk, 50);
    const o = await run(db);
    test(`★★ 기존 활성 잡 ${total}건 — ${total}번째에 있는 c0050에 중복을 넣지 않는다`, () => {
      assert(!o.madeFor.includes(cid(50)),
        `c0050은 살아 있는 KILL_SWITCH_EXECUTE 잡이 있는데 하나 더 넣었다`
        + ` (총 ${total}건 중 ${total}번째라 200에서 잘렸다) — 전량청산이 두 번 나간다`);
      eq(o.rep.created, 48,
        `기존 잡이 없는 연결은 48건인데 ${o.rep.created}건을 만들었다: ${o.madeFor.join(',')}`);
      eq(o.rep.jobsComplete, true, '기존 잡 목록의 완전성을 증명하지 못했다');
    });
  }

  // ══════════ ⑥ jobs 페이지 2가 실패 — fail-closed ══════════
  //
  // 1페이지가 꽉 찼으면 **끝인지 더 있는지 모른다.** 그 상태에서 2페이지가
  // 503이면 "살아 있는 잡 없음"을 어느 연결에도 말할 수 없다.
  for (const [label, bad] of [
    ['503', { data: null, error: { message: '503 Service Unavailable' } }],
    ['타임아웃', { data: null, error: { message: 'statement timeout' } }],
    ['비배열', { data: { oops: true }, error: null }],
  ] as [string, any][]) {
    const db = jobsHeavy(
      seeded(50, { selectHook: (c) => (c.table === 'jobs' && c.nth >= 2 ? bad : undefined) }),
      1, 200, 50,
    );
    const o = await run(db);
    test(`★★ 기존 잡 2페이지가 ${label}이면 신규 INSERT 0건 + 경고`, () => {
      eq(o.rep.created, 0, '기존 잡을 끝까지 못 읽은 상태에서 잡을 만들었다 — 중복 청산이다');
      eq(o.madeFor.length, 0, `중복 후보 연결에 넣었다: ${o.madeFor.slice(0, 3).join(',')}`);
      eq(o.rep.jobsComplete, false, '잘린 목록을 완전하다고 적었다');
      assert(warned(o) > 0, '조용히 건너뛰었다');
    });
  }

  // ══════════ ⑦ 활성 2페이지가 실패 — 읽은 것은 지금 보호한다 ══════════
  //
  // 여기서 전부 멈추면 **긴급 실행이 불필요하게 늦어진다.** 1페이지에서
  // 켜진 것을 확인한 연결은 보호해야 한다. 못 본 뒤쪽은 경고로 남긴다.
  {
    const db = seeded(120, {
      selectHook: (c) => (c.table === 'kill_switch_state' && c.nth >= 2
        ? { data: null, error: { message: '503 Service Unavailable' } } : undefined),
    });
    const o = await run(db);
    test('★★ 활성 2페이지 실패 — 1페이지에서 확인한 연결은 지금 보호한다', () => {
      assert(o.rep.created > 0, '확인된 활성 연결을 보호하지 않았다 — 긴급 실행이 늦어진다');
      eq(o.rep.stateComplete, false, '못 읽은 뒤쪽을 완전하다고 적었다');
      assert(warned(o) > 0, '못 본 연결이 있다는 사실을 적지 않았다');
    });
  }

  // ══════════ ⑧ 페이지 사이 삭제·삽입 ══════════
  {
    // 1페이지를 읽은 **뒤** 앞쪽 행을 지운다. OFFSET이면 한 행을 건너뛴다.
    const db = seededWith(120, (ref) => ({
      selectHook: (c) => {
        if (c.table === 'kill_switch_state' && c.nth === 1) {
          const d = ref();
          d.rows['kill_switch_state'] = d.rows['kill_switch_state']
            .filter((r: any) => r.connection_id !== cid(1));
        }
        return undefined;
      },
    }));
    const o = await run(db);
    test('★★ 페이지 사이에 앞쪽 행이 지워져도 뒤쪽을 건너뛰지 않는다', () => {
      // 1페이지에서 이미 본 cid(1)은 보호해도 되고 안 해도 된다 —
      // 핵심은 **그 삭제 때문에 다른 연결이 빠지지 않는 것**이다.
      const made = new Set(o.madeFor);
      const missing: string[] = [];
      for (let i = 2; i <= 120; i++) if (!made.has(cid(i))) missing.push(cid(i));
      eq(missing.length, 0, `삭제 때문에 빠진 연결: ${missing.slice(0, 5).join(',')}`);
    });
  }
  {
    // 1페이지를 읽은 뒤 **커서보다 뒤에** 새 활성이 생긴다 → 같은 회차에 잡힌다.
    const db = seededWith(60, (ref) => ({
      selectHook: (c) => {
        if (c.table === 'kill_switch_state' && c.nth === 1) {
          const d = ref();
          d.rows['kill_switch_state'].push(ksRow(900));
          d.rows['exchange_connections'].push(connRow(900));
        }
        return undefined;
      },
    }));
    const o = await run(db);
    test('★★ 순회 중 커서 뒤에 생긴 활성도 같은 회차에 잡는다', () => {
      assert(o.madeFor.includes(cid(900)), '순회 중 켜진 킬스위치를 못 봤다');
    });
  }

  // ══════════ ⑨ #404 UNIQUE — DB 최후 방어선과의 역할 구분 ══════════
  //
  // 페이지 순회는 **같은 워커 한 회차 안의** 중복을 막는다. 두 워커가
  // 동시에 들어오는 경합은 못 막는다 — 그건 #404의 partial UNIQUE index가
  // 막는다. 그때 DB가 돌려주는 23505는 **실패가 아니라 중복 차단 성공**이다.
  {
    const db = seeded(3, {
      insertHook: (c) => (c.table === 'jobs' && c.nth === 2
        ? { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        : undefined),
    });
    const o = await run(db);
    test('★★ 동시 INSERT 유니크 충돌(23505)은 중복 잡을 남기지 않는다', () => {
      const ks = db.table('jobs').filter((j) => j.action === 'KILL_SWITCH_EXECUTE');
      const perConn = new Map<string, number>();
      for (const j of ks) perConn.set(String(j.connection_id), (perConn.get(String(j.connection_id)) ?? 0) + 1);
      const dupes = [...perConn.entries()].filter(([, n]) => n > 1);
      eq(dupes.length, 0, `한 연결에 잡이 둘이다: ${dupes.map(([k, n]) => `${k}×${n}`).join(',')}`);
    });
    test('★★ 23505는 critical 오경보로 올리지 않는다 — DB가 막아 준 것이다', () => {
      const crit = o.alerts.filter((a) => a.sev === 'critical');
      eq(crit.length, 0, `중복 차단을 치명 실패로 적었다: ${crit.map((c) => c.title).join(' / ')}`);
      assert(warned(o) > 0, '다른 워커가 이미 만들었다는 사실을 아무 데도 적지 않았다');
    });
  }

  // ══════════ ⑩ 진짜 INSERT 실패는 여전히 치명이다 ══════════
  {
    const db = seeded(2, { failInsertCode: { table: 'jobs', code: 'XX000' } });
    const o = await run(db);
    test('INSERT가 진짜로 실패하면 critical로 적는다 (회귀)', () => {
      eq(o.rep.created, 0, '실패했는데 만들었다고 셌다');
      assert(o.alerts.some((a) => a.sev === 'critical'), '잡을 못 만든 것을 치명으로 적지 않았다');
    });
  }

  // ══════════ ⑪ 긴급 실행이 늦어지지 않는다 ══════════
  //
  // 평소(활성 1건)에 페이지 순회 때문에 조회가 늘어나면 보호가 느려진다.
  {
    const db = seeded(1);
    const o = await run(db);
    test('★★ 활성 1건은 추가 왕복 없이 바로 보호한다', () => {
      eq(o.rep.created, 1, '한 건도 보호하지 못했다');
      const reads = (db.selects['kill_switch_state'] ?? 0) + (db.selects['jobs'] ?? 0);
      assert(reads <= 4, `평소 회차에 조회가 ${reads}번이다 — 긴급 실행이 늦어진다`);
    });
  }

  // ══════════ ⑫ 평소에는 0줄에서 끝난다 (회귀) ══════════
  {
    const db = new FakeDb({
      selectHook: (c) => (c.table === 'kill_switch_state' ? { data: [], error: null } : undefined),
    });
    const o = await run(db);
    test('켜진 킬스위치가 없으면 jobs를 읽지 않는다 (회귀)', () => {
      eq(o.rep.actives, 0, '없는데 있다고 셌다');
      eq(o.rep.created, 0, '없는데 만들었다');
      eq(db.selects['jobs'] ?? 0, 0, '평소 회차에 jobs를 읽었다 — 전송량이 늘어난다');
      eq(warned(o), 0, '정상 0건을 경고로 올렸다');
    });
  }

  // ══════════ ⑬ 꺼진 것은 섞여 있어도 만들지 않는다 (회귀) ══════════
  {
    const db = new FakeDb()
      .seed('kill_switch_state', [
        { connection_id: cid(1), active: true, action_mode: 'BC' },
        { connection_id: cid(2), active: false, action_mode: 'BC' },
      ])
      .seed('exchange_connections', [connRow(1), connRow(2)]);
    const o = await run(db);
    test('꺼진 연결에는 자가복구 잡을 만들지 않는다 (회귀)', () => {
      eq(o.rep.created, 1, '켜진 1건만 만들어야 한다');
      eq(o.madeFor.join(','), cid(1), `잘못된 연결에 만들었다: ${o.madeFor.join(',')}`);
    });
  }

  // ══════════ ⑭-b 같은 connection_id가 두 행 ══════════
  //
  // `connection_id`가 커서다. 같은 값이 두 번 오면 **커서가 전진하지
  // 않는다** — 그대로 다음 페이지를 물으면 같은 페이지를 영원히 받거나
  // 뒤쪽을 건너뛴다. 그래서 거기서 멈추고 "끝까지 읽었다"고 하지 않는다.
  //
  // 그렇다고 그 페이지에서 **이미 켜진 것을 확인한 연결**을 버리면
  // 안 된다. 한 행이 이상해서 50개 연결의 킬스위치를 굶기는 것이 된다.
  {
    const db = new FakeDb()
      .seed('kill_switch_state', [
        { connection_id: cid(1), active: true, action_mode: 'BC' },
        { connection_id: cid(1), active: true, action_mode: 'BC' },
        { connection_id: cid(2), active: true, action_mode: 'BC' },
      ])
      .seed('exchange_connections', [connRow(1), connRow(2)]);
    const o = await run(db);
    test('★★ 같은 connection_id가 두 행이면 끝까지 읽었다고 하지 않는다', () => {
      eq(o.rep.stateComplete, false,
        '커서가 전진하지 않는 응답을 완전한 목록으로 읽었다');
      assert(warned(o) > 0, '커서 이상을 아무 데도 적지 않았다');
    });
    test('★★ 한 행이 이상해도 그 전에 확인한 연결은 보호한다', () => {
      assert(o.madeFor.includes(cid(1)),
        '커서 이상 때문에 켜진 것을 확인한 연결까지 굶겼다');
      const dupes = o.madeFor.filter((c) => c === cid(1)).length;
      eq(dupes, 1, `같은 연결에 ${dupes}건을 넣었다 — 중복 행을 두 건으로 셌다`);
    });
  }

  // ══════════ ⑮ 2워커 경합 — 페이지 순회로는 원자성을 못 만든다 ══════════
  //
  // 이건 **결함 재현이 아니라 한계 기록**이다. 두 워커가 같은 순간에
  // 들어오면 둘 다 "기존 잡 없음"을 끝까지 읽고 둘 다 넣는다. 페이지를
  // 아무리 바르게 순회해도 그 사이를 막지 못한다 — 읽기와 쓰기가
  // 한 트랜잭션이 아니기 때문이다.
  //
  // 그래서 #404의 partial UNIQUE index가 **별도의** 최후 방어선으로
  // 필요하다. 이 시험이 그 역할 구분을 값으로 남긴다.
  {
    const db = seeded(1);
    await Promise.all([run(db), run(db)]);
    test('★★ UNIQUE 제약이 없으면 2워커 경합에서 잡이 둘이 된다 (한계 기록)', () => {
      const ks = db.table('jobs').filter((j) => j.action === 'KILL_SWITCH_EXECUTE');
      eq(ks.length, 2,
        '이 시험은 페이지 순회의 한계를 기록한다 — 1건이면 순회가 원자성을'
        + ' 준 것처럼 보이고, 그 주장은 틀렸다. #404 없이는 둘이 맞다');
    });
  }
  {
    // #404의 partial UNIQUE index를 흉내 낸다: 한 연결에 살아 있는
    // KILL_SWITCH_EXECUTE는 하나뿐.
    const db = seededWith(1, (ref) => ({
      insertHook: (c) => {
        if (c.table !== 'jobs' || c.row?.action !== 'KILL_SWITCH_EXECUTE') return undefined;
        const live = ref().table('jobs').some((j) => String(j.connection_id) === String(c.row.connection_id)
          && j.action === 'KILL_SWITCH_EXECUTE'
          && (j.status === 'PENDING' || j.status === 'PROCESSING'));
        return live
          ? { error: { code: '23505', message: 'duplicate key value violates unique constraint "jobs_one_active_killswitch"' } }
          : undefined;
      },
    }));
    const outs = await Promise.all([run(db), run(db)]);
    test('★★ #404 UNIQUE가 있으면 2워커 경합에서도 잡은 하나다', () => {
      const ks = db.table('jobs').filter((j) => j.action === 'KILL_SWITCH_EXECUTE');
      eq(ks.length, 1, `경합에서 잡이 ${ks.length}건 들어갔다 — 전량청산이 두 번 나간다`);
      eq(outs[0].rep.created + outs[1].rep.created, 1, '만들었다고 센 수가 실제와 다르다');
    });
    test('★★ 경합에서 밀린 쪽은 치명 경보가 아니라 경고로 적는다', () => {
      const crit = outs.flatMap((o) => o.alerts).filter((a) => a.sev === 'critical');
      eq(crit.length, 0, `정상 경합을 치명으로 적었다: ${crit.map((c) => c.title).join(' / ')}`);
      assert(outs.some((o) => o.alerts.some((a) => /이미 있었습니다/.test(a.title))),
        '두 워커가 동시에 돌고 있다는 사실을 아무 데도 적지 않았다');
    });
  }

  // ══════════ ⑯ 재시작 — 이미 있는 잡을 또 만들지 않는다 ══════════
  //
  // `lastKsScanMs`는 프로세스 메모리에 있다. 재시작하면 0이 되어 **즉시**
  // 한 회차가 돈다. 그때 직전 회차가 넣은 잡이 장부에 있다.
  {
    const db = seeded(3);
    const first = await run(db);
    const second = await run(db);   // 재시작 직후 회차
    test('★★ 재시작 직후 회차는 직전 회차의 잡을 중복으로 만들지 않는다', () => {
      eq(first.rep.created, 3, '첫 회차가 3건을 만들지 못했다');
      eq(second.rep.created, 0, `재시작 회차가 ${second.rep.created}건을 더 만들었다`);
      const ks = db.table('jobs').filter((j) => j.action === 'KILL_SWITCH_EXECUTE');
      eq(ks.length, 3, `잡이 ${ks.length}건이다 — 연결당 1건이어야 한다`);
    });
  }
  {
    // 직전 잡이 **끝난** 상태(DONE)면 보호가 없다 → 다시 만든다.
    const db = seeded(1).seed('jobs', [{
      id: 'old', connection_id: cid(1), action: 'KILL_SWITCH_EXECUTE', status: 'DONE',
    }]);
    const o = await run(db);
    test('끝난 잡은 살아 있는 보호로 세지 않는다 (회귀)', () => {
      eq(o.rep.created, 1, 'DONE 잡을 살아 있는 보호로 읽어 자가복구를 막았다');
    });
  }

  // ══════════ ⑭ 연결을 못 읽으면 추측하지 않는다 (회귀) ══════════
  {
    const db = new FakeDb()
      .seed('kill_switch_state', [{ connection_id: cid(1), active: true, action_mode: 'BC' }]);
    const o = await run(db);
    test('연결 행이 없으면 거래소를 추측해 잡을 만들지 않는다 (회귀)', () => {
      eq(o.rep.created, 0, '거래소를 모르는데 만들었다');
      assert(warned(o) > 0, '연결을 못 읽었다는 사실을 적지 않았다');
    });
  }
}
