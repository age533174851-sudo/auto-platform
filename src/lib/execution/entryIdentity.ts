// src/lib/execution/entryIdentity.ts
//
// 진입 시점의 실행 계약 정체를 주문 장부에 남기기 위한 작은 정본.
//
// **100배라는 숫자는 정체가 아니다.** leverage=100, isolated, NO_FIXED_SL 같은
// 결과를 보고 MAX_LEV_100X / EXACT_100X였다고 역추정하면 다른 전략이 같은
// 결과값을 만든 순간 잘못된 종료 권한을 줄 수 있다.
//
// 그래서 프로필 · 프리셋 · 계약 버전 세 축이 모두 있을 때만 정체가 있다.
// 과거 주문은 셋 다 NULL이고, 일부만 있는 값은 "모름"이 아니라 **깨진 기록**이다.

export interface EntryExecutionIdentity {
  profileId: string;
  presetId: string;
  contractVersion: number;
}

export type EntryExecutionIdentityRead =
  | { kind: 'none'; identity: null; reason: string }
  | { kind: 'identity'; identity: EntryExecutionIdentity; reason: string }
  | { kind: 'invalid'; identity: null; reason: string };

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export function executionIdentityColumns(
  identity: EntryExecutionIdentity | null | undefined,
): Record<string, string | number> {
  if (!identity) return {};

  const profileId = String(identity.profileId ?? '').trim();
  const presetId = String(identity.presetId ?? '').trim();
  const contractVersion = Number(identity.contractVersion);

  if (!profileId || !presetId || !Number.isInteger(contractVersion) || contractVersion <= 0) {
    throw new Error('실행 정체는 profileId · presetId · 양의 정수 contractVersion이 모두 있어야 합니다');
  }

  return {
    execution_profile_id: profileId,
    execution_preset_id: presetId,
    execution_contract_version: contractVersion,
  };
}

export function executionIdentityFromRow(row: any): EntryExecutionIdentityRead {
  const p = row?.execution_profile_id;
  const s = row?.execution_preset_id;
  const v = row?.execution_contract_version;
  const blanks = [blank(p), blank(s), blank(v)];

  if (blanks.every(Boolean)) {
    return { kind: 'none', identity: null, reason: '진입 시점 실행 정체가 기록되지 않은 주문입니다' };
  }
  if (blanks.some(Boolean)) {
    return {
      kind: 'invalid', identity: null,
      reason: '실행 정체 세 칸 중 일부만 기록돼 있습니다 — 나머지를 추측하지 않습니다',
    };
  }

  const profileId = String(p).trim();
  const presetId = String(s).trim();
  const rawVersion = typeof v === 'number'
    ? v
    : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);

  if (!profileId || !presetId || !Number.isInteger(rawVersion) || rawVersion <= 0) {
    return {
      kind: 'invalid', identity: null,
      reason: '실행 정체 값의 형식이 잘못돼 있습니다 — 숫자 결과로 대신 판정하지 않습니다',
    };
  }

  return {
    kind: 'identity',
    identity: { profileId, presetId, contractVersion: rawVersion },
    reason: '진입 시점에 저장된 실행 계약 정체입니다',
  };
}
