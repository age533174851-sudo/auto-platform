// src/lib/ledger/ingestHealth.ts
//
// **원장 수집이 지금 돌고 있는가 — 값으로 답한다.**
//
// 왜 필요한가
// ───────────
// "오늘 손익 확인 불가"만 보고는 원인을 못 고른다. 연결이 한 번도
// 수집되지 않은 것인지 · 매 회차 실패하는 것인지 · 수집기가 멈춘
// 것인지는 전혀 다른 일이고 대응도 다르다. 그런데 그걸 알아내는 방법이
// **사람이 Fly 로그를 여는 것**뿐이었다.
//
// 새 상태 시스템을 만들지 않는다
// ──────────────────────────────
// `ledger_ingest_state`가 이미 그 사실을 다 갖고 있다. 여기서는 읽어서
// 판정만 한다 — 표를 하나 더 만들면 두 곳이 갈린다.
//
// **`last_success_at` 칸을 새로 만들지 않는다.** `covered_to`는 성공한
// 회차에만 전진하므로(`ingestState.ts`), 그 값이 곧 마지막 성공 시각이다.
// 파생할 수 있는 것을 칸으로 만들면 둘이 어긋나는 날이 온다.
import type { IngestTarget } from './ingestTargets';
import { LEDGER_LAG_STALE_MS } from './coverageWindow';

export interface IngestStateRecord {
  connectionId: string;
  env: string;
  coveredFromMs: number | null;
  coveredToMs: number | null;
  lastRunAtMs: number | null;
  lastWritten: number | null;
  lastError: string | null;
}

export type IngestHealthCode =
  /** 이 거래소는 원장 수집 경로가 없다 */
  | 'UNSUPPORTED'
  /** 한 번도 성공하지 못했다 (줄이 없거나 covered_to가 없다) */
  | 'NEVER_COVERED'
  /** 마지막 회차가 실패했다 */
  | 'FAILING'
  /** 성공은 했는데 너무 오래됐다 */
  | 'STALE'
  | 'OK';

export interface IngestHealthRow {
  connectionId: string;
  env: string;
  exchange: string;
  code: IngestHealthCode;
  /** 마지막으로 **시도한** 시각 */
  lastAttemptAt: string | null;
  /** 마지막으로 **성공한** 시각 = covered_to */
  lastSuccessAt: string | null;
  coveredThrough: string | null;
  lagMinutes: number | null;
  stale: boolean;
  lastWritten: number | null;
  /** **키·토큰이 섞여 들어오지 않게 걸러 낸 사유** */
  failureReason: string | null;
  reason: string;
}

/**
 * 사유에서 비밀처럼 생긴 것을 지운다.
 *
 * 실패 문자열은 거래소 SDK·PostgREST·자체 코드 어디서든 온다. 그중 하나가
 * 언젠가 키를 담을 수 있고, 이 값은 운영 화면으로 나간다. **길게 이어진
 * 영숫자는 지운다** — 사유를 읽는 데 필요한 정보가 아니다.
 */
export function sanitizeReason(v: any): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s
    .replace(/[A-Za-z0-9_-]{24,}/g, '[가려짐]')
    .slice(0, 200);
}

/**
 * 수집 대상 + 수집 상태 → 운영 화면이 그릴 줄.
 *
 * **없는 줄을 정상으로 적지 않는다.** 한 번도 수집되지 않은 연결은
 * `NEVER_COVERED`이고, 그것이 곧 "오늘 손익을 못 만드는 이유"다.
 */
export function ingestHealthOf(i: {
  /** 활성 연결에서 만든 수집 대상. **못 읽었으면 null** */
  targets: IngestTarget[] | null | undefined;
  /** `ledger_ingest_state` 행. **못 읽었으면 null** */
  states: IngestStateRecord[] | null | undefined;
  nowMs: number;
  staleAfterMs?: number;
}): {
  ok: boolean;
  code: 'TARGETS_UNKNOWN' | 'STATES_UNKNOWN' | 'NO_CONNECTION' | 'DEGRADED' | 'OK';
  rows: IngestHealthRow[];
  summary: string;
} {
  if (i?.targets == null) {
    return { ok: false, code: 'TARGETS_UNKNOWN', rows: [],
      summary: '거래소 연결 목록을 읽지 못했습니다 — 수집 대상이 없다는 뜻이 아닙니다' };
  }
  if (i?.states == null) {
    return { ok: false, code: 'STATES_UNKNOWN', rows: [],
      summary: '수집 상태를 읽지 못했습니다 — 수집이 안 됐다는 뜻이 아닙니다' };
  }
  if (i.targets.length === 0) {
    return { ok: true, code: 'NO_CONNECTION', rows: [],
      summary: '활성 거래소 연결이 없습니다' };
  }

  const staleAfter = i.staleAfterMs ?? LEDGER_LAG_STALE_MS;
  const byKey = new Map<string, IngestStateRecord>();
  for (const s of i.states) {
    if (s?.connectionId) byKey.set(`${s.connectionId}|${s.env}`, s);
  }

  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const rows: IngestHealthRow[] = i.targets.map((t) => {
    const st = byKey.get(`${t.connectionId}|${t.env}`) ?? null;
    const lastSuccessMs = st?.coveredToMs ?? null;
    const lagMs = lastSuccessMs == null ? null : Math.max(0, i.nowMs - lastSuccessMs);
    const failureReason = sanitizeReason(st?.lastError);

    let code: IngestHealthCode;
    let reason: string;
    if (!t.supported) {
      code = 'UNSUPPORTED'; reason = t.reason;
    } else if (lastSuccessMs == null) {
      code = 'NEVER_COVERED';
      reason = st == null
        ? '이 연결은 원장 수집이 한 번도 시도되지 않았습니다'
        : '시도는 했으나 한 번도 성공하지 못했습니다';
    } else if (failureReason) {
      code = 'FAILING';
      reason = '마지막 회차가 실패했습니다 — 덮인 지점은 전진하지 않았습니다';
    } else if (lagMs != null && lagMs > staleAfter) {
      code = 'STALE';
      reason = `마지막 성공이 ${Math.round(lagMs / 60_000)}분 전입니다`;
    } else {
      code = 'OK'; reason = '';
    }

    return {
      connectionId: t.connectionId, env: t.env, exchange: t.exchange, code,
      lastAttemptAt: iso(st?.lastRunAtMs ?? null),
      lastSuccessAt: iso(lastSuccessMs),
      coveredThrough: iso(lastSuccessMs),
      lagMinutes: lagMs == null ? null : Math.round(lagMs / 60_000),
      stale: lagMs != null && lagMs > staleAfter,
      lastWritten: st?.lastWritten ?? null,
      failureReason,
      reason,
    };
  });

  const bad = rows.filter(r => r.code !== 'OK');
  return {
    ok: bad.length === 0,
    code: bad.length === 0 ? 'OK' : 'DEGRADED',
    rows,
    summary: bad.length === 0
      ? `연결 ${rows.length}개 모두 원장 수집이 최신입니다`
      : `연결 ${bad.length}개에 문제가 있습니다 (전체 ${rows.length}개) — `
        + bad.map(r => `${r.exchange}/${r.env}: ${r.code}`).join(' · '),
  };
}
