// src/lib/portfolio/equityCurve.test.ts
//
// 막으려는 것:
//  1. **현재 잔고로 과거를 역산해 그리는 것.** 입출금이 빠지면 100만원을
//     넣은 날이 100만원 번 날로 그려진다. 역산한 곡선은 "대충 맞는 그림"이
//     아니라 틀렸는데 그럴듯한 그림이고, 그걸 보고 사용자는 어느 전략이
//     언제 벌었는지 판단한다
//  2. 구멍을 이어 붙이는 것 — 크론이 이틀 안 돌았는데 양 끝을 직선으로
//     이으면 그 이틀 동안 자산이 매끄럽게 변한 것처럼 보인다
//  3. 못 읽은 총자산을 0으로 그리는 것 — 그래프가 바닥으로 떨어지고
//     사용자는 그 시각에 전액을 잃은 줄 안다
//  4. 자산 차이를 손익이라고 적는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  RANGES, rangeOf, rangeStartMs, curveOf, pointDetailOf, dailyRowsOf,
  snapshotFromRow, GAP_MS, type Snapshot,
} from './equityCurve';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

const S = (daysAgo: number, equity: number | null, over: Partial<Snapshot> = {}): Snapshot => ({
  takenAtMs: NOW - daysAgo * DAY,
  totalEquity: equity,
  ...over,
});

export function runEquityCurveTests() {
  console.log('[자산 그래프 — 없는 점을 만들지 않는다]');

  test('찍어 둔 값이 없으면 그래프를 그리지 않는다', () => {
    // 여기서 현재 잔고로 과거를 되돌려 그리면, 입출금이 빠져서
    // 넣은 날이 번 날로 그려진다.
    const c = curveOf([], '30D', NOW);
    eq(c.hasData, false);
    eq(c.segments.length, 0);
    assert(c.note.includes('되돌려 그리지 않습니다'), c.note);
    assert(c.note.includes('입출금'), c.note);
  });

  test('입력이 아예 없어도 안 터진다', () => {
    eq(curveOf(null, '30D', NOW).hasData, false);
    eq(curveOf(undefined, 'ALL', NOW).segments.length, 0);
  });

  test('이 기간에 점이 없으면 0이었다고 하지 않는다', () => {
    const c = curveOf([S(400, 100)], '30D', NOW);
    eq(c.hasData, false);
    assert(c.note.includes('0이었다는 뜻이 아니라'), c.note);
  });

  console.log('[자산 그래프 — 구멍을 잇지 않는다]');

  test('이틀 넘게 비면 선을 끊는다', () => {
    // 이으면 그 동안 자산이 매끄럽게 변한 것처럼 보인다.
    const c = curveOf([S(20, 100), S(19, 110), S(5, 300), S(4, 310)], '30D', NOW);
    eq(c.segments.length, 2);
    eq(c.gaps, 1);
    eq(c.segments[0].points.length, 2);
    eq(c.segments[1].points.length, 2);
    assert(c.note.includes('선을 잇지 않았습니다'), c.note);
  });

  test('촘촘하면 한 줄로 잇는다', () => {
    const c = curveOf([S(3, 100), S(2, 110), S(1, 120)], '30D', NOW);
    eq(c.segments.length, 1);
    eq(c.gaps, 0);
    eq(c.note, '');
  });

  test('구멍 기준은 상수로 있다', () => {
    eq(GAP_MS, 2 * DAY);
  });

  console.log('[자산 그래프 — 못 읽은 값을 0으로 그리지 않는다]');

  test('총자산을 못 읽은 시점은 빼고, 뺐다고 적는다', () => {
    const c = curveOf([S(3, 100), S(2, null), S(1, 120)], '30D', NOW);
    eq(c.droppedUnreadable, 1);
    // 점 하나가 빠졌어도 남은 둘은 이틀 이내라 한 줄이다.
    eq(c.segments[0].points.length, 2);
    assert(c.note.includes('0으로 그리지 않습니다'), c.note);
  });

  test('전부 못 읽었으면 그리지 않는다', () => {
    const c = curveOf([S(3, null), S(2, null)], '30D', NOW);
    eq(c.hasData, false);
    assert(c.note.includes('전액을 잃은 것처럼'), c.note);
  });

  test('진짜 0은 그린다', () => {
    // 잔고 0은 사실이다. 못 읽은 것과 다르다.
    const c = curveOf([S(2, 0), S(1, 0)], '30D', NOW);
    eq(c.hasData, true);
    eq(c.min, 0);
  });

  console.log('[자산 그래프 — 환경을 섞지 않는다]');

  test('다른 환경의 점은 곡선에 넣지 않는다', () => {
    const c = curveOf([
      S(3, 100, { env: 'LIVE' }),
      S(2, 9_999_999, { env: 'MOCK' }),
      S(1, 120, { env: 'LIVE' }),
    ], '30D', NOW, 'LIVE');
    eq(c.max, 120, '모의 잔고가 최고점이 되면 안 된다');
  });

  console.log('[자산 그래프 — 기간]');

  test('일곱 기간이 있고 기본은 30일이다', () => {
    eq(RANGES.length, 7);
    eq(RANGES.map(r => r.id).join(','), '1D,7D,30D,90D,YTD,1Y,ALL');
    eq(rangeOf(null), '30D');
    eq(rangeOf('아무거나'), '30D');
    eq(rangeOf('1D'), '1D');
  });

  test('전체는 시작이 없다', () => {
    // 0으로 두면 1970년부터라는 뜻이 되고, 그건 '전체'와 다른 말이다.
    eq(rangeStartMs('ALL', NOW), null);
    eq(rangeStartMs('7D', NOW), NOW - 7 * DAY);
  });

  test('올해는 1월 1일부터다', () => {
    eq(rangeStartMs('YTD', NOW), Date.UTC(2026, 0, 1));
  });

  console.log('[자산 그래프 — 눌렀을 때]');

  test('입출금을 손익과 섞지 않는다', () => {
    const d = pointDetailOf(S(0, 1_010_000, {
      realizedPnl: 3.4, unrealizedPnl: 1.21, fees: 0.27, funding: 0.13,
      deposit: 1_000_000, withdrawal: 0, transfer: 0,
    }));
    close(d.tradingPnl!, 3.4 + 1.21 - 0.27 - 0.13, 1e-9);
    assert(d.note.includes('자산이 변한 것과 번 것은 다릅니다'), d.note);
    assert(d.rows.some(r => r.label === '입금'), '입금 줄이 있어야 한다');
  });

  test('항목을 못 읽으면 매매손익을 내지 않는다', () => {
    // 모르는 값을 0으로 더하면 수익이 실제보다 좋게 나온다.
    const d = pointDetailOf(S(0, 100, { realizedPnl: 10 }));
    eq(d.tradingPnl, null);
    assert(d.note.includes('좋게 나옵니다'), d.note);
  });

  test('못 읽은 칸은 known:false로 낸다', () => {
    const d = pointDetailOf(S(0, 100, { realizedPnl: 10 }));
    eq(d.rows.find(r => r.label === '실현손익')!.known, true);
    eq(d.rows.find(r => r.label === '수수료')!.known, false);
  });

  test('시점이 없으면 확인 불가라고 한다', () => {
    const d = pointDetailOf(null);
    eq(d.totalEquity, null);
    assert(d.note.length > 0, d.note);
  });

  console.log('[자산 그래프 — 일별 손익]');

  test('자산 차이를 손익이라고 적지 않는다', () => {
    // 어제보다 100만원 늘었어도 그게 입금이면 번 것은 0원이다.
    const rows = dailyRowsOf([
      S(1, 10_000, { realizedPnl: 0, unrealizedPnl: 0, fees: 0, funding: 0, deposit: 0, withdrawal: 0, transfer: 0 }),
      S(0, 1_010_000, { realizedPnl: 0, unrealizedPnl: 0, fees: 0, funding: 0, deposit: 1_000_000, withdrawal: 0, transfer: 0 }),
    ]);
    const today = rows[0];
    close(today.equityDelta!, 1_000_000, 1e-9);
    close(today.pnl!, 0, 1e-9, '입금은 손익이 아니다');
    eq(today.hadFlow, true);
    assert(today.note.includes('자산 변화와 손익이 다릅니다'), today.note);
  });

  test('최근이 위로 온다', () => {
    const rows = dailyRowsOf([S(2, 100), S(1, 110), S(0, 120)]);
    eq(rows.length, 3);
    assert(rows[0].atMs > rows[1].atMs, '최근이 먼저');
  });

  test('첫날은 비교할 전날이 없어 자산 변화가 없다', () => {
    const rows = dailyRowsOf([S(0, 100)]);
    eq(rows[0].equityDelta, null, '0으로 적으면 안 변한 것처럼 보인다');
  });

  test('점이 없으면 빈 목록이다', () => {
    eq(dailyRowsOf(null).length, 0);
    eq(dailyRowsOf([]).length, 0);
  });

  console.log('[자산 그래프 — DB 행 읽기]');

  test('스네이크 케이스와 ISO 시각을 읽는다', () => {
    const s = snapshotFromRow({
      taken_at: '2026-08-08T00:00:00Z', total_equity: '569.09',
      realized_pnl: '3.4', unrealized_pnl: null, env: 'live',
    })!;
    eq(s.takenAtMs, Date.parse('2026-08-08T00:00:00Z'));
    close(s.totalEquity!, 569.09, 1e-9);
    eq(s.env, 'LIVE');
    eq(s.unrealizedPnl, null, 'null을 0으로 채우지 않는다');
  });

  test('시각이 없으면 점을 만들지 않는다', () => {
    eq(snapshotFromRow({ total_equity: 100 }), null);
    eq(snapshotFromRow(null), null);
  });

  test('총자산이 없어도 시점 자체는 남긴다', () => {
    // 못 읽었다는 사실이 남아야 "그때 몇 개를 못 읽었다"를 셀 수 있다.
    const s = snapshotFromRow({ taken_at: '2026-08-08T00:00:00Z', total_equity: null })!;
    eq(s.totalEquity, null);
  });
}
