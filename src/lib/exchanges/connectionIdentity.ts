// src/lib/exchanges/connectionIdentity.ts
//
// ⑤B-3A-3.1 — **한 사용자가 같은 거래소의 실전과 테스트넷을 동시에 가진다.**
//
// 무엇이 틀려 있었나
// ─────────────────
// 연결 생성이 이렇게 저장하고 있었다:
//
//     .upsert(rec, { onConflict: 'user_id,exchange_id' })
//
// 그런데 DB 제약도 `UNIQUE (user_id, exchange_id)`였다. 즉 같은 사용자에게
// Binance LIVE가 이미 있는데 Binance TESTNET을 등록하면 **새 연결이 아니라
// 기존 LIVE row를 갱신한다.** 실전 키가 테스트넷 키로 덮인다.
//
// 이것은 우리가 ⑤B-3A-3에서 "절대 하지 말 것"으로 적어 둔 바로 그 사고다
// (기존 연결의 is_testnet을 바꿔 TESTNET을 만드는 것). 금지해 놓고 코드가
// 그 길을 열어 두고 있었다.
//
// 정본 identity
// ─────────────
//     user_id + exchange_id + is_testnet
//
// `is_testnet`은 `not null default true`이므로 nullable identity가 되지
// 않는다. 셋 중 하나라도 빠지면 환경이 섞인다.
//
// ★ 이 파일은 DB를 바꾸지 않는다. 판정만 한다.
// ★ 이 파일은 키·시크릿을 **받지 않는다.** 식별자와 환경 플래그만 본다.

/**
 * 연결을 유일하게 만드는 칸. **순서까지 정본이다** — `onConflict`
 * 문자열이 이 순서로 만들어진다.
 */
export const CONNECTION_IDENTITY_COLUMNS = [
  'user_id', 'exchange_id', 'is_testnet',
] as const;

/**
 * upsert의 conflict target.
 *
 * **손으로 적지 않는다.** identity 칸에서 만든다 — 한쪽만 고치면 제약과
 * 코드가 갈린다.
 */
export function connectionConflictTarget(): string {
  return CONNECTION_IDENTITY_COLUMNS.join(',');
}

/** 새 제약 이름 */
export const CONNECTION_IDENTITY_CONSTRAINT = 'exchange_connections_user_exchange_env_key';
/** 환경을 보지 않던 옛 제약 이름 */
export const LEGACY_IDENTITY_CONSTRAINT = 'exchange_connections_user_id_exchange_id_key';

// ── 환경별 기본 이름 ──
//
//   production에 `UNIQUE (user_id, exchange, nickname)`도 있다. 몰래
//   지우지 않는다 — 대신 기본 이름을 환경별로 다르게 만들어 애초에
//   부딪히지 않게 한다.

/** 테스트넷 연결에 붙는 말 */
export const TESTNET_SUFFIX = '테스트넷';
/** 실전 연결에 붙는 말 */
export const LIVE_SUFFIX = '실전';

/**
 * 자동으로 붙는 연결 이름.
 *
 * ★ 두 환경이 **같은 이름이 되면 안 된다.** 같으면 nickname unique가
 *   부딪혀서, 두 번째 등록이 실패하거나(운이 좋을 때) 첫 연결을
 *   덮는다(운이 나쁠 때).
 */
export function envNicknameOf(
  exchangeNameKr: string, isTestnet: boolean,
): string {
  const base = String(exchangeNameKr ?? '').trim() || '거래소';
  return `${base} ${isTestnet ? TESTNET_SUFFIX : LIVE_SUFFIX}`;
}

/** 사용자가 적은 이름이 있으면 그것을, 없으면 환경별 기본 이름을 쓴다 */
export function resolveNickname(i: {
  custom: string | null | undefined;
  exchangeNameKr: string;
  isTestnet: boolean;
}): string {
  const c = String(i?.custom ?? '').trim();
  if (c) return c;
  return envNicknameOf(i.exchangeNameKr, i.isTestnet === true);
}

// ── 판정 ──

export interface ConnectionIdentity {
  userId: string;
  exchangeId: string;
  isTestnet: boolean;
}

export type NicknameVerdictCode = 'OK' | 'NICKNAME_CONFLICT';

export interface NicknameVerdict {
  ok: boolean;
  code: NicknameVerdictCode;
  reason: string;
}

/**
 * 이 이름을 써도 되는가.
 *
 * **기존 연결을 덮지 않는다.** 사용자가 적은 이름이 다른 환경의 연결과
 * 부딪히면 조용히 갱신하는 대신 명시적으로 실패한다 — 덮어쓰면 실전
 * 연결이 사라진 것을 아무도 모른다.
 */
export function nicknameVerdict(i: {
  wanted: string;
  /** 같은 사용자·같은 거래소의 기존 연결들 */
  existing: readonly { nickname: string | null | undefined; isTestnet: boolean }[];
  /** 지금 만들려는(또는 갱신하려는) 환경 */
  isTestnet: boolean;
}): NicknameVerdict {
  const want = String(i?.wanted ?? '').trim();
  if (!want) {
    return { ok: false, code: 'NICKNAME_CONFLICT', reason: '연결 이름이 비어 있습니다' };
  }
  for (const e of Array.isArray(i?.existing) ? i.existing : []) {
    const have = String(e?.nickname ?? '').trim();
    if (!have || have !== want) continue;
    // 같은 환경이면 그 연결을 갱신하는 것이므로 충돌이 아니다.
    if (e.isTestnet === i.isTestnet) continue;
    return {
      ok: false, code: 'NICKNAME_CONFLICT',
      reason: `"${want}"은 이미 ${e.isTestnet ? TESTNET_SUFFIX : LIVE_SUFFIX} 연결이 쓰고 있습니다`
        + ' — 다른 이름을 쓰거나 그 연결을 먼저 정리하세요',
    };
  }
  return { ok: true, code: 'OK', reason: '' };
}

export type EnvSwitchCode = 'OK' | 'ENV_CONNECTION_EXISTS' | 'NO_CHANGE';

export interface EnvSwitchVerdict {
  ok: boolean;
  code: EnvSwitchCode;
  reason: string;
}

/**
 * 이미 등록된 연결의 환경을 바꿔도 되는가.
 *
 * ★ 이제 실전과 테스트넷이 **동시에 존재할 수 있다.** 그래서 전환하려는
 *   쪽에 이미 연결이 있으면 unique가 부딪힌다. 그때 **자동으로 합치거나
 *   지우거나 덮지 않는다** — 어느 쪽 키가 사라졌는지 아무도 모르게 된다.
 */
export function envSwitchVerdict(i: {
  /** 바꾸려는 연결 */
  target: { connectionId: string; isTestnet: boolean };
  /** 같은 사용자·같은 거래소의 **다른** 연결들 */
  siblings: readonly { connectionId: string; isTestnet: boolean }[];
  /** 바꾸려는 목적지 */
  toTestnet: boolean;
}): EnvSwitchVerdict {
  if (i?.target?.isTestnet === i?.toTestnet) {
    return { ok: false, code: 'NO_CHANGE', reason: '이미 그 환경입니다' };
  }
  for (const s of Array.isArray(i?.siblings) ? i.siblings : []) {
    if (s?.connectionId === i.target.connectionId) continue;
    if (s?.isTestnet !== i.toTestnet) continue;
    const label = i.toTestnet ? TESTNET_SUFFIX : LIVE_SUFFIX;
    return {
      ok: false, code: 'ENV_CONNECTION_EXISTS',
      reason: `이미 ${label} 연결이 있습니다.`
        + ` 기존 ${label} 연결을 사용하거나 삭제한 뒤 변경하세요.`,
    };
  }
  return { ok: true, code: 'OK', reason: '' };
}

/** 두 연결이 같은 자리를 가리키는가 */
export function sameIdentity(a: ConnectionIdentity, b: ConnectionIdentity): boolean {
  return a?.userId === b?.userId
    && a?.exchangeId === b?.exchangeId
    && a?.isTestnet === b?.isTestnet;
}

/**
 * production 데이터가 새 identity로 유일한가 (migration preflight와 같은 판정).
 *
 * duplicate가 있으면 **합치거나 지우지 않는다.** 어느 쪽이 맞는지는
 * 사람이 정한다.
 */
export function duplicateIdentityGroups(
  rows: readonly ConnectionIdentity[] | null | undefined,
): Array<{ identity: ConnectionIdentity; count: number }> {
  const seen = new Map<string, { identity: ConnectionIdentity; count: number }>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = `${r?.userId}\u0000${r?.exchangeId}\u0000${r?.isTestnet === true}`;
    const hit = seen.get(key);
    if (hit) { hit.count += 1; continue; }
    seen.set(key, { identity: { userId: r.userId, exchangeId: r.exchangeId,
      isTestnet: r.isTestnet === true }, count: 1 });
  }
  return [...seen.values()].filter(g => g.count > 1);
}
