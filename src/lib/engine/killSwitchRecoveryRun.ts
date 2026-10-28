// src/lib/engine/killSwitchRecoveryRun.ts
//
// **킬스위치 자가복구 한 회차.** 워커의 `pollKillSwitchRecovery()`가
// 하던 일을 그대로 여기로 옮긴 것이다.
//
// 왜 옮겼나
// ─────────
// 이 경로는 전량청산 잡을 만든다. 누락되면 보호가 안 되고, 중복되면
// 청산이 두 번 나간다. 둘 다 되돌릴 수 없다. 그런데 `worker/src/index.ts`
// 안에 있는 동안은 **시험이 한 줄도 닿지 못했다** — 그 파일은 import만
// 해도 워커가 돌기 시작하고, 루트 tsconfig 밖에 있다.
//
// 그래서 판정 정본(`killSwitchRecoveryVerdict`)에는 시험이 붙어 있는데
// **그 정본에 무엇을 먹이는지**에는 하나도 없었다. Issue #514가 지적한
// 결함이 정확히 그 틈에 있다: 정본은 "배열이 아니면 모른다"고 바르게
// 판정하는데, 호출부가 **잘린 정상 배열을 완전한 목록으로 둔갑시켜서**
// 넘기고 있었다.
//
// 거래소·DB·텔레그램은 전부 주입받는다. 워커는 배선만 한다.
// 사본을 두지 않는다 — 워커와 시험이 **이 파일을 같이 컴파일해서 쓴다.**

import type { KillSwitchRecovery } from './killSwitchRecovery';
import { scanKeyset, chunk } from './keysetScan';

// ── 왜 상한 숫자를 올리지 않았나 ──
//
// 50 → 500으로 올리면 501번째에서 같은 사고가 난다. 숫자는 결함의 원인이
// 아니다. 원인은 **잘린 응답과 완전한 응답을 구별하지 않은 것**이다.
// 그래서 페이지 크기는 그대로 두고, 끝까지 읽었는지를 증명한다.
//
// 페이지 수에만 상한을 둔다. 상한에 닿으면 조용히 끝내지 않고
// `scan_limit`으로 드러낸다 — 그건 "없다"가 아니라 "모른다"다.

/** 활성 상태 한 페이지 (기존 `.limit(50)`과 같은 크기) */
export const KS_STATE_PAGE_SIZE = 50;
/** 활성 연결 2,000개까지 — 넘으면 조용히 굶기지 않고 드러낸다 */
export const KS_STATE_MAX_PAGES = 40;
/** 기존 잡 한 페이지 (기존 `.limit(200)`과 같은 크기) */
export const KS_JOBS_PAGE_SIZE = 200;
/** 한 묶음당 잡 5,000건까지 */
export const KS_JOBS_MAX_PAGES = 25;
/** `in(...)`에 한 번에 넣는 connection_id 수 */
export const KS_ID_CHUNK = 50;

/** Postgres 유니크 위반. #404의 partial UNIQUE index가 돌려주는 코드다 */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: any): boolean {
  if (!err) return false;
  if (String(err.code ?? '') === UNIQUE_VIOLATION) return true;
  return /duplicate key|unique constraint/i.test(String(err.message ?? ''));
}

/** `{ data, error }`를 돌려주는 Supabase 조회 체인 (최소 계약) */
export type KsThenable = PromiseLike<{ data?: any; error?: any }>;

export interface KsDb {
  from(table: string): any;
}

export interface KsRecoveryDeps {
  db: KsDb;
  /** 판정 정본. 워커가 `killSwitchRecoveryVerdict`를 그대로 넘긴다 */
  verdict: (i: {
    state: { data?: any; error?: any } | null | undefined;
    existing: { data?: any; error?: any } | null | undefined;
  }) => KillSwitchRecovery;
  alert: (
    channel: 'money' | 'system',
    severity: 'critical' | 'warning' | 'info',
    title: string,
    fields?: Record<string, string | number>,
    dedup?: string,
  ) => Promise<any>;
  /** 쿼터 차단기 계측. 페이지마다 부른다 */
  noteDb: (outcome: { error?: any } | null | undefined) => void;
  /** `EXCHANGE_CONNECTION_COLUMNS` */
  connectionColumns: string;
}

export interface KsRecoveryReport {
  /** 켜져 있다고 **확인한** 연결 수 */
  actives: number;
  /** 새로 만든 자가복구 잡 수 */
  created: number;
  /** 만들지 않고 넘긴 연결 수 */
  skipped: number;
  /** 사람이 읽을 경고. 조용히 건너뛴 것이 없어야 한다 */
  warnings: string[];
  /** 활성 상태 목록을 **끝까지** 읽었음을 증명했는가 */
  stateComplete: boolean;
  /** 기존 잡 목록을 **끝까지** 읽었음을 증명했는가 */
  jobsComplete: boolean;
}

export async function runKillSwitchRecovery(d: KsRecoveryDeps): Promise<KsRecoveryReport> {
  const warnings: string[] = [];
  const report: KsRecoveryReport = {
    actives: 0, created: 0, skipped: 0, warnings,
    stateComplete: false, jobsComplete: false,
  };

  // **켜진 것만** 읽는다. 평소에는 0줄이고 한 페이지에서 끝난다.
  // 꽉 찬 페이지만 다음을 묻는다 — 평소 회차에 왕복이 늘지 않는다.
  const stateScan = await scanKeyset<any>(
    async (cursor, size) => {
      let q: any = d.db.from('kill_switch_state')
        .select('connection_id, active, action_mode')
        .eq('active', true)
        .order('connection_id', { ascending: true });
      if (cursor != null) q = q.gt('connection_id', cursor);
      const r: any = await q.limit(size);
      d.noteDb({ error: r?.error });
      return r;
    },
    (r: any) => String(r?.connection_id ?? ''),
    { pageSize: KS_STATE_PAGE_SIZE, maxPages: KS_STATE_MAX_PAGES },
  );

  report.stateComplete = stateScan.complete;
  const actives = stateScan.rows;
  report.actives = actives.length;

  if (!stateScan.complete) {
    // **못 읽은 것을 "꺼져 있다"로 넘기지 않는다.** 다만 1페이지에서
    // 켜진 것을 확인한 연결은 지금 보호한다 — 여기서 전부 멈추면
    // 긴급 실행이 조회 실패 한 번 때문에 늦어진다. 못 본 뒤쪽은 적는다.
    const reason = String(stateScan.reason);
    warnings.push(`킬스위치 활성 목록을 끝까지 읽지 못했습니다 — ${reason}`);
    await d.alert('system', 'warning', '킬스위치 활성 목록을 끝까지 읽지 못했습니다',
      { 사유: reason, 확인한_연결: actives.length }, 'ks_state_scan');
  }
  if (actives.length === 0) return report;

  const ids = actives.map((r) => String(r.connection_id)).filter(Boolean);
  if (ids.length === 0) return report;

  // ── 기존 KILL_SWITCH_EXECUTE 잡 ──
  //
  // 여기서는 **연결별로 "없다"를 말할 수 있는지**가 전부다. 묶음 하나가
  // 끝까지 읽히면 그 묶음의 연결에 대해서만 '없음'을 말한다. 못 읽은
  // 묶음의 연결은 모르는 것이므로 판정 정본에 오류로 넘겨 막는다.
  const jobsByConn = new Map<string, any[]>();
  const jobsProven = new Set<string>();
  let jobsReason: string | null = null;
  for (const group of chunk(ids, KS_ID_CHUNK)) {
    const scan = await scanKeyset<any>(
      async (cursor, size) => {
        let q: any = d.db.from('jobs').select('id, connection_id')
          .in('connection_id', group)
          .eq('action', 'KILL_SWITCH_EXECUTE')
          .in('status', ['PENDING', 'PROCESSING'])
          .order('id', { ascending: true });
        if (cursor != null) q = q.gt('id', cursor);
        const r: any = await q.limit(size);
        d.noteDb({ error: r?.error });
        return r;
      },
      (r: any) => String(r?.id ?? ''),
      { pageSize: KS_JOBS_PAGE_SIZE, maxPages: KS_JOBS_MAX_PAGES },
    );
    if (!scan.complete) {
      jobsReason = String(scan.reason);
      continue;
    }
    for (const j of scan.rows) {
      const k = String(j?.connection_id ?? '');
      if (!jobsByConn.has(k)) jobsByConn.set(k, []);
      (jobsByConn.get(k) as any[]).push(j);
    }
    for (const g of group) jobsProven.add(g);
  }
  report.jobsComplete = jobsProven.size === ids.length;

  // 잡을 만들려면 연결의 user_id·exchange_id·is_testnet이 필요하다.
  // 이쪽도 묶어서 끝까지 읽는다 — 안 그러면 뒤쪽 연결이 '행 없음'이 된다.
  const connById = new Map<string, any>();
  let connReason: string | null = null;
  for (const group of chunk(ids, KS_ID_CHUNK)) {
    const scan = await scanKeyset<any>(
      async (cursor, size) => {
        let q: any = d.db.from('exchange_connections')
          .select(d.connectionColumns)
          .in('id', group)
          .order('id', { ascending: true });
        if (cursor != null) q = q.gt('id', cursor);
        const r: any = await q.limit(size);
        d.noteDb({ error: r?.error });
        return r;
      },
      (r: any) => String(r?.id ?? ''),
      { pageSize: KS_ID_CHUNK, maxPages: 2 },
    );
    if (!scan.complete) connReason = String(scan.reason);
    for (const c of scan.rows) connById.set(String(c.id), c);
  }

  for (const row of actives) {
    const cid = String(row.connection_id);
    // **완전성을 증명한 연결만** 빈 배열을 말할 수 있다. 증명하지
    // 못했으면 오류로 넘긴다 — 여기서 `[]`로 바꾸면 중복 잡이 생긴다.
    const proven = jobsProven.has(cid);
    const verdict = d.verdict({
      state: { data: row, error: null },
      existing: proven
        ? { data: jobsByConn.get(cid) ?? [], error: null }
        : { data: null, error: { message: jobsReason ?? '기존 잡 목록의 완전성을 증명하지 못했습니다' } },
    });

    if (!verdict.create) {
      report.skipped += 1;
      if (verdict.code === 'JOBS_UNREADABLE' || verdict.code === 'STATE_UNREADABLE') {
        warnings.push(`${cid}: ${verdict.reason}`);
        await d.alert('system', 'warning', '킬스위치 자가복구를 건너뛰었습니다',
          { Connection: cid.slice(0, 8), 사유: verdict.reason }, `ks_skip:${cid}`);
      }
      continue;
    }

    const conn = connById.get(cid);
    if (!conn) {
      // 연결을 못 읽었으면 거래소·모드를 모른다. 추측해서 적지 않는다.
      report.skipped += 1;
      const reason = String(connReason ?? '연결 행 없음');
      warnings.push(`${cid}: 킬스위치가 켜졌는데 연결을 읽지 못했습니다 — ${reason}`);
      await d.alert('system', 'warning', '킬스위치가 켜졌는데 연결을 읽지 못했습니다',
        { Connection: cid.slice(0, 8), 사유: reason }, `ks_conn:${cid}`);
      continue;
    }

    const insRes: any = await d.db.from('jobs').insert({
      user_id: conn.user_id, connection_id: cid,
      // **연결의 거래소를 그대로 적는다.** 예전에는 'binance'가 박혀
      // 있었다. Gate 연결에 그 잡이 붙으면 jobExchangeCheck가 막는다 —
      // 즉 킬스위치가 영원히 실행되지 않는다.
      exchange: String(conn.exchange_id),
      mode: conn.is_testnet === true ? 'TESTNET' : 'LIVE',
      action: 'KILL_SWITCH_EXECUTE',
      payload: { actionMode: verdict.actionMode || 'BC' },
      status: 'PENDING', priority: 0, max_attempts: 10,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const insErr = insRes?.error;
    d.noteDb({ error: insErr });
    if (insErr && isUniqueViolation(insErr)) {
      // **DB가 막아 준 것이다.** #404의 partial UNIQUE index는 두 워커가
      // 동시에 들어올 때의 최후 방어선이고, 여기서 그 코드가 오면
      // 중복이 들어가지 않았다는 증거다. 치명 경보로 올리면 정상 경합마다
      // 사람을 깨운다. 그렇다고 조용히 넘기지도 않는다 — 두 워커가
      // 동시에 돌고 있다는 사실 자체는 알아야 한다.
      report.skipped += 1;
      warnings.push(`${cid}: 다른 워커가 이미 자가복구 잡을 만들었습니다 (DB 유니크 제약이 중복을 막았습니다)`);
      await d.alert('system', 'warning', '킬스위치 자가복구 잡이 이미 있었습니다',
        { Connection: cid.slice(0, 8), 사유: 'DB 유니크 제약이 동시 중복을 막았습니다' },
        `ks_dupe:${cid}`);
      continue;
    }
    if (insErr) {
      const reason = String(insErr.message ?? insErr);
      warnings.push(`${cid}: 킬스위치 자가복구 잡을 만들지 못했습니다 — ${reason}`);
      await d.alert('system', 'critical', '킬스위치 자가복구 잡을 만들지 못했습니다',
        { Connection: cid.slice(0, 8), 사유: reason }, `ks_insert:${cid}`);
      continue;
    }
    report.created += 1;
  }

  return report;
}
