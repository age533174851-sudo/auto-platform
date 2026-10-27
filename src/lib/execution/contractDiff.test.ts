// src/lib/execution/contractDiff.test.ts
//
// **관문을 좁혔으니, 좁힌 뒤에도 잡히는지를 먼저 적는다.**
//
// 이 판정은 "버전을 올려야 하는가"를 정한다. 느슨해지면 같은 예약이 다른
// 의미로 실행되고, 과하게 조이면 프로필 하나를 더할 때마다 운영 중인
// 예약이 전부 멈춘다. 그래서 양쪽을 다 시험한다.
import { test, eq, assert } from '../../test/harness';
import {
  diffContractRows, contractBumpVerdict, type ContractRow,
} from './contractDiff';

const FIELDS: ContractRow = ['#fields', 'leverage,maxLeverage,stopPolicy'];
const A: ContractRow = ['MAX_LEV_100X|EXACT_100X', '[100,100,"NO_FIXED_SL"]'];
const B: ContractRow = ['SCALP_HIGH_LEV|STABILIZE', '[5,10,"FIXED_SL"]'];
const NEW: ContractRow = ['ADAPTIVE_LEV_10_75|ADAPTIVE_RISK', '[10,75,"NO_FIXED_SL"]'];

export function runContractDiffTests() {
  console.log('[실행 계약 — 바뀐 것과 늘어난 것을 가른다]');

  test('바뀐 줄·없어진 줄·늘어난 줄을 각각 센다', () => {
    const d = diffContractRows(
      [FIELDS, A, B],
      [FIELDS, ['MAX_LEV_100X|EXACT_100X', '[75,75,"NO_FIXED_SL"]'], NEW],
    );
    eq(d.changed.join(','), 'MAX_LEV_100X|EXACT_100X');
    eq(d.removed.join(','), 'SCALP_HIGH_LEV|STABILIZE');
    eq(d.added.join(','), 'ADAPTIVE_LEV_10_75|ADAPTIVE_RISK');
  });

  // ══════════ 좁힌 쪽 — 늘어나기만 하면 올리지 않는다 ══════════

  test('★★ 새 조합이 생긴 것만으로는 버전을 올리지 않는다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A, B], head: [FIELDS, A, B, NEW],
      baseVersion: 2, headVersion: 2,
    });
    eq(v.ok, true, v.message);
    eq(v.code, 'OK_ADDED_ONLY');
    // 올리면 저장된 예약이 전부 어긋난다 — 그 이유가 사유에 남아야 한다.
    assert(/VERSION_MISMATCH/.test(v.message), v.message);
  });

  test('늘어난 상태에서 버전을 올려도 막지는 않는다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A], head: [FIELDS, A, NEW], baseVersion: 2, headVersion: 3,
    });
    eq(v.ok, true, v.message);
  });

  // ══════════ 조인 쪽 — 바뀌거나 사라지면 그대로 막는다 ══════════

  test('★★ 기존 조합의 실행값이 바뀌면 버전을 올려야 한다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A],
      head: [FIELDS, ['MAX_LEV_100X|EXACT_100X', '[75,75,"NO_FIXED_SL"]']],
      baseVersion: 2, headVersion: 2,
    });
    eq(v.ok, false, '배율이 100에서 75로 바뀌었는데 통과했다');
    eq(v.code, 'NEEDS_BUMP');
    assert(/MAX_LEV_100X/.test(v.message), v.message);
  });

  test('★★ 기존 조합이 없어져도 버전을 올려야 한다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A, B], head: [FIELDS, A], baseVersion: 2, headVersion: 2,
    });
    eq(v.ok, false, '조합이 사라졌는데 통과했다 — 그 예약은 해석되지 않는다');
    eq(v.code, 'NEEDS_BUMP');
  });

  test('★★ 칸 이름이 바뀌면 버전을 올려야 한다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A],
      head: [['#fields', 'leverage,maxLeverage,stopPolicyV2'], A],
      baseVersion: 2, headVersion: 2,
    });
    eq(v.ok, false, '투영하는 칸이 바뀌었는데 통과했다');
    eq(v.code, 'NEEDS_BUMP');
  });

  test('★★ 바뀜과 늘어남이 섞이면 바뀜이 이긴다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A],
      head: [FIELDS, ['MAX_LEV_100X|EXACT_100X', '[75,75,"NO_FIXED_SL"]'], NEW],
      baseVersion: 2, headVersion: 2,
    });
    eq(v.ok, false, '늘어난 줄이 있다고 바뀐 줄이 묻혔다');
    eq(v.code, 'NEEDS_BUMP');
  });

  test('바뀐 뒤 버전을 올리면 통과한다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A],
      head: [FIELDS, ['MAX_LEV_100X|EXACT_100X', '[75,75,"NO_FIXED_SL"]']],
      baseVersion: 2, headVersion: 3,
    });
    eq(v.ok, true, v.message);
    eq(v.code, 'OK_BUMPED');
  });

  // ══════════ 버전 자체 ══════════

  test('★ 달라진 줄이 없어도 버전이 내려가면 막는다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A], head: [FIELDS, A], baseVersion: 3, headVersion: 2,
    });
    eq(v.ok, false);
    eq(v.code, 'VERSION_WENT_DOWN');
  });

  test('★ 버전이 정수가 아니면 막는다', () => {
    for (const bad of [null, undefined, '2.5', NaN, 'v2']) {
      const v = contractBumpVerdict({
        base: [FIELDS, A], head: [FIELDS, A], baseVersion: 2, headVersion: bad,
      });
      eq(v.ok, false, `headVersion=${String(bad)}인데 통과했다`);
    }
  });

  test('아무것도 달라지지 않으면 조용히 통과한다', () => {
    const v = contractBumpVerdict({
      base: [FIELDS, A, B], head: [FIELDS, A, B], baseVersion: 2, headVersion: 2,
    });
    eq(v.ok, true);
    eq(v.code, 'OK_UNCHANGED');
  });

  test('★ base를 읽지 못한 경우를 "늘어남"으로 읽지 않는다', () => {
    // base가 비면 모든 줄이 added가 된다. 그 상태를 통과로 적으면
    // **base를 못 읽은 회차가 전부 무사통과**한다. 그래서 호출부(검사기)가
    // base 부재를 따로 처리해야 한다는 것을 여기 시험으로 못 박는다.
    const v = contractBumpVerdict({
      base: [], head: [FIELDS, A], baseVersion: 2, headVersion: 2,
    });
    eq(v.code, 'OK_ADDED_ONLY',
      '판정 자체는 늘어남으로 본다 — base 부재는 검사기가 가려야 한다');
  });
}
