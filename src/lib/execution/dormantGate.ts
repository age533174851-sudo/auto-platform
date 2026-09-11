// src/lib/execution/dormantGate.ts
//
// **실행 프로필을 켜고 실행해도 되는가 — 그 판단이 사는 단 한 곳.**
//
// 왜 파일 하나를 따로 만드는가
// ────────────────────────────
// 1A(#244)는 실행 프로필을 가진 예약을 네 층에서 막았다.
//
//   L1  DB CHECK          `execution_profile_id IS NULL OR enabled = false`
//   L2  POST 저장         프로필을 건드리는 요청은 `enabled:false` 명시 필수
//   L3  PATCH 켜기        켜는 UPDATE 조건 안에 프로필 필터
//   L4  실행 직전         `evaluationRunner`가 선점보다 앞에서 BLOCK
//
// 이제 조합 하나를 여는데, **네 층에 각자 "이건 열어도 된다"를 적으면
// 반드시 갈린다.** 이 저장소에서 반복된 고장이 정확히 그것이다
// (`경로가 둘인데 한쪽만 고침`). 특히 나쁜 조합은 L4만 열고 L3가 계속
// 막는 경우다 — 사용자는 켤 수 없는데 시험은 "실행기가 통과시킨다"로
// 초록이 된다.
//
// 그래서 **여기 있는 표 하나가 정본**이고, 코드 층이 전부 이것을 읽는다.
// DB(L1)는 `080`이 같은 조합을 제약으로 적어 둔다 — 워커가 웹 평가기를
// 빌드 시점에 번들하므로, 배포가 엇갈리는 창은 코드 층만으로 못 막는다.
// 둘이 갈리는 것은 검사기가 잡는다.
//
// **전략까지 조합의 일부다**
// ───────────────────────────
// 100X 사이징·손절 정책을 실제로 실행하는 라우트는 지금 `scalp` 하나다.
// `daily-ladder`·`my-original-v1`은 실행 계약을 해석하는 코드가 아예 없다.
//
// 그래서 조합에 전략까지 넣지 않으면 이런 상태가 만들어진다:
//
//   daily-ladder + MAX_LEV_100X + EXACT_100X + TESTNET + 배정비율
//     → DB 허용 → 켜기 허용 → 실행 허용
//     → 그런데 daily-ladder 라우트는 그 계약을 읽지 않는다
//
// 저장된 것은 100X인데 도는 것은 일봉 계단식이다. 이 저장소가 계속
// 막아 온 형태 그대로다 — **화면에는 100X라고 켜져 있는데 실행기는 다른
// 의미로 돈다.** 그래서 `strategyId`가 조합에 들어간다.
//
// 다른 전략에 100X를 붙이고 싶으면 그 라우트에 계약을 배선한 뒤 이 표에
// 줄을 더한다. 전략을 몰래 `scalp`로 바꾸는 것이 아니다.
//
// 지금 열려 있는 것과 열려 있지 않은 것
// ─────────────────────────────────────
// 열림: `scalp` + `MAX_LEV_100X` + `EXACT_100X` + 계약 v2 + **TESTNET**
//       + 증거금 배정 입력
//
// 닫힘:
//   · 같은 조합의 **LIVE** — 고정 손절을 대신할 자동 종료 권한이 실제로
//     배선돼 있다는 증거가 없다. `exitLifecycle`에서 손절 없이 도는 것은
//     시간 청산 하나뿐이고, 그 정책조차 **전략 id**로만 조회되어 이 실행
//     프로필과 연결이 없다. **이 조건을 통과시키려고 임의의 exit 문턱을
//     새로 만들지 않는다.**
//   · **`scalp` 외의 전략** — 그 라우트들은 실행 계약을 읽지 않는다
//   · 기존 세 프로필의 명시적 선택 — 그 프로필들은 실행기가 계약대로
//     실행하지 않는다. 저장은 되지만 켜지지 않는다
//   · 증거금 배정이 비어 있는 예약 — 손절이 없으면 크기를 정할 근거가
//     그 값 하나뿐이다. 없으면 켜져 있어도 아무것도 못 한다

import { PROFILES } from '../strategies/profiles';

export interface OpenCombo {
  /**
   * 이 계약을 **실제로 해석해서 실행하는** 전략.
   *
   * 라우트가 계약을 읽지 않으면 저장된 의미와 도는 의미가 갈린다.
   * 그래서 배선된 전략만 여기 적는다.
   */
  strategyId: string;
  profileId: string;
  presetId: string;
  contractVersion: number;
  /** 이 조합을 열어 둔 운영 모드. LIVE가 없으면 실계좌에서는 못 켠다 */
  modes: readonly string[];
  /** 증거금 배정 비율이 입력돼 있어야 하는가 */
  requiresMarginAllocation: boolean;
}

/**
 * 실행기가 **실제로 계약대로 실행하는** 조합.
 *
 * 여기 없는 조합은 저장은 되지만 켤 수 없다. 조합을 넓히는 변경은 이
 * 배열 한 줄이고, 그때 `080`(DB 제약)도 함께 고쳐야 한다.
 */
export const OPEN_COMBOS: readonly OpenCombo[] = [
  {
    // `/api/autotrade/scalp`만 `resolveExecutionProfile` → `planEntry100x`
    // → `executeOrder({ stopPolicy })` 체인을 탄다.
    strategyId: 'scalp',
    profileId: 'MAX_LEV_100X',
    presetId: 'EXACT_100X',
    contractVersion: 2,
    modes: ['TESTNET'],
    requiresMarginAllocation: true,
  },
];

export interface ExecutionGateInput {
  /** 예약 줄의 strategy_id */
  strategyId?: unknown;
  profileId: unknown;
  presetId?: unknown;
  contractVersion?: unknown;
  /** 'TESTNET' | 'LIVE' | ... 예약 줄의 mode */
  mode?: unknown;
  /** 예약에 입력된 증거금 배정 비율(%). 미지정이면 null */
  marginAllocationPct?: unknown;
}

export interface ExecutionGateVerdict {
  allowed: boolean;
  reason: string;
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());

/**
 * 이 예약을 켜거나 실행해도 되는가.
 *
 * `profileId`가 비어 있으면(=프로필을 쓰지 않는 기존 예약) 통과다.
 * 기존 예약의 동작을 이 파일이 바꾸지 않는다.
 *
 * @param open 열린 조합. 시험이 주입한다. 안 주면 정본을 쓴다.
 */
export function executionGateVerdict(
  input: ExecutionGateInput | string | null | undefined,
  open: readonly OpenCombo[] = OPEN_COMBOS,
): ExecutionGateVerdict {
  const i: ExecutionGateInput = (input && typeof input === 'object')
    ? input as ExecutionGateInput
    : { profileId: input };

  const pid = str(i.profileId);
  if (!pid) return { allowed: true, reason: '' };

  // **모르는 id도 여기서 막힌다.** 화이트리스트라서 그렇다. 모르는 값을
  // "프로필이 없는 것"으로 읽어 통과시키면, 오타 하나가 기존 방식으로
  // 도는 예약이 된다 — 화면에 적힌 것과 다른 실행이다.
  if (!Object.prototype.hasOwnProperty.call(PROFILES, pid)) {
    return { allowed: false,
      reason: `모르는 실행 프로필입니다: ${pid} — 모르는 값을 프로필 없음으로 읽지 않습니다.` };
  }

  const combo = open.find(c => c.profileId === pid);
  if (!combo) {
    return { allowed: false,
      reason: `실행 프로필 ${pid}은(는) 아직 활성화되지 않았습니다`
        + ' — 실행기가 그 계약을 그대로 실행하지 않습니다.' };
  }

  // **전략을 프리셋보다 먼저 본다.** 프로필이 맞아도 라우트가 그 계약을
  // 읽지 않으면 저장된 의미와 도는 의미가 갈린다.
  const strat = str(i.strategyId);
  if (strat !== combo.strategyId) {
    return { allowed: false,
      reason: `${pid}은(는) ${combo.strategyId} 전략에서만 켤 수 있습니다 (받은 값: ${strat || '없음'})`
        + ' — 다른 전략의 라우트는 이 계약을 해석하지 않아,'
        + ' 저장된 의미와 실제로 도는 의미가 달라집니다.' };
  }

  const sid = str(i.presetId);
  if (sid !== combo.presetId) {
    return { allowed: false,
      reason: `${pid}은(는) ${combo.presetId} 프리셋에서만 켤 수 있습니다 (받은 값: ${sid || '없음'}).` };
  }

  const ver = Number(i.contractVersion);
  if (!Number.isInteger(ver) || ver !== combo.contractVersion) {
    return { allowed: false,
      reason: `${pid}은(는) 계약 버전 ${combo.contractVersion}에서만 켤 수 있습니다`
        + ` (받은 값: ${str(i.contractVersion) || '없음'}).` };
  }

  const mode = str(i.mode).toUpperCase();
  if (!combo.modes.includes(mode)) {
    return { allowed: false,
      reason: `${pid}은(는) ${combo.modes.join('/')}에서만 켤 수 있습니다 (받은 값: ${mode || '없음'})`
        + ' — 고정 손절을 대신할 자동 종료 권한이 배선됐다는 증거가 나오기 전에는 실계좌를 열지 않습니다.' };
  }

  if (combo.requiresMarginAllocation) {
    const pct = Number(i.marginAllocationPct);
    if (i.marginAllocationPct == null || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return { allowed: false,
        reason: `${pid}은(는) 증거금 배정 비율을 이 예약에 직접 입력해야 켤 수 있습니다`
          + ' — 고정 손절이 없어 크기를 정할 근거가 그 값 하나뿐이고, 화면 기본값을 빌려 오지 않습니다.' };
    }
  }

  return { allowed: true, reason: '' };
}

export type EnableFilterSpec =
  /** 열린 조합이 없다 — 프로필이 없는 줄만 켤 수 있다 */
  | { kind: 'isNull' }
  /** 프로필이 없거나, 열린 조합에 정확히 맞는 줄만 켤 수 있다 */
  | { kind: 'or'; expr: string };

/**
 * 켜기 UPDATE에 붙일 조건.
 *
 * **되읽어서 판단하면 늦는다.** PATCH의 update와 select가 한 문장이라,
 * 되읽었을 때는 이미 켜진 뒤다. 그래서 조건을 UPDATE 안에 넣는다 —
 * 맞는 줄이 없으면 아무것도 바뀌지 않는다.
 *
 * 순수 함수라 시험할 수 있다. 표가 바뀌었는데 이 자리가 그대로 남는
 * 것을 그렇게 잡는다 — 그러면 실행기만 열리고 사용자는 못 켠다.
 */
export function enableFilterSpec(
  open: readonly OpenCombo[] = OPEN_COMBOS,
): EnableFilterSpec {
  // PostgREST 문법이 깨지지 않게 값 모양을 제한한다. 프로필·프리셋 id는
  // 대문자·숫자·밑줄뿐이고, 그 밖의 값이 오면 조건을 만들지 않는다.
  const safe = open.filter(c =>
    /^[a-z0-9-]+$/.test(c.strategyId)
    && /^[A-Z0-9_]+$/.test(c.profileId)
    && /^[A-Z0-9_]+$/.test(c.presetId)
    && Number.isInteger(c.contractVersion)
    && c.modes.length > 0
    && c.modes.every(m => /^[A-Z0-9_]+$/.test(m)));
  if (safe.length === 0) return { kind: 'isNull' };

  const groups = safe.flatMap(c => c.modes.map(m => {
    const parts = [
      `strategy_id.eq.${c.strategyId}`,
      `execution_profile_id.eq.${c.profileId}`,
      `execution_preset_id.eq.${c.presetId}`,
      `execution_contract_version.eq.${c.contractVersion}`,
      `mode.eq.${m}`,
    ];
    if (c.requiresMarginAllocation) parts.push('margin_allocation_pct.not.is.null');
    return `and(${parts.join(',')})`;
  }));

  return { kind: 'or', expr: ['execution_profile_id.is.null', ...groups].join(',') };
}
