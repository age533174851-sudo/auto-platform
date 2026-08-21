// src/lib/ops/secretSync.test.ts
//
// **이 테스트가 지키는 것: "밀어 넣었다"를 "맞았다"로 적지 않는다.**
//
// 2026-08-19에 워커는 멀쩡히 돌고 배포는 성공이고 Fly는 started라고
// 하는데 화면은 아무것도 못 봤다 — 다른 데이터베이스를 보고 있었다.
// 사흘을 잃었다. `flyctl secrets set`이 0을 돌려준 것은 "명령을 받았다"
// 이지 "맞았다"가 아니다.
import { test, eq, assert } from '../../test/harness';
import { syncPlanOf, syncVerify, syncReport, SYNCED_NAMES } from './secretSync';

const FP_A = 'aaaaaa';
const FP_B = 'bbbbbb';
const allSource = {
  SUPABASE_URL: FP_A, SUPABASE_SERVICE_ROLE_KEY: FP_A,
  EXCHANGE_ENCRYPTION_KEY: FP_A, ADMIN_SECRET: FP_A,
};

export function runSecretSyncTests() {
  console.log('[시크릿 동기화 — 무엇을 밀 것인가]');

  test('이미 같은 것은 밀지 않는다 — 재시작시키지 않는다', () => {
    // 미는 것은 재시작이고, 재시작은 그 순간 열린 포지션의 감시를 끊는다.
    const p = syncPlanOf({
      sourceFp: allSource, vercelFp: allSource, flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    eq(p.push.length, 0);
    assert(p.steps.every(s => s.code === 'ALREADY_SAME'), JSON.stringify(p.steps[0]));
  });

  test('다르면 민다', () => {
    const p = syncPlanOf({
      sourceFp: allSource,
      vercelFp: { ...allSource, SUPABASE_URL: FP_B },
      flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    eq(p.push.length, 1);
    eq(p.push[0].name, 'SUPABASE_URL');
    eq(p.push[0].destination, 'vercel');
  });

  test('지문을 못 읽었으면 "아마 같겠지"로 넘기지 않고 민다', () => {
    // 여기서 넘기면 사흘을 잃은 그 고장이 그대로 남는다.
    const p = syncPlanOf({
      sourceFp: allSource, vercelFp: undefined, flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    eq(p.push.length, SYNCED_NAMES.length);
    assert(p.push.every(x => x.destination === 'vercel'), JSON.stringify(p.push));
  });

  test('기준값이 없으면 밀지 않고 사람에게 넘긴다', () => {
    // **빈 값을 밀면 지우는 것과 같다.**
    const p = syncPlanOf({
      sourceFp: { ...allSource, ADMIN_SECRET: null },
      vercelFp: {}, flyFp: {}, canPushVercel: true, canPushFly: true,
    });
    assert(!p.push.some(x => x.name === 'ADMIN_SECRET'), JSON.stringify(p.push));
    assert(p.bootstrap.some(b => b.includes('ADMIN_SECRET')), p.bootstrap.join('|'));
  });

  test('자격이 없으면 그 사실을 사람 할 일로 적는다', () => {
    const p = syncPlanOf({
      sourceFp: allSource, vercelFp: {}, flyFp: {},
      canPushVercel: false, canPushFly: true,
    });
    assert(p.bootstrap.some(b => b.includes('VERCEL_TOKEN')), p.bootstrap.join('|'));
    assert(!p.push.some(x => x.destination === 'vercel'), '자격 없이 밀려고 합니다');
  });

  test('어긋나면 무슨 일이 나는지 값으로 들고 있다', () => {
    const p = syncPlanOf({ sourceFp: allSource, canPushVercel: true, canPushFly: true });
    const enc = p.steps.find(s => s.name === 'EXCHANGE_ENCRYPTION_KEY')!;
    assert(enc.consequence.includes('키가 틀렸다'), enc.consequence);
  });

  console.log('[시크릿 동기화 — 밀어 넣은 것과 맞은 것은 다르다]');

  test('웹·워커가 기준과 같으면 SYNCED다', () => {
    const v = syncVerify({
      sourceFp: allSource,
      webFp: { SUPABASE_URL: FP_A, EXCHANGE_ENCRYPTION_KEY: FP_A },
      workerFp: { SUPABASE_URL: FP_A, EXCHANGE_ENCRYPTION_KEY: FP_A },
    });
    eq(v.code, 'SYNCED');
  });

  test('밀었는데도 다르면 MISMATCH이고 되돌릴 곳이 없다고 적는다', () => {
    const v = syncVerify({
      sourceFp: allSource,
      webFp: { SUPABASE_URL: FP_B, EXCHANGE_ENCRYPTION_KEY: FP_A },
      workerFp: { SUPABASE_URL: FP_A, EXCHANGE_ENCRYPTION_KEY: FP_A },
    });
    eq(v.code, 'MISMATCH');
    eq(v.mismatched.join(','), 'SUPABASE_URL(웹)');
    assert(v.reason.includes('되돌릴 이전 값은 아무도 갖고 있지 않으므로'), v.reason);
  });

  test('워커만 아직 안 떴으면 실패로 적지 않는다', () => {
    const v = syncVerify({
      sourceFp: allSource,
      webFp: { SUPABASE_URL: FP_A, EXCHANGE_ENCRYPTION_KEY: FP_A },
      workerFp: { SUPABASE_URL: FP_B, EXCHANGE_ENCRYPTION_KEY: FP_A },
      workerStale: true,
    });
    eq(v.code, 'WORKER_STALE');
  });

  test('못 읽은 것을 맞았다고 하지 않는다', () => {
    const v = syncVerify({ sourceFp: allSource, webFp: null, workerFp: null });
    eq(v.code, 'UNKNOWN');
    assert(v.reason.includes('맞았다는 뜻이 아닙니다'), v.reason);
  });

  console.log('[시크릿 동기화 — 끝 상태는 넷뿐이다]');

  test('전부 같았으면 READY이고 아무것도 재시작 안 했다고 적는다', () => {
    const plan = syncPlanOf({
      sourceFp: allSource, vercelFp: allSource, flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    const r = syncReport({ plan, pushed: 0,
      verify: { code: 'SYNCED', mismatched: [], reason: '' } });
    eq(r.outcome, 'READY'); eq(r.entryAllowed, true); eq(r.humanTodo.length, 0);
  });

  test('맞추고 확인까지 됐으면 SELF_HEALED다', () => {
    const plan = syncPlanOf({
      sourceFp: allSource, vercelFp: { SUPABASE_URL: FP_B }, flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    const r = syncReport({ plan, pushed: 4,
      verify: { code: 'SYNCED', mismatched: [], reason: '' } });
    eq(r.outcome, 'SELF_HEALED'); eq(r.entryAllowed, true);
  });

  test('최초 권한 연결이 없으면 BOOTSTRAP_REQUIRED다', () => {
    const plan = syncPlanOf({
      sourceFp: allSource, canPushVercel: false, canPushFly: true,
    });
    const r = syncReport({ plan, pushed: 0, verify: null });
    eq(r.outcome, 'BOOTSTRAP_REQUIRED');
    // **진입은 막지 않는다** — 자격이 없는 것과 값이 어긋난 것은 다르다.
    eq(r.entryAllowed, true);
    assert(r.humanTodo.length > 0, '사람이 할 일이 비어 있습니다');
  });

  test('확인 못 했으면 BLOCKED이고 신규 진입을 막는다', () => {
    const plan = syncPlanOf({
      sourceFp: allSource, vercelFp: allSource, flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    const r = syncReport({ plan, pushed: 2, verify: null });
    eq(r.outcome, 'BLOCKED'); eq(r.entryAllowed, false);
  });

  test('지문이 어긋나면 BLOCKED다 — 이미 열린 포지션은 계속 돈다', () => {
    const plan = syncPlanOf({
      sourceFp: allSource, vercelFp: allSource, flyFp: allSource,
      canPushVercel: true, canPushFly: true,
    });
    const r = syncReport({ plan, pushed: 1,
      verify: { code: 'MISMATCH', mismatched: ['SUPABASE_URL(워커)'], reason: 'x' } });
    eq(r.outcome, 'BLOCKED'); eq(r.entryAllowed, false);
  });
}
