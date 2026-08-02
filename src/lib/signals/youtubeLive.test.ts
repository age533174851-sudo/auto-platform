import { test, eq, assert } from '../../test/harness';
import {
  parseLiveSearch, remainingChecks, pollIntervalMs, channelIdFromUrl,
  liveSearchUrl, LIVE_LABEL, SEARCH_COST, DAILY_QUOTA,
} from './youtubeLive';

export function runYoutubeLiveTests() {
  console.log('[유튜브 라이브 — 확인 못 한 것을 꺼짐으로 읽지 않는다]');

  const live = { items: [{ id: { videoId: 'abc123' }, snippet: { title: 'BTC 방송' } }] };

  // ── 응답 해석 ───────────────────────────────────────────
  test('라이브를 찾으면 링크까지 준다', () => {
    const r = parseLiveSearch('UC1', 200, live);
    eq(r.state, 'live');
    eq(r.videoId, 'abc123');
    eq(r.title, 'BTC 방송');
    assert(r.url!.includes('abc123'), r.url!);
  });

  test('빈 목록은 확인된 방송 없음이다', () => {
    const r = parseLiveSearch('UC1', 200, { items: [] });
    eq(r.state, 'offline');
  });

  test('할당량 초과를 꺼짐으로 읽지 않는다', () => {
    // 이걸 offline으로 읽으면 오후 내내 모든 채널이 꺼진 것으로 보인다.
    // 실제로는 확인을 못 한 것이다.
    const r = parseLiveSearch('UC1', 403, { error: { message: 'quotaExceeded' } });
    eq(r.state, 'unknown');
    assert(r.reason.includes('할당량'), r.reason);
  });

  test('권한 문제도 확인 불가다', () => {
    const r = parseLiveSearch('UC1', 403, { error: { message: 'API key not valid' } });
    eq(r.state, 'unknown');
    assert(r.reason.includes('API key'), r.reason);
  });

  test('다른 오류도 확인 불가다', () => {
    eq(parseLiveSearch('UC1', 500, {}).state, 'unknown');
    eq(parseLiveSearch('UC1', 404, {}).state, 'unknown');
  });

  test('응답 모양이 바뀌면 빈 목록으로 읽지 않는다', () => {
    // items가 없는 것을 '방송 안 함'으로 읽으면 조용히 전부 꺼진다.
    eq(parseLiveSearch('UC1', 200, {}).state, 'unknown');
    eq(parseLiveSearch('UC1', 200, null).state, 'unknown');
    eq(parseLiveSearch('UC1', 200, { items: 'nope' }).state, 'unknown');
  });

  test('영상 id가 없으면 라이브라고 하지 않는다', () => {
    // 링크를 못 만들면 사용자가 확인할 방법이 없다.
    eq(parseLiveSearch('UC1', 200, { items: [{ snippet: { title: 'x' } }] }).state, 'unknown');
  });

  test('제목이 없어도 라이브는 라이브다', () => {
    const r = parseLiveSearch('UC1', 200, { items: [{ id: { videoId: 'v1' } }] });
    eq(r.state, 'live');
    eq(r.title, null);
  });

  // ── 할당량 ──────────────────────────────────────────────
  test('search 한 번은 100단위다', () => {
    // 이게 이 기능의 진짜 제약이다. 하루 100번이 전부다.
    eq(SEARCH_COST, 100);
    eq(remainingChecks(0), DAILY_QUOTA / SEARCH_COST);
  });

  test('쓴 만큼 줄어든다', () => {
    eq(remainingChecks(5000), 50);
    eq(remainingChecks(10000), 0);
  });

  test('넘게 썼어도 음수가 안 된다', () => {
    eq(remainingChecks(99999), 0);
    eq(remainingChecks(-5), 0);
    eq(remainingChecks(NaN), 0);
  });

  // ── 확인 간격 ───────────────────────────────────────────
  test('채널이 많을수록 간격이 길어진다', () => {
    const one = pollIntervalMs(1)!;
    const five = pollIntervalMs(5)!;
    assert(five > one, `5채널(${five})이 1채널(${one})보다 길어야 한다`);
  });

  test('하루 할당량 안에 들어간다', () => {
    // 짧게 잡으면 오전에 다 쓰고 저녁 방송을 못 본다.
    const n = 5;
    const ms = pollIntervalMs(n)!;
    const callsPerDay = (86_400_000 / ms) * n;
    assert(callsPerDay * SEARCH_COST <= DAILY_QUOTA,
      `하루 ${callsPerDay * SEARCH_COST}단위 — 할당량 초과`);
  });

  test('여유를 남긴다', () => {
    // 수동 새로고침이나 다른 기능이 쓸 몫이다.
    const ms = pollIntervalMs(1)!;
    const used = (86_400_000 / ms) * SEARCH_COST;
    assert(used < DAILY_QUOTA * 0.75, `${used}단위 — 너무 많이 쓴다`);
  });

  test('채널이 없으면 간격도 없다', () => {
    eq(pollIntervalMs(0), null);
    eq(pollIntervalMs(-1), null);
    eq(pollIntervalMs(NaN), null);
  });

  test('채널이 너무 많으면 null로 알린다', () => {
    // 몰래 몇 개만 확인하면 나머지는 영영 안 본다.
    eq(pollIntervalMs(1000), null);
  });

  // ── 채널 id ─────────────────────────────────────────────
  test('/channel/UC… 에서 뽑는다', () => {
    eq(channelIdFromUrl('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'),
       'UCabcdefghijklmnopqrstuv');
  });

  test('id를 그대로 줘도 된다', () => {
    eq(channelIdFromUrl('UCabcdefghijklmnopqrstuv'), 'UCabcdefghijklmnopqrstuv');
  });

  test('핸들이나 사용자명은 추측하지 않는다', () => {
    // 추측하면 엉뚱한 채널을 감시한다.
    eq(channelIdFromUrl('https://www.youtube.com/@wedom'), null);
    eq(channelIdFromUrl('https://www.youtube.com/c/someone'), null);
    eq(channelIdFromUrl('https://chzzk.naver.com/abc'), null);
    eq(channelIdFromUrl(''), null);
    eq(channelIdFromUrl(null), null);
  });

  // ── 주소 ────────────────────────────────────────────────
  test('라이브만 찾는 주소를 만든다', () => {
    const u = liveSearchUrl('UC1', 'KEY');
    assert(u.includes('eventType=live'), u);
    assert(u.includes('channelId=UC1'), u);
    assert(u.includes('key=KEY'), u);
    // 하나만 받으면 된다 — 더 받아도 비용은 같지만 쓰지 않는다
    assert(u.includes('maxResults=1'), u);
  });

  // ── 라벨 ────────────────────────────────────────────────
  test('확인 불가를 꺼짐처럼 적지 않는다', () => {
    assert(LIVE_LABEL.unknown.note.includes('꺼졌다는 뜻이 아닙니다'), LIVE_LABEL.unknown.note);
    assert(LIVE_LABEL.offline.note.includes('확인했고'), LIVE_LABEL.offline.note);
  });
}
