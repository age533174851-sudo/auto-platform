// GET /api/signals/live — 등록된 채널이 지금 방송 중인가
//
// 공식 API만 쓴다
// ───────────────
// 유튜브 Data API로 "지금 라이브인가"만 묻는다. 영상·오디오·자막을
// 받아오지 않는다 — 그건 약관 위반이고, 실시간 자막 스트림은 애초에
// 공식 API가 주지도 않는다.
//
// 그래서 여기서 얻는 것은 **켜졌다/꺼졌다**뿐이다. 무슨 말을 했는지는
// 사람이 보고 넣는다.
//
// 할당량을 먼저 본다
// ──────────────────
// search.list는 한 번에 100단위를 쓰고 하루 10,000이 기본이다.
// **하루 100번이 전부다.** 화면을 열 때마다 전 채널을 확인하면 금방
// 다 쓰고, 그러면 정작 저녁 방송을 못 본다. 그래서 확인 결과를 캐시하고
// 간격을 채널 수에 맞춰 잡는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  checkLive, channelIdFromUrl, pollIntervalMs, LIVE_LABEL, SEARCH_COST,
  type LiveStatus,
} from '@/lib/signals/youtubeLive';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 확인 결과를 잠깐 들고 있는다.
 *
 * 서버리스라 인스턴스마다 따로지만, 한 인스턴스가 짧은 시간에 여러 번
 * 불리는 것은 막는다 — 화면 새로고침 한 번에 할당량을 다 쓰는 것이
 * 가장 흔한 사고다.
 */
const cache = new Map<string, { at: number; status: LiveStatus }>();

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const apiKey = process.env.YOUTUBE_API_KEY || '';

  let channels: any[] = [];
  try {
    const { data, error } = await (sb as any)
      .from('trader_channels').select('id, name, platform, channel_url, enabled')
      .eq('user_id', uid).eq('enabled', true);
    if (error) throw new Error(error.message);
    channels = Array.isArray(data) ? data : [];
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'read_failed', message: String(e?.message || e) },
      { status: 500 });
  }

  // 유튜브 채널만 확인할 수 있다. 나머지는 **확인 불가로 남긴다** —
  // 치지직·SOOP은 공개 API가 없어서 켜졌는지 알 방법이 없다. 꺼진 것으로
  // 그리면 방송 중인데 앱은 조용한 상태가 된다.
  const youtube = channels
    .map(c => ({ c, ytId: channelIdFromUrl(c.channel_url) }))
    .filter(x => x.ytId);

  const interval = pollIntervalMs(youtube.length);
  const now = Date.now();
  const results: any[] = [];
  let spentUnits = 0;

  for (const { c, ytId } of youtube) {
    const hit = cache.get(ytId!);
    // 간격이 null이면(채널이 너무 많음) 아예 안 부른다.
    const fresh = hit && interval != null && now - hit.at < interval;
    if (fresh) {
      results.push({ channelId: c.id, name: c.name, ...hit!.status, cached: true });
      continue;
    }
    if (interval == null) {
      results.push({
        channelId: c.id, name: c.name, state: 'unknown', videoId: null, url: null,
        reason: `채널이 ${youtube.length}개라 하루 할당량으로는 다 확인할 수 없습니다`,
        cached: false,
      });
      continue;
    }
    const st = await checkLive(ytId!, apiKey);
    spentUnits += SEARCH_COST;
    cache.set(ytId!, { at: now, status: st });
    results.push({ channelId: c.id, name: c.name, ...st, cached: false });
  }

  // 유튜브가 아닌 채널은 목록에 남기되 확인 불가로 적는다.
  for (const c of channels) {
    if (channelIdFromUrl(c.channel_url)) continue;
    results.push({
      channelId: c.id, name: c.name, state: 'unknown', videoId: null, url: null,
      reason: c.channel_url
        ? '유튜브 채널 주소(/channel/UC…)가 아니라 방송 여부를 확인할 수 없습니다'
        : '채널 주소가 없습니다 — 유튜브 /channel/UC… 주소를 넣으면 방송 감지가 됩니다',
      cached: false,
    });
  }

  return NextResponse.json({
    ok: true,
    results,
    labels: LIVE_LABEL,
    // 무엇을 보고 판단했는지 남긴다
    keyConfigured: !!apiKey,
    pollIntervalMs: interval,
    spentUnits,
    note: !apiKey
      ? 'YOUTUBE_API_KEY가 없어 아무것도 확인하지 못했습니다 — 전부 확인 불가입니다'
      : `유튜브 채널 ${youtube.length}개 · 확인 간격 ${interval ? Math.round(interval / 60_000) + '분' : '—'}`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
