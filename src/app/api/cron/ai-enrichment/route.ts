// GET /api/cron/ai-enrichment
//
// 저장된 미분석 기사에 AI 분석을 붙인다.
//
// 순서대로 하나씩 부르는 이유
// ───────────────────────────
// 병렬로 던지면 429가 한꺼번에 온다. 그러면 배치 전체가 실패하고, 다음
// 크론에서 같은 기사를 또 부른다 — 요금은 나가고 결과는 없다. 뉴스 분석은
// 몇 초 늦어도 상관없는 일이라 순서대로 도는 쪽이 낫다.
//
// 실패를 세는 이유
// ────────────────
// 안 세면 크론이 돌 때마다 같은 실패를 반복한다. 15분 주기면 실패 하나가
// 하루 96번 과금된다. 다만 429·타임아웃은 세지 않는다 — 일시적 오류로
// 멀쩡한 기사를 영영 포기하면 안 된다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { unanalyzed, attachAnalysis, recordFailure } from '@/lib/news/store';
import { analyzeArticle } from '@/lib/news/analyzeOne';
import { planEnrichment, nextAttempts, isTransient, shouldStopBatch, DEFAULT_BATCH } from '@/lib/news/enrichPlan';
import { callAny, availableProviders } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      || req.nextUrl.searchParams.get('secret') || '';
    if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (availableProviders().length === 0) {
    return NextResponse.json({
      ok: false,
      message: 'AI 공급자 키가 없습니다. 분석을 돌릴 수 없습니다.',
    }, { status: 503 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const batch = Number(req.nextUrl.searchParams.get('limit')) || DEFAULT_BATCH;

  // 후보를 넉넉히 읽는다. 시도 한도를 넘긴 것이 섞여 있으면 그만큼
  // 실제 분석 대상이 줄기 때문이다.
  const candidates = await unanalyzed(sb, Math.min(50, batch * 4));
  if (candidates === null) {
    // 조회 실패를 '분석할 것 없음'으로 보여주면 안 된다
    return NextResponse.json({
      ok: false,
      message: '미분석 기사를 읽지 못했습니다 — 없는 것이 아니라 확인 불가입니다. news_articles 테이블(019)을 확인하세요.',
    }, { status: 503 });
  }

  const plan = planEnrichment(candidates, batch);

  const done: { hash: string; direction: string; confidence: number }[] = [];
  const failed: { hash: string; reason: string; transient: boolean; attempts: number }[] = [];

  for (const a of plan.take) {
    const r = await analyzeArticle(a, (input) => callAny(input));

    if (r.ok && r.value) {
      const saved = await attachAnalysis(sb, a.hash, r.value, r.repaired);
      if (saved.ok) {
        done.push({ hash: a.hash, direction: r.value.direction, confidence: r.value.confidence });
      } else {
        // 분석은 됐는데 저장이 안 됐다. 다음에 다시 부르면 돈이 또 나가므로
        // 실패로 세되 이유를 남긴다.
        const n = nextAttempts(a.attempts, saved.error);
        await recordFailure(sb, a.hash, n, `분석 저장 실패: ${saved.error}`);
        failed.push({ hash: a.hash, reason: saved.error, transient: false, attempts: n });
      }
      continue;
    }

    const transient = isTransient(r.reason);
    const n = nextAttempts(a.attempts, r.reason);
    await recordFailure(sb, a.hash, n, r.reason);
    failed.push({ hash: a.hash, reason: r.reason, transient, attempts: n });

    // 한도 초과가 나면 남은 것도 같은 결과일 가능성이 높다. 계속 던지면
    // 요금만 나가고 다음 크론까지 한도가 안 풀린다.
    if (shouldStopBatch(r.reason)) break;
  }

  return NextResponse.json({
    ok: true,
    analyzed: done.length,
    failed: failed.length,
    // 포기한 기사를 숨기지 않는다. 왜 분석이 안 붙는지 알 수 있어야 한다.
    givenUp: plan.givenUp.length,
    deferred: plan.deferred,
    results: done,
    failures: failed,
    note: 'AI 예측이며 투자 조언이 아닙니다. 주문 파이프라인과는 분리돼 있습니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
