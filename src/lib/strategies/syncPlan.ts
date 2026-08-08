// src/lib/strategies/syncPlan.ts
//
// **내가 틀렸던 것부터 적는다.**
//
// 앞서 `dataLocation.ts`에 "전략은 브라우저 안에만 있다, 크론을 붙여도
// 읽을 것이 없다"고 적었다. 그건 사실이 아니었다. 확인해 보니:
//
//   supabase/migrations/005_user_strategies.sql   표가 이미 있다
//   src/app/api/strategies/sync/route.ts          pull/push/delete 라우트가 있다
//   src/lib/strategies/sync.ts                    클라이언트 쪽도 있다
//   StrategyBuilderPage.tsx                       실제로 부르고 있다
//
// **전략은 서버에 미러링되고 있었다.** 서버는 읽을 수 있다. 못 읽는 게
// 아니라, 읽는 실행기가 없는 것이다 — 저장 위치 문제가 아니라 실행기
// 문제였다. 고칠 곳이 다르다.
//
// 그러면 이 파일은 왜 있는가
// ──────────────────────────
// 미러링 방식에 남은 구멍 때문이다. 지금 `pullStrategies`는 이렇다:
//
//   if (!l || r.updatedAt > l.updatedAt) saveStrategy(r);   // 최신 것이 이긴다
//
// 지우지는 않으니 최악은 피한다. 하지만:
//
//   **양쪽이 다 바뀌면 진 쪽이 조용히 사라진다.** 휴대폰에서 손절을
//   2%로 바꾸고 PC에서 익절을 3%로 바꿨다면, 최신 것 하나만 남는
//   순간 다른 하나는 흔적도 없다. 사용자는 자기가 바꾼 게 안 먹혔다고만
//   알고, 왜인지는 모른다.
//
//   **pull이 실패해도 화면은 조용하다.** `syncStatus`가 'idle'로
//   돌아갈 뿐이라, 사용자는 이 브라우저의 목록이 전부인 줄 안다.
//   없다고 새로 만들면 나중에 같은 전략이 둘이 되고, 둘 다 켜지면
//   같은 신호에 주문이 두 번 나간다.
//
// 그래서 이 파일의 규칙
// ─────────────────────
//   · **없는 것을 지운 것으로 읽지 않는다.** 한쪽에만 있으면 '추가'다
//   · **못 읽었으면 아무것도 쓰지 않고, 빈 목록도 그리지 않는다**
//   · **양쪽이 다 바뀌었으면 고르지 않고 물어본다**

import type { UserStrategy } from './types';

/** 한 항목을 어떻게 할 것인가 */
export type SyncAction =
  /** 브라우저 것을 서버에 올린다 */
  | 'UPLOAD'
  /** 서버 것을 브라우저로 내린다 */
  | 'DOWNLOAD'
  /** 양쪽이 다 바뀌었다. **자동으로 고르지 않는다** */
  | 'CONFLICT'
  /** 같다 */
  | 'IN_SYNC';

export interface SyncItem {
  id: string;
  name: string;
  action: SyncAction;
  localUpdatedAt: number | null;
  remoteUpdatedAt: number | null;
  reason: string;
}

export interface SyncPlan {
  ok: boolean;
  /** 읽기 실패 등으로 아예 막혔는가 */
  blocked: boolean;
  uploads: SyncItem[];
  downloads: SyncItem[];
  conflicts: SyncItem[];
  inSync: SyncItem[];
  /**
   * 지울 것.
   *
   * **언제나 비어 있다.** 한쪽에 없다는 것은 지웠다는 뜻이 아니다 —
   * 새 기기이거나, 아직 안 내려받았거나, 조회가 덜 됐을 수도 있다.
   * 삭제는 사용자가 삭제 버튼을 눌렀을 때만 일어난다.
   */
  deletions: SyncItem[];
  summary: string;
  reason: string;
}

function ms(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * 내용이 같은가.
 *
 * 시각은 뺀다 — 저장만 다시 눌러도 `updatedAt`은 바뀌는데 그게 변경은
 * 아니다. 시각으로만 비교하면 안 바뀐 것이 계속 충돌로 뜬다.
 */
export function fingerprintOf(s: any): string {
  if (!s || typeof s !== 'object') return '';
  const { updatedAt, createdAt, updated_at, created_at, ...rest } = s as any;
  try {
    const keys = Object.keys(rest).sort();
    return JSON.stringify(keys.map(k => [k, (rest as any)[k]]));
  } catch { return ''; }
}

export interface SyncInput {
  local: UserStrategy[] | null | undefined;
  remote: any[] | null | undefined;
  /**
   * 서버를 읽는 데 성공했는가.
   *
   * **`false`와 `null`은 다르다.** false는 "서버가 못 읽겠다고 답했다",
   * null은 "로그인을 안 했거나 물어보지도 못했다"다. 둘을 뭉개면
   * 로그아웃 상태를 조회 실패로 오해한다.
   */
  remoteReadOk: boolean | null;
  /**
   * 마지막으로 성공한 동기화 시각.
   *
   * 이걸 알면 "한쪽만 바뀌었다"를 판정할 수 있다. 모르면 양쪽이 다르다는
   * 사실만 남으므로 **충돌로 본다** — 모르는 채로 한쪽을 고르면 다른
   * 쪽의 변경이 조용히 없어진다.
   */
  lastSyncAtMs?: number | null;
}

/**
 * 무엇을 올리고 무엇을 내릴 것인가.
 *
 * **아무것도 지우지 않는다.**
 */
export function syncPlan(input: SyncInput | null | undefined): SyncPlan {
  const empty = {
    uploads: [] as SyncItem[], downloads: [] as SyncItem[],
    conflicts: [] as SyncItem[], inSync: [] as SyncItem[], deletions: [] as SyncItem[],
  };
  const i = input ?? ({} as SyncInput);

  if (i.remoteReadOk !== true) {
    return { ...empty, ok: false, blocked: true,
      summary: '동기화하지 않았습니다',
      reason: i.remoteReadOk === null
        ? '서버를 읽었는지조차 확인하지 못했습니다 — 상태를 모르는 채로 올리면'
          + ' 갱신인지 새로 만드는 건지도 모릅니다'
        : '서버에서 전략 목록을 읽지 못했습니다 — 여기서 올리면 서버에 이미 있는'
          + ' 전략과 중복되거나 덮어씁니다. 읽기가 될 때까지 아무것도 쓰지 않습니다' };
  }

  const local = Array.isArray(i.local) ? i.local : [];
  const remote = Array.isArray(i.remote) ? i.remote : [];
  const lastSync = ms(i.lastSyncAtMs);

  const byId = new Map<string, { l?: any; r?: any }>();
  for (const s of local) {
    const id = String(s?.id ?? '');
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), l: s });
  }
  for (const s of remote) {
    const id = String(s?.id ?? '');
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), r: s });
  }

  const out = { ...empty };

  for (const [id, pair] of byId) {
    const l = pair.l, r = pair.r;
    const lt = ms(l?.updatedAt ?? l?.updated_at);
    const rt = ms(r?.updatedAt ?? r?.updated_at);
    const name = String(l?.name ?? r?.name ?? id);
    const base = { id, name, localUpdatedAt: lt, remoteUpdatedAt: rt };

    // 한쪽에만 있다 — **추가이지 삭제가 아니다.**
    if (l && !r) {
      out.uploads.push({ ...base, action: 'UPLOAD',
        reason: '서버에 없는 전략입니다 — 올립니다' });
      continue;
    }
    if (!l && r) {
      out.downloads.push({ ...base, action: 'DOWNLOAD',
        reason: '이 브라우저에 없는 전략입니다 — 내려받습니다.'
          + ' 여기 없다고 지워진 것이 아닙니다' });
      continue;
    }

    if (fingerprintOf(l) === fingerprintOf(r)) {
      out.inSync.push({ ...base, action: 'IN_SYNC', reason: '' });
      continue;
    }

    // 내용이 다르다. 누가 바뀌었는가.
    if (lastSync === null || lt === null || rt === null) {
      out.conflicts.push({ ...base, action: 'CONFLICT',
        reason: '양쪽 내용이 다른데 어느 쪽이 언제 바뀌었는지 확인하지 못했습니다 —'
          + ' 한쪽을 고르면 다른 쪽 변경이 흔적 없이 사라집니다' });
      continue;
    }

    const localChanged = lt > lastSync;
    const remoteChanged = rt > lastSync;

    if (localChanged && remoteChanged) {
      out.conflicts.push({ ...base, action: 'CONFLICT',
        reason: '마지막 동기화 이후 양쪽에서 모두 바뀌었습니다 —'
          + ' 최신 것만 남기면 다른 쪽 변경이 조용히 없어집니다' });
    } else if (localChanged) {
      out.uploads.push({ ...base, action: 'UPLOAD', reason: '이 브라우저에서만 바뀌었습니다' });
    } else if (remoteChanged) {
      out.downloads.push({ ...base, action: 'DOWNLOAD', reason: '서버에서만 바뀌었습니다' });
    } else {
      // 둘 다 마지막 동기화보다 오래됐는데 내용이 다르다. 설명이 안 된다.
      out.conflicts.push({ ...base, action: 'CONFLICT',
        reason: '내용은 다른데 양쪽 다 마지막 동기화 이후 바뀐 적이 없습니다 —'
          + ' 어딘가에서 기록이 어긋났습니다. 자동으로 고르지 않습니다' });
    }
  }

  const parts: string[] = [];
  if (out.uploads.length) parts.push(`올림 ${out.uploads.length}`);
  if (out.downloads.length) parts.push(`내림 ${out.downloads.length}`);
  if (out.conflicts.length) parts.push(`충돌 ${out.conflicts.length}`);

  return {
    ...out,
    ok: true, blocked: false,
    summary: parts.length ? parts.join(' · ') : '이미 같습니다',
    reason: out.conflicts.length
      ? `충돌 ${out.conflicts.length}건은 자동으로 고르지 않습니다 — 어느 쪽을 남길지 직접 정하세요`
      : '',
  };
}

// ── 화면이 무엇을 그릴 것인가 ─────────────────────────────

export interface ListVerdict {
  strategies: UserStrategy[];
  /** 이 목록이 완전한가 */
  complete: boolean;
  /** 어디서 온 목록인가 */
  source: 'SERVER' | 'BROWSER' | 'MERGED' | 'NONE';
  warning: string;
}

/**
 * 전략 목록 화면에 무엇을 그릴 것인가.
 *
 * **서버를 못 읽었을 때 아무 말 없이 로컬 목록만 그리지 않는다.**
 * 사용자는 그게 전부인 줄 알고, 없는 전략을 새로 만든다 — 그 사이
 * 서버에는 원본이 멀쩡히 있고, 이제 같은 전략이 둘이 된다.
 * 그리고 둘 다 켜지면 같은 신호에 주문이 두 번 나간다.
 */
export function listVerdict(
  local: UserStrategy[] | null | undefined,
  remote: any[] | null | undefined,
  remoteReadOk: boolean | null,
): ListVerdict {
  const l = Array.isArray(local) ? local : [];

  if (remoteReadOk !== true) {
    return {
      strategies: l,
      complete: false,
      source: l.length ? 'BROWSER' : 'NONE',
      warning: l.length
        ? '서버 목록을 읽지 못해 이 브라우저에 저장된 것만 보여 줍니다 —'
          + ' 다른 기기에서 만든 전략은 여기 없을 수 있습니다.'
          + ' 없다고 새로 만들면 나중에 같은 전략이 둘이 됩니다'
        : '서버 목록을 읽지 못했습니다 — 전략이 없다는 뜻이 아닙니다.'
          + ' 여기서 새로 만들면 나중에 중복될 수 있습니다',
    };
  }

  const r = Array.isArray(remote) ? remote : [];
  const seen = new Set(r.map(s => String(s?.id ?? '')));
  const localOnly = l.filter(s => !seen.has(String(s?.id ?? '')));
  const merged = [...(r as UserStrategy[]), ...localOnly]
    .sort((a: any, b: any) => (ms(b?.updatedAt ?? b?.updated_at) ?? 0) - (ms(a?.updatedAt ?? a?.updated_at) ?? 0));

  if (localOnly.length > 0) {
    return { strategies: merged, complete: true, source: 'MERGED',
      warning: `아직 서버에 올라가지 않은 전략 ${localOnly.length}개가 있습니다 —`
        + ' 이 브라우저에만 있어 기기를 바꾸면 보이지 않습니다' };
  }
  return { strategies: merged, complete: true, source: 'SERVER', warning: '' };
}

/**
 * 서버 행을 화면이 쓰는 모양으로.
 *
 * **모르는 칸을 그럴듯한 기본값으로 채우지 않는다** — `enabled`를
 * 'true' 문자열이나 1로도 켜짐으로 읽으면 사용자가 안 켠 전략이 돈다.
 */
export function fromRow(row: any): UserStrategy | null {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id ?? '');
  if (!id) return null;
  return {
    ...row,
    id,
    name: String(row.name ?? ''),
    enabled: row.enabled === true,
    updatedAt: ms(row.updatedAt ?? row.updated_at) ?? 0,
    createdAt: ms(row.createdAt ?? row.created_at) ?? 0,
  } as UserStrategy;
}
