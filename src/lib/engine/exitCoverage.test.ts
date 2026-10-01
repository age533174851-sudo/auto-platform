// src/lib/engine/exitCoverage.test.ts
//
// **같은 전략인데 계약에 따라 받는 감시가 다르다.**
//
// `scalp`은 기본 예약으로도 돌고 `MAX_LEV_100X`/`EXACT_100X`(고정 손절
// 없음)로도 돈다. 표가 전략 단위였을 때는 `scalp` 한 줄이
// `lifecyclePolicyOf('scalp')`를 근거로 트레일링·본전이동·시간청산을 전부
// true로 적었고, `NO_FIXED_SL` 계약의 포지션에는 그 중 하나도 돌지 않는데도
// 화면과 응답은 초록이었다.
//
// 이 파일이 지키는 것은 두 가지다:
//   ① `NO_FIXED_SL` 계약 줄이 **존재하고** 전부 false라고 말한다
//   ② 그 판정을 표가 **다시 적지 않고** 분류기에게 묻는다
import { test, eq, assert } from '../../test/harness';
import {
  exitCoverage, exitCoverageLine, exitCoverageGaps, genericLifecycleAdmission,
} from './exitCoverage';

const rowFor = (presetId: string) =>
  exitCoverage().find(c => c.contract?.presetId === presetId);

export function runExitCoverageTests() {
  console.log('\n🩺 청산 감시 커버리지 — 전략 축이 아니라 계약 축');

  // ── ① 분류기에게 묻는다 ──

  test('기본 예약(옛 줄)은 예전처럼 일반 생명주기에 들어간다', () => {
    const a = genericLifecycleAdmission(null);
    eq(a.admitted, true, '★ 기존 동작이 바뀌었습니다 — 계약 없는 줄이 관리에서 빠집니다');
    eq(a.code, 'MANAGED');
  });

  test('FIXED_SL 계약도 들어간다', () => {
    eq(genericLifecycleAdmission('FIXED_SL').admitted, true);
  });

  test('NO_FIXED_SL 계약은 들어가지 않고, 이유가 분류기의 코드다', () => {
    const a = genericLifecycleAdmission('NO_FIXED_SL');
    eq(a.admitted, false, '★ 고정 손절 없는 계약이 일반 생명주기에 들어갔습니다');
    // **표가 이유를 지어내지 않는다.** `managedPosition`이 돌려준 코드다.
    eq(a.code, 'NO_FIXED_SL_EXIT_UNWIRED');
    assert(a.reason.length > 0, '유예에는 사유가 있어야 합니다');
  });

  // ── ② 표가 그 사실을 말한다 ──

  test('NO_FIXED_SL 계약 줄이 표에 있다', () => {
    const r = rowFor('EXACT_100X');
    assert(!!r, '★ 열려 있는 NO_FIXED_SL 조합이 표에 없습니다 — 표가 그 계약을 빠뜨립니다');
    eq(r!.strategyId, 'scalp');
    eq(r!.stopPolicy, 'NO_FIXED_SL');
    eq(r!.contract!.profileId, 'MAX_LEV_100X');
    eq(r!.contract!.contractVersion, 2);
  });

  test('그 줄은 트레일링·본전이동·시간청산·포지션점검을 받지 않는다고 적는다', () => {
    const r = rowFor('EXACT_100X')!;
    eq(r.trailing, false, '★ 돌지 않는 트레일링을 true로 적었습니다');
    eq(r.breakEven, false, '★ 돌지 않는 본전이동을 true로 적었습니다');
    eq(r.timeExit, false, '★ 돌지 않는 시간청산을 true로 적었습니다');
    eq(r.positionGuard, false, '★ 돌지 않는 포지션 점검을 true로 적었습니다');
    // 진입 보호주문은 **계약상 안 거는 것**이다. 그래도 false가 맞다 —
    // 이 칸은 "거는가"를 묻는다.
    eq(r.protectiveOrdersAtEntry, false);
  });

  test('빈 칸의 이유에 "종료 수단이 사람뿐"이 적힌다', () => {
    const r = rowFor('EXACT_100X')!;
    assert(r.gap != null, '★ 빈 칸이 있는데 이유가 없습니다');
    assert(/사람이 직접 닫는/.test(r.gap!),
      '★ 자동 종료가 없다는 사실을 적지 않습니다 — 운영자가 무엇이 없는지 모릅니다');
    // 유예 코드를 그대로 적는다. 사람이 어느 규칙에 걸렸는지 알아야 한다.
    assert(/NO_FIXED_SL_EXIT_UNWIRED/.test(r.gap!), '★ 유예 코드가 사유에 없습니다');
  });

  test('계약이 선언한 보유 한도를 아무도 읽지 않는다는 사실도 적는다', () => {
    const r = rowFor('EXACT_100X')!;
    // 계약은 `maxHoldSec`를 갖고 있는데 청산 경로는 전략 id로만 정책을
    // 찾는다. "적혀 있다"와 "돈다"를 구별해서 적어야 거짓말이 아니다.
    assert(/읽지 않습니다/.test(r.gap!),
      '★ 계약이 선언한 보유 한도가 배선돼 있는 것처럼 읽힙니다');
  });

  test('빈 칸 목록에 그 줄이 들어간다', () => {
    const gaps = exitCoverageGaps();
    assert(gaps.some(g => g.contract?.presetId === 'EXACT_100X'),
      '★ 빈 칸 목록이 NO_FIXED_SL 계약을 빠뜨립니다');
  });

  // ── ③ 기존 줄은 건드리지 않는다 ──

  test('기본 예약 줄들은 계약 축이 비어 있고 값이 그대로다', () => {
    const base = exitCoverage().filter(c => c.contract == null);
    assert(base.length >= 3, '실행 경로가 있는 전략 줄이 사라졌습니다');
    for (const b of base) {
      // **`FIXED_SL`이라고 적지 않는다.** 기본 예약의 장부 칸은 비어 있고,
      // null과 `NO_FIXED_SL`을 구별하는 것이 이 계약의 요점이다.
      eq(b.stopPolicy, null, '★ 옛 줄을 "고정 손절을 쓰기로 정한 줄"로 바꿔 읽습니다');
    }
    const scalp = base.find(c => c.strategyId === 'scalp')!;
    eq(scalp.timeExit, true, '★ 기본 scalp의 기존 커버리지가 바뀌었습니다');
    eq(scalp.gap, null);
  });

  // ── ③-b 표를 **정말 읽는가** ──
  //
  // 이름만 보는 검사는 "import는 남겨 두고 목록을 손으로 적는" 변경을
  // 잡지 못한다. 실제로 그 변이가 한 번 새 나갔다. 그래서 조합을
  // 주입해서 표가 따라오는지 본다.

  test('조합을 주입하면 그 조합의 전략으로 계약 줄이 생긴다', () => {
    const injected = [{
      strategyId: 'my-original-v1', profileId: 'MAX_LEV_100X',
      presetId: 'EXACT_100X', contractVersion: 2,
      modes: ['TESTNET'], requiresMarginAllocation: true,
    }];
    const got = exitCoverage(injected as any).filter(c => c.contract != null);
    eq(got.length, 1, '★ 주입한 조합이 표에 반영되지 않습니다');
    eq(got[0].strategyId, 'my-original-v1',
      '★ 주입을 무시하고 어딘가에 박아 둔 목록을 씁니다');
  });

  test('열린 조합이 없으면 계약 줄도 없다', () => {
    const got = exitCoverage([]).filter(c => c.contract != null);
    eq(got.length, 0, '★ 조합이 없는데 계약 줄이 나옵니다');
    // 기본 예약 줄은 그대로 있어야 한다 — 조합과 무관하다.
    assert(exitCoverage([]).length >= 3, '기본 예약 줄까지 사라졌습니다');
  });

  // ── ④ 요약 줄 ──

  test('요약 줄이 계약 단위로 세고 빠진 계약을 지목한다', () => {
    const line = exitCoverageLine();
    // 전략 수로 세면 같은 전략의 다른 계약이 숨는다.
    assert(/실행 계약/.test(line), `★ 아직 전략 수로 셉니다: ${line}`);
    assert(/scalp\/EXACT_100X/.test(line),
      `★ 빠진 계약을 지목하지 않습니다: ${line}`);
  });

  test('"전부 감시 대상"이라고 적지 않는다', () => {
    // 이 저장소 규칙: **UNKNOWN을 0으로 적지 않는다.** 안 보는 계약이
    // 하나라도 있으면 "정상"이라고 쓰면 안 된다.
    assert(!/전부 청산 감시 대상/.test(exitCoverageLine()),
      '★ 돌지 않는 계약이 있는데 전부 감시 중이라고 적습니다');
  });
}
