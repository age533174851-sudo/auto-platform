// 실행 프로필이 **화면과 같은 의미**로 해석되는가.
//
// 여기서 막는 것은 전부 "조용히 다른 값으로 실행되는" 자리들이다.
// 오타 하나가 다른 배율이 되거나, 반쪽 선택이 채워지거나, 값이 바뀌었는데
// 같은 버전으로 남는 것.
import { test, assert, eq } from '../../test/harness';
import {
  resolveExecutionProfile, executionContractFingerprint,
  EXECUTION_CONTRACT_VERSION, CONTRACT_FIELDS, isExecutionResolveError,
} from './profile';
import { PROFILES } from '../strategies/profiles';
import { PRESET_TABLE } from '../strategies/profilePreset';

const V = EXECUTION_CONTRACT_VERSION;

/** 실패 코드. 성공했으면 빈 문자열 — 시험에서 좁히기를 반복하지 않으려고 둔다 */
const failCode = (r: ReturnType<typeof resolveExecutionProfile>) =>
  (isExecutionResolveError(r) ? r.code : '');

export function runExecutionProfileTests() {
  // ── 세 칸이 비면 기존 예약이다 ──
  test('세 칸이 모두 비면 프로필 없음이다 — 실패가 아니다', () => {
    for (const v of [[null, null, null], [undefined, undefined, undefined], ['', '', '']]) {
      const r = resolveExecutionProfile(v[0], v[1], v[2]);
      assert(r.ok && r.kind === 'none', `기존 예약이 실패로 처리됐다: ${JSON.stringify(v)}`);
    }
  });

  // ── 반쪽 선택은 채우지 않는다 ──
  test('일부만 있으면 나머지를 추측하지 않는다', () => {
    const cases: any[][] = [
      ['SCALP_HIGH_LEV', null, null],
      [null, 'RESEARCH', null],
      [null, null, V],
      ['SCALP_HIGH_LEV', 'RESEARCH', null],
      ['SCALP_HIGH_LEV', null, V],
      [null, 'RESEARCH', V],
    ];
    for (const c of cases) {
      const r = resolveExecutionProfile(c[0], c[1], c[2]);
      assert(failCode(r) === 'INCOMPLETE_SELECTION',
        `반쪽 선택이 통과했다: ${JSON.stringify(c)} → ${JSON.stringify(r)}`);
    }
  });

  // ── 모르는 값은 다른 값으로 대신하지 않는다 ──
  test('모르는 프로필은 스윙으로 떨어지지 않는다', () => {
    // 실제로 나기 쉬운 오타다. getProfile()을 썼다면 SWING_LOW_LEV가 된다.
    const r = resolveExecutionProfile('SCALP_HGIH_LEV', 'RESEARCH', V);
    assert(failCode(r) === 'UNKNOWN_PROFILE', JSON.stringify(r));
  });

  test('모르는 프리셋은 기본값으로 떨어지지 않는다', () => {
    // presetOf()를 썼다면 STABILIZE가 된다 — 25배가 5배로 조용히 바뀐다.
    for (const bad of ['RESERCH', 'stabilise', 'AGGRESSIVE', 'x']) {
      const r = resolveExecutionProfile('SCALP_HIGH_LEV', bad, V);
      assert(failCode(r) === 'UNKNOWN_PRESET', `${bad} → ${JSON.stringify(r)}`);
    }
  });

  test('버전이 다르면 조용히 올리지 않는다', () => {
    for (const bad of [V + 1, V - 1, 0, '1.0', 'x']) {
      const r = resolveExecutionProfile('SCALP_HIGH_LEV', 'RESEARCH', bad);
      assert(failCode(r) === 'VERSION_MISMATCH', `${bad} → ${JSON.stringify(r)}`);
    }
  });

  // ── 두 층이 실제로 다른 값을 낸다 ──
  test('같은 프로필이라도 프리셋이 다르면 다른 계약이다', () => {
    const research = resolveExecutionProfile('SCALP_HIGH_LEV', 'RESEARCH', V);
    const stabilize = resolveExecutionProfile('SCALP_HIGH_LEV', 'STABILIZE', V);
    assert(research.ok && research.kind === 'contract', 'RESEARCH 해석 실패');
    assert(stabilize.ok && stabilize.kind === 'contract', 'STABILIZE 해석 실패');
    const a = (research as any).contract, b = (stabilize as any).contract;
    assert(JSON.stringify(a) !== JSON.stringify(b),
      '연구용과 안정화가 같은 계약으로 해석됐다 — 두 층이 한 축으로 뭉갰다');
    // 실제 차이를 못박는다. 다섯 배다.
    eq(a.leverage, 25);
    eq(b.leverage, 5);
    eq(a.riskPercentPerTrade, 0.5);
    eq(b.riskPercentPerTrade, 0.25);
  });

  test('연구용은 프로필 표의 값 그대로다', () => {
    const r: any = resolveExecutionProfile('SCALP_HIGH_LEV', 'RESEARCH', V);
    const base: any = PROFILES.SCALP_HIGH_LEV;
    for (const f of CONTRACT_FIELDS) {
      eq(JSON.stringify(r.contract[f]), JSON.stringify(base[f]));
    }
  });

  // ── 계약에 모의값·문구가 섞이지 않는다 ──
  test('계약에는 실행값만 있다 — 모의값과 화면 문구는 없다', () => {
    const r: any = resolveExecutionProfile('SCALP_HIGH_LEV', 'RESEARCH', V);
    const keys = Object.keys(r.contract).sort();
    eq(JSON.stringify(keys),
      JSON.stringify(['contractVersion', 'presetId', 'profileId', ...CONTRACT_FIELDS].sort()));
    for (const banned of ['label', 'description', 'simCurrency', 'simSeed',
      'simTargetEquity', 'simPrice', 'simHoldSec', 'edgePp', 'assumedWinRate']) {
      assert(!(banned in r.contract), `계약에 ${banned}이 들어갔다`);
    }
  });

  test('지문에도 모의값·문구가 들어가지 않는다', () => {
    const fp = executionContractFingerprint();
    for (const banned of ['label', 'description', 'sim', 'edge', '스캘핑', '연구용']) {
      assert(!fp.includes(banned), `지문에 ${banned}이 들어갔다`);
    }
  });

  test('지문은 모든 조합을 덮는다', () => {
    const combos = Object.keys(PROFILES).length * Object.keys(PRESET_TABLE).length;
    const rows = JSON.parse(executionContractFingerprint());
    eq(rows.length, combos);
    assert(!JSON.stringify(rows).includes('UNRESOLVED'), '해석하지 못한 조합이 있다');
  });

  test('지문은 흔들리지 않는다', () => {
    eq(executionContractFingerprint(), executionContractFingerprint());
    assert(!/\d{10,}/.test(executionContractFingerprint()), '지문에 시각이 들어갔다');
  });

  // ── 이 계약은 아직 잠들어 있다 ──
  test('1A 계약 버전은 1이다 — 올리는 것은 검사기가 강제한다', () => {
    eq(EXECUTION_CONTRACT_VERSION, 1);
  });
}
