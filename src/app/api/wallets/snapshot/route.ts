// POST /api/wallets/snapshot — 자산을 찍는다
//
// **읽기 요청이 쓰기를 하고 있었다.**
//
// `/api/wallets/overview`는 GET인데 `account_equity_snapshots`에 INSERT를
// 했다. 그 자리에 붙어 있던 주석은 정직했다 — "읽기 요청이 쓰기를 하는
// 것이 어색하지만, 표를 채우는 다른 경로가 없는 상태를 더 두는 것이
// 나쁘다." 그 다른 경로가 이 파일이다.
//
// 왜 옮기나
// ─────────
//   · **사람이 안 보면 곡선이 안 그려진다.** 자동매매는 24시간 도는데
//     자산 기록은 사람이 앱을 여는 시간에만 남았다. 밤사이 무슨 일이
//     있었는지는 영원히 알 수 없다
//   · **탭을 두 개 열면 두 번 찍혔다.** "마지막 기록에서 15분" 판정은
//     동시 요청 둘을 다 통과시킨다
//   · GET이 실패하면 곡선이 조용히 멈춘다. 그걸 아무도 모른다
//
// 이제 워커가 15분마다 깨운다. 거래소를 부르는 것은 여전히 Vercel이다
// (Binance가 Fly의 IP 지역을 차단한다) — 청산 감시·원장 수집과 같은
// 구조이고, **새 비밀은 만들지 않는다.**
//
// 중복은 판정이 아니라 제약이 막는다
// ──────────────────────────────────
// 064가 `(user_id, env, account_key, bucket_start)`에 유일 인덱스를 걸었다.
// 같은 15분 칸의 두 번째 쓰기는 DB가 막는다 — 경쟁 조건에서 애플리케이션
// 판정은 언제나 지고, 제약은 지지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { readUserWallets } from '@/lib/portfolio/walletRead';
import { snapshotUpsert, SNAPSHOT_CONFLICT_KEY, SNAPSHOT_BUCKET_MS } from '@/lib/portfolio/snapshotBucket';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8'); const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export async function POST(req: NextRequest) {
  // 워커가 자기 ADMIN_SECRET으로 부른다 — **새 비밀을 만들지 않는다.**
  const admin = safeEqual(req.headers.get('x-admin-secret'), process.env.ADMIN_SECRET || '');
  const body: any = admin ? await req.json().catch(() => ({})) : {};
  const uid = admin
    ? (String(body?.userId ?? '') || null)
    : await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let userIds: string[] = [];
  if (uid) userIds = [uid];
  else if (admin) {
    // 관리자 호출인데 userId를 안 줬으면 연결이 있는 모든 사용자를 돈다.
    const { data, error } = await (sb as any).from('exchange_connections')
      .select('user_id').eq('is_active', true);
    if (error) {
      // **못 읽은 것을 '사용자 없음'으로 적지 않는다.**
      return NextResponse.json({ ok: false, error: 'users_unreadable',
        message: `사용자 목록을 읽지 못했습니다: ${String(error.message).slice(0, 200)}` }, { status: 503 });
    }
    userIds = Array.from(new Set((Array.isArray(data) ? data : []).map((r: any) => String(r.user_id))));
  } else {
    return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const nowMs = Date.now();
  const results: any[] = [];
  let written = 0;
  let failed = 0;

  for (const userId of userIds) {
    const w = await readUserWallets(sb, userId);
    if (!w.ok) {
      failed++;
      results.push({ userId, ok: false,
        error: `거래소 연결 목록을 읽지 못했습니다: ${String(w.error ?? '').slice(0, 200)}` });
      continue;
    }

    for (const e of w.envs) {
      if (e.connections === 0) {
        results.push({ userId, env: e.env, ok: true, code: 'NO_ACCOUNT',
          reason: '이 환경에 연결된 계좌가 없습니다' });
        continue;
      }
      // **못 읽은 자산을 0으로 찍지 않는다.** 값을 못 매긴 자산이 하나라도
      // 있으면 그 순간의 부분합계이므로 찍지 않는다 — 그 기록은 되돌릴 수
      // 없고, 곡선에는 "자산이 줄었다"로 남는다.
      const row = snapshotUpsert({
        userId, env: e.env as any, nowMs,
        totalEquity: e.total.value,
        unrealizedPnl: e.unrealizedPnl.value,
        unpricedCount: e.unpricedAssets.length,
        intervalMs: SNAPSHOT_BUCKET_MS,
        source: 'worker',
      });
      if (!row) {
        results.push({ userId, env: e.env, ok: true, code: 'EQUITY_UNKNOWN',
          reason: e.unpricedAssets.length > 0
            ? `값을 못 매긴 자산이 있어 찍지 않았습니다 (${e.unpricedAssets.join(', ')}) — `
              + '부분합계를 찍으면 곡선에 "자산이 줄었다"로 남습니다'
            : '자산을 읽지 못해 찍지 않았습니다 — 0으로 찍지 않습니다' });
        continue;
      }

      // 같은 칸이면 조용히 덮는다. **판정이 아니라 제약이 막는다.**
      const { error } = await (sb as any).from('account_equity_snapshots')
        .upsert(row, { onConflict: SNAPSHOT_CONFLICT_KEY, ignoreDuplicates: false });
      if (error) {
        failed++;
        const msg = String(error.message ?? '');
        results.push({ userId, env: e.env, ok: false,
          // 064가 아직 안 갔으면 그 사실이 그대로 보여야 한다.
          error: /bucket_start|aes_bucket_uniq|constraint/i.test(msg)
            ? `자산 기록에 실패했습니다 — 마이그레이션 064가 필요합니다: ${msg.slice(0, 160)}`
            : `자산 기록에 실패했습니다: ${msg.slice(0, 200)}`,
        });
        continue;
      }
      written++;
      results.push({ userId, env: e.env, ok: true, code: 'TAKEN',
        bucketStart: row.bucket_start, totalEquity: row.total_equity });
    }
  }

  // **하나라도 못 적었으면 성공으로 적지 않는다.** 워커 로그에 남아야
  // "곡선이 왜 멈췄는지"를 나중에 찾을 수 있다.
  return NextResponse.json({
    ok: failed === 0, scanned: userIds.length, written, failed, results,
  }, { status: failed === 0 ? 200 : 500, headers: { 'Cache-Control': 'no-store' } });
}
