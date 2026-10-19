// src/lib/smoke/preflightReport.test.ts
//
// **점검이 초록인데 시작은 막히는 일이 없어야 한다.**
//
// 사전 점검의 쓸모는 하나다 — 여기서 통과하면 실주문 명령이 통과한다.
// 그래서 이 시험이 지키는 것은 "ready가 PASS 전부일 때만 참인가"이고,
// 특히 **보지 못한 항목(SKIPPED)을 통과로 세지 않는가**다.

import { test, eq, assert } from '../../test/harness';
import { buildPreflightReport, type PreflightFacts } from './preflightReport';
import { headlessPreflightVerdict } from './smokeRun';

/** 전부 통과한 사실 묶음 */
const allGood = (): PreflightFacts => ({
  creds: { ok: true, detail: 'binance 연결을 읽었습니다' },
  testnet: { ok: true, reason: '테스트넷 연결이 확인됐습니다' },
  ledger: { readable: true, reason: '3건을 끝까지 읽었습니다' },
  exposure: { blocked: false, code: 'CLEAR', reason: '정리되지 않은 노출이 없습니다' },
  killSwitch: { allowed: true, message: '꺼져 있습니다' },
  exitPolicy: { ok: true, reason: 'default · 배율 10' },
  symbol: { ok: true, code: 'CLEAR', reason: 'BTCUSDT — 기존 포지션 0 · 조건부 주문 0' },
  runTable: { present: true, reason: 'smoke_runs 표가 있습니다' },
});

const stateOf = (r: ReturnType<typeof buildPreflightReport>, id: string) =>
  r.checks.find((c) => c.id === id)?.state;

export function runPreflightReportTests() {
  console.log('[스모크 사전 점검 — 주문 전에 알 수 있는 것은 주문 전에]');

  test('① 전부 통과하면 ready', () => {
    const r = buildPreflightReport(allGood());
    eq(r.ready, true, '여덟 항목이 전부 PASS면 준비된 것이다');
    eq(r.checks.length, 8, '항목이 빠지면 안 본 것을 통과로 세는 것이다');
    eq(r.blockers.length, 0, '막는 것이 없어야 한다');
  });

  // **SKIPPED는 PASS가 아니다.**
  //
  // 자격증명을 못 읽으면 뒤를 볼 수 없다. 그때 뒤 항목이 조용히
  // 사라지거나 통과로 적히면, 가장 위험한 상태(아무것도 확인 못 함)가
  // 가장 깨끗해 보인다.
  test('② 앞이 막히면 뒤는 SKIPPED이고 ready가 아니다', () => {
    const f = allGood();
    f.creds = { ok: false, detail: '연결을 찾지 못했습니다' };
    f.testnet = null; f.symbol = null;
    const r = buildPreflightReport(f);
    eq(r.ready, false, '확인하지 못한 채로 준비됐다고 적지 않는다');
    eq(stateOf(r, 'TESTNET_VERIFIED'), 'SKIPPED', '못 본 것은 SKIPPED다');
    eq(stateOf(r, 'SYMBOL_CLEAR'), 'SKIPPED', '못 본 것은 SKIPPED다');
    eq(r.checks.length, 8, '항목 수는 그대로여야 한다 — 사라지면 안 본 줄을 모른다');
  });

  // 테스트넷 '확인되지 않음'(null)은 실전이라는 뜻은 아니지만 통과도 아니다.
  test('③ 테스트넷이 확인되지 않으면 ready가 아니다', () => {
    const f = allGood();
    f.testnet = { ok: false, reason: '이 연결이 테스트넷인지 확인되지 않았습니다' };
    const r = buildPreflightReport(f);
    eq(r.ready, false, '확인되지 않은 환경에는 주문을 내지 않는다');
    eq(stateOf(r, 'TESTNET_VERIFIED'), 'FAIL');
    assert(r.blockers.some((b) => b.includes('테스트넷')), '막는 사유에 적혀야 한다');
  });

  // **못 읽어서 막힌 것과 실제로 남아서 막힌 것은 사람이 할 일이 다르다.**
  test('④ 노출을 못 읽은 것은 UNKNOWN, 남아 있는 것은 FAIL', () => {
    const unread = allGood();
    unread.exposure = { blocked: true, code: 'LEDGER_UNREADABLE', reason: '못 읽었습니다' };
    eq(stateOf(buildPreflightReport(unread), 'NO_UNRESOLVED_EXPOSURE'), 'UNKNOWN',
      '못 읽은 것을 "남아 있다"로 적지 않는다');

    const left = allGood();
    left.exposure = { blocked: true, code: 'UNPROTECTED_UNRESOLVED', reason: '2건 남았습니다' };
    eq(stateOf(buildPreflightReport(left), 'NO_UNRESOLVED_EXPOSURE'), 'FAIL',
      '남아 있는 것은 FAIL이다');

    eq(buildPreflightReport(unread).ready, false, '둘 다 ready는 아니다');
    eq(buildPreflightReport(left).ready, false);
  });

  // 종목 조회 실패도 같은 규칙이다 — 0건이 아니다.
  test('⑤ 종목 조회 실패는 UNKNOWN이지 "깨끗함"이 아니다', () => {
    const f = allGood();
    f.symbol = { ok: false, code: 'UNKNOWN', reason: '조건부 주문 목록을 읽지 못했습니다' };
    const r = buildPreflightReport(f);
    eq(stateOf(r, 'SYMBOL_CLEAR'), 'UNKNOWN');
    eq(r.ready, false, '모르는 것은 통과가 아니다');
  });

  // 장부 상한에 닿으면 전체를 본 것이 아니다.
  test('⑥ 장부 상한에 닿으면 조회 자체가 FAIL이다', () => {
    const f = allGood();
    f.ledger = { readable: false, reason: '조회 상한(1000건)에 도달했습니다' };
    f.exposure = null;                       // 전부 못 봤으므로 판정하지 않는다
    const r = buildPreflightReport(f);
    eq(stateOf(r, 'LEDGER_READABLE'), 'FAIL');
    eq(stateOf(r, 'NO_UNRESOLVED_EXPOSURE'), 'SKIPPED');
    eq(r.ready, false);
  });

  // 표가 없으면 시작이 503으로 끝난다 — 실주문을 누른 뒤에 알 일이 아니다.
  test('⑦ 묶음 표가 없으면 ready가 아니다', () => {
    const f = allGood();
    f.runTable = { present: false, reason: 'smoke_runs 표가 없습니다 — 마이그레이션 053' };
    const r = buildPreflightReport(f);
    eq(r.ready, false);
    assert(r.blockers.some((b) => b.includes('053')), '무엇을 적용해야 하는지 적어야 한다');
  });

  // 킬스위치와 청산가 관문은 시작 경로와 같은 함수가 판정한다.
  test('⑧ 킬스위치가 켜져 있거나 청산가 관문이 막으면 ready가 아니다', () => {
    const ks = allGood();
    ks.killSwitch = { allowed: false, message: '킬스위치가 켜져 있습니다' };
    eq(buildPreflightReport(ks).ready, false, '킬스위치는 스모크에도 걸린다');

    const lg = allGood();
    lg.exitPolicy = { ok: false, reason: '손절이 청산가 너머입니다' };
    eq(buildPreflightReport(lg).ready, false);
  });

  // ── 무인 호출 판정 ──
  //
  // **확인 문구를 요구하지 않는다.** 주문을 내지 않기 때문이다.
  // 대신 "누구의 어느 연결인지"는 똑같이 요구한다 — 비우면 "전체"가
  // 되는 자리를 열지 않는 것이 이 판정의 전부다.
  test('⑨ 무인 사전 점검은 userId·connectionId를 요구하고 확인 문구는 요구하지 않는다', () => {
    const ok = headlessPreflightVerdict({ userId: 'u-1', connectionId: 'c-123456789' });
    eq(ok.ok, true, '둘을 적었으면 통과한다 (확인 문구 없이)');
    eq(ok.userId, 'u-1');
    eq(ok.connectionId, 'c-123456789');

    for (const bad of [undefined, null, '', '   ']) {
      eq(headlessPreflightVerdict({ userId: bad, connectionId: 'c-1' }).code, 'USER_REQUIRED',
        `userId=${JSON.stringify(bad)}는 막혀야 한다`);
      eq(headlessPreflightVerdict({ userId: 'u-1', connectionId: bad }).code, 'CONNECTION_REQUIRED',
        `connectionId=${JSON.stringify(bad)}는 막혀야 한다`);
    }
  });

  // **id를 통째로 로그에 적지 않는다.**
  test('⑩ 승인 문구에 연결 id 전체가 들어가지 않는다', () => {
    const id = 'c-0123456789abcdef';
    const v = headlessPreflightVerdict({ userId: 'u-1', connectionId: id });
    assert(!v.message.includes(id), `연결 id 전체가 문구에 들어갔습니다: ${v.message}`);
  });
}
