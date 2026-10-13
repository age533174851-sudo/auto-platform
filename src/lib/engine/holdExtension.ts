// src/lib/engine/holdExtension.ts
//
// **4시간이 됐다. 그래도 지금 닫아야 하는가 — 하나의 순수 판정.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// Exact100X의 자동 종료 수단은 **시간 청산 하나뿐이다**
// (`stopPolicy: 'NO_FIXED_SL'`, `takeProfitPolicy: 'NO_FIXED_TP'`,
// `seatExitCapabilities`에서 `timeExit`만 참). 그리고 그 하나는
// **손익을 보지 않는다** — `exitAuthority` ⑤는 `heldMs >= maxHoldMs`
// 한 줄이다.
//
// 그래서 지금 일어나는 일:
//
//   손실 중인 포지션도 4시간째에 닫힌다   → 맞다. 위험 관리다.
//   추세를 타고 올라가는 포지션도 닫힌다  → **이기고 있는 자리를 끊는다.**
//
// 둘이 같은 한 줄에 묶여 있어서 한쪽만 고칠 수 없다. 이 파일이 그 둘을
// 가른다.
//
// ★ 이 모듈이 할 수 있는 일은 **하나뿐이다 — 이미 승인된 종료를 늦추는 것.**
//
//   · 새 종료를 **당기지 않는다.** 4시간 전에는 아예 호출되지 않는다.
//   · 고정 익절을 **만들지 않는다.** 가격 목표를 거래소에 걸지 않는다.
//   · 기존 손절·보호장치를 **건드리지 않는다.** 읽지도 않는다.
//   · 주문을 내지 않는다 — 낼 수단이 타입에 없다.
//
//   즉 이 파일의 실패 모양은 "닫지 말았어야 할 것을 닫았다"가 아니라
//   **"닫아야 할 것을 늦췄다"**다. 그래서 모든 모호함은 닫는 쪽으로
//   떨어진다(fail-closed): 증거가 없으면·낡았으면·모르면 **닫는다.**
//
// ★ 그리고 늦춤에는 **절대 상한이 있다.** `absoluteMaxHoldMs`를 넘으면
//   어떤 증거로도 연장되지 않는다. "계속 수익이니 계속 들고 있는다"가
//   무한히 이어지는 경로를 만들지 않는다.
//
// 왜 실행 계약(`maxHoldSec`)을 고치지 않았는가
// ────────────────────────────────────────────
// `maxHoldSec: 14400`은 **언제 종료가 시작되는가**를 정하는 유일한
// 정본이고, 그 값을 바꾸면 이미 열려 있는 포지션들의 계약 지문과
// 버전까지 흔든다. 이 파일은 그 질문에 답하지 않는다 — **"시작된 종료를
// 증거가 있을 때 얼마나 늦출 수 있는가"**라는 다른 질문에 답한다.
// 질문이 둘이므로 정본도 둘이고, 둘이 서로를 덮어쓰지 않는다.
//
// 100배 격리의 산술 — 문턱을 여기서 지어내지 않은 근거
// ──────────────────────────────────────────────────
//   · 청산 거리 = 100/100 − 유지증거금률 ≈ **가격 0.6%**
//   · 왕복 taker 수수료 0.1% 명목 = **증거금 10%** (ROE 10%)
//   · 손익분기 가격 변동 ≈ 0.1% → ROE 0
//   · 즉 **ROE 3%는 가격 0.03%**이고, 수수료보다 작다. 이 숫자들을
//     ROE로 적는 이유가 그것이다 — 가격 퍼센트로 적으면 전부 반올림
//     오차처럼 보인다.
//
// ★ 성과가 좋아진다고 주장하지 않는다. 이 컨테이너에는 시장 데이터가
//   없어서 후보 비교·백테스트는 **UNKNOWN**이다. 검증한 것은 안전
//   속성(늦추기만 함 · 상한 · fail-closed)과 산술이다.

// ★ **`CLOSE_*`는 종료 "의도"다 — 거래소 청산 완료가 아니다.**
//
//   이 모듈이 돌려주는 `CLOSE_*`는 모두 한 가지 뜻뿐이다:
//   **"이번 회차에 늦추지 않는다."** 그 뒤에 실제로 닫혔는지는 이 모듈이
//   알 수 없다 — 주문을 낼 수단이 없으므로 알 방법도 없다.
//
//   실제 청산 결과를 말하는 것은 `ExitRunCode`와 `flatVerified` 둘뿐이다
//   (`CLOSED_VERIFIED` · `RECONCILED_CLOSED` · `CLOSE_REJECTED` ·
//   `CLOSE_INCOMPLETE` · `CLOSE_UNKNOWN_RECONCILE_REQUIRED`).
//
//   둘을 같은 값으로 읽으면 **거부된 청산이 "닫았다"로 적힌다.** 그래서
//   이름이 `CLOSED_*`가 아니라 `CLOSE_*`(동사)다.

export type HoldExtensionCode =
  /** 늦춘다 */
  | 'EXTEND'
  /** 이 계약에 연장 정책이 선언돼 있지 않다 — **오늘과 똑같이 닫는다** */
  | 'CLOSE_DISABLED'
  /** 절대 상한에 닿았다. 증거와 무관하게 닫는다 */
  | 'CLOSE_CAP'
  /** 증거가 없다. 없는 것은 통과가 아니다 */
  | 'CLOSE_EVIDENCE_MISSING'
  /** 증거가 낡았다. 낡은 증거는 증거가 아니다 */
  | 'CLOSE_EVIDENCE_STALE'
  /** 청산까지 남은 여유가 모자라다 — **수익보다 먼저 본다** */
  | 'CLOSE_LIQUIDATION_RISK'
  /** 수수료·펀딩까지 셈한 순수익이 문턱 아래다 (손실 포지션 위험 관리) */
  | 'CLOSE_LOSING'
  /** 고점 대비 수익을 되돌렸다 (이익 보호) */
  | 'CLOSE_GIVEBACK'
  /** 추세가 살아 있다는 증거가 없다 */
  | 'CLOSE_TREND_DEAD';

export interface HoldExtensionPolicy {
  /** 기록에 남는 판본 이름 */
  policyId: string;
  /**
   * **연장의 절대 상한(ms).** 어떤 증거로도 이 선을 넘지 않는다.
   *
   * 계약의 `maxHoldSec`과 다른 값이다 — 그쪽은 "종료가 시작되는 시각",
   * 이쪽은 "늦출 수 있는 끝".
   */
  absoluteMaxHoldMs: number;
  /** 연장하려면 순수익 ROE(%)가 이보다 커야 한다 */
  minNetRoePct: number;
  /** 고점 보호가 **작동하기 시작하는** 순수익 ROE(%) */
  givebackArmRoePct: number;
  /** 고점 대비 이 비율을 반납하면 닫는다 (0~1) */
  givebackFraction: number;
  /**
   * 노이즈 바닥. 요구 반납폭은 `ATR ROE × 이 배수`보다 작아지지 않는다.
   *
   * ATR을 모르면 바닥이 0이 되어 **닫기 쉬워진다** — 모호함이 닫는
   * 쪽으로 떨어지는 그 방향이다.
   */
  atrGivebackFloorMultiple: number;
  /** 남은 청산 여유(가격 %)가 이보다 작으면 닫는다 */
  minLiquidationHeadroomPct: number;
  /** 청산 주문에서 예상하는 미끄러짐 여유(가격 %). 순수익에서 깎는다 */
  exitSlippageAllowancePct: number;
  /** 증거가 이보다 오래됐으면 쓰지 않는다 */
  maxEvidenceAgeMs: number;
}

/**
 * 연장 판정에 필요한 **관측**. 전부 호출부가 넣는다.
 *
 * 이 모듈은 가격도 캔들도 읽지 않는다 — 읽으면 시험이 네트워크 없이
 * 경계를 재현할 수 없고, "판정과 조회가 한 함수에" 있는 그 모양이 된다.
 *
 * ★ `null`은 **UNKNOWN이고 0이 아니다.** 아래 판정이 UNKNOWN을 통과로
 *   읽지 않는다.
 */
export interface HoldEvidence {
  /** 이 관측을 받은 시각(ms). 없으면 쓸 수 없다 */
  observedAtMs: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  leverage: number | null;
  /** 왕복 taker 수수료율(명목 기준). 0.001 = 0.1% */
  roundTripFeeRate: number | null;
  /** 지금까지 **낸** 펀딩(quote). 받았으면 음수. 모르면 null */
  fundingPaidQuote: number | null;
  /** 진입 명목(quote). 펀딩을 ROE로 바꿀 때 쓴다 */
  notionalAtEntryQuote: number | null;
  /** 진입 후 **가장 유리했던** 가격. 없으면 null */
  bestPrice: number | null;
  /** 남은 청산 여유(가격 %) */
  liquidationHeadroomPct: number | null;
  /** 추세가 살아 있는가. **모르면 null이고 그건 통과가 아니다** */
  trendAlive: boolean | null;
  /** ATR을 가격 %로 환산한 값. 없으면 null */
  atrPct: number | null;
}

export interface HoldExtensionDecision {
  extend: boolean;
  code: HoldExtensionCode;
  reason: string;
  policyId: string | null;
  /** 수수료·미끄러짐·펀딩까지 깎은 순수익 ROE(%). 못 구하면 null */
  netRoePct: number | null;
  /** 같은 셈으로 본 고점 순수익 ROE(%) */
  peakNetRoePct: number | null;
  /** 닫히기까지 필요한 반납폭(ROE %). 보호가 아직 안 걸렸으면 null */
  requiredGivebackRoePct: number | null;
  liquidationHeadroomPct: number | null;
  /** 늦출 수 있는 끝(ms epoch). 연장했을 때만 적는다 */
  absoluteDeadlineMs: number | null;
}

// ══════════════════════════════════════════════════════════════
// ★ 어느 계약에 연장이 열려 있는가 — **정본은 여기 하나다**
// ══════════════════════════════════════════════════════════════
//
// 목록에 없으면 `CLOSE_DISABLED`이고, 그것은 **오늘과 글자 그대로 같은
// 동작**이다(4시간째 닫는다). 그래서 이 파일을 더해도 선언하지 않은
// 계약의 의미는 바뀌지 않는다.
const POLICIES: Record<string, HoldExtensionPolicy> = {
  // Exact100X — 시간 청산이 유일한 종료 수단인 계약
  'MAX_LEV_100X/EXACT_100X': {
    policyId: 'hold-extension-100x-v1',
    // 4시간에서 시작해 **최대 12시간**까지만.
    //
    // ★ 이 숫자는 데이터에서 유도한 것이 **아니다.** 이 저장소에는
    //   Exact100X의 실측 표본이 0건이고, 그러니 "몇 시간이 최적인가"는
    //   UNKNOWN이다. 모를 때는 **작은 쪽**을 고른다 — 연장은 무보호
    //   노출 시간을 늘리는 일이고(이 계약에는 고정 손절이 없다),
    //   4시간에서 12시간은 그 시간을 이미 3배로 늘린다.
    //
    //   표본이 쌓인 뒤에 올리는 것은 이 한 줄을 고치는 일이다. 반대로
    //   표본 없이 24시간을 적어 두면, 그 숫자를 고른 근거가 영영 없다.
    absoluteMaxHoldMs: 12 * 3_600_000,
    // 왕복 수수료가 ROE 10%다. 그 위에서만 "이기고 있다"고 말한다 —
    // ROE 10%는 본전이고 승자가 아니다.
    minNetRoePct: 15,
    givebackArmRoePct: 25,
    givebackFraction: 0.4,
    atrGivebackFloorMultiple: 0.5,
    // 청산 거리가 0.6%다. **절반을 남긴다.**
    minLiquidationHeadroomPct: 0.3,
    exitSlippageAllowancePct: 0.02,
    maxEvidenceAgeMs: 60_000,
  },
};

const num = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface HoldExtensionTarget {
  profileId?: unknown;
  presetId?: unknown;
}

/**
 * 이 실행 계약에 연장 정책이 **선언돼** 있는가.
 *
 * ★ "선언됨"은 "켜짐"이 **아니다.** 켜짐은 `judgeHoldExtensionActivation`이
 *   정하고, 기본값은 **꺼짐**이다. 둘을 한 함수로 합치면 "선언했으니
 *   돈다"가 되고, 그건 검증되지 않은 파라미터를 운영 기본값으로 켜는 것이다.
 */
export function resolveHoldExtensionPolicy(
  t: HoldExtensionTarget | null | undefined,
): HoldExtensionPolicy | null {
  const pid = String(t?.profileId ?? '').trim();
  const sid = String(t?.presetId ?? '').trim();
  if (!pid || !sid) return null;
  return POLICIES[`${pid}/${sid}`] ?? null;
}

// ══════════════════════════════════════════════════════════════
// ★ 켜짐은 **승인이다.** 기본값은 꺼짐이다
// ══════════════════════════════════════════════════════════════
//
// 왜 기본이 꺼짐인가
// ──────────────────
// 이 연장의 문턱 다섯 개(순수익 15% · 작동 25% · 반납 0.4 · ATR 0.5 ·
// 청산 여유 0.3%)와 상한 12시간은 **산술에서 유도했고 데이터에서 유도하지
// 않았다.** Exact100X 실측 표본은 0건이다. 검증되지 않은 파라미터를
// 운영 기본값으로 켜면, 그것을 고른 근거가 "그때 그렇게 적혀 있었다"가 된다.
//
// 그래서 선언(정책 표)과 켜짐(승인)을 나눈다. 선언은 커밋이고, 켜짐은
// **사람의 명시적 승인**이다 — LIVE 자금 승인과 같은 분류다.
//
// 왜 스위치 하나가 아니라 **시각**인가
// ────────────────────────────────────
// boolean 하나로 켜면, 켜는 순간 **이미 열려 있는 포지션들의 종료 규칙이
// 바뀐다.** 사용자가 4시간 계약으로 연 자리가 승인 한 번에 12시간 자리로
// 변한다 — 그 포지션에 대해서는 아무도 그것을 고르지 않았다.
//
// 그래서 승인 값 자체를 **"언제부터"**로 둔다. 한 칸이 승인과 적용 시점을
// 같이 들고 있으므로, 맞춰야 할 값이 둘로 늘지 않는다.
//
//     EXACT100X_HOLD_EXTENSION_APPROVED_AT=2026-10-20T00:00:00Z
//
// 그 시각 **이후에 연** 포지션만 연장 대상이다. 그 전에 연 포지션은
// 계약이 선언한 4시간에 그대로 닫힌다.
//
// 비어 있거나 읽을 수 없으면 **꺼짐**이다. 모르는 값을 "켜짐"으로 읽지 않는다.

export interface HoldExtensionActivationEnv {
  EXACT100X_HOLD_EXTENSION_APPROVED_AT?: string;
}

export type HoldExtensionActivationCode =
  /** 승인됨. `approvedAtMs` 이후에 연 포지션만 대상이다 */
  | 'APPROVED'
  /** 승인 값이 없다 — **기본값** */
  | 'NOT_APPROVED'
  /** 값이 있는데 시각으로 읽히지 않는다. 켜지 않는다 */
  | 'UNPARSEABLE';

export interface HoldExtensionActivation {
  enabled: boolean;
  code: HoldExtensionActivationCode;
  /** 이 시각 이후에 연 포지션만 대상. 꺼졌으면 null */
  approvedAtMs: number | null;
  reason: string;
}

/**
 * 연장이 켜져 있는가. **환경을 인자로 받는다.**
 *
 * 두 가지 이유로 `process.env`를 여기서 읽지 않는다:
 *
 *   ① 시험이 모든 조합을 `process.env`를 건드리지 않고 확인해야 한다.
 *   ② 이 파일은 **순수 판정 모듈이다.** import도 0개이고 주변 상태도
 *      읽지 않는다. 그래서 검사기가 이 파일(과 이 파일을 쓰는 사슬)을
 *      Node 타입 없이 단독으로 컴파일해 **실제로 불러 볼 수 있다.**
 *      여기서 `process.env` 한 줄을 읽는 순간 그 사슬 전체가 검사기에서
 *      컴파일되지 않았다 — 실제로 그렇게 깨졌다.
 *
 * `process.env`를 읽는 얇은 래퍼는 `holdExtensionEnv.ts`에 있다.
 */
export function judgeHoldExtensionActivation(
  e: HoldExtensionActivationEnv | null | undefined,
): HoldExtensionActivation {
  const raw = String(e?.EXACT100X_HOLD_EXTENSION_APPROVED_AT ?? '').trim();
  if (!raw) {
    return { enabled: false, code: 'NOT_APPROVED', approvedAtMs: null,
      reason: '승자 보유 연장은 승인되지 않았습니다 (기본값: 꺼짐)'
        + ' — 계약이 선언한 보유 한도에서 닫습니다' };
  }
  // epoch ms 숫자도, ISO 날짜도 받는다. **둘 중 어느 모양도 아니면 켜지지
  // 않는다.** `Date.parse`에 아무 문자열이나 넘기면 안 된다 — 엔진에 따라
  // `'-5'`나 `'2'` 같은 값도 어떤 시각으로 읽히고, 그러면 오타가 승인이 된다.
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
  const asNum = /^\d+$/.test(raw) ? Number(raw)
    : ISO_DAY.test(raw) ? Date.parse(raw) : NaN;
  // ★ **그럴듯한 ms epoch 범위 안이어야 한다.**
  //
  //   `'2'`는 숫자로 읽히고 1970-01-01T00:00:00.002Z가 된다. 그러면 그 뒤에
  //   연 **모든** 포지션이 "승인 뒤"가 되어, 오타 한 자가 소급 적용 금지를
  //   통째로 무력화한다.
  //
  //   초 단위를 ms 칸에 넣는 실수도 같은 모양이다 — 1760000000(초)은 ms로
  //   읽으면 1970년이다. 둘 다 여기서 걸린다.
  const MIN_MS = Date.parse('2020-01-01T00:00:00Z');
  const MAX_MS = Date.parse('2100-01-01T00:00:00Z');
  if (!Number.isFinite(asNum) || !(asNum >= MIN_MS) || !(asNum < MAX_MS)) {
    return { enabled: false, code: 'UNPARSEABLE', approvedAtMs: null,
      reason: '보유 연장 승인 값을 시각으로 읽지 못했습니다'
        + ' (ms epoch 또는 ISO 날짜, 2020~2100 범위)'
        + ' — 읽지 못한 승인은 승인이 아니므로 켜지 않습니다' };
  }
  return {
    enabled: true, code: 'APPROVED', approvedAtMs: asNum,
    reason: `보유 연장이 승인됐습니다 (${new Date(asNum).toISOString()} 이후에`
      + ' 연 포지션만 대상 — 그 전에 연 포지션은 계약 한도에서 닫습니다)',
  };
}

export type HoldExtensionGateCode =
  | 'OPEN'
  /** 이 계약에 연장 정책이 선언돼 있지 않다 */
  | 'NOT_DECLARED'
  | 'NOT_APPROVED'
  | 'UNPARSEABLE'
  /** 승인 **전에** 연 포지션이다 — 규칙을 소급 적용하지 않는다 */
  | 'OPENED_BEFORE_APPROVAL'
  /** 진입 시각을 읽지 못했다 — 소급인지 아닌지 알 수 없다 */
  | 'OPENED_AT_UNUSABLE';

export interface HoldExtensionGateVerdict {
  /** 열렸을 때만 정책이 있다. `null`이면 **오늘과 같이 닫는다** */
  policy: HoldExtensionPolicy | null;
  code: HoldExtensionGateCode;
  reason: string;
  activation: HoldExtensionActivation;
}

/**
 * **이 포지션에 연장을 물어봐도 되는가.**
 *
 *   ① 이 계약에 정책이 선언돼 있는가
 *   ② 사람이 승인했는가              (기본값: 아니다)
 *   ③ 이 포지션이 승인 **뒤에** 열렸는가
 *
 * 셋이 모두 참일 때만 정책을 돌려준다. 하나라도 아니면 `policy: null`이고,
 * 그러면 종료 경로는 연장 기능이 없던 때와 **글자 그대로 같이** 동작한다.
 */
export function holdExtensionGate(i: {
  executionIdentity: HoldExtensionTarget | null | undefined;
  openedAtMs: number | null | undefined;
  /**
   * 승인 환경. **호출부가 넣는다.** 안 넣으면 승인 없음(= 꺼짐)이다 —
   * 이 함수는 `process.env`를 집지 않는다.
   */
  env: HoldExtensionActivationEnv | null | undefined;
}): HoldExtensionGateVerdict {
  const activation = judgeHoldExtensionActivation(i?.env);

  const declared = resolveHoldExtensionPolicy(i?.executionIdentity);
  if (declared == null) {
    return { policy: null, code: 'NOT_DECLARED', activation,
      reason: '이 실행 계약에는 보유 연장이 선언돼 있지 않습니다' };
  }
  if (!activation.enabled) {
    return {
      policy: null,
      code: activation.code === 'UNPARSEABLE' ? 'UNPARSEABLE' : 'NOT_APPROVED',
      activation, reason: activation.reason,
    };
  }

  const opened = num(i?.openedAtMs);
  if (opened == null || !(opened > 0)) {
    // 소급인지 아닌지 **모른다.** 모르면 열지 않는다.
    return { policy: null, code: 'OPENED_AT_UNUSABLE', activation,
      reason: `진입 시각을 읽지 못해(${String(i?.openedAtMs)}) 이 포지션이 승인 뒤에`
        + ' 열린 것인지 확인할 수 없습니다 — 연장하지 않습니다' };
  }
  if (opened < (activation.approvedAtMs as number)) {
    return { policy: null, code: 'OPENED_BEFORE_APPROVAL', activation,
      reason: '승인 전에 열린 포지션입니다 — 이미 운영 중인 자리의 종료 규칙을'
        + ' 소급해서 바꾸지 않습니다 (계약이 선언한 보유 한도에서 닫습니다)' };
  }
  return { policy: declared, code: 'OPEN', activation, reason: activation.reason };
}

/** 선언된 계약 목록 — 검사기·시험이 센다 */
export function holdExtensionContractKeys(): string[] {
  return Object.keys(POLICIES).sort();
}

const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

/**
 * 순수익 ROE(%) — **한 곳에서만 센다.**
 *
 * 왜 gross를 쓰지 않는가: 100배에서 왕복 수수료는 증거금의 10%다.
 * gross로 "수익이니 더 들고 있자"를 판단하면 **수수료만큼 지는 자리를
 * 승자라고 부른다.**
 */
export function netRoeOf(i: {
  side: 'LONG' | 'SHORT';
  entryPrice: number; price: number; leverage: number;
  roundTripFeeRate: number; slippageAllowancePct: number;
  fundingPaidQuote: number; notionalAtEntryQuote: number | null;
}): number | null {
  if (!(i.entryPrice > 0) || !(i.price > 0) || !(i.leverage > 0)) return null;
  const dir = i.side === 'LONG' ? 1 : -1;
  const grossPricePct = ((i.price - i.entryPrice) / i.entryPrice) * 100 * dir;
  const grossRoePct = grossPricePct * i.leverage;
  const feeRoePct = i.roundTripFeeRate * 100 * i.leverage;
  const slipRoePct = i.slippageAllowancePct * i.leverage;
  let fundingRoePct = 0;
  if (i.fundingPaidQuote !== 0) {
    const notional = i.notionalAtEntryQuote;
    // 펀딩을 냈는데 명목을 모르면 **ROE로 바꿀 수 없다.** 0으로 적지 않는다.
    if (notional == null || !(notional > 0)) return null;
    const marginQuote = notional / i.leverage;
    if (!(marginQuote > 0)) return null;
    fundingRoePct = (i.fundingPaidQuote / marginQuote) * 100;
  }
  const net = grossRoePct - feeRoePct - slipRoePct - fundingRoePct;
  return Number.isFinite(net) ? net : null;
}

const close = (
  code: HoldExtensionCode, reason: string,
  over: Partial<HoldExtensionDecision> = {},
): HoldExtensionDecision => ({
  extend: false, code, reason,
  policyId: null, netRoePct: null, peakNetRoePct: null,
  requiredGivebackRoePct: null, liquidationHeadroomPct: null,
  absoluteDeadlineMs: null, ...over,
});

export interface HoldExtensionInput {
  /** 이 계약의 연장 정책. **없으면 오늘과 같다** */
  policy: HoldExtensionPolicy | null | undefined;
  evidence: HoldEvidence | null | undefined;
  side: 'LONG' | 'SHORT';
  /** 지금까지 보유한 시간(ms) */
  heldMs: number;
  /** 판정 시각 — 인자로 받는다. 경계에서 답이 흔들리지 않게 */
  nowMs: number;
}

/**
 * **이미 승인된 시간 청산을 늦춰도 되는가.**
 *
 * 순서가 계약이다. 위험이 수익보다 앞이고, 증거 없음이 전부보다 앞이다.
 *
 *   ① 연장 정책이 있는가            없으면 닫는다 (오늘과 동일)
 *   ② 절대 상한에 닿았는가          닿았으면 증거를 보지도 않는다
 *   ③ 증거가 있고 신선한가          없으면·낡았으면 닫는다
 *   ④ 청산 여유가 남아 있는가       **수익보다 먼저**
 *   ⑤ 순수익이 문턱 위인가          손실 포지션은 여기서 닫힌다
 *   ⑥ 고점 대비 반납했는가          이익 보호
 *   ⑦ 추세가 살아 있는가            증거가 없으면 닫는다
 *   ⑧ 그러면 늦춘다
 */
export function decideHoldExtension(i: HoldExtensionInput): HoldExtensionDecision {
  // ── ① 정책 ──
  const p = i?.policy ?? null;
  if (p == null) {
    return close('CLOSE_DISABLED',
      '이 계약에는 보유 연장이 선언돼 있지 않습니다 — 계약이 정한 보유 한도에서 닫습니다');
  }

  const held = num(i?.heldMs);
  const now = num(i?.nowMs);
  if (held == null || now == null || !(held >= 0)) {
    return close('CLOSE_EVIDENCE_MISSING',
      `보유 경과를 읽지 못했습니다 (${String(i?.heldMs)}) — 늦추지 않습니다`,
      { policyId: p.policyId });
  }

  // ── ② 절대 상한 ──
  //
  // **증거보다 앞이다.** 뒤로 밀면 "증거가 좋으니 상한을 넘겨도 된다"는
  // 경로가 생긴다. 상한은 증거로 뚫리지 않는다.
  if (held >= p.absoluteMaxHoldMs) {
    return close('CLOSE_CAP',
      `보유 ${Math.round(held / 60_000)}분 — 연장 절대 상한`
      + ` ${Math.round(p.absoluteMaxHoldMs / 60_000)}분에 닿았습니다`
      + ' (수익이어도 더 늦추지 않습니다)',
      { policyId: p.policyId });
  }

  // ── ③ 증거 ──
  const e = i?.evidence ?? null;
  if (e == null) {
    return close('CLOSE_EVIDENCE_MISSING',
      '보유 연장을 판단할 관측이 없습니다 — 확인하지 못한 것은 통과가 아닙니다',
      { policyId: p.policyId });
  }
  const observedAt = num(e.observedAtMs);
  const entry = num(e.entryPrice);
  const mark = num(e.markPrice);
  const lev = num(e.leverage);
  const fee = num(e.roundTripFeeRate);
  const funding = num(e.fundingPaidQuote);
  const headroom = num(e.liquidationHeadroomPct);

  // ── ③-b 무엇이 비었나 — **신선도보다 먼저 묻는다** ──
  //
  // 순서를 뒤집으면 마크가 조회가 실패한 회차가 "관측 시각을 모릅니다"로
  // 적힌다. 둘 다 사실이지만 운영자가 고쳐야 할 것은 **마크가 조회**다.
  const missing: string[] = [];
  if (observedAt == null || !(observedAt > 0)) missing.push('관측 시각');
  if (entry == null || !(entry > 0)) missing.push('진입가');
  if (mark == null || !(mark > 0)) missing.push('마크가');
  if (lev == null || !(lev > 0)) missing.push('배율');
  if (fee == null || !(fee >= 0)) missing.push('왕복 수수료율');
  if (funding == null) missing.push('펀딩 비용');
  if (headroom == null) missing.push('청산 여유');
  if (missing.length > 0) {
    return close('CLOSE_EVIDENCE_MISSING',
      `연장 판단에 필요한 관측이 없습니다 (${missing.join('·')})`
      + ' — 모르는 값을 0으로 적지 않고 닫습니다',
      { policyId: p.policyId, liquidationHeadroomPct: headroom });
  }

  // ★ 창을 **양쪽으로** 본다.
  //
  //   한 회차의 판정 시각은 하나로 고정된다(`nowMs`). 그런데 증거는 그
  //   시각 **뒤에** 거래소에서 읽힌다 — 같은 회차 안의 조회이므로 몇
  //   밀리초에서 몇백 밀리초 뒤다. 그것을 "미래 관측"으로 막으면 연장은
  //   영원히 일어나지 않는다.
  //
  //   반대로 판정 시각보다 **한참** 앞선 관측은 시계가 어긋났다는 뜻이고,
  //   그건 0으로 깎지 않고 막아야 한다. 그래서 허용 창과 같은 폭을 미래
  //   쪽에도 쓴다.
  const age = now - observedAt!;
  if (age > p.maxEvidenceAgeMs) {
    return close('CLOSE_EVIDENCE_STALE',
      `관측이 ${Math.round(age / 1000)}초 전 값입니다`
      + ` (허용 ${Math.round(p.maxEvidenceAgeMs / 1000)}초) — 낡은 증거로 늦추지 않습니다`,
      { policyId: p.policyId });
  }
  if (-age > p.maxEvidenceAgeMs) {
    return close('CLOSE_EVIDENCE_STALE',
      `관측 시각이 판정 시각보다 ${-age}ms 미래입니다 — 시계가 어긋난 것이므로`
      + ' 0으로 깎지 않고 막습니다',
      { policyId: p.policyId });
  }

  // ── ④ 청산 여유 — **수익보다 먼저** ──
  //
  // 100배 격리에서 청산은 가격 0.6% 거리다. 수익이 크다는 사실이 그
  // 거리를 늘려 주지 않는다.
  if (!(headroom! >= p.minLiquidationHeadroomPct)) {
    return close('CLOSE_LIQUIDATION_RISK',
      `청산까지 남은 여유가 ${headroom!.toFixed(3)}%입니다`
      + ` (최소 ${p.minLiquidationHeadroomPct}%) — 수익이어도 늦추지 않습니다`,
      { policyId: p.policyId, liquidationHeadroomPct: headroom });
  }

  const common = {
    side: i.side, entryPrice: entry!, leverage: lev!,
    roundTripFeeRate: fee!, slippageAllowancePct: p.exitSlippageAllowancePct,
    fundingPaidQuote: funding!, notionalAtEntryQuote: num(e.notionalAtEntryQuote),
  };
  const net = netRoeOf({ ...common, price: mark! });
  if (net == null) {
    return close('CLOSE_EVIDENCE_MISSING',
      '순수익을 셈하지 못했습니다 (펀딩을 ROE로 바꿀 명목이 없습니다)'
      + ' — 늦추지 않습니다',
      { policyId: p.policyId, liquidationHeadroomPct: headroom });
  }

  // 고점은 **같은 셈**으로 본다. gross 고점과 net 현재를 비교하면
  // 수수료만큼의 가짜 반납이 매번 생긴다.
  const best = num(e.bestPrice);
  const peakRaw = best == null ? null : netRoeOf({ ...common, price: best });
  // 고점을 모르면 **현재를 고점으로 본다** — 반납폭이 0이 되어 ⑥이
  // 아무것도 막지 않는다. 그래서 ⑥만으로 안전을 주장하지 않고 ⑤가
  // 손실을 따로 막는다.
  const peak = peakRaw == null ? net : Math.max(peakRaw, net);

  // ── ⑤ 순수익 문턱 — 손실 포지션 위험 관리 ──
  if (!(net > p.minNetRoePct)) {
    return close('CLOSE_LOSING',
      `순수익 ROE ${pct(net)} — 연장 문턱 ${pct(p.minNetRoePct)} 아래입니다`
      + ' (수수료·펀딩·미끄러짐을 셈한 값). 위험 관리로 닫습니다',
      { policyId: p.policyId, netRoePct: net, peakNetRoePct: peak,
        liquidationHeadroomPct: headroom });
  }

  // ── ⑥ 이익 보호 — 고점 대비 반납 ──
  //
  // 고정 익절이 아니다. 가격 목표를 거래소에 걸지 않고, 목표에 닿아서
  // 닫는 것도 아니다. **이미 승인된 종료를 더 늦추지 않을** 뿐이다.
  let required: number | null = null;
  if (peak >= p.givebackArmRoePct) {
    const atr = num(e.atrPct);
    // ATR을 모르면 바닥이 0 — 닫기 쉬워지는 쪽이다.
    const atrFloor = atr == null || !(atr > 0)
      ? 0 : atr * lev! * p.atrGivebackFloorMultiple;
    required = Math.max(peak * p.givebackFraction, atrFloor);
    const drop = peak - net;
    if (drop >= required) {
      return close('CLOSE_GIVEBACK',
        `고점 ROE ${pct(peak)} → 지금 ${pct(net)} (${pct(-drop)} 반납,`
        + ` 보호 문턱 ${required.toFixed(2)}%p) — 수익을 더 돌려주지 않습니다`,
        { policyId: p.policyId, netRoePct: net, peakNetRoePct: peak,
          requiredGivebackRoePct: required, liquidationHeadroomPct: headroom });
    }
  }

  // ── ⑦ 추세 ──
  //
  // **`true`가 아니면 전부 닫는다.** `null`(모름)도 닫는다 — 모르는 것을
  // "살아 있다"로 읽으면 이 모듈 전체가 "수익이면 계속 들고 있는다"가 된다.
  if (e.trendAlive !== true) {
    return close('CLOSE_TREND_DEAD',
      e.trendAlive === false
        ? `순수익 ROE ${pct(net)}이지만 추세가 꺾였습니다 — 계약 한도에서 닫습니다`
        : '추세가 살아 있다는 증거가 없습니다 — 모르는 것을 통과로 읽지 않습니다',
      { policyId: p.policyId, netRoePct: net, peakNetRoePct: peak,
        requiredGivebackRoePct: required, liquidationHeadroomPct: headroom });
  }

  // ── ⑧ 늦춘다 ──
  return {
    extend: true, code: 'EXTEND',
    reason: `순수익 ROE ${pct(net)} (고점 ${pct(peak)}) · 청산 여유`
      + ` ${headroom!.toFixed(3)}% · 추세 유지 — 계약 한도를 넘겨 보유를 연장합니다`
      + ` (절대 상한까지 ${Math.round((p.absoluteMaxHoldMs - held) / 60_000)}분)`,
    policyId: p.policyId,
    netRoePct: net, peakNetRoePct: peak,
    requiredGivebackRoePct: required,
    liquidationHeadroomPct: headroom,
    absoluteDeadlineMs: now + (p.absoluteMaxHoldMs - held),
  };
}

// ══════════════════════════════════════════════════════════════
// ★ 캔들 → 추세·ATR·고점 — **순수 함수다. 네트워크를 모른다**
// ══════════════════════════════════════════════════════════════
//
// 왜 여기 있는가: 호출부가 캔들에서 직접 "추세가 살아 있다"를 셈하면 그
// 판단이 라우트 안에 들어가고, 그 자리는 시험되지 않는다. 그리고 다음에
// 같은 판단이 필요해지면 두 번째 복사본이 생긴다.

export interface HoldBar { high: number; low: number; close: number }

export interface BarTrendSummary {
  /** 쓸 수 있는 봉이 충분했는가 */
  ok: boolean;
  /** 추세가 살아 있는가. 못 정하면 null */
  trendAlive: boolean | null;
  /** ATR을 **가격 %**로. 못 정하면 null */
  atrPct: number | null;
  /** 진입 후 가장 유리했던 가격. 못 정하면 null */
  bestPrice: number | null;
  reason: string;
}

/** 추세 판정에 필요한 최소 봉 수 */
export const TREND_MIN_BARS = 8;
/** 단기 이동평균 길이 */
export const TREND_MA_PERIOD = 6;
/** ATR 길이 */
export const TREND_ATR_PERIOD = 6;

/**
 * 봉에서 **추세·변동성·고점**을 뽑는다.
 *
 * 추세 정의 — 두 조건을 **모두** 본다:
 *   · 마지막 종가가 단기 이동평균의 유리한 쪽에 있다
 *   · 그 이동평균 자체가 유리한 방향으로 움직이고 있다
 *
 * 하나만 보면 횡보 구간에서 매 봉 답이 뒤집힌다. 봉이 모자라면
 * `trendAlive: null`이고, 위 ⑦이 그것을 닫는 쪽으로 읽는다.
 */
export function summarizeBars(
  bars: ReadonlyArray<HoldBar> | null | undefined,
  side: 'LONG' | 'SHORT',
): BarTrendSummary {
  const rows = (bars ?? []).filter(b =>
    b != null && Number.isFinite(Number(b.high)) && Number.isFinite(Number(b.low))
    && Number.isFinite(Number(b.close)) && Number(b.close) > 0);
  if (rows.length < TREND_MIN_BARS) {
    return { ok: false, trendAlive: null, atrPct: null, bestPrice: null,
      reason: `봉이 ${rows.length}개뿐입니다 (최소 ${TREND_MIN_BARS}) — 추세를 정하지 않습니다` };
  }

  const closes = rows.map(b => Number(b.close));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const maNow = mean(closes.slice(-TREND_MA_PERIOD));
  const maPrev = mean(closes.slice(-TREND_MA_PERIOD - 1, -1));
  const last = closes[closes.length - 1];
  const dir = side === 'LONG' ? 1 : -1;
  const trendAlive = (last - maNow) * dir > 0 && (maNow - maPrev) * dir > 0;

  // ATR — true range 평균. 전 종가가 있는 구간만 센다.
  const trs: number[] = [];
  for (let k = rows.length - TREND_ATR_PERIOD; k < rows.length; k += 1) {
    if (k <= 0) continue;
    const hi = Number(rows[k].high), lo = Number(rows[k].low);
    const prev = Number(rows[k - 1].close);
    trs.push(Math.max(hi - lo, Math.abs(hi - prev), Math.abs(lo - prev)));
  }
  const atr = trs.length > 0 ? mean(trs) : null;
  const atrPct = atr != null && last > 0 ? (atr / last) * 100 : null;

  const bestPrice = side === 'LONG'
    ? Math.max(...rows.map(b => Number(b.high)))
    : Math.min(...rows.map(b => Number(b.low)));

  return {
    ok: true, trendAlive, atrPct,
    bestPrice: Number.isFinite(bestPrice) && bestPrice > 0 ? bestPrice : null,
    reason: trendAlive
      ? `마지막 종가가 단기 평균의 ${side === 'LONG' ? '위' : '아래'}이고 평균도 같은 방향입니다`
      : '종가와 단기 평균의 방향이 추세를 지지하지 않습니다',
  };
}
