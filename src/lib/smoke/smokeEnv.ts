// src/lib/smoke/smokeEnv.ts
//
// **스모크 경로는 테스트넷에서만 돈다 — 조회도 포함한다.**
//
// 왜 이 파일이 생겼나 (#552 추가 감사)
// ───────────────────────────────────
// `startAttempt.ts:77-81`은 이미 이 관문을 갖고 있다:
//
//     const testnet = (creds as any).testnet as boolean;
//     // **저장소 규칙: is_testnet === false 만 실전이다.**
//     if (testnet !== true) { ... 403 }
//
// 그런데 **고아 보호주문 진단 경로에는 그 관문이 없었다.**
// `/api/autotrade/smoke-test/orphans`는 자격증명을 읽은 직후 포지션과
// 조건부 주문을 조회한다. 실전 연결을 넘기면 **주문은 못 내더라도 실계좌에
// signed 조회가 이미 나간다.** 스모크는 `smoke_tests.mode`가
// `CHECK (mode = 'TESTNET')`인 기능이다 — 그 기능의 진단이 실계좌를
// 건드릴 이유가 없다.
//
// 그래서 판단을 **여기 한 곳**에 둔다. 두 곳에 같은 `if`가 있으면
// 언젠가 한쪽만 고쳐진다 — `CLAUDE.md`의 상습 고장 ②.
//
// **기준은 `startAttempt`와 같다.** `creds.testnet !== true`면 막는다.
// `loadFuturesCreds`는 `testnet: conn.is_testnet !== false`로 계산하므로
// `is_testnet`이 NULL인 연결은 테스트넷으로 본다 — "모르는 값이 실전이
// 되면 안 된다"는 그 파일의 규칙이다. 진단을 더 엄격하게 (`is_testnet`이
// 명시적으로 true일 때만) 막으면 **스모크를 돌릴 수는 있는데 그 뒤에 남은
// 주문은 진단할 수 없는 연결**이 생긴다. 그건 안전해지는 것이 아니라
// 남은 보호주문을 볼 방법이 없어지는 것이다.

export interface SmokeEnvVerdict {
  ok: boolean;
  code: 'TESTNET' | 'TESTNET_ONLY';
  status: number;
  message: string;
}

/**
 * 이 연결로 스모크 경로를 돌려도 되는가. **조회 전에 묻는다.**
 *
 * `startAttempt`와 같은 기준이다. 다르면 "진입은 막혔는데 조회는 나가는"
 * 상태가 생긴다.
 */
export function smokeEnvGate(i: { testnet?: unknown } | null | undefined): SmokeEnvVerdict {
  if (i?.testnet !== true) {
    return {
      ok: false, code: 'TESTNET_ONLY', status: 403,
      message: '실전 연결로는 스모크 경로를 쓰지 않습니다 — 조회도 하지 않습니다',
    };
  }
  return { ok: true, code: 'TESTNET', status: 200, message: '테스트넷 연결입니다' };
}
