// src/lib/ops/autoVerify.test.ts
//
// **사용자가 Gate 앱을 열어 확인하지 않아도 되게 한다.**
//
// 다만 그러려면 이 판정이 사람보다 엄해야 한다. 사람은 화면을 보고
// "0이네"라고 말할 수 있지만, 이 코드는 **못 읽은 것과 0을 구분해야
// 한다.** 그 구분이 무너지면 화면이 사람보다 못한 확인이 된다.

import { test, eq, assert } from '../../test/harness';
import { testnetVerify, cleanupVerify, ledgerHealth, LEDGER_STALE_MS } from './autoVerify';

const NOW = 1_800_000_000_000;

export function runAutoVerifyTests() {
  console.log('[자동 검증 — Gate 앱을 열지 않아도 되게]');

  // ── 테스트넷 읽기 전용 ──

  const okProbe = {
    accountOk: true, positionsOk: true, ordersOk: true,
    leverageOk: true, positionModeOk: true, isTestnet: true,
  };

  test('전부 읽히면 PASS', () => {
    eq(testnetVerify(okProbe).code, 'PASS');
  });

  test('**포지션을 못 읽으면 통과가 아니다**', () => {
    const v = testnetVerify({ ...okProbe, positionsOk: null });
    eq(v.code, 'UNKNOWN');
    assert(/정상이라는 뜻이 아닙니다/.test(v.summary), v.summary);
  });

  test('조회가 실패하면 FAIL이고 왜 문제인지 적는다', () => {
    const v = testnetVerify({ ...okProbe, ordersOk: false });
    eq(v.code, 'FAIL');
    assert(/보호주문/.test(v.checks.find(c => c.id === 'orders')!.detail));
  });

  test('**실전 연결이면 테스트넷 검증 대상이 아니다**', () => {
    const v = testnetVerify({ ...okProbe, isTestnet: false });
    eq(v.code, 'FAIL');
  });

  test('테스트넷인지 모르면 통과가 아니다 — 그 한 번이 실제 돈이다', () => {
    eq(testnetVerify({ ...okProbe, isTestnet: null }).code, 'UNKNOWN');
  });

  test('아무것도 못 읽으면 통과가 아니다', () => {
    eq(testnetVerify(null).code, 'UNKNOWN');
  });

  // ── #142 정리 검증 ──

  const clean = {
    positionQty: 0, positionRead: true, ownedProtectionLeft: [] as string[],
    foreignKept: 0, unknownOwnership: 0, cleanupCode: 'CLEAN', rereadConfirmed: true,
  };

  test('포지션 0 · 내 보호주문 없음 · 재조회 확인이면 PASS', () => {
    const v = cleanupVerify(clean);
    eq(v.code, 'PASS');
    eq(v.blockEntry, false);
  });

  test('**남은 보호주문이 있으면 FAIL이고 새 진입을 막는다**', () => {
    // 남은 주문 위로 새 SL/TP를 얹으면 다음 진입이 옛 주문에 맞는다.
    const v = cleanupVerify({ ...clean, ownedProtectionLeft: ['2089209928026685417'] });
    eq(v.code, 'FAIL');
    eq(v.blockEntry, true);
    // **번호는 문자열로 그대로 적는다** — int64를 숫자로 다루면 끝자리가 뭉개진다
    assert(/2089209928026685417/.test(v.checks.find(c => c.id === 'ownedProtection')!.detail));
  });

  test('**포지션을 못 읽은 것을 0으로 적지 않는다**', () => {
    const v = cleanupVerify({ ...clean, positionRead: false, positionQty: null });
    eq(v.code, 'UNKNOWN');
    assert(/0이라는 뜻이 아닙니다/.test(v.checks[0].detail), v.checks[0].detail);
  });

  test('**소유를 판정 못 한 주문이 있으면 통과가 아니다**', () => {
    const v = cleanupVerify({ ...clean, unknownOwnership: 2 });
    eq(v.code, 'FAIL');
    eq(v.blockEntry, true);
  });

  test('**남의 주문이 남아 있는 것은 정상이다**', () => {
    // 지우면 안 되는 것이다. 이게 FAIL이 되면 Cancel All을 부르게 된다.
    const v = cleanupVerify({ ...clean, foreignKept: 3 });
    eq(v.code, 'PASS');
    assert(/손대지 않았습니다/.test(v.checks.find(c => c.id === 'foreign')!.detail));
  });

  test('재조회로 확인 못 했으면 통과가 아니다', () => {
    // 취소 요청이 200을 받은 것과 주문이 사라진 것은 다른 사실이다.
    eq(cleanupVerify({ ...clean, rereadConfirmed: null }).code, 'UNKNOWN');
    eq(cleanupVerify({ ...clean, rereadConfirmed: false }).code, 'FAIL');
  });

  test('정리 절차가 CLEAN이 아니면 FAIL', () => {
    eq(cleanupVerify({ ...clean, cleanupCode: 'LEFTOVER' }).code, 'FAIL');
    eq(cleanupVerify({ ...clean, cleanupCode: 'NOTHING_TO_DO' }).code, 'PASS');
  });

  // ── 장부 건강 ──

  const goodLedger = {
    tableExists: true, lastEventMs: NOW - 60_000, eventCount: 42,
    duplicateKeys: 0, fillCount: 10, ledgerFillCount: 10, feesCollected: true, nowMs: NOW,
  };

  test('쓰이고 있으면 PASS', () => {
    eq(ledgerHealth(goodLedger).code, 'PASS');
  });

  test('**표는 있는데 기록이 없으면 FAIL이다**', () => {
    // 048이 표만 만들어지고 채우는 코드가 없어서 지갑 곡선이 구조적으로
    // 비어 있었다. 표의 존재를 건강으로 읽으면 그 고장이 돌아온다.
    const v = ledgerHealth({ ...goodLedger, eventCount: 0, lastEventMs: null });
    eq(v.code, 'FAIL');
    assert(/writer가 배선되지 않았을/.test(v.checks.find(c => c.id === 'writer')!.detail));
  });

  test('오래 아무것도 안 적히면 FAIL', () => {
    const v = ledgerHealth({ ...goodLedger, lastEventMs: NOW - LEDGER_STALE_MS - 1000 });
    eq(v.code, 'FAIL');
  });

  test('같은 열쇠로 중복 기록되면 FAIL — 손익이 부풀려진다', () => {
    eq(ledgerHealth({ ...goodLedger, duplicateKeys: 2 }).code, 'FAIL');
  });

  test('체결 수와 장부 수가 다르면 FAIL', () => {
    const v = ledgerHealth({ ...goodLedger, ledgerFillCount: 7 });
    eq(v.code, 'FAIL');
    assert(/빠진 것이 손익에 안 잡힙니다/.test(v.checks.find(c => c.id === 'fills')!.detail));
  });

  test('수수료를 안 모으면 매매손익을 확정할 수 없다고 말한다', () => {
    const v = ledgerHealth({ ...goodLedger, feesCollected: false });
    eq(v.code, 'FAIL');
    assert(/매매손익을 확정할 수 없습니다/.test(v.checks.find(c => c.id === 'fees')!.detail));
  });

  test('표가 없으면 자동 적용 중이라고 적는다 — 사람에게 SQL을 시키지 않는다', () => {
    const v = ledgerHealth({ ...goodLedger, tableExists: false });
    eq(v.code, 'FAIL');
    assert(/자동으로 적용/.test(v.checks[0].detail), v.checks[0].detail);
  });

  test('장부를 못 읽으면 통과가 아니다', () => {
    eq(ledgerHealth(null).code, 'UNKNOWN');
    eq(ledgerHealth({ ...goodLedger, tableExists: null }).code, 'UNKNOWN');
  });
}
