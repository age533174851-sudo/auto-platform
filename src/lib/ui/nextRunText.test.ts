// 사진(7055.jpg)이 잡아 준 두 고장을 시험으로 고정한다.
//
//   ① 정지된 봇에 시각을 적었다 — 오지 않을 약속
//   ② 30초 뒤 시각을 연·월·일·초까지 적었다 — 목록이 열 줄이 된 이유
//
// 시간대는 **고정해서** 넣는다. 벽시계나 실행 환경의 TZ에 기대면 이
// 시험은 CI에서만 빨개지거나, 더 나쁘게는 조용히 통과한다.
import { test, assert, eq } from '../../test/harness';
import { nextRunText, compactTime, parseAt, UNKNOWN_TEXT } from './nextRunText';

const KST = 'Asia/Seoul';
/** 2026-11-18 13:16 KST */
const NOW = Date.parse('2026-11-18T04:16:00.000Z');
const at = (iso: string) => Date.parse(iso);

export function runNextRunTextTests() {
  // ── ① 오지 않을 약속을 적지 않는다 ──
  test('★★ 정지된 봇에는 시각이 아니라 이유를 적는다', () => {
    const v = nextRunText({ blockedReason: '예정 없음', blockedDetail: '정지된 봇입니다',
      atMs: at('2026-11-18T04:15:32Z'), nowMs: NOW, timeZone: KST });
    eq(v.text, '예정 없음');
    eq(v.detail, '정지된 봇입니다');
    eq(v.blocked, true);
    assert(!/\d{1,2}:\d{2}/.test(v.text), `정지인데 시각을 적었습니다: ${v.text}`);
  });

  test('막힌 이유는 시각보다 **먼저** 본다 — 지난 시각이어도 이유가 이긴다', () => {
    const v = nextRunText({ blockedReason: '예정 없음', atMs: at('2026-11-16T04:00:00Z'), nowMs: NOW, timeZone: KST });
    eq(v.text, '예정 없음');
    eq(v.overdue, false);
  });

  // 320px에서 이 칸은 105px다. 긴 문장은 말줄임이 뜻을 지운다 —
  // 실측에서 「지금 차례 — 다음 회차에 평가합니다」가 180px를 요구했다.
  test('★★ 좁은 칸에 들어갈 만큼 짧다 — 설명은 detail로 내린다', () => {
    const cases = [
      nextRunText({ blockedReason: '예정 없음', nowMs: NOW }),
      nextRunText({ atMs: NOW - 1, nowMs: NOW }),
      nextRunText({ atMs: null, nowMs: NOW }),
      nextRunText({ atMs: NOW + 60_000, nowMs: NOW, timeZone: KST }),
    ];
    for (const v of cases) {
      assert(v.text.length <= 9, `칸에 안 들어갑니다(${v.text.length}자): 「${v.text}」`);
      assert(v.detail.length >= v.text.length, `설명이 더 짧습니다: 「${v.detail}」`);
    }
  });

  // ── ② 못 읽은 것을 0이나 "없음"으로 적지 않는다 ──
  test('★★ 시각을 못 읽으면 확인 불가다 — "아직 없음"이 아니다', () => {
    for (const bad of [null, undefined, NaN]) {
      const v = nextRunText({ atMs: bad as any, nowMs: NOW, timeZone: KST });
      eq(v.text, UNKNOWN_TEXT);
      eq(v.blocked, false);
      eq(v.overdue, false);
    }
  });

  test('parseAt은 못 읽은 것을 null로 준다 — 0으로 주지 않는다', () => {
    eq(parseAt(null), null);
    eq(parseAt(''), null);
    eq(parseAt('아직 없음'), null);
    eq(parseAt('2026-11-18T04:15:32.000Z'), at('2026-11-18T04:15:32Z'));
  });

  // ── ③ 지난 시각은 "다음"이 아니다 ──
  test('★★ 예정 시각이 지났으면 지금 차례라고 적는다', () => {
    const v = nextRunText({ atMs: at('2026-11-18T04:15:32Z'), nowMs: NOW, timeZone: KST });
    eq(v.overdue, true);
    eq(v.text, '지금 차례');
    assert(v.detail.includes('지났습니다'), v.detail);
  });

  test('경계 — 같은 ms는 지난 것으로, 1ms 뒤는 미래로 본다', () => {
    eq(nextRunText({ atMs: NOW, nowMs: NOW, timeZone: KST }).overdue, true);
    eq(nextRunText({ atMs: NOW + 1, nowMs: NOW, timeZone: KST }).overdue, false);
  });

  // ── ④ 길이 — 사진의 「2026. 11. 18. 오후 1:15:32」를 없앤다 ──
  test('★★ 오늘 안에 올 시각에는 날짜도 초도 적지 않는다', () => {
    const v = nextRunText({ atMs: at('2026-11-18T05:30:00Z'), nowMs: NOW, timeZone: KST });
    eq(v.text, '오후 2:30');
    assert(!v.text.includes('2026'), v.text);
    assert(!/:\d{2}:\d{2}/.test(v.text), `초를 적었습니다: ${v.text}`);
  });

  test('사진 속 문자열보다 실제로 짧다', () => {
    const before = new Date(at('2026-11-18T05:30:00Z')).toLocaleString('ko-KR', { timeZone: KST });
    const after = nextRunText({ atMs: at('2026-11-18T05:30:00Z'), nowMs: NOW, timeZone: KST }).text;
    assert(after.length * 2 < before.length,
      `짧아지지 않았습니다: 「${before}」(${before.length}) → 「${after}」(${after.length})`);
  });

  test('내일·어제는 날짜 대신 말로 적는다', () => {
    eq(compactTime(at('2026-11-19T05:30:00Z'), NOW, KST), '내일 오후 2:30');
    eq(compactTime(at('2026-11-17T05:30:00Z'), NOW, KST), '어제 오후 2:30');
  });

  test('그보다 먼 날은 월·일까지만 적는다 — 연도는 적지 않는다', () => {
    const s = compactTime(at('2026-11-25T05:30:00Z'), NOW, KST);
    assert(s.includes('11') && s.includes('25'), s);
    assert(!s.includes('2026'), `연도를 적었습니다: ${s}`);
  });

  // 자정을 사이에 둔 30분 뒤는 "오늘"이 아니다. 로컬 날짜로 갈라야 한다.
  test('자정을 넘긴 30분 뒤는 내일로 적는다 — 시:분만 적으면 어제처럼 보인다', () => {
    const night = Date.parse('2026-11-18T14:50:00.000Z'); // 23:50 KST
    eq(compactTime(night + 30 * 60_000, night, KST), '내일 오전 12:20');
  });

  test('못 읽은 ms는 compactTime도 확인 불가로 준다', () => {
    eq(compactTime(NaN, NOW, KST), UNKNOWN_TEXT);
  });
}
