import { test, eq, assert } from '../../test/harness';
import { blockEventsFrom, summarizeSafetyEvents } from './safetyLog';

export function runSafetyLogTests() {
  console.log('[안전장치 발동 기록 — 한 번도 안 걸린 것과 못 읽은 것은 다르다]');

  const R = (id: string, status: string, blocks: boolean, detail = '') =>
    ({ id, label: id, status, blocks, detail });

  // ── 무엇을 남기는가 ─────────────────────────────────────
  test('막은 항목만 남긴다', () => {
    const rows = blockEventsFrom([
      R('DAILY_LOSS_LIMIT', 'fail', true, '오늘 -5.2%'),
      R('CLOCK_SKEW', 'pass', false),
      R('AI_VETO', 'warn', false, '기권'),
    ]);
    eq(rows.length, 1);
    eq(rows[0].kind, 'DAILY_LOSS_LIMIT');
  });

  test('status가 fail이어도 막지 않으면 발동이 아니다', () => {
    // 경고로만 남는 항목이 있다. 그걸 발동으로 세면 "안전장치가 자주
    // 걸린다"는 착시가 생기고, 정작 진짜 차단이 묻힌다.
    eq(blockEventsFrom([R('X', 'fail', false)]).length, 0);
  });

  test('한 주문이 셋에 걸리면 세 줄이 남는다', () => {
    // 합쳐서 한 줄로 적으면 **어느 안전장치가 실제로 일하는지** 알 수 없다.
    const rows = blockEventsFrom([
      R('A', 'fail', true), R('B', 'unknown', true), R('C', 'fail', true),
    ]);
    eq(rows.length, 3);
  });

  test('fail과 unknown을 합치지 않는다', () => {
    // 앞은 한도에 걸린 것이고 뒤는 확인을 못 한 것이다. 고치는 방법이 다르다.
    const rows = blockEventsFrom([R('A', 'fail', true), R('B', 'unknown', true)]);
    eq(rows[0].status, 'fail');
    eq(rows[1].status, 'unknown');
  });

  test('시장·종목을 같이 남긴다', () => {
    const rows = blockEventsFrom([R('A', 'fail', true)], { market: 'USDM', symbol: 'BTCUSDT' });
    eq(rows[0].market, 'USDM');
    eq(rows[0].symbol, 'BTCUSDT');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(blockEventsFrom(null).length, 0);
    eq(blockEventsFrom(undefined).length, 0);
    eq(blockEventsFrom([null as any, { } as any]).length, 0);
  });

  // ── 요약 ────────────────────────────────────────────────
  const KINDS = [
    { id: 'DAILY_LOSS_LIMIT', label: '오늘 손실 한도' },
    { id: 'AI_VETO', label: 'AI 거부권' },
  ];

  test('기록이 없으면 발동 0 — 다만 읽었다는 표시가 붙는다', () => {
    const s = summarizeSafetyEvents([], KINDS);
    eq(s.length, 2);
    eq(s[0].count, 0);
    eq(s[0].lastAtMs, null);
    eq(s[0].known, true);   // ← 읽었는데 없는 것
  });

  test('못 읽었으면 known=false — 0으로 그리면 안 된다', () => {
    // 이 구분이 이 파일의 존재 이유다. '한 번도 안 걸림'과 '이력을 못
    // 읽음'이 화면에서 같아 보이면, 안전장치가 죽어도 알 수 없다.
    const s = summarizeSafetyEvents(null, KINDS);
    eq(s[0].known, false);
    eq(s[0].count, 0);
  });

  test('가장 최근 것을 마지막 발동으로 삼는다', () => {
    const s = summarizeSafetyEvents([
      { kind: 'DAILY_LOSS_LIMIT', status: 'fail', reason: '옛날', occurred_at: '2026-01-01T00:00:00Z' },
      { kind: 'DAILY_LOSS_LIMIT', status: 'unknown', reason: '최근', occurred_at: '2026-06-01T00:00:00Z' },
    ], KINDS);
    const d = s.find(x => x.kind === 'DAILY_LOSS_LIMIT')!;
    eq(d.count, 2);
    eq(d.lastReason, '최근');
    eq(d.lastStatus, 'unknown');
  });

  test('시각이 깨진 행은 횟수엔 세되 마지막 발동으로 삼지 않는다', () => {
    const s = summarizeSafetyEvents([
      { kind: 'AI_VETO', status: 'fail', reason: '정상', occurred_at: '2026-06-01T00:00:00Z' },
      { kind: 'AI_VETO', status: 'fail', reason: '깨짐', occurred_at: 'not-a-date' },
    ], KINDS);
    const a = s.find(x => x.kind === 'AI_VETO')!;
    eq(a.count, 2);
    eq(a.lastReason, '정상');
  });

  test('목록에 없는 항목도 버리지 않는다', () => {
    // 검사 이름이 바뀌면 옛 기록이 조용히 사라진다 — 그러면 "그때는
    // 발동한 적 없다"가 된다.
    const s = summarizeSafetyEvents([
      { kind: 'OLD_CHECK', status: 'fail', occurred_at: '2026-06-01T00:00:00Z' },
    ], KINDS);
    assert(s.some(x => x.kind === 'OLD_CHECK'), '옛 항목이 사라졌다');
  });
}
