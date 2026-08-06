// src/lib/risk/emergencyLevel.test.ts
//
// 막으려는 것:
//  1. 봇 문제로 누른 비상정지가 **손매매 포지션까지** 시장가로 닫는 것
//     — 한 번 겪으면 다음부터 그 버튼을 못 누른다
//  2. 봇 포지션을 못 가렸을 때 '모르면 전부'로 기울어, 이 단계를 만든
//     이유의 정반대가 되는 것
//  3. 되돌릴 수 없는 동작을 한 번만 묻고 실행하는 것
//  4. 잠그려고 눌렀는데 포지션이 나가는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  LEVELS, LEVEL_ORDER, levelOf, actionModeOf,
  automatedSymbols, closeTargets, confirmLines,
} from './emergencyLevel';

const POSITIONS = [
  { symbol: 'BTCUSDT', qty: 1 },
  { symbol: 'ETHUSDT', qty: 10 },
  { symbol: 'SOLUSDT', qty: 100 },
];

/** signal_id에 전략 태그가 있으면 봇이 낸 것 */
const strategyOf = (r: any) => {
  const s = String(r?.signal_id ?? '');
  return s.startsWith('scalp:') || s.startsWith('ladder:') ? s.split(':')[0] : null;
};

export function runEmergencyLevelTests() {
  console.log('[비상정지 — 단계 정의]');

  test('약한 것부터 강한 것 순서다', () => {
    eq(LEVEL_ORDER[0], 'PAUSE_ENTRIES');
    eq(LEVEL_ORDER.length, Object.keys(LEVELS).length, '표와 순서가 어긋났다');
  });

  test('모르는 단계는 null이다', () => {
    eq(levelOf('아무거나'), null);
    eq(levelOf(''), null);
    eq(levelOf(null), null);
  });

  test('killSwitch의 actionMode로 번역된다', () => {
    // 두 번째 체계를 만들지 않는다 — 갈리면 한쪽만 고쳐진다.
    eq(actionModeOf(LEVELS.PAUSE_ENTRIES), 'A');
    eq(actionModeOf(LEVELS.CLOSE_ALL), 'ABCD');
    eq(actionModeOf(null), '');
  });

  console.log('[비상정지 — 되돌릴 수 없으면 두 번 묻는다]');

  test('되돌릴 수 있는 것은 한 번만 묻는다', () => {
    // 다 두 번 물으면 급할 때 손이 느려진다.
    eq(LEVELS.PAUSE_ENTRIES.confirmSteps, 1);
    eq(LEVELS.PAUSE_ENTRIES.reversible, true);
  });

  test('시장가로 나가는 것은 두 번 묻는다', () => {
    for (const l of ['REDUCE_RISK', 'CLOSE_AUTOMATED', 'CLOSE_ALL'] as const) {
      eq(LEVELS[l].confirmSteps, 2, l);
      eq(LEVELS[l].reversible, false, l);
    }
  });

  test('계좌 잠금도 두 번 묻는다 — 급할 때 아무것도 못 하게 되니까', () => {
    eq(LEVELS.LOCK_ACCOUNT.confirmSteps, 2);
    eq(LEVELS.LOCK_ACCOUNT.reversible, true, '풀 수는 있다');
  });

  test('잠금은 포지션을 닫지 않는다', () => {
    // 잠그는 것과 정리하는 것은 다른 결정이다. 섞으면 "잠그려고
    // 눌렀는데 포지션이 나갔다"가 된다.
    eq(LEVELS.LOCK_ACCOUNT.closePct, 0);
    eq(closeTargets(LEVELS.LOCK_ACCOUNT, POSITIONS, new Set()).targets.length, 0);
  });

  console.log('[비상정지 — 자동매매 것만 닫기]');

  test('전략 태그로 봇 주문을 가린다', () => {
    const s = automatedSymbols([
      { symbol: 'BTCUSDT', signal_id: 'scalp:btc-1' },
      { symbol: 'ETHUSDT', signal_id: 'manual-abc' },
      { symbol: 'SOLUSDT', signal_id: 'ladder:sol-2' },
    ], strategyOf);
    eq(s.has('BTCUSDT'), true);
    eq(s.has('SOLUSDT'), true);
    eq(s.has('ETHUSDT'), false, '손으로 낸 주문에는 태그가 없다');
  });

  test('손매매 포지션은 건드리지 않는다', () => {
    // 봇 문제로 누른 버튼이 어제부터 들고 있던 손매매까지 닫으면,
    // 다음부터 그 버튼을 못 누른다.
    const auto = new Set(['BTCUSDT']);
    const r = closeTargets(LEVELS.CLOSE_AUTOMATED, POSITIONS, auto);
    eq(r.targets.length, 1);
    eq(r.targets[0].symbol, 'BTCUSDT');
    assert(r.note.includes('손매매 2개는 그대로'), r.note);
  });

  test('봇 포지션을 못 가리면 아무것도 안 닫는다', () => {
    // '모르면 전부'로 기울면 손매매까지 나가고, 그건 이 단계를
    // 만든 이유의 정반대다.
    const r = closeTargets(LEVELS.CLOSE_AUTOMATED, POSITIONS, new Set());
    eq(r.targets.length, 0);
    assert(r.note.includes('닫을 것이 없습니다'), r.note);
  });

  test('전체 종료는 손매매도 닫는다 — 그렇다고 적는다', () => {
    const r = closeTargets(LEVELS.CLOSE_ALL, POSITIONS, new Set(['BTCUSDT']));
    eq(r.targets.length, 3);
    assert(LEVELS.CLOSE_ALL.confirmText.includes('손매매'),
      '무엇이 나가는지 확인 문구에 적혀야 한다');
  });

  console.log('[비상정지 — 절반 축소]');

  test('절반은 수량으로 계산한다', () => {
    const r = closeTargets(LEVELS.REDUCE_RISK, POSITIONS, new Set());
    eq(r.targets.length, 3);
    close(r.targets[0].qty as number, 0.5, 1e-9);
    close(r.targets[1].qty as number, 5, 1e-9);
  });

  test('전량은 수량을 계산하지 않고 null이다', () => {
    // 수량을 넣으면 그 사이 값이 바뀌었을 때 남거나 초과한다.
    // 전량은 거래소가 '그때 있는 것'으로 처리하게 둔다.
    const r = closeTargets(LEVELS.CLOSE_ALL, POSITIONS, new Set());
    for (const t of r.targets) eq(t.qty, null);
  });

  test('절반 축소는 신규도 같이 막는다', () => {
    // 줄이는 동안 새로 들어오면 줄인 뜻이 없다.
    assert(LEVELS.REDUCE_RISK.actions.includes('A'));
  });

  test('수량이 0이거나 없는 포지션은 뺀다', () => {
    const r = closeTargets(LEVELS.CLOSE_ALL, [
      { symbol: 'BTCUSDT', qty: 0 },
      { symbol: '', qty: 5 },
      { symbol: 'ETHUSDT', qty: 1 },
    ] as any, new Set());
    eq(r.targets.length, 1);
  });

  console.log('[비상정지 — 확인 문구]');

  test('무엇이 나가는지 숫자로 적는다', () => {
    // "정말 실행할까요?"만 물으면 사람은 읽지 않고 예를 누른다.
    const plan = closeTargets(LEVELS.CLOSE_ALL, POSITIONS, new Set());
    const lines = confirmLines(LEVELS.CLOSE_ALL, plan);
    const text = lines.join('\n');
    assert(text.includes('BTCUSDT'), text);
    assert(text.includes('되돌릴 수 없습니다'), text);
  });

  test('되돌릴 수 있는 단계에는 경고를 안 붙인다', () => {
    const lines = confirmLines(LEVELS.PAUSE_ENTRIES, { targets: [], note: '' });
    assert(!lines.join('\n').includes('되돌릴 수 없습니다'),
      '늘 붙으면 아무도 안 읽는다');
  });

  test('목록이 길면 잘라서 개수를 적는다', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}USDT`, qty: 1 }));
    const plan = closeTargets(LEVELS.CLOSE_ALL, many, new Set());
    const text = confirmLines(LEVELS.CLOSE_ALL, plan).join('\n');
    assert(text.includes('외 12개'), text);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(closeTargets(null, POSITIONS, new Set()).targets.length, 0);
    eq(closeTargets(LEVELS.CLOSE_ALL, null, new Set()).targets.length, 0);
    eq(automatedSymbols(null, strategyOf).size, 0);
    assert(confirmLines(null, { targets: [], note: '' }).length > 0);
  });
}
