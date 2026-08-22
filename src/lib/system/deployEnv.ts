// src/lib/system/deployEnv.ts
//
// **Preview에서 없는 것을 고장이라고 적지 않는다.**
//
// 무엇이 문제였나
// ───────────────
// Preview 배포에는 실계좌 시크릿도, 운영 Worker도 없다. **그게 정상이다** —
// 미리보기가 실계좌 키를 들고 있으면 그쪽이 사고다.
//
// 그런데 화면은 그 둘을 이렇게 적었다:
//
//   Worker · 없음 / 실행기가 한 번도 보고한 적이 없습니다
//   API 시크릿이 비어 있습니다. 연결을 다시 등록하세요.
//
// 운영이 멀쩡한데 **미리보기를 운영처럼 진단한 것**이다. 그리고 두 번째
// 문장은 시키는 대로 하면 더 나빠진다 — Preview의 암호화 키로 다시
// 저장하면 운영이 그 값을 못 읽는다.
//
// 무엇을 바꾸지 않는가
// ────────────────────
// **운영에서는 하나도 안 느슨해진다.** Worker 하트비트가 없으면 그건
// 실제 장애이고, 시크릿이 정말 비어 있으면 그것도 실제 장애다.
// 이 파일이 하는 일은 **어디에서 보고 있는지**를 판정에 넣는 것뿐이다.
//
// 그리고 Preview에 운영 시크릿을 넣는 것은 해결이 아니다. 그 방향은
// 이 파일 어디에도 없다.

export type DeployEnv = 'production' | 'preview' | 'development' | 'unknown';

export interface DeployEnvInput {
  VERCEL_ENV?: string;
  NODE_ENV?: string;
}

/**
 * 지금 어느 배포에서 도는가.
 *
 * **모르는 것을 운영이라고 하지 않는다.** 로컬·자체 호스팅은 `unknown`이고,
 * 그때는 아래 판정이 운영과 같은 엄격함을 쓴다 — 느슨한 쪽이 기본값이면
 * 언젠가 진짜 장애가 조용해진다.
 */
export function deployEnvOf(e: DeployEnvInput = process.env as any): DeployEnv {
  const v = String(e.VERCEL_ENV || '').toLowerCase();
  if (v === 'production' || v === 'preview' || v === 'development') return v;
  return 'unknown';
}

/**
 * 이 배포에서 **운영 자격(실계좌 키·Worker)을 기대해도 되는가.**
 *
 * Preview와 development는 아니다. 나머지는 전부 기대한다 — 모르는
 * 배포에서 검사를 끄면 진짜 장애가 조용해진다.
 */
export function expectsProductionRuntime(env: DeployEnv = deployEnvOf()): boolean {
  return env !== 'preview' && env !== 'development';
}

export type RuntimeCheckCode =
  /** 이 배포에서 볼 것이 아니다 */
  | 'NOT_APPLICABLE'
  /** 있어야 하는데 없다 — 실제 장애 */
  | 'MISSING'
  /** 있다 */
  | 'PRESENT'
  /** 확인하지 못했다. **없다는 뜻이 아니다** */
  | 'UNKNOWN';

export interface RuntimeCheck {
  code: RuntimeCheckCode;
  /** 이것을 장애로 그릴 것인가 */
  failing: boolean;
  label: string;
  reason: string;
}

/**
 * Worker 하트비트를 어떻게 읽을 것인가.
 *
 * `present`는 **하트비트를 봤는가**이고, `null`은 **확인하지 못했다**이다.
 * 셋을 섞지 않는다 — 없는 것과 못 본 것은 고칠 곳이 다르다.
 */
export function workerCheck(i: {
  present: boolean | null;
  env?: DeployEnv;
}): RuntimeCheck {
  const env = i.env ?? deployEnvOf();
  if (!expectsProductionRuntime(env)) {
    return {
      code: 'NOT_APPLICABLE', failing: false,
      label: 'Worker · 확인 대상 아님',
      reason: `${envLabel(env)} 배포입니다 — 운영 Worker는 여기에 보고하지 않습니다. `
        + '자동매매 실행 여부는 운영 배포에서 확인하세요',
    };
  }
  if (i.present === null || i.present === undefined) {
    return {
      code: 'UNKNOWN', failing: false,
      label: 'Worker · 확인 못 함',
      reason: '상태를 읽지 못했습니다 — 없다는 뜻이 아닙니다',
    };
  }
  if (!i.present) {
    return {
      code: 'MISSING', failing: true,
      label: 'Worker · 없음',
      reason: '실행기가 보고하지 않습니다 — 자동매매·예약 청산·손절 감시가 함께 멈춥니다',
    };
  }
  return { code: 'PRESENT', failing: false, label: 'Worker · 실행 중', reason: '' };
}

/**
 * 거래소 시크릿을 어떻게 읽을 것인가.
 *
 * **`decryptSecretResult`의 코드를 그대로 받는다.** 여기서 다시
 * 판정하지 않는다 — 같은 판단이 두 곳에 있으면 갈린다.
 */
export function credsCheck(i: {
  /** 'OK' | 'NO_KEY' | 'KEY_MISMATCH' | 'MALFORMED' | 'EMPTY' | null(확인 못 함) */
  code: string | null | undefined;
  /** 그 코드에 붙은 설명 */
  message?: string | null;
  env?: DeployEnv;
}): RuntimeCheck {
  const env = i.env ?? deployEnvOf();
  const code = String(i.code ?? '').toUpperCase();

  if (code === 'OK') {
    return { code: 'PRESENT', failing: false, label: '거래소 자격 · 확인됨', reason: '' };
  }
  if (!code) {
    return {
      code: 'UNKNOWN', failing: false, label: '거래소 자격 · 확인 못 함',
      reason: '확인하지 못했습니다 — 없다는 뜻이 아닙니다',
    };
  }

  // ── Preview에서 암호화 키가 없거나 다른 것은 장애가 아니다 ──
  //
  // **그게 정상이다.** 미리보기가 실계좌 키를 들고 있으면 그쪽이 사고다.
  // 그리고 여기서 "연결을 다시 등록하세요"라고 적으면, 시키는 대로 한
  // 사람이 Preview 키로 덮어써서 **운영이 그 값을 못 읽게 만든다.**
  const keyIssue = code === 'NO_KEY' || code === 'KEY_MISMATCH';
  if (keyIssue && !expectsProductionRuntime(env)) {
    return {
      code: 'NOT_APPLICABLE', failing: false,
      label: '거래소 자격 · 확인 대상 아님',
      reason: `${envLabel(env)} 배포에는 실거래 암호화 키가 없습니다 — 정상입니다. `
        + '여기서 연결을 다시 등록하지 마세요: 운영이 그 값을 못 읽게 됩니다',
    };
  }

  return {
    code: 'MISSING', failing: true,
    label: '거래소 자격 · 사용 불가',
    // 무엇을 고쳐야 하는지는 crypto 계층이 이미 적어 뒀다.
    reason: String(i.message || '거래소 자격을 사용할 수 없습니다'),
  };
}

export function envLabel(env: DeployEnv): string {
  return env === 'production' ? '운영'
    : env === 'preview' ? '미리보기(Preview)'
    : env === 'development' ? '개발'
    : '알 수 없는';
}
