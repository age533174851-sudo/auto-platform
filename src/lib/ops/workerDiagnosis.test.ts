// src/lib/ops/workerDiagnosis.test.ts
//
// 지키는 것
//  1. 못 물어본 것을 "없다"로 적지 않는다 (UNVERIFIED ≠ NO_APP)
//  2. 시크릿 목록을 못 읽었으면 "없다"고 단정하지 않는다
//  3. 값처럼 생긴 것은 로그에서 지운다
//  4. 실제로 겪은 상태(머신 started · SUPABASE 맞음 · heartbeat 38시간)를
//     SUPABASE 탓으로 돌리지 않는다
import { test, assert, eq } from '../../test/harness';
import {
  diagnoseWorker, diagnosisReport, scrubLogLine, interestingLogLines,
  REQUIRED_WORKER_SECRETS,
} from './workerDiagnosis';

const ALL_SECRETS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_SECRET', 'APP_URL', 'EXCHANGE_ENCRYPTION_KEY'];

export function runWorkerDiagnosisTests() {
  console.log('\n🩺 워커 진단 (workerDiagnosis)');

  // ── 1. 못 물어본 것 ──
  test('flyctl을 못 불렀으면 UNVERIFIED — 워커가 없다고 적지 않는다', () => {
    const d = diagnoseWorker({ queried: false, machines: null, secretNames: null, logLines: null, heartbeatAgeSec: null });
    eq(d.code, 'UNVERIFIED', '확인 못 함');
    assert(!/없습니다 —/.test(d.headline) || /뜻이 아닙니다/.test(d.headline), '없다고 단정하면 안 된다');
    assert(/뜻이 아닙니다/.test(d.headline), '없다는 뜻이 아니라고 분명히 적어야 한다');
  });

  test('시크릿 목록을 못 읽었으면 MISSING_SECRET으로 단정하지 않는다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'abc123', state: 'started' }],
      secretNames: null, logLines: [], heartbeatAgeSec: 100000,
    });
    assert(d.code !== 'MISSING_SECRET', '못 읽은 것을 없는 것으로 읽었다');
    assert(d.evidence.some(e => /없다는 뜻이 아닙니다/.test(e)), '못 읽었다는 사실이 근거에 남아야 한다');
  });

  // ── 2. 실제로 겪은 상태 ──
  test('머신 started + SUPABASE 맞음 + heartbeat 38시간 → SUPABASE 탓으로 돌리지 않는다', () => {
    const d = diagnoseWorker({
      queried: true,
      machines: [{ id: '784ed315f23358', state: 'started' }, { id: '784117eb141708', state: 'stopped' }],
      secretNames: ALL_SECRETS,
      logLines: [],
      heartbeatAgeSec: 137570,
    });
    eq(d.code, 'STARTED_BUT_SILENT', '떠 있는데 조용한 상태');
    assert(!/SUPABASE_URL/.test(d.nextStep), 'SUPABASE를 원인으로 단정하면 엉뚱한 곳을 파게 된다');
    assert(/137570초 전/.test(d.evidence.join(' ')), 'heartbeat 나이가 근거에 남아야 한다');
  });

  test('필수 이름이 없으면 MISSING_SECRET — 그리고 시스템이 할 일로 적는다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }],
      secretNames: ['ADMIN_SECRET'], logLines: [], heartbeatAgeSec: null,
    });
    eq(d.code, 'MISSING_SECRET', '필수 누락');
    for (const n of REQUIRED_WORKER_SECRETS) assert(d.headline.includes(n), `${n}이 결론에 있어야 한다`);
    assert(/sync-secrets/.test(d.nextStep), '사람이 대시보드를 여는 대신 워크플로가 한다고 적어야 한다');
  });

  test('워커가 스스로 "미설정"이라고 말하면 그 말을 근거로 쓴다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }],
      secretNames: ALL_SECRETS,
      logLines: ['SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정'],
      heartbeatAgeSec: null,
    });
    eq(d.code, 'MISSING_SECRET', '워커의 말이 우선');
    assert(d.evidence.some(e => /미설정/.test(e)), '그 줄이 근거에 실려야 한다');
  });

  test('머신이 전부 멈춰 있으면 ALL_STOPPED', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'stopped' }],
      secretNames: ALL_SECRETS, logLines: [], heartbeatAgeSec: null,
    });
    eq(d.code, 'ALL_STOPPED', '전부 멈춤');
  });

  test('머신이 하나도 없으면 NO_APP — 다만 목록을 읽은 경우에만', () => {
    const read = diagnoseWorker({ queried: true, machines: [], secretNames: ALL_SECRETS, logLines: [], heartbeatAgeSec: null });
    eq(read.code, 'NO_APP', '읽었는데 0대면 없는 것이다');
    const unread = diagnoseWorker({ queried: true, machines: null, secretNames: ALL_SECRETS, logLines: [], heartbeatAgeSec: null });
    assert(unread.code !== 'NO_APP', '못 읽은 것을 0대로 읽으면 안 된다');
  });

  test('crash 로그가 있으면 CRASH_LOOP', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }], secretNames: ALL_SECRETS,
      logLines: ['machine exited with exit code 1', 'Restarting machine'], heartbeatAgeSec: null,
    });
    eq(d.code, 'CRASH_LOOP', '재시작 반복');
  });

  test('heartbeat 실패 로그가 있으면 DB_WRITE_FAILED — 죽은 것과 구분한다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }], secretNames: ALL_SECRETS,
      logLines: ['[heartbeat] 실패 relation "worker_heartbeat" does not exist'], heartbeatAgeSec: null,
    });
    eq(d.code, 'DB_WRITE_FAILED', '살아 있는데 못 쓰는 것');
    assert(d.code !== 'CRASH_LOOP', '죽은 것과 다른 고장이다');
  });

  test('heartbeat가 최근이면 ALIVE — 진단하지 않는다', () => {
    const d = diagnoseWorker({ queried: true, machines: null, secretNames: null, logLines: null, heartbeatAgeSec: 12 });
    eq(d.code, 'ALIVE', '살아 있음');
  });

  // ── 3. 조용히 죽는 것 ──
  test('EXCHANGE_ENCRYPTION_KEY가 없으면 필수는 아니지만 반드시 말한다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }],
      secretNames: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      logLines: [], heartbeatAgeSec: 100000,
    });
    assert(d.code !== 'MISSING_SECRET', '이건 워커를 멈추지는 않는다');
    assert(d.degraded.some(g => /EXCHANGE_ENCRYPTION_KEY/.test(g)), '없으면 주문이 안 나간다는 것을 말해야 한다');
    assert(d.degraded.some(g => /주문이 나가지 않습니다/.test(g)), '무엇을 잃는지 적어야 한다');
  });

  test('별칭(ENCRYPTION_KEY)이 있으면 없다고 하지 않는다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }],
      secretNames: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ENCRYPTION_KEY', 'ADMIN_SECRET', 'APP_URL'],
      logLines: [], heartbeatAgeSec: 100000,
    });
    assert(!d.degraded.some(g => /EXCHANGE_ENCRYPTION_KEY/.test(g)), '워커는 두 이름을 다 받는다');
  });

  // ── 4. 값 가리기 ──
  test('JWT는 로그에서 지운다', () => {
    const s = scrubLogLine('error: invalid key eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdefghijklmnop');
    assert(!/eyJhbGciOiJIUzI1NiJ9/.test(s), 'JWT가 그대로 남았다');
    assert(/가림:jwt/.test(s), '가렸다는 흔적은 남아야 한다');
  });

  test('접속 문자열의 자격 정보를 지운다', () => {
    const s = scrubLogLine('connect postgresql://user:p4ssw0rd@db.example.com:5432/postgres failed');
    assert(!/p4ssw0rd/.test(s), '비밀번호가 그대로 남았다');
  });

  test('긴 hex(파생 키·다이제스트)를 지운다', () => {
    const s = scrubLogLine('key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    assert(!/0123456789abcdef0123456789abcdef/.test(s), 'hex가 그대로 남았다');
  });

  test('관심 없는 줄은 옮기지 않는다 — 로그를 통째로 붙이지 않는다', () => {
    const lines = interestingLogLines(['평범한 줄입니다', '[heartbeat] 실패 permission denied', '또 평범한 줄']);
    eq(lines.length, 1, '단서가 되는 줄만');
    assert(/permission denied/.test(lines[0]), '그 줄이 맞아야 한다');
  });

  test('로그를 못 읽었으면 빈 목록 — 없다고 적지 않는다', () => {
    eq(interestingLogLines(null).length, 0, 'null은 빈 목록');
  });

  test('보고서에 근거와 다음 할 일이 같이 있다', () => {
    const d = diagnoseWorker({
      queried: true, machines: [{ id: 'm1', state: 'started' }], secretNames: ALL_SECRETS,
      logLines: [], heartbeatAgeSec: 137570,
    });
    const r = diagnosisReport(d);
    assert(/근거:/.test(r), '근거가 있어야 한다');
    assert(/다음:/.test(r), '다음 할 일이 있어야 한다');
    assert(/STARTED_BUT_SILENT/.test(r), '코드가 있어야 한다');
  });
}
