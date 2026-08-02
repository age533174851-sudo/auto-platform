// src/lib/signals/youtubeLive.ts
//
// **유튜브 라이브 시작 감지 — 공식 API만 쓴다.**
//
// 무엇을 하고 무엇을 안 하는가
// ────────────────────────────
// 한다: 공식 Data API로 "지금 라이브 중인가"를 묻는다.
// 안 한다: 영상·오디오·자막을 받아오지 않는다. 그건 약관 위반이고,
//          실시간 자막 스트림은 애초에 공식 API가 주지도 않는다.
//
// 그래서 이 파일이 알려줄 수 있는 것은 **켜졌다/꺼졌다**뿐이다.
// 무슨 말을 했는지는 사람이 보고 넣는다(positionParse).
//
// 할당량이 진짜 제약이다
// ──────────────────────
// search.list는 **한 번에 100 단위**를 쓴다. 기본 할당량이 하루 10,000이라
// **하루 100번**이 전부다. 채널 다섯 개를 10분마다 확인하면 하루 720번 —
// 오전에 다 쓰고 나머지 하루는 아무것도 못 본다.
//
// 그리고 할당량이 떨어지면 API는 403을 준다. 그걸 '방송 안 함'으로 읽으면
// **오후 내내 모든 채널이 꺼진 것으로 보인다.** 실제로는 확인을 못 한 것이다.
// 이 파일이 상태를 셋으로 나누는 이유가 그것이다.

export type LiveState = 'live' | 'offline' | 'unknown';

export interface LiveStatus {
  channelId: string;
  state: LiveState;
  /** 라이브면 그 영상 id */
  videoId: string | null;
  title: string | null;
  /** 원본 링크 — 사용자가 직접 보러 갈 수 있게 */
  url: string | null;
  reason: string;
}

/** search.list 한 번의 비용 (단위) */
export const SEARCH_COST = 100;
/** 기본 일일 할당량 */
export const DAILY_QUOTA = 10_000;

/**
 * 오늘 몇 번 더 확인할 수 있는가.
 *
 * **여유를 남긴다.** 할당량을 다 쓰면 그날은 아무것도 못 보는데,
 * 정작 방송이 켜지는 시간이 저녁일 수 있다.
 */
export function remainingChecks(usedUnits: number, dailyQuota = DAILY_QUOTA): number {
  const used = Number(usedUnits);
  if (!Number.isFinite(used) || used < 0) return 0;
  return Math.max(0, Math.floor((dailyQuota - used) / SEARCH_COST));
}

/**
 * 채널 수에 맞는 확인 간격(ms).
 *
 * 하루 할당량을 채널 수로 나눠서, **하루 종일 고르게** 쓰도록 잡는다.
 * 짧게 잡으면 오전에 다 쓴다.
 *
 * @param reserveRatio 남겨 둘 비율. 기본 30% — 수동 새로고침이나
 *                     다른 기능이 쓸 몫이다.
 */
export function pollIntervalMs(
  channelCount: number, dailyQuota = DAILY_QUOTA, reserveRatio = 0.3,
): number | null {
  const n = Number(channelCount);
  // 채널이 없으면 확인할 것도 없다. 0으로 나누지 않는다.
  if (!Number.isFinite(n) || n <= 0) return null;
  const usable = Math.floor((dailyQuota * (1 - reserveRatio)) / SEARCH_COST);
  const perChannel = Math.floor(usable / n);
  if (perChannel <= 0) {
    // 채널이 너무 많아 하루 한 번도 못 본다. null로 돌려주고 화면이
    // 그 사실을 적는다 — 몰래 몇 개만 확인하면 나머지는 영영 안 본다.
    return null;
  }
  return Math.ceil(86_400_000 / perChannel);
}

/** 채널 주소에서 채널 id를 뽑는다. 못 뽑으면 null — 추측하지 않는다 */
export function channelIdFromUrl(url: string | null | undefined): string | null {
  const s = String(url || '').trim();
  if (!s) return null;
  // /channel/UC... 형태만 확실하다. @핸들이나 /c/이름은 별도 조회가
  // 필요하고, 그걸 여기서 추측하면 엉뚱한 채널을 감시한다.
  const m = s.match(/\/channel\/(UC[A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

/**
 * search.list 응답을 해석한다.
 *
 * 순수 함수다. **HTTP 상태는 호출부가 넘긴다** — 여기서는 그것을 보고
 * 셋 중 하나를 고르는 일만 한다.
 */
export function parseLiveSearch(
  channelId: string,
  httpStatus: number,
  body: any,
): LiveStatus {
  const base = { channelId, videoId: null, title: null, url: null };

  if (httpStatus === 403) {
    // 할당량 초과이거나 키 문제다. **꺼진 것이 아니다.**
    const msg = body?.error?.message || '';
    return { ...base, state: 'unknown',
      reason: /quota/i.test(msg)
        ? '오늘 유튜브 API 할당량을 다 썼습니다 — 방송 여부를 확인하지 못했습니다'
        : `유튜브 API가 거부했습니다: ${msg || '권한 확인 필요'}` };
  }
  if (httpStatus !== 200) {
    return { ...base, state: 'unknown', reason: `유튜브 API 오류 (${httpStatus})` };
  }
  const items = body?.items;
  if (!Array.isArray(items)) {
    // 모양이 바뀌었다. 빈 목록으로 읽으면 '방송 안 함'이 된다.
    return { ...base, state: 'unknown', reason: '유튜브 응답 모양이 예상과 다릅니다' };
  }
  if (items.length === 0) {
    // **이건 확인된 '안 함'이다.** 위의 unknown과 구분된다.
    return { ...base, state: 'offline', reason: '지금 라이브가 없습니다' };
  }

  const it = items[0];
  const videoId = it?.id?.videoId ? String(it.id.videoId) : null;
  if (!videoId) {
    return { ...base, state: 'unknown', reason: '라이브를 찾았지만 영상 id가 없습니다' };
  }
  return {
    channelId, state: 'live', videoId,
    title: it?.snippet?.title ? String(it.snippet.title) : null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    reason: '라이브 중입니다',
  };
}

export function liveSearchUrl(channelId: string, apiKey: string): string {
  const p = new URLSearchParams({
    part: 'snippet', channelId, eventType: 'live', type: 'video',
    maxResults: '1', key: apiKey,
  });
  return `https://www.googleapis.com/youtube/v3/search?${p.toString()}`;
}

/**
 * 실제로 물어본다.
 *
 * 키가 없으면 **부르지 않는다.** 빈 키로 부르면 403이 오고, 그건
 * 위에서 '확인 불가'로 잡히긴 하지만 할당량 초과와 구분이 안 된다.
 */
export async function checkLive(
  channelId: string, apiKey: string | null | undefined,
): Promise<LiveStatus> {
  const base = { channelId, videoId: null, title: null, url: null };
  if (!channelId) {
    return { ...base, state: 'unknown', reason: '채널 id가 없습니다' };
  }
  if (!apiKey) {
    return { ...base, state: 'unknown',
      reason: 'YOUTUBE_API_KEY가 없습니다 — 방송 감지를 켜려면 환경변수에 넣으세요' };
  }
  try {
    const r = await fetch(liveSearchUrl(channelId, apiKey), {
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    });
    let body: any = null;
    try { body = await r.json(); } catch { /* 아래에서 unknown */ }
    return parseLiveSearch(channelId, r.status, body);
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return { ...base, state: 'unknown',
      reason: aborted ? '유튜브 응답이 10초 안에 오지 않았습니다' : `유튜브에 연결하지 못했습니다: ${e?.message || e}` };
  }
}

/** 화면에 그대로 쓸 라벨. 확인 불가를 '꺼짐'으로 그리지 않기 위한 한 곳 */
export const LIVE_LABEL: Record<LiveState, { text: string; note: string }> = {
  live:    { text: 'LIVE',      note: '지금 방송 중입니다' },
  offline: { text: '방송 없음',  note: '확인했고 라이브가 없습니다' },
  unknown: { text: '확인 불가',  note: '방송 여부를 확인하지 못했습니다 — 꺼졌다는 뜻이 아닙니다' },
};
