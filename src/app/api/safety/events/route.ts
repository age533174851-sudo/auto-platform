// GET /api/safety/events — 안전장치가 **실제로 발동한** 이력
//
// 왜 이 화면이 필요한가
// ─────────────────────
// 설정값만 보이면 사람은 그것이 돌고 있다고 믿는다. "오늘 손실 한도 5%"가
// 적혀 있으면 그 한도가 일하고 있다고 읽는다.
//
// 그런데 오늘 하루에만 켜져 있다고 믿었는데 한 번도 안 돈 안전장치를
// 여섯 개 찾았다 — 지표 회피(응답 필드 이름이 안 맞아 항상 빈 배열),
// 실전 연결 분류, 연결 테스트 호스트, 선물 가용 증거금, 백테스트 청산,
// 캘린더 크론. 전부 에러가 안 나고 화면이 멀쩡했다.
//
// **한 번도 발동한 적 없는 안전장치는 작동한다고 말할 수 없다.**
// 이 라우트는 설정값 옆에 '마지막 발동'을 놓아 그 차이를 드러낸다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { readSafetyEvents, summarizeSafetyEvents } from '@/lib/safety/safetyLog';
import { CHECK_SPECS } from '@/lib/engine/preTradeChecklist';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 며칠치를 볼 것인가 */
const DEFAULT_DAYS = 30;

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || DEFAULT_DAYS));
  const since = Date.now() - days * 86_400_000;

  // 검사 목록은 체크리스트에서 그대로 가져온다. 여기 따로 적으면 검사를
  // 추가했을 때 이 화면에만 안 나오고, 그러면 "그 검사는 발동한 적 없다"로
  // 읽힌다 — 실제로는 화면이 모르는 것뿐인데.
  const kinds = CHECK_SPECS.map(s => ({ id: String(s.id), label: String(s.label || s.id) }));

  const rows = await readSafetyEvents(sb, uid, since);
  const items = summarizeSafetyEvents(rows as any, kinds);

  return NextResponse.json({
    ok: true,
    days,
    // 못 읽었으면 그렇게 말한다. 빈 목록으로 그리면 "한 번도 발동한 적
    // 없음"이 되는데, 그건 이 기능이 없애려던 바로 그 거짓말이다.
    known: Array.isArray(rows),
    note: Array.isArray(rows)
      ? null
      : '발동 이력을 읽지 못했습니다 — 아래 숫자는 0이 아니라 확인 불가입니다. 마이그레이션 026을 적용했는지 확인하세요.',
    items,
    // 최근 것 몇 개는 그대로 보여준다. 요약만 있으면 "무엇 때문에
    // 막혔는지"를 되짚을 수 없다.
    recent: (rows || []).slice(0, 30),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
