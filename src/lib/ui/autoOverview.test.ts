// src/lib/ui/autoOverview.test.ts
//
// 막으려는 것:
//  1. **'진입 안 함'을 '진입'으로 읽는 것.** 문자열이 둘 다 '진입'으로
//     시작한다 — 순서를 잘못 보면 포지션이 없는데 있다고 믿게 된다
//  2. 점수를 못 읽었는데 0:0으로 그리는 것. 0은 '모름'이 아니라
//     '완전한 무승부'로 읽힌다
//  3. 확인 못 한 항목을 '정상'으로 세는 것
//  4. 문제가 있는데 접혀 있는 것 / 정상인데 늘 펼쳐져 있는 것
//  5. 모르는 mode를 실전으로도 모의로도 읽는 것
//  6. '전략 중지'가 열린 포지션 관리까지 멈추는 것으로 읽히는 것
import { test, assert, eq } from '../../test/harness';
import {
  AUTO_TABS, tabOf, envOf, autoTitle, ENV_TONE, headerEnvOf,
  healthSummaryOf, healthTone,
  parseScores, decisionCardOf,
  primaryCardOf, stopStrategyEffect,
  alertsOf, FEED_LAG_WARN_SEC,
  scheduleSummaryOf,
} from './autoOverview';
import { evaluateBattle, DEFAULT_MIN_MARGIN } from '../strategies/dailyBattle';

export function runAutoOverviewTests() {
  console.log('[자동매매 개요 — 탭과 환경]');

  test('진단이 마지막 탭이다 — 지금 화면 대부분이 여기로 간다', () => {
    eq(AUTO_TABS.length, 5);
    eq(AUTO_TABS[0].id, 'overview');
    eq(AUTO_TABS[AUTO_TABS.length - 1].id, 'diagnostics');
  });

  test('모르는 탭은 개요다', () => {
    eq(tabOf(null), 'overview');
    eq(tabOf('아무거나'), 'overview');
    eq(tabOf('history'), 'history');
  });

  test('모르는 mode를 실전으로 읽지 않는다', () => {
    // 실전으로 읽으면 멀쩡한 화면이 겁을 주고, 모의로 읽으면 실제 돈이
    // 나가는 화면이 조용해진다.
    eq(envOf(null), 'TESTNET');
    eq(envOf(''), 'TESTNET');
    eq(envOf('아무거나'), 'TESTNET');
    eq(envOf('TESTNET'), 'TESTNET');
  });

  test('LIVE로 시작하면 실전이다', () => {
    eq(envOf('LIVE'), 'LIVE');
    eq(envOf('LIVE_SMALL'), 'LIVE');
    eq(envOf('live_small'), 'LIVE');
    eq(ENV_TONE.LIVE, 'live');
  });

  test('PAPER는 모의다', () => {
    eq(envOf('PAPER'), 'MOCK');
    eq(envOf('MOCK'), 'MOCK');
  });

  test("제목이 '실제 실행' 대신 환경을 말한다", () => {
    eq(autoTitle('LIVE'), '자동매매 (실전)');
    eq(autoTitle('TESTNET'), '자동매매 (테스트넷)');
    eq(autoTitle('MOCK'), '자동매매 (모의)');
    for (const e of ['LIVE', 'TESTNET', 'MOCK'] as const) {
      assert(!autoTitle(e).includes('실제 실행'), autoTitle(e));
    }
  });

  test('예약이 섞이면 가장 위험한 환경을 적는다', () => {
    // 실전 예약이 하나라도 켜져 있는데 머리말이 TESTNET이면, 사용자는
    // 실제 돈이 걸린 화면을 연습 화면으로 본다.
    eq(headerEnvOf([
      { enabled: true, mode: 'TESTNET' }, { enabled: true, mode: 'LIVE_SMALL' },
    ]), 'LIVE');
    eq(headerEnvOf([{ enabled: true, mode: 'PAPER' }, { enabled: true, mode: 'TESTNET' }]), 'TESTNET');
    eq(headerEnvOf([{ enabled: true, mode: 'PAPER' }]), 'MOCK');
  });

  test('꺼 둔 실전 예약으로 화면을 빨갛게 만들지 않는다', () => {
    // 그 빨강은 곧 배경이 되고, 진짜 실전일 때 아무도 안 놀란다.
    eq(headerEnvOf([{ enabled: false, mode: 'LIVE' }, { enabled: true, mode: 'TESTNET' }]), 'TESTNET');
    eq(headerEnvOf([]), 'TESTNET');
    eq(headerEnvOf(null), 'TESTNET');
  });

  console.log('[자동매매 개요 — 점검을 접는다]');

  const ok = (id: string) => ({ id, label: id, state: 'ok' as const });
  const bad = (id: string) => ({ id, label: id, state: 'bad' as const });
  const unk = (id: string) => ({ id, label: id, state: 'unknown' as const });

  test('전부 정상이면 한 줄로 접힌다', () => {
    const s = healthSummaryOf([ok('a'), ok('b'), ok('c')]);
    eq(s.label, '3/3 정상');
    eq(s.allGood, true);
    eq(s.expandByDefault, false);
    eq(healthTone(s), 'good');
  });

  test('막힌 것이 있으면 펼치고 개수를 적는다', () => {
    const s = healthSummaryOf([ok('a'), ok('b'), bad('연결')]);
    eq(s.label, '2/3 · 주문 차단 항목 1개');
    eq(s.expandByDefault, true);
    eq(s.blockingCount, 1);
    eq(s.blockingLabels[0], '연결');
    eq(healthTone(s), 'bad');
  });

  test('확인 못 한 것을 정상으로 세지 않는다', () => {
    // 확인하지 못한 것은 통과가 아니다.
    const s = healthSummaryOf([ok('a'), ok('b'), unk('크론')]);
    eq(s.ok, 2);
    eq(s.allGood, false);
    assert(!s.label.includes('정상'), s.label);
    assert(s.label.includes('확인 못 한 항목 1개'), s.label);
    eq(healthTone(s), 'warn');
  });

  test('확인 못 한 것만으로는 펼치지 않는다 — 대신 접힌 줄에 적는다', () => {
    // 이것까지 펼치면 거의 언제나 펼쳐져 있고, 그러면 접는 뜻이 없다.
    const s = healthSummaryOf([ok('a'), unk('b')]);
    eq(s.expandByDefault, false);
    assert(s.label.includes('1개'), s.label);
  });

  test('항목을 하나도 못 읽으면 정상이라고 하지 않는다', () => {
    const s = healthSummaryOf([]);
    eq(s.allGood, false);
    eq(healthTone(s), 'muted');
    assert(s.label.includes('읽지 못했'), s.label);
  });

  console.log('[자동매매 개요 — 마지막 판단]');

  test("'진입 안 함'을 '진입'으로 읽지 않는다", () => {
    const c = decisionCardOf({ lastResult: '진입 안 함: 조건 불충족' });
    eq(c.verdict, 'WATCHING');
    eq(c.badge, '거래 안 함');
    eq(c.tone, 'warn', '관망은 실패와 같은 색이면 안 된다');
  });

  test('진입은 초록이다', () => {
    const c = decisionCardOf({ lastResult: '진입: 체결 0.01 BTC' });
    eq(c.verdict, 'ENTERED');
    eq(c.tone, 'good');
  });

  test('연결 없음은 차단이지 관망이 아니다', () => {
    const c = decisionCardOf({ lastResult: '연결 없음' });
    eq(c.verdict, 'BLOCKED');
    eq(c.tone, 'bad');
  });

  test('실패는 오류다', () => {
    eq(decisionCardOf({ lastResult: '호출 실패: timeout' }).verdict, 'ERROR');
    eq(decisionCardOf({ lastResult: '실패 (500)' }).verdict, 'ERROR');
  });

  test('기록이 없으면 없다고 한다', () => {
    const c = decisionCardOf({ lastResult: null });
    eq(c.verdict, 'UNKNOWN');
    eq(c.scoresKnown, false);
    eq(c.longScore, null);
  });

  test('모르는 문장은 정상으로도 오류로도 세지 않는다', () => {
    const c = decisionCardOf({ lastResult: '알 수 없는 무언가' });
    eq(c.verdict, 'UNKNOWN');
    eq(c.detail, '알 수 없는 무언가', '원문을 그대로 보여줘야 한다');
  });

  test('점수를 못 읽으면 0으로 채우지 않는다', () => {
    // 0:0은 '모름'이 아니라 '완전한 무승부'로 읽힌다.
    const c = decisionCardOf({ lastResult: '진입 안 함: 조건 불충족' });
    eq(c.scoresKnown, false);
    eq(c.longScore, null);
    eq(c.shortScore, null);
    eq(c.margin, null);
  });

  console.log('[자동매매 개요 — 점수 읽기는 dailyBattle 문장에 매여 있다]');

  test('거래 안 하는 문장에서 점수를 읽는다', () => {
    const s = '점수 차이 8점이 최소 우위 12점 미만 — 오늘은 거래하지 않습니다 (LONG 54 : 46 SHORT)';
    const v = parseScores(s);
    eq(v.longScore, 54);
    eq(v.shortScore, 46);
    eq(v.margin, 8);
    eq(v.minMargin, 12);
  });

  test('우세 문장에서도 읽는다 — 앞이 언제나 LONG이다', () => {
    // dailyBattle은 side와 무관하게 longTotal : shortTotal 순으로 적는다.
    const a = parseScores('LONG 우세 (54 : 46) · 5개 축 중 3개 동의 · 점수차 8점');
    eq(a.longScore, 54); eq(a.shortScore, 46); eq(a.margin, 8);

    const b = parseScores('SHORT 우세 (41 : 62) · 5개 축 중 4개 동의 · 점수차 21점');
    eq(b.longScore, 41, 'SHORT 우세여도 앞 숫자는 LONG 점수다');
    eq(b.shortScore, 62);
  });

  test('거부 문장(괄호에 공백 없음)에서도 읽는다', () => {
    const v = parseScores('LONG 우세(58:42)였으나 위험 조건으로 진입하지 않습니다 — 급등 후 추격');
    eq(v.longScore, 58);
    eq(v.shortScore, 42);
    eq(v.margin, 16, '문장에 점수차가 없으면 두 점수에서 계산한다');
  });

  test('점수가 없는 문장에서는 null이다', () => {
    const v = parseScores('진입 안 함: 캘린더 조건');
    eq(v.longScore, null);
    eq(v.shortScore, null);
    eq(v.minMargin, null);
  });

  test('dailyBattle이 실제로 내는 문장을 그대로 읽는다', () => {
    // **여기가 이 파싱의 안전장치다.** dailyBattle의 문장이 바뀌면
    // 화면이 조용히 점수를 잃는 대신 이 테스트가 먼저 깨진다.
    //
    // 세 갈래(무승부·우세·거부)를 다 지나가도록 여러 흐름을 넣는다.
    const flat = Array.from({ length: 30 }, () => 100);
    const up = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const down = Array.from({ length: 30 }, (_, i) => 160 - i * 2);

    for (const closes of [flat, up, down]) {
      const r = evaluateBattle({ dailyCloses: closes }, { minMargin: DEFAULT_MIN_MARGIN });
      const v = parseScores(r.reason);
      eq(v.longScore, Number(r.longTotal.toFixed(0)), `문장: ${r.reason}`);
      eq(v.shortScore, Number(r.shortTotal.toFixed(0)), `문장: ${r.reason}`);
      if (r.side === 'NO_TRADE' && !r.veto?.vetoed) {
        eq(v.minMargin, r.minMarginRequired, `문장: ${r.reason}`);
        eq(v.margin, Number(r.margin.toFixed(0)), `문장: ${r.reason}`);
      }
    }
  });

  test('관망 카드가 실제 차이와 필요 차이를 같이 말한다', () => {
    const c = decisionCardOf({
      symbol: 'BTCUSDT',
      lastResult: '진입 안 함: 점수 차이 8점이 최소 우위 12점 미만 — 오늘은 거래하지 않습니다 (LONG 54 : 46 SHORT)',
    });
    eq(c.verdict, 'WATCHING');
    eq(c.scoresKnown, true);
    eq(c.longScore, 54);
    eq(c.margin, 8);
    eq(c.minMargin, 12);
    assert(c.headline.includes('실제 차이 8점'), c.headline);
    assert(c.headline.includes('최소차이 12점'), c.headline);
  });

  test('얼마나 지났는지 센다', () => {
    const c = decisionCardOf({ lastResult: '진입 안 함: x', nowMs: 1000, lastRunAtMs: 400 });
    eq(c.agoMs, 600);
    eq(decisionCardOf({ lastResult: 'x' }).agoMs, null);
  });

  console.log('[자동매매 개요 — 무엇을 위에 두는가]');

  test('포지션이 있으면 포지션이 먼저다', () => {
    eq(primaryCardOf(1), 'POSITION');
    eq(primaryCardOf(0), 'DECISION');
    eq(primaryCardOf(null), 'DECISION');
    eq(primaryCardOf('아무거나'), 'DECISION');
  });

  test('전략 중지는 신규 진입만 멈춘다', () => {
    // 못 여는 것은 불편이고 못 닫는 것은 사고다.
    const e = stopStrategyEffect();
    eq(e.blocksNewEntry, true);
    eq(e.keepsManagingPosition, true);
    assert(e.note.includes('신규 진입만'), e.note);
    assert(e.note.includes('계속'), e.note);
  });

  console.log('[자동매매 개요 — 정상일 때는 경고 자리를 안 쓴다]');

  test('정상이면 경고가 하나도 없다', () => {
    eq(alertsOf({}).length, 0);
    eq(alertsOf(null).length, 0);
    eq(alertsOf({ unknownOrders: 0, unprotectedPositions: 0, feedLagSec: 0 }).length, 0);
  });

  test('못 닫는 쪽이 먼저다', () => {
    const a = alertsOf({ unprotectedPositions: 1, unknownOrders: 2 });
    eq(a[0].id, 'unprotected');
    eq(a[1].id, 'unknown');
  });

  test('연결이 끊기면 지연은 따로 안 띄운다', () => {
    // 끊긴 것과 느린 것을 같이 띄우면 무엇을 고쳐야 하는지 흐려진다.
    const a = alertsOf({ feedDown: true, feedLagSec: 30 });
    eq(a.filter(x => x.id === 'lag').length, 0);
    eq(a.filter(x => x.id === 'feed').length, 1);
  });

  test('지연은 기준을 넘을 때만 띄운다', () => {
    eq(alertsOf({ feedLagSec: FEED_LAG_WARN_SEC - 0.1 }).length, 0);
    eq(alertsOf({ feedLagSec: FEED_LAG_WARN_SEC }).length, 1);
  });

  test('막힌 점검 항목은 그대로 경고가 된다', () => {
    const a = alertsOf({ blockingLabels: ['Gate 연결'] });
    eq(a.length, 1);
    assert(a[0].text.includes('Gate 연결'), a[0].text);
  });

  console.log('[자동매매 개요 — 예약 한 줄]');

  test('연결이 없으면 주문을 낼 수 없다고 말한다', () => {
    const s = scheduleSummaryOf({ symbol: 'BTCUSDT', mode: 'TESTNET', interval_min: 10 });
    eq(s.connected, false);
    eq(s.blocking, true);
    assert(s.accountText.includes('주문을 낼 수 없습니다'), s.accountText);
  });

  test('주기를 못 읽으면 지어내지 않는다', () => {
    eq(scheduleSummaryOf({ symbol: 'BTCUSDT', connection_id: 'c1' }).intervalText, '');
    eq(scheduleSummaryOf({ symbol: 'BTCUSDT', connection_id: 'c1', interval_min: 0 }).intervalText, '');
    eq(scheduleSummaryOf({ symbol: 'BTCUSDT', connection_id: 'c1', interval_min: 10 }).intervalText, '10분마다');
  });

  test('계좌는 거래소와 환경을 같이 적는다', () => {
    const s = scheduleSummaryOf(
      { symbol: 'BTCUSDT', mode: 'TESTNET', connection_id: 'c1', interval_min: 10 }, 'Gate');
    eq(s.accountText, 'Gate TESTNET');
    eq(s.env, 'TESTNET');
  });

  test('심볼이 없으면 빈 칸으로 두지 않는다', () => {
    eq(scheduleSummaryOf({}).symbol, '심볼 없음');
  });
}
