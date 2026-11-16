// src/lib/ui/refreshState.test.ts
//
// 막으려는 것: **갱신 한 번 실패가 "데이터 없음"으로 보이는 것.**
//
// `PaperAutomationControl`은 15초마다 다시 읽는데, 그 호출이 한 번 실패하면
// 잔고·체결 이력·반복 상태를 전부 지우고 "상태 확인 전"을 띄웠다. 확인을
// 했고 실패한 것인데 "확인 전"이라고 적은 것이고, 사용자는 자기 모의 계좌가
// 비었거나 자동매매가 꺼진 것으로 읽을 수 있다.
//
// 반대 방향도 막는다: 낡은 값을 **현재값처럼 조용히** 보여 주면 안 된다.
// 남겨 두되 낡았다고 적어야 하고, 그 판정은 `dataQuality.assess()`가 한다 —
// 여기서 다시 만들지 않는다.

import { test, eq, assert } from '../../test/harness';
import { refreshStart, refreshOk, refreshFailed, refreshCleared } from './refreshState';
import { assess } from '../engine/dataQuality';

const T0 = 1_700_000_000_000;
const SNAP = { enabled: true, balance: 61_258.32 };
/** 화면이 쓰는 그대로: 주기 수신 · 15초 주기 */
const look = (okAt: number | null, now: number) =>
  assess({ kind: okAt == null ? 'UNAVAILABLE' : 'POLLED', origin: '서버', label: '반복 상태',
    asOf: okAt, expectedIntervalMs: 15_000 }, now);

export function runRefreshStateTests() {
  console.log('[갱신 상태 — 실패를 "없음"으로 적지 않는다]');

  test('★★ 한 번 실패해도 방금까지 보던 값을 지우지 않는다', () => {
    // 지우면 "지금 읽은 결과 비어 있음"과 구별되지 않는다 — 사용자는
    // 모의 계좌가 비었거나 자동매매가 꺼진 것으로 읽는다.
    const ok = refreshOk(SNAP, T0);
    const bad = refreshFailed(ok, '서버 반복 상태를 확인하지 못했습니다');
    eq(bad.data, SNAP, '값을 버렸다 — 이게 원래 고장이다');
    eq(bad.okAt, T0, '마지막 성공 시각을 버렸다');
    assert(bad.error.length > 0, '오류를 숨기면 안 된다');
    eq(bad.failures, 1);
  });

  test('★★ 그래도 낡았다는 사실이 드러난다 — 판정은 dataQuality가 한다', () => {
    // 남겨 두는 것과 현재값처럼 보여 주는 것은 다르다.
    const bad = refreshFailed(refreshOk(SNAP, T0), '조회 실패');
    const v = look(bad.okAt, T0 + 200_000);   // 15초 주기 × 10배 초과
    eq(v.freshness, 'STALE');
    eq(v.tradeable, false);
    assert(v.text.includes('분 전'), `언제 읽은 값인지 적어야 한다: ${v.text}`);
  });

  test('★ 한 번도 성공하지 않았으면 보여 줄 값이 없는 것이 맞다', () => {
    const bad = refreshFailed(refreshStart<typeof SNAP>(), '조회 실패');
    eq(bad.data, null);
    eq(bad.okAt, null);
    const v = look(bad.okAt, T0);
    eq(v.freshness, 'NONE');
    eq(v.ageMs, null, '못 잰 나이를 0으로 적지 않는다');
  });

  test('성공하면 오류와 실패 기록이 지워진다', () => {
    const next = refreshOk(SNAP, T0 + 1000);
    eq(next.error, '');
    eq(next.failures, 0);
    eq(look(next.okAt, T0 + 1000).freshness, 'FRESH');
  });

  test('연속 실패가 쌓인다 — 한 번 끊긴 것과 계속 끊긴 것은 다르다', () => {
    let s = refreshOk(SNAP, T0);
    for (let i = 1; i <= 4; i++) s = refreshFailed(s, '조회 실패');
    eq(s.failures, 4);
    eq(s.data, SNAP, '실패가 쌓여도 값은 그대로다');
    eq(s.okAt, T0);
  });

  test('오류 메시지가 비어 있어도 "오류 없음"으로 보이지 않는다', () => {
    const s = refreshFailed(refreshOk(SNAP, T0), '');
    assert(s.error.length > 0, `빈 메시지가 무음이 되면 안 된다: ${JSON.stringify(s.error)}`);
  });

  test('★ 비우는 것은 따로 있다 — 로그아웃처럼 정말 없을 때만', () => {
    const s = refreshCleared<typeof SNAP>();
    eq(s.data, null); eq(s.okAt, null); eq(s.error, ''); eq(s.failures, 0);
  });
}
