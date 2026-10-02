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

  test('그 줄은 **시간 청산만** 열렸다고 적는다 — 나머지는 그대로 false다', () => {
    const r = rowFor('EXACT_100X')!;
    // ⑤에서 전용 종료 권한이 붙어 시간 청산 **하나만** 돌기 시작했다.
    // 이 값은 표에 손으로 적은 것이 아니라 분류기에서 derive한 것이다 —
    // 배선을 끊으면 같이 false가 된다(변이가 그것을 증명한다).
    eq(r.timeExit, true, '★ 배선된 시간 청산을 false로 적었습니다');
    eq(r.trailing, false, '★ 돌지 않는 트레일링을 true로 적었습니다');
    eq(r.breakEven, false, '★ 돌지 않는 본전이동을 true로 적었습니다');
    // 진입 보호주문은 **계약상 안 거는 것**이다. 그래도 false가 맞다 —
    // 이 칸은 "거는가"를 묻는다.
    eq(r.protectiveOrdersAtEntry, false);
    // 전용 권한이 매 회차 거래소 노출을 다시 읽는다.
    eq(r.positionGuard, true);
  });

  test('시간 청산이 열려도 **없는 것은 없다고** 적는다', () => {
    const r = rowFor('EXACT_100X')!;
    assert(r.gap != null, '★ 하나가 열렸다고 빈 칸이 사라지면 안 됩니다');
    assert(/시간 청산만/.test(r.gap!),
      '★ "종료가 된다"로 읽히면 안 됩니다 — 열린 것은 하나뿐입니다');
    assert(/트레일링·본전이동·adverse\/청산여유 비상 종료는\s*아직 없습니다/.test(r.gap!),
      '★ 아직 없는 종료 수단을 적지 않습니다 — 운영자가 무엇이 없는지 모릅니다');
    assert(/불리하게 움직이면 자동으로 닫히지/.test(r.gap!),
      '★ 보유 한도 전에 손실이 나도 안 닫힌다는 사실을 적어야 합니다');
  });

  test('계약이 선언한 보유 한도를 **실제로 읽는다**고 적는다', () => {
    const r = rowFor('EXACT_100X')!;
    // 전에는 "선언하지만 청산 경로가 그 값을 읽지 않습니다"였다. ⑤에서
    // `resolveExitPolicy`가 계약에서 직접 읽으므로 그 문장은 더 이상
    // 사실이 아니다. **사실이 바뀌면 표도 바뀐다.**
    assert(/최대 보유 4시간을 전용 종료 권한이 읽어/.test(r.gap!),
      `★ 계약 한도 배선을 적지 않습니다 — ${r.gap}`);
    assert(!/읽지 않습니다/.test(r.gap!), '★ 옛 사실이 그대로 남아 있습니다');
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
