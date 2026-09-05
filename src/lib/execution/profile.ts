// src/lib/execution/profile.ts
//
// **화면에서 고른 실행 프로필이 실제 주문 경로에서 같은 의미가 되게 한다.**
//
// 무엇이 고장나 있었나
// ────────────────────
// 화면의 프로필 표는 이미 정본을 갖고 있었다 — 배율 25~50배, 위험 0.5%,
// 익절 0.6% / 손절 0.3%, isolated, Post-only. 그런데 그 값을 읽는 곳이
// **화면 하나뿐**이었다(`StrategyProfilesPanel`). 실행 경로는 아무도
// `profiles.ts`도 `ruleEngine.ts`도 부르지 않는다.
//
// 실제 단타는 ATR에서 손절·목표를 매번 새로 계산한다(`scalpSignal`).
// 그래서 화면은 "손절 0.3%"라고 적혀 있는데 거래소에는 그날의 ATR이
// 나갔다. 만들어 놓고 배선을 안 한 것이다.
//
// 이 파일이 하는 일 — 그리고 하지 않는 일
// ───────────────────────────────────────
// **1A에서는 계약만 만든다.** 정본을 해석하고, 저장하고, 실행 경로까지
// 전달하는 길만 낸다. 실제 주문 의미는 한 글자도 바꾸지 않는다.
//
// 그래서 이 계약을 가진 예약은 **잠들어 있다**(dormant). 켤 수 없다.
// 저장은 되지만 `enabled=false`만 허용하고, 켜려 하면 막고, 혹시 DB에
// 켜져 있어도 실행 직전에 막는다. 이유는 하나다 — 지금 실행기는 이
// 계약을 아직 읽지 않으므로, 켤 수 있게 두면 **"화면은 연구용인데
// 실제는 ATR"**이라는 바로 그 고장을 정식 기능으로 다시 만드는 셈이다.
//
// 두 층을 한 축으로 섞지 않는다
// ─────────────────────────────
// 이 저장소의 실행 설정은 두 층이다.
//
//   기본 프로필  SCALP_HIGH_LEV · SWING_LOW_LEV · DAILY_HIGH_LEV
//   위험 프리셋  STABILIZE · RESEARCH
//
// `RESEARCH`는 **프리셋이지 프로필이 아니다.** 둘을 한 칸에 섞으면
// `SCALP_HIGH_LEV + RESEARCH`(25배)와 `SCALP_HIGH_LEV + STABILIZE`(5배)를
// 구분할 수 없다 — 다섯 배 차이가 같은 값으로 저장된다. 그래서 선택은
// 언제나 **세 축**이다: 프로필 · 프리셋 · 계약 버전.
//
// 되돌아가지 않는다
// ─────────────────
// 기존 `getProfile()`은 모르는 id에 `SWING_LOW_LEV`를 돌려주고,
// `presetOf()`는 모르는 값에 `STABILIZE`를 돌려준다. 화면에서는 그것이
// 편의지만 **실행에서는 오타 하나가 다른 배율로 주문을 내는 일**이다.
// 그래서 이 파일은 둘 다 쓰지 않는다. 정확히 일치할 때만 해석하고,
// 아니면 막는다.
//
// `applyPreset()`은 안에서 `presetOf()`를 부른다. 그래서 "직접 안 쓴다"
// 만으로는 부족하다 — **검증을 먼저 끝낸 뒤에만** 부른다. 모르는
// 프리셋이 `applyPreset()`에 도달하는 것 자체가 불가능해야 한다.
import { PROFILES, type StrategyProfile, type StrategyType } from '../strategies/profiles';
import { PRESET_TABLE, applyPreset, type RiskPresetId } from '../strategies/profilePreset';

/**
 * 해석된 실행 계약의 버전.
 *
 * **최종 실행값 전체를 가리킨다** — 기본 프로필과 프리셋 override를 합친
 * 결과다. 어느 쪽 숫자가 바뀌든 이 값을 올려야 한다. 기본 프로필만
 * 버전을 매기면, 프리셋의 위험 0.25%가 0.4%로 바뀌어도 같은 버전이
 * 되어 **같은 예약이 다른 의미로 실행된다.**
 *
 * 올리는 것은 자동이 아니다. 검사기가 이전 커밋과 비교해서, 실행값이
 * 바뀌었는데 이 숫자가 그대로면 실패시킨다.
 */
export const EXECUTION_CONTRACT_VERSION = 1;

/**
 * 계약에 들어가는 칸 — **화이트리스트다.**
 *
 * `StrategyProfile`에는 실행값과 모의 전용값이 같은 객체에 산다
 * (`simSeed` · `simCurrency` · `simTargetEquity` · `simPrice` ·
 * `simHoldSec`). 프로필을 통째로 넘기면 모의 시드 하나 바꿨다고 실행
 * 계약 버전을 올려야 하는 구조가 된다. 화면 문구(`label`·`description`)도
 * 마찬가지다.
 *
 * 그래서 **여기 적힌 것만** 계약이고, 지문도 이것만 본다. 한 배열을
 * 투영과 지문이 함께 쓴다 — 목록이 둘이 되면 언젠가 갈리고, 갈리는
 * 순간이 이 파일이 막으려는 고장 그 자체다.
 */
export const CONTRACT_FIELDS = [
  'leverage', 'maxLeverage', 'marginModes', 'maxPortfolioPct',
  'riskPercentPerTrade', 'takeProfitPct', 'stopLossPct',
  'orderType', 'timeoutSec', 'dailyLossLimitPct',
  'maxHoldSec', 'maxOpenPositions',
] as const;

export type ContractField = (typeof CONTRACT_FIELDS)[number];

export interface ExecutionContract {
  profileId: StrategyType;
  presetId: RiskPresetId;
  contractVersion: number;
  leverage: number;
  maxLeverage: number;
  marginModes: string[];
  maxPortfolioPct: number;
  riskPercentPerTrade: number;
  takeProfitPct: number;
  stopLossPct: number;
  orderType: string;
  timeoutSec: number;
  dailyLossLimitPct: number;
  maxHoldSec: number;
  maxOpenPositions: number;
}

export type ExecutionResolveCode =
  /** 세 칸이 모두 비어 있다 — 프로필을 쓰지 않는 기존 예약 */
  | 'NONE'
  /** 세 칸 중 일부만 있다. **추측해서 채우지 않는다** */
  | 'INCOMPLETE_SELECTION'
  /** 모르는 프로필 id. 다른 프로필로 대신하지 않는다 */
  | 'UNKNOWN_PROFILE'
  /** 모르는 프리셋 id. 기본 프리셋으로 대신하지 않는다 */
  | 'UNKNOWN_PRESET'
  /** 저장할 때의 계약과 지금 계약이 다르다. 조용히 올리지 않는다 */
  | 'VERSION_MISMATCH';

export type ExecutionResolve =
  | { ok: true; kind: 'none'; contract: null }
  | { ok: true; kind: 'contract'; contract: ExecutionContract }
  | { ok: false; code: ExecutionResolveCode; message: string };

/**
 * 실패한 해석인가.
 *
 * `strictNullChecks`가 꺼져 있어 `ok` 같은 boolean 리터럴로는 유니온이
 * 좁혀지지 않는다. 키 존재로 좁히면 그 설정과 무관하게 동작한다.
 * 호출부마다 이 요령을 다시 쓰지 않도록 여기 한 번만 둔다.
 */
export function isExecutionResolveError(
  r: ExecutionResolve,
): r is Extract<ExecutionResolve, { code: ExecutionResolveCode }> {
  return 'code' in r;
}

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/**
 * 세 축을 해석한다.
 *
 * 순서가 계약의 일부다. **검증을 전부 끝낸 뒤에만** `applyPreset()`을
 * 부른다 — 그 함수는 안에서 `presetOf()`를 부르고, `presetOf()`는 모르는
 * 값을 기본 프리셋으로 바꾼다. 검증을 먼저 하면 그 경로에 도달할 수 없다.
 *
 *   ① 프로필 정확 일치        PROFILES[id]
 *   ② 프리셋 정확 일치        PRESET_TABLE의 키
 *   ③ 버전 일치
 *   ④ 그 뒤에만 applyPreset
 *   ⑤ 화이트리스트 투영
 */
export function resolveExecutionProfile(
  profileId: unknown, presetId: unknown, version: unknown,
): ExecutionResolve {
  const blanks = [isBlank(profileId), isBlank(presetId), isBlank(version)];

  // 셋 다 비면 프로필을 쓰지 않는 예약이다 — 기존 동작 그대로.
  if (blanks.every(Boolean)) return { ok: true, kind: 'none', contract: null };

  // 하나라도 비면 **나머지로 추측하지 않는다.** 반쪽 선택은 선택이 아니다.
  if (blanks.some(Boolean)) {
    return {
      ok: false, code: 'INCOMPLETE_SELECTION',
      message: '실행 프로필 선택이 완전하지 않습니다 — 프로필·프리셋·버전이 모두 있어야 합니다',
    };
  }

  // ① 프로필. `getProfile()`을 쓰지 않는다 — 그쪽은 모르는 id를 스윙으로 바꾼다.
  const pid = String(profileId);
  const base: StrategyProfile | undefined = (PROFILES as any)[pid];
  if (!base) {
    return {
      ok: false, code: 'UNKNOWN_PROFILE',
      message: `모르는 실행 프로필입니다: ${pid}`,
    };
  }

  // ② 프리셋. `presetOf()`를 쓰지 않는다 — 그쪽은 모르는 값을 기본값으로 바꾼다.
  const sid = String(presetId);
  if (!Object.prototype.hasOwnProperty.call(PRESET_TABLE, sid)) {
    return {
      ok: false, code: 'UNKNOWN_PRESET',
      message: `모르는 위험 프리셋입니다: ${sid}`,
    };
  }

  // ③ 버전. 저장 시점과 지금이 다르면 **조용히 올리지 않는다.**
  //
  // 숫자로 눕히지 않는다. `Number('1.0')`은 1이라 '1.0'이 버전 1로
  // 통과한다 — 우리가 쓴 적 없는 모양이 조용히 맞는 값이 되는 것이고,
  // 그게 이 파일이 막으려는 종류의 일이다. 정수이거나 정수 모양의
  // 문자열일 때만 읽는다.
  const raw = typeof version === 'number' ? version
    : (typeof version === 'string' && /^-?\d+$/.test(version.trim()) ? Number(version) : NaN);
  const v = raw;
  if (!Number.isInteger(v) || v !== EXECUTION_CONTRACT_VERSION) {
    return {
      ok: false, code: 'VERSION_MISMATCH',
      message: `실행 계약 버전이 다릅니다 (저장 ${String(version)} · 지금 ${EXECUTION_CONTRACT_VERSION})`
        + ' — 값이 바뀌었을 수 있으니 다시 선택해 저장해야 합니다',
    };
  }

  // ④ 여기서부터 안전하다. 검증된 값만 들어간다.
  const merged = applyPreset(base, sid as RiskPresetId);

  // ⑤ 화이트리스트 투영. 모의값·문구는 들어오지 않는다.
  const out: any = {
    profileId: pid as StrategyType,
    presetId: sid as RiskPresetId,
    contractVersion: EXECUTION_CONTRACT_VERSION,
  };
  for (const f of CONTRACT_FIELDS) out[f] = (merged as any)[f];
  return { ok: true, kind: 'contract', contract: out as ExecutionContract };
}

/**
 * 실행 계약 전체의 지문.
 *
 * 모든 (프로필 × 프리셋) 조합의 **실행값만** 안정 직렬화한다. 검사기가
 * 이전 커밋의 지문과 비교해서, 값이 바뀌었는데 버전이 그대로면 막는다.
 *
 * `profileId`·`presetId`는 조합 키라서 값 쪽에 넣지 않는다. 모의값과
 * 화면 문구도 넣지 않는다 — `simSeed`를 바꿨다고 실행 계약 버전을 올려야
 * 한다면 그 버전은 실행을 가리키는 것이 아니게 된다.
 */
export function executionContractFingerprint(): string {
  const rows: any[] = [];
  for (const pid of Object.keys(PROFILES).sort()) {
    for (const sid of Object.keys(PRESET_TABLE).sort()) {
      const r = resolveExecutionProfile(pid, sid, EXECUTION_CONTRACT_VERSION);
      if (!r.ok || r.kind !== 'contract') {
        rows.push([pid, sid, 'UNRESOLVED']);
        continue;
      }
      rows.push([pid, sid, CONTRACT_FIELDS.map(f => (r.contract as any)[f])]);
    }
  }
  return JSON.stringify(rows);
}
