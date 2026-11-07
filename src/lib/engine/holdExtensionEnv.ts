// src/lib/engine/holdExtensionEnv.ts
//
// **승인 값을 `process.env`에서 읽는 자리 — 여기 하나뿐이다.**
//
// 왜 판정 모듈에서 뗐는가
// ───────────────────────
// `holdExtension.ts`는 import가 0개인 순수 판정 모듈이다. 그 성질 덕분에
// 검사기가 Node 타입 없이 그 파일만 컴파일해서 **실제로 불러 볼 수
// 있다**(`check-hold-extension.mjs`가 기본 꺼짐·소급 금지를 그렇게
// 확인한다).
//
// 거기에 `process.env` 한 줄을 넣었더니 `check-100x-contract.mjs`의
// 탐침 컴파일이 **그 파일을 쓰는 사슬 전체**에서 깨졌다
// (`exitAuthority` · `exitAuthorityRun` · `exitCoverage` ·
// `escapeObservationStore`). 판정은 그대로였는데 검사기 일곱 개가
// "컴파일되지 않습니다"로 멈췄다.
//
// 그래서 주변 상태를 읽는 일은 이 파일 하나가 맡는다. 판정 쪽은
// 환경을 **인자로** 받고, 안 받으면 승인 없음(= 꺼짐)으로 떨어진다.

import type { HoldExtensionActivationEnv, HoldExtensionActivation } from './holdExtension';
import { judgeHoldExtensionActivation } from './holdExtension';

/**
 * 지금 프로세스의 승인 환경.
 *
 * **값을 해석하지 않는다** — 읽어서 그대로 넘긴다. 판정은
 * `judgeHoldExtensionActivation` 한 곳이다.
 */
export function holdExtensionEnvFromProcess(): HoldExtensionActivationEnv {
  return {
    EXACT100X_HOLD_EXTENSION_APPROVED_AT:
      process.env.EXACT100X_HOLD_EXTENSION_APPROVED_AT,
  };
}

/** 지금 프로세스에서 연장이 켜져 있는가 */
export function holdExtensionActivation(): HoldExtensionActivation {
  return judgeHoldExtensionActivation(holdExtensionEnvFromProcess());
}
