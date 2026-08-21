// src/lib/portfolio/snapshotBucket.test.ts
//
// **이 테스트가 지키는 것 하나: 같은 15분을 두 번 찍지 않는다.**
//
// 048은 `UNIQUE (user_id, env, account_key, taken_at)`을 걸어 두고
// 중복을 막는다고 적었다. `taken_at`은 밀리초까지 들어간 실제 시각이라
// 그 제약은 한 번도 아무것도 막지 못했다. 실제로 막고 있던 것은
// "마지막 기록에서 15분" 판정 하나였고, 탭을 두 개 열면 진다.
//
// 여기서 검사하는 것은 **키가 칸에 맞춰 떨어지는가**다. 두 요청이
// 같은 칸이면 같은 키가 나와야 DB의 유일 제약이 두 번째를 막는다.
import { test, eq, assert } from '../../test/harness';
import {
  bucketStartMs, bucketStartIso, snapshotFreshness, snapshotUpsert,
  SNAPSHOT_BUCKET_MS, SNAPSHOT_STALE_MS, SNAPSHOT_CONFLICT_KEY,
} from './snapshotBucket';

const T0 = Date.parse('2026-08-21T10:07:33.412Z');

export function runSnapshotBucketTests() {
  console.log('[자산 스냅샷 — 시각이 아니라 칸에 찍는다]');

  test('같은 15분 안의 두 시각은 같은 칸이다', () => {
    // 탭을 두 개 열어 동시에 들어온 두 요청. **같은 키가 나와야 한다** —
    // 다르면 DB 제약이 통과시키고 그날 손익이 두 배로 보인다.
    const a = bucketStartMs(Date.parse('2026-08-21T10:00:01.000Z'));
    const b = bucketStartMs(Date.parse('2026-08-21T10:14:59.999Z'));
    eq(a, b);
    eq(bucketStartIso(a), '2026-08-21T10:00:00.000Z');
  });

  test('칸 경계를 넘으면 다른 칸이다', () => {
    const a = bucketStartMs(Date.parse('2026-08-21T10:14:59.999Z'));
    const b = bucketStartMs(Date.parse('2026-08-21T10:15:00.000Z'));
    assert(a !== b, '경계에서 칸이 안 바뀌면 15분마다 못 찍는다');
    eq(b! - a!, SNAPSHOT_BUCKET_MS);
  });

  test('바닥으로 내린다 — 반올림하면 같은 순간이 다른 칸으로 간다', () => {
    // 반올림이면 10:08은 10:15 칸으로 가고 10:07은 10:00 칸으로 간다.
    // 1분 차이로 다른 칸이 되면 두 번 찍힌다.
    eq(bucketStartIso(T0), '2026-08-21T10:00:00.000Z');
    eq(bucketStartIso(Date.parse('2026-08-21T10:08:00.000Z')), '2026-08-21T10:00:00.000Z');
  });

  test('시각을 못 읽으면 null이다 — 0으로 떨어뜨리지 않는다', () => {
    // 0으로 떨어지면 1970-01-01 칸에 전부 몰리고 두 번째부터 전부 막힌다.
    eq(bucketStartMs(null), null);
    eq(bucketStartMs('abc'), null);
    eq(bucketStartMs(undefined), null);
    eq(bucketStartMs(true), null);
  });

  console.log('[자산 스냅샷 — 못 읽은 것을 0으로 찍지 않는다]');

  test('자산을 못 읽었으면 행을 만들지 않는다', () => {
    // **되돌릴 수 없는 기록이다.** 0을 남기면 곡선이 바닥으로 떨어지고
    // 사용자는 그 시각에 전액을 잃은 줄 안다.
    const row = snapshotUpsert({
      userId: 'u1', env: 'LIVE', nowMs: T0, totalEquity: null,
    });
    eq(row, null);
  });

  test('값을 못 매긴 자산이 있으면 부분합계를 찍지 않는다', () => {
    const row = snapshotUpsert({
      userId: 'u1', env: 'LIVE', nowMs: T0, totalEquity: 900, unpricedCount: 1,
    });
    eq(row, null, '부분합계를 찍으면 곡선에 "자산이 줄었다"로 남는다');
  });

  test('읽은 값만 행에 넣는다 — 못 읽은 칸은 0이 아니라 없음이다', () => {
    const row = snapshotUpsert({
      userId: 'u1', env: 'TESTNET', nowMs: T0, totalEquity: 1000, unrealizedPnl: null,
    })!;
    eq(row.total_equity, 1000);
    eq(row.env, 'TESTNET');
    eq('unrealized_pnl' in row, false, '못 읽은 값이 0으로 기록된다');
    eq(row.bucket_start, '2026-08-21T10:00:00.000Z');
    // 칸 안 어디였는지도 남는다.
    eq(row.taken_at, new Date(T0).toISOString());
    eq(row.source, 'worker');
  });

  test('읽은 미실현손익은 넣는다', () => {
    const row = snapshotUpsert({
      userId: 'u1', env: 'LIVE', nowMs: T0, totalEquity: 500, unrealizedPnl: -3,
    })!;
    eq(row.unrealized_pnl, -3);
  });

  test('사용자를 모르면 찍지 않는다', () => {
    eq(snapshotUpsert({ userId: '', env: 'LIVE', nowMs: T0, totalEquity: 1 }), null);
  });

  test('충돌 키는 064의 인덱스와 같은 칸 순서다', () => {
    // 두 곳에 문자열이 갈리면 upsert가 중재 인덱스를 못 찾고, 그때부터
    // 모든 스냅샷 쓰기가 실패한다.
    eq(SNAPSHOT_CONFLICT_KEY, 'user_id,env,account_key,bucket_start');
  });

  console.log('[자산 스냅샷 — 워커가 멈추면 화면이 말한다]');

  test('오래 안 찍혔으면 오래됐다고 말한다', () => {
    // 쓰기를 워커로 옮기면서 생긴 새 실패 모드다. 예전에는 화면을 여는
    // 행위가 곧 기록이라 "오래됨"이 존재할 수 없었다.
    const f = snapshotFreshness({ nowMs: T0, lastTakenMs: T0 - SNAPSHOT_STALE_MS - 60_000, connections: 1 });
    eq(f.code, 'STALE'); eq(f.stale, true);
    assert(f.reason.includes('지금 자산이 아닙니다'), f.reason);
  });

  test('최근에 찍혔으면 경고하지 않는다', () => {
    const f = snapshotFreshness({ nowMs: T0, lastTakenMs: T0 - 60_000, connections: 1 });
    eq(f.code, 'FRESH'); eq(f.stale, false);
  });

  test('한 번도 안 찍혔으면 그 사실을 말한다', () => {
    const f = snapshotFreshness({ nowMs: T0, lastTakenMs: null, connections: 1 });
    eq(f.code, 'NEVER'); eq(f.stale, true);
  });

  test('기록을 못 읽은 것을 "기록 없음"으로 적지 않는다', () => {
    // 못 읽은 것과 없는 것은 다르다. 못 읽었는데 "한 번도 안 찍혔다"고
    // 하면 사용자는 워커가 죽은 줄 안다.
    const f = snapshotFreshness({ nowMs: T0, lastTakenMs: null, historyOk: false, connections: 1 });
    eq(f.code, 'UNKNOWN'); eq(f.stale, false);
    assert(f.reason.includes('기록이 없다는 뜻이 아닙니다'), f.reason);
  });

  test('연결이 없으면 찍을 자산이 없다 — 경고하지 않는다', () => {
    const f = snapshotFreshness({ nowMs: T0, lastTakenMs: null, connections: 0 });
    eq(f.code, 'NO_ACCOUNT'); eq(f.stale, false);
  });
}
