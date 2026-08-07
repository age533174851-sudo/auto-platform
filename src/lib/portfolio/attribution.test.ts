// src/lib/portfolio/attribution.test.ts
//
// 막으려는 것:
//  1. **합이 안 맞는데 맞는 것처럼 보여주는 것.** 귀속 분석에서 가장
//     흔한 거짓말이다 — 남는 만큼을 아무 항목에나 밀어 넣으면 화면은
//     언제나 깔끔하고, '설명되지 않은 손익이 있다'는 사실만 사라진다
//  2. 금액을 못 읽은 항목을 0으로 세는 것
//  3. 비중을 순합으로 나눠서 작은 항목이 300%로 뜨는 것
//  4. 비용이 이익의 절반을 먹고 있는데 총손익만 보여주는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  attributionOf, rowsWithResidual, topMoversOf, RECONCILE_EPS,
} from './attribution';

export function runAttributionTests() {
  console.log('[성과 귀속 — 왜 +10%인가]');

  const SAMPLE = [
    { key: 'swing', label: '스윙', amount: 1400 },
    { key: 'vwap', label: 'VWAP', amount: 600 },
    { key: 'fees', label: '수수료', amount: -210, isCost: true },
    { key: 'funding', label: '펀딩비', amount: -90, isCost: true },
  ];

  test('항목을 쪼개고 합을 낸다', () => {
    const a = attributionOf(SAMPLE, 1700);
    eq(a.explained, 1700);
    eq(a.reported, 1700);
    eq(a.unexplained, 0);
    eq(a.reconciled, true);
    eq(a.reason, '');
  });

  test('벌어들인 쪽과 나간 쪽을 따로 센다', () => {
    const a = attributionOf(SAMPLE, 1700);
    eq(a.grossGain, 2000);
    eq(a.grossCost, 300);
  });

  console.log('[성과 귀속 — 합이 안 맞으면 그렇다고 말한다]');

  test('남는 것을 아무 항목에나 얹지 않는다', () => {
    // 장부는 +2,000인데 항목 합은 +1,700이다. 300이 어디선가 새고 있다.
    const a = attributionOf(SAMPLE, 2000);
    eq(a.reconciled, false);
    close(a.unexplained!, 300, 1e-9);
    assert(a.reason.includes('안 세고 있는 비용'), a.reason);
    // 항목 자체는 그대로여야 한다 — 아무 데도 300을 안 얹었다.
    eq(a.rows.find(r => r.key === 'swing')!.amount, 1400);
  });

  test('설명되지 않은 부분이 마지막 줄로 선다', () => {
    const a = attributionOf(SAMPLE, 2000);
    const rows = rowsWithResidual(a);
    eq(rows.length, SAMPLE.length + 1);
    const last = rows[rows.length - 1];
    eq(last.key, '__unexplained__');
    eq(last.label, '설명되지 않음');
    close(last.amount, 300, 1e-9);
  });

  test('맞으면 그 줄을 만들지 않는다', () => {
    eq(rowsWithResidual(attributionOf(SAMPLE, 1700)).length, SAMPLE.length);
  });

  test('반올림 수준의 차이는 경고하지 않는다', () => {
    // 이것까지 띄우면 경고가 배경이 되고 진짜 누락이 묻힌다.
    const a = attributionOf(SAMPLE, 1700 + RECONCILE_EPS / 2);
    eq(a.reconciled, true);
    eq(rowsWithResidual(a).length, SAMPLE.length);
  });

  test('총손익을 안 주면 확인 못 했다고 말한다', () => {
    const a = attributionOf(SAMPLE);
    eq(a.unexplained, null);
    eq(a.reconciled, false, '확인하지 못한 것은 통과가 아니다');
    assert(a.reason.includes('확인하지 못했습니다'), a.reason);
  });

  console.log('[성과 귀속 — 모르는 항목]');

  test('금액을 못 읽은 항목을 0으로 세지 않는다', () => {
    const a = attributionOf([
      { key: 'swing', label: '스윙', amount: 1400 },
      { key: 'vwap', label: 'VWAP', amount: null },
    ], 2000);
    assert(a.missing.includes('VWAP'), a.missing.join(','));
    assert(a.reason.includes('합계에서 빠져'), a.reason);
    eq(a.rows.find(r => r.key === 'vwap')!.known, false);
    eq(a.explained, 1400, '못 읽은 값은 합에 안 들어간다');
  });

  test('진짜 0은 읽은 값이다', () => {
    const a = attributionOf([{ key: 'x', label: 'X', amount: 0 }], 0);
    eq(a.missing.length, 0);
    eq(a.rows[0].known, true);
  });

  console.log('[성과 귀속 — 비중]');

  test('비중을 절대값으로 나눈다 — 300%가 안 뜬다', () => {
    // 순합으로 나누면 이익과 손실이 상쇄돼 분모가 0에 가까워지고,
    // 작은 항목이 터무니없는 비중으로 뜬다.
    const a = attributionOf([
      { key: 'a', label: 'A', amount: 1000 },
      { key: 'b', label: 'B', amount: -990 },
    ], 10);
    for (const r of a.rows) {
      assert(r.sharePct >= 0 && r.sharePct <= 100, `${r.label} ${r.sharePct}%`);
    }
    close(a.rows[0].sharePct, 1000 / 1990 * 100, 1e-9);
  });

  test('항목이 없으면 비중이 0이다 — 0으로 나누지 않는다', () => {
    const a = attributionOf([], 0);
    eq(a.rows.length, 0);
    eq(a.explained, 0);
  });

  console.log('[성과 귀속 — 한 줄 요약]');

  test('가장 번 것과 가장 잃은 것을 짚는다', () => {
    const m = topMoversOf(attributionOf([
      { key: 'swing', label: '스윙', amount: 1400 },
      { key: 'scalp', label: '스캘핑', amount: -500 },
      { key: 'fees', label: '수수료', amount: -210, isCost: true },
    ], 690));
    eq(m.bestGain!.label, '스윙');
    eq(m.worstLoss!.label, '스캘핑', '비용은 손실 전략으로 세지 않는다');
    eq(m.biggestCost!.label, '수수료');
  });

  test('비용이 이익의 몇 %를 먹었는지 꼭 말한다', () => {
    // 회전이 빠른 전략은 이 값이 조용히 절반을 넘어간다.
    const m = topMoversOf(attributionOf([
      { key: 'scalp', label: '스캘핑', amount: 1000 },
      { key: 'fees', label: '수수료', amount: -600, isCost: true },
    ], 400));
    close(m.costShareOfGainPct!, 60, 1e-9);
    assert(m.summary.includes('60%'), m.summary);
  });

  test('이익이 없으면 비용 비중을 지어내지 않는다', () => {
    const m = topMoversOf(attributionOf([
      { key: 'fees', label: '수수료', amount: -600, isCost: true },
    ], -600));
    eq(m.costShareOfGainPct, null, '0으로 나누면 Infinity가 화면에 뜬다');
  });

  test('합이 안 맞으면 요약에도 적는다', () => {
    const m = topMoversOf(attributionOf(SAMPLE, 2000));
    assert(m.summary.includes('설명되지 않은 손익'), m.summary);
  });

  test('쪼갤 것이 없으면 없다고 한다', () => {
    eq(topMoversOf(attributionOf([], 0)).summary, '쪼갤 항목이 없습니다');
  });
}
