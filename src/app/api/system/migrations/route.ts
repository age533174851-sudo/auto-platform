// GET /api/system/migrations — 무엇이 적용됐고 무엇이 남았는가
//
// **사람이 Supabase 대시보드를 열지 않아도 답이 나와야 한다.**
// 적용은 migrate 워크플로가 자동으로 하고, 이 라우트는 그 결과를 읽는다.
//
// 판정은 여기 없다. migrationStatus.ts에 있고 테스트가 붙어 있다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { migrationStatusOf } from '@/lib/system/migrationStatus';
import { MIGRATION_MANIFEST, REQUIRED_MIGRATIONS } from '@/lib/system/migrationManifest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let rows: any[] | null = null;
  let readError: string | null = null;
  try {
    const { data, error } = await (sb as any)
      .from('schema_migrations')
      .select('filename, checksum, status, verified, verify_detail, applied_at, applied_by, runtime_sha, error')
      .order('applied_at', { ascending: false });
    if (!error && Array.isArray(data)) rows = data;
    else if (error && /does not exist|schema cache|relation/i.test(String(error.message))) {
      // 기록표 자체가 아직 없다 — 첫 자동 적용 전이다. **못 읽은 것과 다르다.**
      rows = [];
      readError = 'schema_migrations 표가 아직 없습니다 — 첫 자동 적용에서 만들어집니다';
    } else if (error) {
      readError = String(error.message).slice(0, 200);
    }
  } catch (e: any) {
    readError = String(e?.message ?? e).slice(0, 200);
  }

  const checksums: Record<string, string> = {};
  for (const m of MIGRATION_MANIFEST) checksums[m.name] = m.checksum;
  const status = migrationStatusOf({ required: REQUIRED_MIGRATIONS, rows, checksums });

  const byName = new Map((rows ?? []).map((r: any) => [String(r.filename), r]));
  const files = MIGRATION_MANIFEST.map(m => {
    const r: any = byName.get(m.name);
    return {
      name: m.name, id: m.id, risk: m.risk,
      // **기록이 없으면 'PENDING'이다. 'OK'가 아니다.**
      state: r == null ? 'PENDING'
        : String(r.status) === 'FAILED' ? 'FAILED'
        : r.verified === false ? 'UNVERIFIED'
        : String(r.status) === 'BASELINE' ? 'ADOPTED'
        : 'APPLIED',
      appliedAt: r?.applied_at ?? null,
      appliedBy: r?.applied_by ?? null,
      runtimeSha: r?.runtime_sha ?? null,
      verified: r?.verified ?? null,
      verifyDetail: r?.verify_detail ?? null,
      // 실패 사유는 스크립트가 접속 정보를 지운 뒤 넣은 것이다.
      error: r?.error ?? null,
      checksumChanged: !!(r?.checksum && m.checksum && r.checksum !== m.checksum),
    };
  });

  return NextResponse.json({
    ok: true, status, files, readError, checkedAt: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
