// GET /api/system/status — 지금 무엇이 실제로 돌고 있는가
//
// 이 라우트는 **설정을 보여주지 않는다.** 마지막으로 실제로 일어난 일만
// 본다. 설정값만 보이면 사람은 그것이 돌고 있다고 믿는다 — 이 저장소에서
// 하루에만 여덟 개가 그 모양이었다.
//
// 판정은 여기 없다. statusReport.ts에 있고 테스트가 붙어 있다.
// 이 파일은 읽어 오기만 한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  cronStatus, tableStatus, connectionStatus, overallSummary,
  type CronExpectation, type TableProbe, type StatusItem,
} from '@/lib/system/statusReport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HOUR = 3_600_000;

/**
 * 크론이 얼마나 자주 돌아야 하는가.
 *
 * Vercel 무료 플랜은 **하루 1회**만 허용한다. 그래서 실제 등록 주기보다
 * 넉넉하게 잡는다 — 실제로 하루 한 번 도는 것을 '문제'로 그리면 매일
 * 빨간불이 켜지고, 그러면 사람은 곧 이 화면을 안 본다.
 */
const CRONS: CronExpectation[] = [
  { job: 'exit-monitor',  label: '청산 감시',    maxGapMs: 30 * HOUR },
  { job: 'calendar-sync', label: '일정 동기화',  maxGapMs: 30 * HOUR },
];

/** 있어야 하는 표 */
const TABLES: Array<{ name: string; label: string; migration: string }> = [
  { name: 'sub_accounts',  label: '가상 서브계좌', migration: '024' },
  { name: 'safety_events', label: '안전장치 기록', migration: '026' },
  { name: 'cron_runs',     label: '크론 실행 기록', migration: '029' },
];

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const now = Date.now();
  const items: StatusItem[] = [];

  // ── 크론 ──
  const { readCronRuns } = await import('@/lib/system/cronLog');
  const runs = await readCronRuns(sb, now - 7 * 24 * HOUR);
  items.push(...cronStatus(runs as any, CRONS, now));

  // ── 표(마이그레이션) ──
  //
  // 한 줄만 세어 본다. 실제로 못 읽으면 exists를 **null로 둔다** —
  // 없는 것과 못 읽은 것은 대응이 다르다.
  const probes: TableProbe[] = [];
  for (const t of TABLES) {
    let exists: boolean | null = null;
    try {
      const { error } = await (sb as any).from(t.name).select('*', { count: 'exact', head: true }).limit(1);
      if (!error) exists = true;
      else if (/does not exist|schema cache|relation/i.test(String(error.message))) exists = false;
      // 그 외 오류(권한 등)는 null로 남는다 — 없다고 단정하지 않는다.
    } catch { /* null */ }
    probes.push({ ...t, exists });
  }
  items.push(...tableStatus(probes));

  // ── 연결 ──
  let count: number | null = null;
  let lastOkMs: number | null = null;
  let untested = 0;
  try {
    const { data, error } = await (sb as any)
      .from('exchange_connections')
      .select('id, last_tested_at, test_status')
      .eq('user_id', uid);
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    count = rows.length;
    for (const r of rows) {
      const t = Date.parse(String(r?.last_tested_at ?? ''));
      if (!Number.isFinite(t)) { untested += 1; continue; }
      if (r?.test_status === 'ok' && (lastOkMs == null || t > lastOkMs)) lastOkMs = t;
    }
  } catch { /* count는 null로 남는다 → 확인 불가 */ }
  items.push(connectionStatus({ count, lastOkMs, untested }, now));

  // ── 안전장치가 한 번이라도 발동한 적 있는가 ──
  //
  // 발동한 적 없는 안전장치는 작동한다고 말할 수 없다. 다만 이것은
  // '문제'가 아니다 — 걸릴 일이 없었을 수도 있다. 사실만 적는다.
  try {
    const { data, error } = await (sb as any)
      .from('safety_events').select('occurred_at')
      .eq('user_id', uid).order('occurred_at', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const t = Date.parse(String(data?.[0]?.occurred_at ?? ''));
    items.push({
      id: 'safety', label: '안전장치 발동 이력',
      health: Number.isFinite(t) ? 'ok' : 'warn',
      detail: Number.isFinite(t)
        ? `마지막 발동 ${new Date(t).toLocaleString('ko-KR')}`
        : '한 번도 발동한 적이 없습니다 — 걸릴 일이 없었을 수도 있고, 안 도는 것일 수도 있습니다',
      action: Number.isFinite(t) ? null : '소액 실거래로 한 번 발동시켜 보는 것이 유일한 확인 방법입니다',
    });
  } catch {
    items.push({
      id: 'safety', label: '안전장치 발동 이력', health: 'unknown',
      detail: '이력을 읽지 못했습니다 — 발동 안 했다는 뜻이 아닙니다', action: null,
    });
  }

  const overall = overallSummary(items);
  return NextResponse.json({
    ok: true, overall, items, checkedAt: now,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
