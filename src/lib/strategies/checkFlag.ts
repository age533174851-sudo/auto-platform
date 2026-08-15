// src/lib/strategies/checkFlag.ts
//
// **점검인 줄 알았던 호출이 진짜 주문을 내면 안 된다.**
//
// 실제로 있던 고장
// ────────────────
// 화면의 [지금 점검하기]는 `strategyRunRequest()`가 만든 본문을 보낸다.
// 그 함수는 레지스트리의 `checkFlag`를 그대로 켠다:
//
//     if (i.checkOnly) body[spec.checkFlag] = true;
//
// scalp의 `checkFlag`는 `'checkOnly'`다. 그런데 scalp 라우트가 실제로
// 주문을 멈추는 값은 이거였다:
//
//     const dryRun = body.dryRun === true;      // ← checkOnly는 안 본다
//
// 그래서 **점검 요청에 `{checkOnly: true}`가 실려 나가는데 라우트는
// 그 값을 읽지 않는다.** `dryRun`은 `undefined`이므로 조건이 맞으면
// 주문 경로까지 간다. 사용자는 "주문은 안 냅니다"라고 적힌 버튼을 눌렀다.
//
// daily-ladder는 `checkOnly`와 `dryRun`을 둘 다 읽고 있어서 괜찮았다.
// **경로가 둘인데 한쪽만 고친** 이 저장소의 대표 고장이다.
//
// 그래서 이름을 외우지 않게 한다
// ──────────────────────────────
// 라우트가 플래그 이름을 직접 쓰면 언젠가 또 갈린다. 여기 함수 하나를
// 부르면 레지스트리가 뭐라고 선언했든 맞는 값을 읽는다.
//
// 그리고 **둘 다 받는다.** 옛 호출부(수동 curl · 저장된 스크립트)가
// 반대 이름을 보낼 수 있는데, 그때 주문이 나가면 안 된다.
// 점검을 요청하는 어떤 표현이든 점검으로 읽는 쪽이 안전하다.

import { resolveStrategy, type StrategyId } from './registry';

/** 이 저장소가 쓰는 점검 플래그 이름 전부 */
export const CHECK_FLAGS = ['checkOnly', 'dryRun'] as const;

export interface CheckFlagVerdict {
  /** **주문을 내지 않는 호출인가** */
  checkOnly: boolean;
  /** 어느 이름으로 왔는가. 기록용 */
  via: 'checkOnly' | 'dryRun' | null;
  /** 이 전략이 선언한 이름 */
  declared: 'checkOnly' | 'dryRun' | null;
  /**
   * 선언한 이름과 실제로 온 이름이 다른가.
   *
   * 다르다고 막지는 않는다 — 점검은 안전한 쪽이다. 다만 **기록에 남긴다**:
   * 화면과 라우트가 갈렸다는 신호이고, 그게 이 파일이 생긴 이유다.
   */
  mismatch: boolean;
}

/**
 * 이 요청이 점검(주문 없음)인가.
 *
 * **`=== true`만 본다.** 문자열 `'false'`는 truthy라, 느슨하게 읽으면
 * 반대로 뒤집힌다. 그리고 반대 실수는 방향이 나쁘다 — 점검을 실주문으로
 * 읽는 것이 실주문을 점검으로 읽는 것보다 훨씬 비싸다.
 */
export function checkOnlyOf(strategyId: StrategyId | string, body: any): CheckFlagVerdict {
  // 환경은 판정에 쓰지 않는다 — 플래그 이름은 환경과 무관하다.
  // TESTNET으로 물어보는 이유는 그쪽이 더 넓어서 명세를 확실히 얻기 때문이다.
  const sv = resolveStrategy({ id: String(strategyId), env: 'TESTNET' });
  const declared = (sv.spec?.checkFlag ?? null) as CheckFlagVerdict['declared'];

  const byCheckOnly = body?.checkOnly === true;
  const byDryRun = body?.dryRun === true;
  const via = byCheckOnly ? 'checkOnly' : byDryRun ? 'dryRun' : null;

  return {
    checkOnly: byCheckOnly || byDryRun,
    via,
    declared,
    mismatch: via != null && declared != null && via !== declared,
  };
}

/**
 * 점검 결과를 응답에 실을 모양.
 *
 * 화면이 "왜 주문이 안 나갔는지"를 값으로 읽을 수 있어야 한다 —
 * 문장에서 되짚게 하면 문장이 바뀔 때 화면이 조용히 틀린다.
 */
export function checkFlagNote(v: CheckFlagVerdict): string {
  if (!v.checkOnly) return '';
  const base = '점검 호출입니다 — 주문을 보내지 않습니다';
  if (!v.mismatch) return base;
  return `${base} (요청은 ${v.via}로 왔고 이 전략의 선언은 ${v.declared}입니다 — `
    + '둘 다 점검으로 읽었습니다)';
}
