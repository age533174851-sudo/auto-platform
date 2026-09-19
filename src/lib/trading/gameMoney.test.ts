// src/lib/trading/gameMoney.test.ts
//
// **표시만 바꾼다 — 회계에 배수가 끼어들 자리가 없는지 고정한다.**
//
// 배수를 하나라도 넣으면 이 파일이 두 번째 화폐 권위가 되고, 챌린지의
// 목표·실패 판정까지 흔들린다. PR5가 장부 셋을 하나로 합친 일이 무의미해진다.
import { test, eq, assert } from '../../test/harness';
import {
  GAME_MONEY_UNIT, usesGameMoney, formatGameMoney, formatMoneyForScope, modeBadge,
} from './gameMoney';

export function runGameMoneyTests() {
  // ── ★ 1:1 ──
  test('★ 내부 10,000은 화면에서도 10,000이다 — 환율이 없다', () => {
    eq(formatGameMoney(10000), '10,000 P');
    eq(formatGameMoney(1), '1 P');
    eq(formatGameMoney(72500), '72,500 P');
  });

  test('★ 어떤 값에도 배수가 곱해지지 않는다', () => {
    for (const v of [1, 7, 100, 12345, 999999]) {
      const s = formatGameMoney(v, { unit: false }).replace(/,/g, '');
      eq(Number(s), v);
    }
  });

  test('★ 역변환·환산 함수가 아예 없다 — 붙일 자리를 두지 않는다', async () => {
    const mod: any = await import('./gameMoney');
    for (const name of Object.keys(mod)) {
      assert(!/parse|toNumber|rate|convert|exchange|multiplier|fromGame/i.test(name),
        `환산·역변환 함수가 생겼습니다: ${name}`);
    }
  });

  // ── LIVE 금지 ──
  test('★ LIVE에는 게임머니를 쓰지 않는다', () => {
    eq(usesGameMoney('LIVE'), false);
    assert(!formatMoneyForScope(10000, 'LIVE').includes('P'), '실제 돈에 P가 붙었습니다');
  });

  test('★ 모르는 장부도 게임머니가 아니다 — 확인 못 한 것을 모의로 읽지 않는다', () => {
    for (const s of [null, undefined, '', 'WAT', 'TESTNET', 'paper']) {
      eq(usesGameMoney(s as any), false);
    }
  });

  test('모의와 챌린지만 게임머니다', () => {
    eq(usesGameMoney('PAPER'), true);
    eq(usesGameMoney('CHALLENGE'), true);
  });

  test('장부에 따라 표기가 갈린다', () => {
    assert(formatMoneyForScope(10000, 'PAPER').includes('P'), '모의에 P가 없습니다');
    assert(formatMoneyForScope(10000, 'CHALLENGE').includes('P'), '챌린지에 P가 없습니다');
    assert(!formatMoneyForScope(10000, 'LIVE').includes('P'), '실전에 P가 붙었습니다');
  });

  // ── 못 읽은 값 ──
  test('★ 못 읽은 값은 0이 아니라 —다', () => {
    for (const v of [null, undefined, '', NaN, 'abc', {}]) {
      eq(formatGameMoney(v as any), '—');
      eq(formatMoneyForScope(v as any, 'PAPER'), '—');
      eq(formatMoneyForScope(v as any, 'LIVE'), '—');
    }
  });

  test('0은 확인된 사실이라 0으로 적는다', () => {
    eq(formatGameMoney(0), '0 P');
  });

  // ── 부호 ──
  test('손익은 부호를 붙인다', () => {
    eq(formatGameMoney(3420, { signed: true }), '+3,420 P');
    eq(formatGameMoney(-3420, { signed: true }), '-3,420 P');
    eq(formatGameMoney(-3420), '-3,420 P');     // 음수는 signed 없어도 붙는다
    eq(formatGameMoney(3420), '3,420 P');
  });

  test('자릿수를 고를 수 있다', () => {
    eq(formatGameMoney(1234.5678, { decimals: 2 }), '1,234.57 P');
    eq(formatGameMoney(1234.5678), '1,235 P');   // 기본은 정수
  });

  test('단위를 끌 수 있다 — 좁은 표에서 쓴다', () => {
    eq(formatGameMoney(100, { unit: false }), '100');
  });

  // ── 이름은 상수 하나 ──
  test('★ 표시명이 상수 하나라 바꿔도 회계에 영향이 없다', () => {
    eq(GAME_MONEY_UNIT, 'P');
    assert(formatGameMoney(1).endsWith(GAME_MONEY_UNIT), '표시명이 상수에서 오지 않습니다');
  });

  // ── 모드 배지 ──
  test('★ 모르는 모드는 실제 돈으로 취급한다 — 이쪽 실수가 더 비싸다', () => {
    for (const s of [null, undefined, '', 'WAT']) {
      const b = modeBadge(s as any);
      eq(b.realMoney, true);
      eq(b.tone, 'UNKNOWN');
      assert(!/모의/.test(b.label), '모르는 모드를 모의로 적었습니다');
    }
  });

  test('모의·챌린지는 실제 돈이 아니고 실전은 실제 돈이다', () => {
    eq(modeBadge('PAPER').realMoney, false);
    eq(modeBadge('CHALLENGE').realMoney, false);
    eq(modeBadge('LIVE').realMoney, true);
  });

  test('세 모드의 이름이 서로 다르다 — 화면에서 구별된다', () => {
    const labels = ['PAPER', 'CHALLENGE', 'LIVE'].map(s => modeBadge(s).label);
    eq(new Set(labels).size, 3);
  });
}
