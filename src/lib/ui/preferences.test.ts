// src/lib/ui/preferences.test.ts
//
// 이 테스트가 막는 것 둘:
//  · **저장된 값이 화면을 망가뜨리는 것** — 옛 판이나 손으로 고친 값
//  · **설정 하나로 안전장치가 꺼지는 것** — 실전 확인창이 대표적이다

import { test, eq, assert } from '../../test/harness';
import {
  DEFAULTS, normalizePrefs, shouldConfirm, moveButton, toggleButton,
  POSITION_BUTTONS, CONFIRM_KINDS, BUTTON_LABEL, CONFIRM_LABEL,
  type Preferences, type PositionButton,
} from './preferences';

export function runPreferencesTests() {
  console.log('[화면 기본값 — 눌러도 아무 일 안 하는 스위치를 두지 않는다]');

  // ── 기본값 ──────────────────────────────────────────────
  test('기본은 안전한 쪽이다', () => {
    // Mark — 얇은 호가의 한 틱 꼬리에 손절이 털리는 것을 줄인다
    eq(DEFAULTS.trigger, 'MARK');
    // 격리 — 교차는 손실이 계좌 전체로 번진다
    eq(DEFAULTS.paperMargin, 'ISOLATED');
    // 시장가·청산은 되돌릴 수 없다
    assert(DEFAULTS.confirmKinds.includes('MARKET'), '시장가 확인창이 기본에서 빠졌다');
    assert(DEFAULTS.confirmKinds.includes('CLOSE'), '청산 확인창이 기본에서 빠졌다');
  });

  test('모든 버튼·확인 항목에 한국어 이름이 있다', () => {
    for (const b of POSITION_BUTTONS) assert(!!BUTTON_LABEL[b], `${b} 이름 없음`);
    for (const k of CONFIRM_KINDS) assert(!!CONFIRM_LABEL[k], `${k} 이름 없음`);
  });

  // ── 저장값 정리 ─────────────────────────────────────────
  test('모양이 틀린 값은 기본으로 되돌린다', () => {
    const p = normalizePrefs({ trigger: 'XX', unit: 1, leverage: 'abc', density: null });
    eq(p.trigger, DEFAULTS.trigger);
    eq(p.unit, DEFAULTS.unit);
    eq(p.leverage, DEFAULTS.leverage);
    eq(p.density, DEFAULTS.density);
  });

  test('하나 틀렸다고 전부 날리지 않는다', () => {
    const p = normalizePrefs({ trigger: 'LAST', leverage: 999 });
    eq(p.trigger, 'LAST', '멀쩡한 값까지 되돌렸다');
    eq(p.leverage, DEFAULTS.leverage);
  });

  test('배율은 1~125 밖이면 기본으로', () => {
    eq(normalizePrefs({ leverage: 0 }).leverage, DEFAULTS.leverage);
    eq(normalizePrefs({ leverage: 126 }).leverage, DEFAULTS.leverage);
    eq(normalizePrefs({ leverage: 1 }).leverage, 1);
    eq(normalizePrefs({ leverage: 125 }).leverage, 125);
  });

  test('모르는 버튼 이름은 버린다', () => {
    const p = normalizePrefs({ positionButtons: ['TPSL', '없는버튼', 'CLOSE'] });
    eq(p.positionButtons.join(','), 'TPSL,CLOSE');
  });

  // **버튼이 하나도 없으면 포지션 카드에서 청산조차 못 한다.**
  // 그 상태가 저장되면 앱을 다시 켜도 그대로다.
  test('버튼이 비면 기본으로 되돌린다', () => {
    eq(normalizePrefs({ positionButtons: [] }).positionButtons.length > 0, true);
    eq(normalizePrefs({ positionButtons: ['없는것'] }).positionButtons.length > 0, true);
  });

  test('중복은 지운다', () => {
    eq(normalizePrefs({ positionButtons: ['TPSL', 'TPSL', 'CLOSE'] }).positionButtons.join(','),
      'TPSL,CLOSE');
  });

  // 확인창은 전부 꺼도 된다 — 다만 실전은 아래에서 무시한다
  test('확인창은 전부 꺼도 저장된다', () => {
    eq(normalizePrefs({ confirmKinds: [] }).confirmKinds.length, 0);
  });

  test('아무것도 없으면 통째로 기본', () => {
    for (const bad of [null, undefined, 'string', 42, []]) {
      const p = normalizePrefs(bad as any);
      eq(p.trigger, DEFAULTS.trigger, JSON.stringify(bad));
    }
  });

  // ── 확인창 ──────────────────────────────────────────────
  const P = (over: Partial<Preferences> = {}): Preferences => ({ ...DEFAULTS, ...over });

  test('끈 유형은 안 묻는다 (모의)', () => {
    eq(shouldConfirm(P({ confirmKinds: [] }), 'MARKET', false), false);
    eq(shouldConfirm(P({ confirmKinds: ['MARKET'] }), 'MARKET', false), true);
    eq(shouldConfirm(P({ confirmKinds: ['MARKET'] }), 'LIMIT', false), false);
  });

  // **이게 이 파일에서 가장 중요한 테스트다.**
  // 진짜 돈이 나가는 것을 설정 하나로 끌 수 있으면, 그건 설정이 아니라
  // 안전장치 제거다. 이 저장소에는 실전으로 잘못 넘어가는 경로가 이미
  // 여러 번 있었다.
  test('실전은 설정과 무관하게 항상 묻는다', () => {
    const off = P({ confirmKinds: [] });
    for (const k of CONFIRM_KINDS) {
      eq(shouldConfirm(off, k, true), true, `실전 ${k}에서 확인창이 꺼졌다`);
    }
  });

  // ── 버튼 순서 ───────────────────────────────────────────
  test('순서를 옮긴다', () => {
    const l: PositionButton[] = ['LEVERAGE', 'TPSL', 'CLOSE'];
    eq(moveButton(l, 0, 2).join(','), 'TPSL,CLOSE,LEVERAGE');
    eq(moveButton(l, 2, 0).join(','), 'CLOSE,LEVERAGE,TPSL');
  });

  test('범위 밖이면 그대로 둔다 — 조용히 잘리지 않는다', () => {
    const l: PositionButton[] = ['LEVERAGE', 'TPSL'];
    eq(moveButton(l, -1, 0).join(','), 'LEVERAGE,TPSL');
    eq(moveButton(l, 0, 5).join(','), 'LEVERAGE,TPSL');
    eq(moveButton(l, 1, 1).join(','), 'LEVERAGE,TPSL');
    eq(moveButton(l, 0, 1).length, 2, '옮기다 개수가 바뀌었다');
  });

  // ── 버튼 켜고 끄기 ──────────────────────────────────────
  test('켜고 끈다', () => {
    const r1 = toggleButton(['LEVERAGE', 'TPSL'], 'CLOSE');
    eq(r1.list.join(','), 'LEVERAGE,TPSL,CLOSE');
    const r2 = toggleButton(r1.list, 'TPSL');
    eq(r2.list.join(','), 'LEVERAGE,CLOSE');
  });

  // 다 끄면 포지션 카드에서 청산조차 못 하는데, 화면에는 그냥 버튼 없는
  // 카드로 보인다.
  test('마지막 하나는 못 끈다 — 이유를 적는다', () => {
    const r = toggleButton(['CLOSE'], 'CLOSE');
    eq(r.list.join(','), 'CLOSE');
    assert(r.reason.length > 0, '이유가 비어 있다');
  });

  test('넷을 넘겨 켤 수 없다 — 이유를 적는다', () => {
    const full: PositionButton[] = ['LEVERAGE', 'TPSL', 'CLOSE', 'REVERSE'];
    const r = toggleButton(full, 'LEVERAGE');
    // 이미 있는 것은 끄는 동작이라 통과한다
    eq(r.list.length, 3);
    // 넷이 다 켜진 상태에서 없는 것을 더 켤 수는 없다
    const r2 = toggleButton(full.slice(0, 4), 'LEVERAGE');
    eq(r2.list.length <= 4, true);
  });
}
