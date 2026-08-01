import { test, eq, assert } from '../../test/harness';
import { exitOnBar, exitOnMark, type ExitPos, type Bar } from './exitRules';

export function runExitRulesTests() {
  console.log('[청산 규칙 — 데모와 백테스트가 같은 기계를 돌린다]');

  const CFG = { maxHoldHours: 72 };
  const H = 3_600_000;
  const long = (o: Partial<ExitPos> = {}): ExitPos => ({
    side: 'LONG', entry: 100, stop: 98, takeProfit: 104, liquidation: 90, openedAt: 0, ...o,
  });
  const short = (o: Partial<ExitPos> = {}): ExitPos => ({
    side: 'SHORT', entry: 100, stop: 102, takeProfit: 96, liquidation: 110, openedAt: 0, ...o,
  });
  const bar = (o: number, h: number, l: number, c: number, t = H): Bar => ({ t, o, h, l, c });

  // ── 순서 ────────────────────────────────────────────────
  test('한 봉에서 손절과 익절이 둘 다 닿으면 손절이다', () => {
    // OHLC로는 고가와 저가 중 무엇이 먼저였는지 알 수 없다. 모르는 것을
    // 유리하게 읽으면 그 성적표는 검증이 아니라 희망이다.
    const r = exitOnBar(long(), bar(100, 105, 97, 103), CFG);
    eq(r?.reason, 'SL');
  });

  test('청산가까지 갔으면 손절이 아니라 청산이다', () => {
    const r = exitOnBar(long(), bar(100, 101, 89, 95), CFG);
    eq(r?.reason, 'LIQUIDATION');
  });

  test('아무것도 안 닿으면 안 나간다', () => {
    eq(exitOnBar(long(), bar(100, 103, 99, 101), CFG), null);
  });

  // ── 갭 ──────────────────────────────────────────────────
  test('손절을 뛰어넘어 열리면 손절가가 아니라 시가에 체결된다', () => {
    // 밤사이 -8%로 열리면 -2% 손절은 -2%가 아니라 -8%다. 손절가에 받았다고
    // 계산하는 백테스트는 실제로 계좌를 없애는 그 차이를 통째로 지운다.
    const r = exitOnBar(long({ stop: 98 }), bar(92, 93, 91, 92), CFG);
    eq(r?.reason, 'SL');
    eq(r?.price, 92);
    eq(r?.gapped, true);
  });

  test('갭 없이 손절을 스치면 손절가 그대로', () => {
    const r = exitOnBar(long({ stop: 98 }), bar(100, 100.5, 97.5, 99), CFG);
    eq(r?.price, 98);
    eq(r?.gapped, false);
  });

  test('익절은 갭이 유리해도 걸어 둔 가격으로만 친다', () => {
    // 실제로는 더 좋게 받지만, 그 이득을 넣으면 백테스트가 실전보다
    // 좋아지는 방향으로만 어긋난다.
    const r = exitOnBar(long({ stop: null, takeProfit: 104 }), bar(108, 110, 107, 109), CFG);
    eq(r?.reason, 'TP');
    eq(r?.price, 104);
  });

  test('숏도 같은 규칙 — 위로 갭이 나면 시가에 체결', () => {
    const r = exitOnBar(short({ stop: 102, liquidation: null }), bar(107, 108, 106, 107), CFG);
    eq(r?.reason, 'SL');
    eq(r?.price, 107);
    eq(r?.gapped, true);
  });

  test('숏 익절도 걸어 둔 가격까지만', () => {
    const r = exitOnBar(short({ stop: null, takeProfit: 96 }), bar(92, 93, 90, 91), CFG);
    eq(r?.reason, 'TP');
    eq(r?.price, 96);
  });

  // ── 없는 값 ─────────────────────────────────────────────
  test('손절이 없으면 손절로 안 나간다 — 0을 손절가로 치지 않는다', () => {
    eq(exitOnBar(long({ stop: null, liquidation: null, takeProfit: null }), bar(100, 101, 1, 2), CFG), null);
    eq(exitOnBar(long({ stop: 0, liquidation: null, takeProfit: null }), bar(100, 101, 1, 2), CFG), null);
  });

  // ── 보유 시간 ───────────────────────────────────────────
  test('보유 시간이 지나면 종가로 나간다', () => {
    const r = exitOnBar(long({ stop: null, takeProfit: null, liquidation: null }),
      bar(100, 101, 99, 100.5, 73 * H), CFG);
    eq(r?.reason, 'MAX_HOLD');
    eq(r?.price, 100.5);
  });

  test('시간 청산보다 손절이 먼저다', () => {
    const r = exitOnBar(long(), bar(100, 101, 97, 100, 99 * H), CFG);
    eq(r?.reason, 'SL');
  });

  test('maxHoldHours 0이면 시간으로 안 닫는다', () => {
    const r = exitOnBar(long({ stop: null, takeProfit: null, liquidation: null }),
      bar(100, 101, 99, 100, 9999 * H), { maxHoldHours: 0 });
    eq(r, null);
  });

  // ── 시세 하나만 아는 경우 ───────────────────────────────
  test('시세를 모르면 아무것도 닫지 않는다', () => {
    // 추측한 가격으로 닫으면 그 손익이 장부에 남고 그 뒤가 전부 그 위에 쌓인다.
    eq(exitOnMark(long(), null, H, CFG), null);
    eq(exitOnMark(long(), 0, H, CFG), null);
    eq(exitOnMark(long(), NaN as any, H, CFG), null);
  });

  test('시세 하나로도 같은 규칙이 돈다', () => {
    eq(exitOnMark(long(), 97, H, CFG)?.reason, 'SL');
    eq(exitOnMark(long(), 105, H, CFG)?.reason, 'TP');
    eq(exitOnMark(long(), 89, H, CFG)?.reason, 'LIQUIDATION');
    eq(exitOnMark(long(), 100, H, CFG), null);
  });

  test('시세가 이미 손절을 지났으면 체결가는 손절가가 아니라 그 시세다', () => {
    // 97에서 알아챘는데 98에 받았다고 적으면, 실제로는 못 받는 1원을
    // 매번 벌어들이는 장부가 된다.
    const r = exitOnMark(long(), 97, H, CFG);
    assert(r?.gapped === true, '시세가 손절 너머면 걸어 둔 가격에 못 받은 것이다');
    eq(r?.price, 97);
  });
}
