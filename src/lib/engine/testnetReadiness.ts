// src/lib/engine/testnetReadiness.ts
//
// ⑤B-3A-3 — **실측을 시작할 수 있는 상태인가.** 표본을 만드는 코드가 아니다.
//
// 왜 이 파일이 필요한가
// ────────────────────
// `exit-monitor`의 자격 조회가 세 가지 **다른 사실**을 한 문장으로 뭉개고
// 있었다:
//
//     '연결을 읽지 못했거나 출금 권한이 있는 키라 조회하지 않았습니다'
//
// row를 못 읽은 것 · 출금 권한이 켜진 것 · 모르는 거래소인 것은 전부
// 대응이 다르다. 그런데 최근 7일 1037회가 모두 이 문장이었고, 어느
// 것인지 알 방법이 없었다. **확인하지 못한 것을 한 가지 원인으로 적지
// 않는다.**
//
// ★ 이 파일은 **시크릿을 보지 않는다.** 입력은 "있다/없다"와 "풀렸다/
//   못 풀었다"뿐이다. 키·시크릿 원문도, 암호문도, **길이도** 받지
//   않는다. 받지 않으면 흘릴 수도 없다.
//
// ★ 이 파일은 주문도, DB 쓰기도, 연결 생성도 하지 않는다. 판정만 한다.

import {
  verifiedTestnetObservationEligibility,
  type RiskObservationEligibilityInput,
} from './riskObservationEligibility';

/** 정본의 입력 모양을 그대로 쓴다 — 여기서 다시 선언하지 않는다 */
type SampleReadinessInput = RiskObservationEligibilityInput;

// ── ① 자격 진단 (시크릿을 보지 않는다) ──

export type CredentialDiagnosis =
  /** 쓸 수 있다 */
  | 'READY'
  /** 그 연결 row가 없다 (또는 읽지 못했다) */
  | 'NO_CONNECTION'
  /** 거래소 식별자를 해석하지 못했다. **모르는 거래소를 binance로 읽지 않는다** */
  | 'UNSUPPORTED_EXCHANGE'
  /** 출금 권한이 있는 키다 — 조회조차 하지 않는다 */
  | 'WITHDRAWAL_ENABLED'
  /** api_key 칸이 비었다 */
  | 'KEY_MISSING'
  /** api_secret 칸이 비었다 */
  | 'SECRET_MISSING'
  /** 암호문은 있는데 복호화가 실패했다 — 키 교체·환경 불일치 */
  | 'DECRYPT_FAILED';

/**
 * 자격 진단 입력.
 *
 * ★ **문자열을 받지 않는다.** 전부 boolean이다. 값을 받지 않으므로
 *   실수로 로그에 싣는 경로가 생기지 않는다.
 */
export interface CredentialFacts {
  /** 연결 row를 실제로 읽었는가 */
  rowFound: boolean;
  /** 거래소 식별자가 해석됐는가 (`resolveExecExchange`의 결과 유무) */
  exchangeResolved: boolean;
  /** 출금 권한 플래그. **못 읽었으면 null이고 통과가 아니다** */
  hasWithdrawal: boolean | null | undefined;
  /** api_key 칸이 비어 있지 않은가 */
  keyPresent: boolean;
  /** api_secret_enc 칸이 비어 있지 않은가 */
  secretCiphertextPresent: boolean;
  /** 복호화가 성공했는가 (평문을 넘기지 않는다) */
  secretDecrypted: boolean;
}

/**
 * 어느 사실 때문에 못 쓰는가.
 *
 * 순서가 의미를 가진다 — 없는 row의 출금 권한을 묻지 않는다.
 */
export function diagnoseCredential(i: CredentialFacts): CredentialDiagnosis {
  if (i?.rowFound !== true) return 'NO_CONNECTION';
  if (i.exchangeResolved !== true) return 'UNSUPPORTED_EXCHANGE';
  // **null은 통과가 아니다.** 출금 권한을 확인하지 못했으면 켜진 것으로 본다.
  if (i.hasWithdrawal !== false) return 'WITHDRAWAL_ENABLED';
  if (i.keyPresent !== true) return 'KEY_MISSING';
  if (i.secretCiphertextPresent !== true) return 'SECRET_MISSING';
  if (i.secretDecrypted !== true) return 'DECRYPT_FAILED';
  return 'READY';
}

/** 사람에게 보여 줄 한 줄. **값은 절대 들어가지 않는다** */
export function credentialDiagnosisReason(code: CredentialDiagnosis): string {
  switch (code) {
    case 'READY': return '';
    case 'NO_CONNECTION': return '연결 기록을 읽지 못했습니다';
    case 'UNSUPPORTED_EXCHANGE': return '거래소 식별자를 해석하지 못했습니다';
    case 'WITHDRAWAL_ENABLED': return '출금 권한이 있는(또는 확인하지 못한) 키라 조회하지 않았습니다';
    case 'KEY_MISSING': return 'API 키 칸이 비어 있습니다';
    case 'SECRET_MISSING': return 'API 시크릿 칸이 비어 있습니다';
    case 'DECRYPT_FAILED': return 'API 시크릿을 복호화하지 못했습니다';
    default: return '알 수 없는 자격 상태입니다';
  }
}

// ── ② Binance TESTNET 연결 준비 상태 ──

export type TestnetConnectionReadiness =
  | 'READY'
  /** binance + testnet 연결이 **하나도 없다**. 기존 연결을 고쳐서 만들지 않는다 */
  | 'NO_BINANCE_TESTNET_CONNECTION'
  | 'CONNECTION_INACTIVE'
  | 'READ_PERMISSION_MISSING'
  | 'TRADE_PERMISSION_MISSING'
  | 'WITHDRAWAL_PERMISSION_PRESENT'
  | 'CREDENTIALS_UNUSABLE';

export interface ConnectionFacts {
  /** 로그에 남겨도 되는 식별자만. **키가 아니다** */
  connectionId: string;
  exchange: string | null | undefined;
  testnet: boolean | null | undefined;
  active: boolean | null | undefined;
  permissionRead: boolean | null | undefined;
  permissionTrade: boolean | null | undefined;
  hasWithdrawal: boolean | null | undefined;
  /** ①의 결과. 없으면 아직 진단하지 않은 것이다 */
  credential?: CredentialDiagnosis | null;
}

export interface TestnetReadinessVerdict {
  ready: boolean;
  code: TestnetConnectionReadiness;
  reason: string;
  /** 자격이 맞는 연결의 식별자. 없으면 null */
  connectionId: string | null;
}

const nope = (
  code: TestnetConnectionReadiness, reason: string, connectionId: string | null = null,
): TestnetReadinessVerdict => ({ ready: false, code, reason, connectionId });

/**
 * Binance TESTNET 실측을 시작할 수 있는 연결이 있는가.
 *
 * ★ **기존 연결을 고쳐서 만들지 않는다.** LIVE 연결의 testnet 플래그를
 *   뒤집거나 Gate 연결을 binance라고 적는 것은 표본을 거짓으로 만드는
 *   일이다. 그런 연결이 없으면 없다고 적는다.
 */
export function binanceTestnetReadiness(
  connections: readonly ConnectionFacts[] | null | undefined,
): TestnetReadinessVerdict {
  const all = Array.isArray(connections) ? connections : [];
  // binance이면서 testnet인 것만 후보다. 둘 중 하나라도 아니면 후보가 아니다.
  const cand = all.filter(c =>
    String(c?.exchange ?? '').trim().toLowerCase() === 'binance' && c?.testnet === true);

  if (cand.length === 0) {
    return nope('NO_BINANCE_TESTNET_CONNECTION',
      'Binance TESTNET 연결이 없습니다'
      + ' — 기존 연결의 testnet 플래그를 바꾸지 않고 별도 연결을 추가해야 합니다');
  }

  let last: TestnetReadinessVerdict | null = null;
  for (const c of cand) {
    const id = String(c.connectionId ?? '').trim() || null;
    if (c.active !== true) { last = nope('CONNECTION_INACTIVE', '연결이 비활성입니다', id); continue; }
    if (c.permissionRead !== true) {
      last = nope('READ_PERMISSION_MISSING', '읽기 권한이 없습니다', id); continue;
    }
    // **출금 권한이 있으면 여기서 멈춘다.** 확인하지 못한 것(null)도 멈춘다.
    if (c.hasWithdrawal !== false) {
      last = nope('WITHDRAWAL_PERMISSION_PRESENT',
        '출금 권한이 있는(또는 확인하지 못한) 키입니다 — 출금 비허용 키여야 합니다', id);
      continue;
    }
    if (c.permissionTrade !== true) {
      last = nope('TRADE_PERMISSION_MISSING',
        '거래 권한이 없습니다 — 실제 진입이 불가능합니다', id);
      continue;
    }
    if (c.credential != null && c.credential !== 'READY') {
      last = nope('CREDENTIALS_UNUSABLE',
        `자격을 쓸 수 없습니다 (${c.credential})`, id);
      continue;
    }
    return { ready: true, code: 'READY', reason: '', connectionId: id };
  }
  return last ?? nope('NO_BINANCE_TESTNET_CONNECTION', 'Binance TESTNET 연결이 없습니다');
}

// ── ③ 표본 자격 (기존 정본에 위임한다) ──

export type SampleReadiness =
  | 'READY'
  | 'VENUE_UNSUPPORTED'
  | 'IDENTITY_MISMATCH'
  | 'NO_EXACT100X_POSITION'
  | 'POSITION_NOT_OPEN'
  | 'SIDE_MISMATCH'
  | 'NOT_TESTNET';

/**
 * 이 포지션이 VERIFIED 표본 자격이 있는가.
 *
 * ★ **판정을 복제하지 않는다.** `verifiedTestnetObservationEligibility`가
 *   정본이고 여기서는 ⑤B-3A-3가 쓰는 이름으로 옮기기만 한다. 같은 판단이
 *   두 곳에 있으면 언젠가 갈린다.
 */
export function sampleReadiness(
  i: SampleReadinessInput,
): { ready: boolean; code: SampleReadiness; reason: string } {
  const v = verifiedTestnetObservationEligibility(i);
  const map: Record<string, SampleReadiness> = {
    ELIGIBLE: 'READY',
    NOT_TESTNET: 'NOT_TESTNET',
    VENUE_UNSUPPORTED: 'VENUE_UNSUPPORTED',
    IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
    POSITION_UNUSABLE: 'NO_EXACT100X_POSITION',
    NO_POSITION: 'POSITION_NOT_OPEN',
    SIDE_MISMATCH: 'SIDE_MISMATCH',
  };
  const code = map[v.code] ?? 'NO_EXACT100X_POSITION';
  return { ready: code === 'READY', code, reason: v.reason };
}

// ── ④ 어느 경로의 실패인가 ──
//
//   보호주문 고아 정리(`live_orders`의 sl/tp가 있는 줄)와 Exact100X 전용
//   종료 권한 후보는 **다른 경로다.** 앞의 것이 실패한 것을 "Exact100X
//   관측 실패"라고 적으면 원인이 영구히 뒤섞인다.

export type FailurePath =
  /** 전략을 가리지 않는 보호주문 고아 정리 */
  | 'GENERIC_PROTECTION_SWEEP'
  /** Exact100X 전용 종료 권한 후보 */
  | 'EXACT100X_AUTHORITY'
  /** 자리를 유예한 줄 */
  | 'DEFERRED'
  /** 실행 계약 칸이 없는 옛 줄 */
  | 'LEGACY_ROW';

export interface FailureBreakdown {
  path: FailurePath;
  code: CredentialDiagnosis | 'OTHER';
  count: number;
}

/**
 * 실패를 **경로별·원인별로** 센다.
 *
 * 합계만 적으면 1037회가 무엇이었는지 영원히 알 수 없다 — 실제로 그
 * 상태였다.
 */
export function classifyFailures(
  items: readonly { path: FailurePath; code: CredentialDiagnosis | 'OTHER' }[] | null | undefined,
): FailureBreakdown[] {
  const seen = new Map<string, FailureBreakdown>();
  for (const it of Array.isArray(items) ? items : []) {
    const key = `${it?.path}:${it?.code}`;
    const hit = seen.get(key);
    if (hit) { hit.count += 1; continue; }
    seen.set(key, { path: it.path, code: it.code, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}
