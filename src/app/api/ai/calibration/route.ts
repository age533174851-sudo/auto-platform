// GET /api/ai/calibration?days=90&source=consensus
//
// AI의 확신도가 실제로 맞는지 채점해서 돌려준다.
//
// 이 화면이 없으면 "AI 점수 96/100"은 확인할 방법이 없는 숫자다. 여기서
// 답하는 것은 하나다 — **80%라고 말한 것들 중 실제로 몇 %가 맞았나.**
//
// 채점은 lib/ai/calibration의 순수 함수가 한다. 이 라우트는 읽어서 넘기고
// 결과를 그대로 돌려줄 뿐이다 — 화면·라우트·계산이 각자 자기 셈을 갖기
// 시작하면 어느 숫자가 맞는지 아무도 모르게 된다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId, getSupabaseAdmin } from '@/lib/supabase/server';
import { calibrate, type PredictionRecord } from '@/lib/ai/calibration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const days = Math.min(365, Math.max(1, Number(sp.get('days')) || 90));
  const source = sp.get('source') || 'consensus';

  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({
      ok: false, error: 'db_unavailable',
      message: 'Supabase가 설정되지 않아 채점 기록을 읽을 수 없습니다.',
    }, { status: 503 });
  }

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  let rows: any[] = [];
  try {
    // 생성된 타입에 없는 표라 `sb`를 먼저 넓힌다. `sb.from(...) as any`로는
    // from() 호출 자체가 먼저 검사돼서 통하지 않는다.
    const { data, error } = await (sb as any).from('ai_predictions')
      .select('source, direction, confidence, outcome, decided_at, responded, asked, applied')
      .eq('user_id', uid)
      .eq('source', source)
      .gte('decided_at', since)
      .order('decided_at', { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);
    rows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    // 조회 실패를 '기록 없음'으로 그리지 않는다. 빈 표와 못 읽은 표는
    // 완전히 다른 상태인데 화면에서는 둘 다 비어 보인다.
    return NextResponse.json({
      ok: false, error: 'query_failed',
      message: `채점 기록을 읽지 못했습니다 (${e?.message || e}). `
        + '마이그레이션 023을 적용했는지 확인하세요.',
    }, { status: 500 });
  }

  const records: PredictionRecord[] = rows.map(r => ({
    source: String(r.source ?? ''),
    direction: r.direction ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    outcome: r.outcome ?? null,
    atMs: r.decided_at ? Date.parse(String(r.decided_at)) : null,
  }));

  const report = calibrate(records);

  // 커버리지도 같이 낸다. 적중률이 좋아도 매번 2/5만 답했다면 그 성적은
  // 다섯이 답한 성적이 아니다.
  const withCov = rows.filter(r => r.responded != null);
  const avgResponded = withCov.length
    ? Math.round((withCov.reduce((a, r) => a + Number(r.responded), 0) / withCov.length) * 10) / 10
    : null;
  const avgAsked = (() => {
    const l = rows.filter(r => r.asked != null);
    return l.length ? Math.round((l.reduce((a, r) => a + Number(r.asked), 0) / l.length) * 10) / 10 : null;
  })();

  // 막은 것과 통과시킨 것을 따로 센다. 막은 것만 채점하면
  // "AI가 막았을 때는 늘 맞더라"는 착시가 생긴다.
  const applied = { VETO: 0, PASS: 0, INFO: 0, unknown: 0 };
  for (const r of rows) {
    const k = String(r.applied ?? '');
    if (k === 'VETO' || k === 'PASS' || k === 'INFO') applied[k]++;
    else applied.unknown++;
  }

  return NextResponse.json({
    ok: true,
    source, days,
    report,
    coverage: {
      avgResponded, avgAsked,
      note: avgResponded != null && avgAsked != null && avgResponded < avgAsked
        ? `평균 ${avgAsked}개에 물어 ${avgResponded}개가 답했습니다 — 이 성적은 ${avgAsked}개가 동의한 성적이 아닙니다`
        : null,
    },
    applied,
    note: report.status === 'ok'
      ? '이 숫자는 과거 기록입니다. 앞으로도 같다는 뜻이 아닙니다.'
      : '채점된 표본이 부족합니다 — 적중률을 내지 않았습니다. 3전 3승을 100%로 적으면 가장 검증 안 된 것이 가장 좋아 보입니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
