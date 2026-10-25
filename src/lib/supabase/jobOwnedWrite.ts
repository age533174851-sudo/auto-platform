// All post-claim job writes must be fenced by owner and attempt.
export type OwnedJobWrite = {
  id: string;
  owner: string;
  attempts: number; // post-claim value, not the SELECT snapshot
  changes: Record<string, unknown>;
};
export type OwnedJobWriteResponse = { data?: unknown; error?: unknown } | null | undefined;
export type OwnedJobStore = {
  writeIfOwned: (input: OwnedJobWrite) => Promise<OwnedJobWriteResponse>;
};
export type OwnedJobWriteResult = {
  code: 'SAVED' | 'OWNERSHIP_LOST' | 'DB_WRITE_FAILED';
  reason: string;
};

export async function persistOwnedJob(store: OwnedJobStore, input: OwnedJobWrite): Promise<OwnedJobWriteResult> {
  if (!input.id || !input.owner || !Number.isInteger(input.attempts) || input.attempts < 1) {
    return { code: 'DB_WRITE_FAILED', reason: '작업 소유권 표식(id/owner/attempts)이 불완전합니다' };
  }
  try {
    const response = await store.writeIfOwned(input);
    if (!response) return { code: 'DB_WRITE_FAILED', reason: 'DB 갱신 응답이 없습니다' };
    if (response.error) {
      const message = (response.error as any)?.message ?? response.error;
      return { code: 'DB_WRITE_FAILED', reason: `DB 갱신 오류: ${String(message)}` };
    }
    if (!Array.isArray(response.data)) {
      return { code: 'DB_WRITE_FAILED', reason: '갱신된 행을 확인할 수 없습니다 (비배열 응답)' };
    }
    if (response.data.length === 0) {
      return { code: 'OWNERSHIP_LOST', reason: '작업 소유권 또는 시도가 변경되어 갱신 0행' };
    }
    if (response.data.length !== 1 || String(response.data[0]?.id ?? '') !== input.id) {
      return { code: 'DB_WRITE_FAILED', reason: '갱신된 행이 예상한 작업 1건과 다릅니다' };
    }
    return { code: 'SAVED', reason: '소유권을 확인하고 작업 상태 1건을 저장했습니다' };
  } catch (e: any) {
    return { code: 'DB_WRITE_FAILED', reason: `DB 갱신 예외: ${String(e?.message ?? e)}` };
  }
}
