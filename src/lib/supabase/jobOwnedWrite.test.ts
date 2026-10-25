import { test, eq, assert } from '../../test/harness';
import { persistOwnedJob, type OwnedJobWrite, type OwnedJobStore } from './jobOwnedWrite';

function fakeStore(initial: any) {
  let row = { ...initial };
  let dbError: any = null;
  let malformed = false;
  let throws = false;
  let calls = 0;
  const store: OwnedJobStore = {
    writeIfOwned: async (req: OwnedJobWrite) => {
      calls++;
      if (throws) throw new Error('exceed_egress_quota');
      if (dbError) return { data: null, error: dbError };
      if (malformed) return { data: null, error: null };
      // The same atomic predicate as the PostgREST UPDATE in worker/src/index.ts.
      if (row.id !== req.id || row.status !== 'PROCESSING'
        || row.locked_by !== req.owner || row.attempts !== req.attempts) {
        return { data: [], error: null };
      }
      row = { ...row, ...req.changes };
      return { data: [{ id: row.id }], error: null };
    },
  };
  return {
    store, row: () => row, calls: () => calls,
    change: (patch: any) => { row = { ...row, ...patch }; },
    fail: (e: any) => { dbError = e; },
    malformed: () => { malformed = true; },
    throws: () => { throws = true; },
  };
}
const base = { id: 'job-1', status: 'PROCESSING', locked_by: 'A', attempts: 1, result: null };
const req = (changes: Record<string, unknown> = { status: 'COMPLETED', locked_by: null }) => ({
  id: 'job-1', owner: 'A', attempts: 1, changes,
});
export function runJobOwnedWriteTests() {
  console.log('[잡 후속 쓰기 — 소유권 CAS / DB ACK]');
  test('현재 소유자와 attempt가 일치하면 1행 저장', async () => {
    const db = fakeStore(base);
    eq((await persistOwnedJob(db.store, req())).code, 'SAVED');
    eq(db.row().status, 'COMPLETED');
  });
  test('★ A 실행 중 B가 회수해 재claim하면 A finalize는 B를 덮지 못한다', async () => {
    const db = fakeStore(base);
    db.change({ locked_by: 'B', attempts: 2 });
    eq((await persistOwnedJob(db.store, req())).code, 'OWNERSHIP_LOST');
    eq(db.row().status, 'PROCESSING'); eq(db.row().locked_by, 'B');
  });
  test('★ 같은 WORKER_ID 재시작이어도 이전 attempt는 거부', async () => {
    const db = fakeStore({ ...base, attempts: 2 });
    eq((await persistOwnedJob(db.store, req())).code, 'OWNERSHIP_LOST');
  });
  test('★ 늦은 action retry UPDATE는 새 소유자의 PROCESSING을 덮지 못한다', async () => {
    const db = fakeStore({ ...base, locked_by: 'B', attempts: 2 });
    eq((await persistOwnedJob(db.store, req({ status: 'PENDING', locked_by: null }))).code, 'OWNERSHIP_LOST');
    eq(db.row().status, 'PROCESSING');
  });
  test('★ 늦은 READ_FAILED retry UPDATE도 새 소유자를 덮지 못한다', async () => {
    const db = fakeStore({ ...base, locked_by: 'B', attempts: 2 });
    eq((await persistOwnedJob(db.store, req({ status: 'PENDING', locked_by: null, error: 'read failed' }))).code, 'OWNERSHIP_LOST');
    eq(db.row().locked_by, 'B');
  });
  test('★ DB 402는 성공도 소유권 상실도 아니다', async () => {
    const db = fakeStore(base); db.fail({ message: 'exceed_egress_quota' });
    const r = await persistOwnedJob(db.store, req());
    eq(r.code, 'DB_WRITE_FAILED'); assert(r.reason.includes('exceed_egress_quota'));
    eq(db.row().status, 'PROCESSING');
  });
  test('DB 예외는 DB_WRITE_FAILED', async () => {
    const db = fakeStore(base); db.throws();
    eq((await persistOwnedJob(db.store, req())).code, 'DB_WRITE_FAILED');
  });
  test('비배열 응답은 성공이 아니다', async () => {
    const db = fakeStore(base); db.malformed();
    eq((await persistOwnedJob(db.store, req())).code, 'DB_WRITE_FAILED');
  });
  test('COMPLETED/FAILED/PENDING은 늦은 finalize로 덮지 않는다', async () => {
    for (const status of ['COMPLETED', 'FAILED', 'PENDING']) {
      const db = fakeStore({ ...base, status });
      eq((await persistOwnedJob(db.store, req())).code, 'OWNERSHIP_LOST');
      eq(db.row().status, status);
    }
  });
  test('claim 전 attempts=0은 요청 자체를 거부', async () => {
    const db = fakeStore(base);
    eq((await persistOwnedJob(db.store, { ...req(), attempts: 0 })).code, 'DB_WRITE_FAILED');
    eq(db.calls(), 0);
  });
  test('다른 job id는 갱신되지 않는다', async () => {
    const db = fakeStore(base);
    eq((await persistOwnedJob(db.store, { ...req(), id: 'other' })).code, 'OWNERSHIP_LOST');
  });
}
