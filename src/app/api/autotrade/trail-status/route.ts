// GET /api/autotrade/trail-status — 트레일링이 지금 무엇을 하고 있는가
//
// 왜 필요한가
// ───────────
// 트레일링·본전 이동은 **이미 돌고 있다.** 크론(exit-monitor)이 주기마다
// 손절을 옮긴다. 그런데 화면 어디에도 그 설정도, 그 결과도 없었다.
//
// 오늘 고친 여섯 개는 "켜졌다고 믿는데 안 도는" 것이었다. 이건 반대다 —
// **도는데 사용자가 모른다.** 손절가가 자기도 모르게 움직이는 것은 그것대로
// 위험하다: 이익을 지키려고 옮긴 손절에 걸려 나갔는데 왜 나갔는지 모른다.
//
// 이 라우트는 **아무것도 실행하지 않는다.**
// ─────────────────────────────────────────
// 같은 판정 함수(decideExits)를 부르되 결과를 돌려주기만 한다. 크론의
// GET은 CRON_SECRET으로 잠겨 있고 그건 화면에 둘 수 없다 — 그래서 읽기
// 전용 경로를 따로 낸다. 판정을 여기 다시 적지 않는 이유는, 규칙이 두 벌이
// 되면 **화면이 말하는 것과 실제로 손절을 옮기는 것이 갈리기** 때문이다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { readTrailConfig } from '@/lib/engine/trailPlan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { cfg, note } = readTrailConfig(k => process.env[k]);
  const testnet = (process.env.LADDER_MODE || 'TESTNET').toUpperCase() !== 'LIVE';

  let decisions: any[] = [];
  let error: string | null = null;
  try {
    const { decideExits } = await import('@/lib/engine/exitMonitor');
    // liveStopFor를 넘기지 않는다 — 거래소를 부르면 화면 여는 것만으로
    // 요청이 나간다. 진입 손절을 기준으로 본 판정이라는 사실은 아래
    // `liveStopKnown: false`로 그대로 적는다. **모르는 것을 아는 척하지
    // 않으면 화면이 덜 유용해도 틀리지는 않는다.**
    decisions = await decideExits(sb, { testnet, cfg, userId: uid });
  } catch (e: any) {
    error = String(e?.message || e);
  }

  return NextResponse.json({
    ok: error == null,
    error,
    // 지금 무엇이 켜져 있는가. 환경변수로만 바꿀 수 있다는 사실도 적는다 —
    // 화면에서 못 바꾸는 값을 바꿀 수 있는 것처럼 두면 안 된다.
    config: {
      useTrailing: cfg.useTrailing,
      useBreakEven: cfg.useBreakEven,
      trailStartR: cfg.trailStartR,
      trailDistanceR: cfg.trailDistanceR,
      breakEvenR: cfg.breakEvenR,
    },
    configNote: note || null,
    envOnly: true,
    liveStopKnown: false,
    positions: (decisions || []).map((d: any) => ({
      symbol: d.symbol,
      action: d.action,
      reason: d.reason,
      highWaterR: Number.isFinite(d.highWaterR) ? Number(d.highWaterR.toFixed(2)) : null,
      currentStop: d.currentStop ?? null,
      newStop: d.newStop ?? null,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
