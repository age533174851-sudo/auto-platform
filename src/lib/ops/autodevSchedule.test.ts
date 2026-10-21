// src/lib/ops/autodevSchedule.test.ts
//
// **예약이 꺼진 상태가 초록으로 보이는 길을 막는다.**
//
// 실제로 그랬다. 두 워크플로의 예약은 매시 발화하는데 회차는 전부
// `conclusion=skipped`로 끝났고(저장소 변수가 켜져 있지 않다), 검사기는
// 그 사실과 무관하게 ✅만 찍었다. 검사기가 보던 조건이 "두 예약 시각이
// 같은가" 하나뿐이라, **예약이 아예 없어도 통과**했기 때문이다.

import { test, eq, assert } from '../../test/harness';
import {
  laneScheduleOf, autodevScheduleVerdict,
} from './autodevSchedule';

const WITH_CRON = (cron: string) => `name: X

on:
  schedule:
    # 정시를 피한다
    - cron: '${cron}'
  workflow_dispatch:
    inputs:
      focus:
        default: ''

concurrency:
  group: claude-hourly-autodev
`;

const MANUAL = `name: X

on:
  workflow_dispatch:
    inputs:
      focus:
        default: ''

concurrency:
  group: claude-hourly-autodev
`;

export function runAutodevScheduleTests() {
  console.log('[무인 회차 예약 — 꺼진 것을 초록으로 적지 않는다]');

  test('예약이 있으면 cron 값을 읽는다', () => {
    const l = laneScheduleOf('dev', WITH_CRON('17 * * * *'));
    eq(l.state, 'SCHEDULED');
    eq(l.cron, '17 * * * *');
  });

  test('★ 예약이 없으면 "수동 전용"이지 "문제 없음"이 아니다', () => {
    const l = laneScheduleOf('dev', MANUAL);
    eq(l.state, 'MANUAL_ONLY');
    eq(l.cron, null);
  });

  test('★ 파일이 없는 것과 예약이 없는 것을 구분한다', () => {
    eq(laneScheduleOf('dev', null).state, 'WORKFLOW_MISSING');
    eq(laneScheduleOf('dev', undefined).state, 'WORKFLOW_MISSING');
  });

  test('★ on: 블록을 못 찾으면 UNKNOWN이다 — 예약 없음으로 적지 않는다', () => {
    eq(laneScheduleOf('dev', 'name: X\njobs:\n  a: {}\n').state, 'UNREADABLE');
  });

  test('★ 주석과 프롬프트 본문의 cron 글자를 예약으로 읽지 않는다', () => {
    // `on:` 블록 **밖**에 있는 글자다. 이것을 예약으로 읽으면 예약이
    // 없는데 있다고 결론 내린다.
    const src = `name: X

on:
  workflow_dispatch: {}

jobs:
  dev:
    steps:
      - run: echo "cron: '17 * * * *' 는 예전 설정이다"
`;
    eq(laneScheduleOf('dev', src).state, 'MANUAL_ONLY');
  });

  test('★ on: 블록 안의 주석에 적힌 cron도 예약이 아니다', () => {
    const src = `name: X

on:
  # - cron: '17 * * * *'   ← 껐다
  workflow_dispatch: {}

jobs: {}
`;
    eq(laneScheduleOf('dev', src).state, 'MANUAL_ONLY');
  });

  test('두 갈래가 서로 다른 시각에 예약돼 있으면 통과한다', () => {
    const v = autodevScheduleVerdict([
      { name: 'dev', source: WITH_CRON('17 * * * *') },
      { name: 'trading', source: WITH_CRON('47 * * * *') },
    ]);
    eq(v.ok, true); eq(v.code, 'SCHEDULED');
    assert(v.summary.includes('17 * * * *') && v.summary.includes('47 * * * *'), v.summary);
  });

  test('★ 두 예약을 모두 지운 트리는 통과하되 "수동 전용"이라고 적는다', () => {
    // **실패로 만들지 않는다.** 사람이 끄기로 할 수 있다. 다만 초록이
    // "무인 회차가 돌고 있다"는 뜻이 되면 끈 것을 잊는다.
    const v = autodevScheduleVerdict([
      { name: 'dev', source: MANUAL },
      { name: 'trading', source: MANUAL },
    ]);
    eq(v.ok, true);
    eq(v.code, 'MANUAL_ONLY');
    assert(/수동 실행 전용/.test(v.summary), v.summary);
    assert(!/돌고 있다/.test(v.summary), v.summary);
  });

  test('★ 한 갈래만 예약돼 있으면 막는다 — 조용히 한쪽만 도는 상태', () => {
    for (const [a, b] of [[WITH_CRON('17 * * * *'), MANUAL], [MANUAL, WITH_CRON('47 * * * *')]]) {
      const v = autodevScheduleVerdict([
        { name: 'dev', source: a }, { name: 'trading', source: b },
      ]);
      eq(v.ok, false);
      eq(v.code, 'SPLIT');
      assert(v.errors.join(' ').includes('한 갈래만'), v.errors.join(' '));
    }
  });

  test('두 갈래의 예약 시각이 같으면 막는다 (기존 규칙)', () => {
    const v = autodevScheduleVerdict([
      { name: 'dev', source: WITH_CRON('17 * * * *') },
      { name: 'trading', source: WITH_CRON('17 * * * *') },
    ]);
    eq(v.ok, false); eq(v.code, 'SAME_TIME');
  });

  test('★ 워크플로를 읽지 못하면 막는다 — 못 읽은 것은 "예약 없음"이 아니다', () => {
    for (const bad of [null, 'name: X\njobs: {}\n']) {
      const v = autodevScheduleVerdict([
        { name: 'dev', source: bad }, { name: 'trading', source: WITH_CRON('47 * * * *') },
      ]);
      eq(v.ok, false);
      eq(v.code, 'UNREADABLE');
    }
  });

  // 실제 워크플로 파일로 거는 판정은 검사기(`check-claude-hourly.mjs`)가 한다 —
  // 이 러너는 `src`만 복사해서 돌아 `.github/`가 없다.
}
