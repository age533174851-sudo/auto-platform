// GET /api/cron/cleanup?apply=1
//
// 오래된 데이터를 지운다.
//
// 기본은 미리보기다
// ─────────────────
// apply=1 이 없으면 **세기만 하고 지우지 않는다.** 삭제는 되돌릴 수 없는데
// 이 엔드포인트는 손으로도 부를 수 있다. 주소를 잘못 눌러서 지워지는 일이
// 없어야 한다. 크론만 apply=1을 붙인다.
//
// 왜 표별로 따로 세는가
// ─────────────────────
// 한 표에서 예상보다 많이 지워지려 하면 그 표만 건너뛰고 나머지는 진행한다.
// 전부 멈추면 정리가 영영 안 되고, 전부 진행하면 잘못된 설정이 그대로
// 실행된다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  planCleanup, checkDeleteSize, DEFAULT_RULES,
  MIN_RETENTION_DAYS, MAX_DELETE_PER_RUN,
} from '@/lib/maintenance/retention';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TableResult {
  table: string;
  cutoff: string;
  days: number;
  /** 지울 대상 개수. 세지 못하면 null */
  eligible: number | null;
  /** 표 전체 개수. 세지 못하면 null */
  total: number | null;
  deleted: number;
  skipped: string;
  reason: string;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      || req.nextUrl.searchParams.get('secret') || '';
    if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  // 표 이름이 실행 중에 정해지므로 생성된 DB 타입의 유니온과 맞지 않는다.
  // 다른 라우트들과 같은 방식으로 any를 거친다.

  // 실제 삭제는 명시적으로 요청해야 한다
  const apply = req.nextUrl.searchParams.get('apply') === '1';
  const daysOverride = req.nextUrl.searchParams.get('days');
  const override = daysOverride != null ? { days: Number(daysOverride) } : undefined;

  const plan = planCleanup(DEFAULT_RULES, Date.now(), override);

  const results: TableResult[] = [];

  for (const item of plan.items) {
    const base: TableResult = {
      table: item.table, cutoff: item.cutoff, days: item.days,
      eligible: null, total: null, deleted: 0, skipped: '', reason: item.reason,
    };

    // 먼저 센다. 세지 못하면 지우지 않는다 — 몇 건인지 모르는 채로
    // 삭제하면 잘못됐을 때 얼마나 잃었는지도 모른다.
    let eligible: number | null = null;
    let total: number | null = null;
    try {
      const q = await ((sb as any).from(item.table) as any)
        .select('*', { count: 'exact', head: true })
        .lt(item.column, item.cutoff);
      if (!q.error) eligible = Number(q.count) || 0;
      else base.skipped = `개수 조회 실패: ${q.error.message}`;

      const t = await ((sb as any).from(item.table) as any)
        .select('*', { count: 'exact', head: true });
      if (!t.error) total = Number(t.count) || 0;
    } catch (e: any) {
      base.skipped = `조회 중 오류: ${e?.message || e}`;
    }

    base.eligible = eligible;
    base.total = total;

    if (eligible == null) { results.push(base); continue; }

    const size = checkDeleteSize(eligible, total ?? 0);
    if (!size.ok) {
      base.skipped = size.reason;
      results.push(base);
      continue;
    }
    if (eligible === 0) { base.skipped = '지울 것 없음'; results.push(base); continue; }

    if (!apply) {
      base.skipped = `미리보기 — ${eligible}건이 대상입니다. 실제로 지우려면 apply=1`;
      results.push(base);
      continue;
    }

    try {
      const { error } = await ((sb as any).from(item.table) as any)
        .delete()
        .lt(item.column, item.cutoff);
      if (error) base.skipped = `삭제 실패: ${error.message}`;
      else base.deleted = eligible;
    } catch (e: any) {
      base.skipped = `삭제 중 오류: ${e?.message || e}`;
    }
    results.push(base);
  }

  const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);

  return NextResponse.json({
    ok: true,
    applied: apply,
    totalDeleted,
    tables: results,
    // 거부된 규칙을 숨기지 않는다. 왜 안 지워졌는지 알아야 한다.
    rejected: plan.rejected,
    limits: { minRetentionDays: MIN_RETENTION_DAYS, maxDeletePerRun: MAX_DELETE_PER_RUN },
    note: apply
      ? '삭제는 되돌릴 수 없습니다.'
      : '미리보기입니다 — 아무것도 지우지 않았습니다. 실제 삭제는 apply=1.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
