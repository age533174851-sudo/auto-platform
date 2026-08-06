// src/lib/risk/idempotency.ts
//
// 같은 신호를 두 번 받았을 때 주문을 한 번만 내기 위한 것.
//
// 이 파일이 **막지 못하고 있던 것 둘**
// ────────────────────────────────────
//
// 1. 만료된 키가 영원히 막았다
//
//    `webhook_dedup.key`는 PRIMARY KEY이고, 만료된 행을 지우는
//    `cleanupDedup`은 **호출하는 곳이 한 군데도 없었다.** 그래서
//    알림 본문에 고정 `id`를 적어 두는 흔한 방식 — TradingView에서
//    사람이 직접 JSON을 쓰는 방식이 그렇다 — 을 쓰면 키가 `cid:내알림`
//    하나로 고정되고, **그 알림은 평생 한 번만 실행된다.**
//
//    두 번째부터는 "⚠️ 중복 신호 무시됨"이 뜬다. 사용자는 중복을
//    잘 막고 있다고 읽는다. 실제로는 진짜 신호가 조용히 버려지는
//    중이다. `expires_at` 칸은 있었는데 아무도 안 봤다.
//
// 2. 시간버킷 경계에서 둘 다 통과했다
//
//    고유 id가 없으면 `floor(now / 15초)`로 키를 만들었다. 그러면
//    14.999초와 15.001초에 온 **같은 신호가 다른 키**가 되어 둘 다
//    주문을 낸다. 그리고 재발사가 몰리는 자리가 정확히 그 자리다 —
//    1ms 차이로 갈리는 방어는 방어가 아니다.
//
// 무엇이 안 바뀌었나
// ──────────────────
// 원자성은 여전히 UNIQUE(key) 위반에서 온다. 읽고-나서-쓰면 두 요청이
// 동시에 "없네"를 보고 둘 다 넣는다. 아래의 이웃 버킷 확인은 그
// 원자적 삽입 **뒤에** 도는 보조 검사이고, 승자는 양쪽이 같은 답을
// 내도록 결정론적으로 고른다(먼저 만들어진 쪽). 조정 없이도 갈리지 않는다.

/** 같은 신호를 가리키는 키 묶음. 이웃 버킷까지 함께 본다 */
export interface SignalKeySet {
  key: string;
  /**
   * 경계를 사이에 둔 같은 신호가 가질 수 있는 키들.
   *
   * LIKE로 접두사 검색을 하지 않는다 — Gate 심볼(`BTC_USDT`)의 `_`가
   * LIKE 와일드카드라서 남의 신호까지 긁어 온다. 정확한 키 목록으로
   * 묻는다.
   */
  neighbors: string[];
  /** 클라이언트가 준 고유 id로 만든 키인가 */
  clientScoped: boolean;
}

export function signalKey(params: {
  clientId?: string | null;   // 클라이언트가 준 고유 id (있으면 최우선)
  connectionId: string;
  symbol: string;
  action: string;
  side: string;
  windowSec?: number;
  /** 테스트에서 시각을 고정하기 위한 것. 없으면 지금 */
  nowMs?: number;
}): string {
  return signalKeySet(params).key;
}

export function signalKeySet(params: {
  clientId?: string | null;
  connectionId: string;
  symbol: string;
  action: string;
  side: string;
  windowSec?: number;
  nowMs?: number;
}): SignalKeySet {
  if (params.clientId) {
    return { key: `cid:${params.clientId}`, neighbors: [], clientScoped: true };
  }
  const win = params.windowSec ?? 15;
  const now = Number.isFinite(params.nowMs as number) ? (params.nowMs as number) : Date.now();
  const base = `${params.connectionId}:${params.symbol}:${params.action}:${params.side}`.toLowerCase();
  const bucket = Math.floor(now / (win * 1000));
  return {
    key: `${base}:${bucket}`,
    // 앞뒤 한 칸씩. 창이 15초이므로 경계를 사이에 둔 같은 신호는
    // 반드시 이 셋 중 하나에 들어간다.
    neighbors: [`${base}:${bucket - 1}`, `${base}:${bucket + 1}`],
    clientScoped: false,
  };
}

export interface ClaimResult {
  ok: boolean;
  duplicate: boolean;
  error?: string;
  /** 사람이 읽을 사유 */
  reason?: string;
  /** 만료된 키를 되찾아 쓴 경우 */
  reclaimed?: boolean;
  /** dedup 표가 설치돼 있는가. false면 멱등성이 **한 번도 안 돈다** */
  installed?: boolean;
}

const isUniqueViolation = (e: any) =>
  e && (e.code === '23505' || /duplicate key|unique/i.test(e.message || ''));
const isMissingTable = (e: any) =>
  e && (e.code === '42P01' || /does not exist|relation .* does not exist/i.test(e.message || ''));

/**
 * 신호를 claim 한다. 처음이면 진행, 이미 있으면 중복.
 *
 * DB 오류에는 통과시킨다(fail-open). 여기서 막으면 dedup 표 하나가
 * 안 되는 것으로 주문 경로 전체가 멎는데, 중복 주문보다 **아무 주문도
 * 못 내는 쪽**이 이 표의 취지에서 더 멀다. 다만 그 사실을 `installed`와
 * `error`로 돌려주므로, 호출부가 조용히 지나가지는 않는다.
 */
export async function claimSignal(
  sb: any,
  key: string | SignalKeySet,
  windowSec = 15,
  opts: { nowMs?: number } = {},
): Promise<ClaimResult> {
  const set: SignalKeySet = typeof key === 'string'
    ? { key, neighbors: [], clientScoped: key.startsWith('cid:') }
    : key;
  const now = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const nowIso = new Date(now).toISOString();
  const expIso = new Date(now + windowSec * 1000).toISOString();

  const insert = async () => {
    const { error } = await sb.from('webhook_dedup').insert({
      key: set.key, created_at: nowIso, expires_at: expIso,
    });
    return error ?? null;
  };

  try {
    let err = await insert();

    if (err && isMissingTable(err)) {
      // 표가 없으면 멱등성이 **한 번도 안 돈 것**이다. 통과시키되
      // 통과했다고 적지 않는다 — 0과 없음은 다르다.
      return {
        ok: true, duplicate: false, installed: false, error: err.message,
        reason: 'webhook_dedup 표가 없습니다 — 중복 차단이 돌지 않았습니다 (마이그레이션 007 필요)',
      };
    }

    if (err && isUniqueViolation(err)) {
      // ── 만료된 키인가 ──
      //
      // 여기가 이 파일에서 제일 중요한 갈림길이다. 만료를 안 보면
      // 고정 id를 쓰는 알림이 평생 한 번만 실행된다.
      const { data: row, error: readErr } = await sb.from('webhook_dedup')
        .select('key, created_at, expires_at')
        .eq('key', set.key)
        .maybeSingle();

      if (readErr) {
        // 못 읽었으면 **중복으로 본다.** 여기서 통과시키면 진짜 중복이
        // 조회 실패 한 번에 뚫린다.
        return { ok: false, duplicate: true, installed: true, error: readErr.message,
          reason: '같은 키가 이미 있는데 만료 여부를 확인하지 못했습니다' };
      }

      const expMs = row?.expires_at ? Date.parse(row.expires_at) : NaN;
      const expired = Number.isFinite(expMs) && expMs <= now;
      if (!expired) {
        return { ok: false, duplicate: true, installed: true,
          reason: `같은 신호가 ${windowSec}초 안에 이미 처리되었습니다` };
      }

      // 만료됐다 — 되찾는다. 지우고 다시 넣으며, 그 사이 남이 넣었으면
      // 그쪽이 이긴 것이다.
      await sb.from('webhook_dedup').delete().eq('key', set.key).lte('expires_at', nowIso);
      err = await insert();
      if (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, duplicate: true, installed: true,
            reason: '만료된 키를 되찾는 사이 다른 요청이 먼저 가져갔습니다' };
        }
        return { ok: true, duplicate: false, installed: true, error: err.message,
          reason: '중복 확인에 실패해 통과시켰습니다' };
      }
      return await checkNeighbors(sb, set, now, nowIso, { reclaimed: true });
    }

    if (err) {
      return { ok: true, duplicate: false, installed: true, error: err.message,
        reason: '중복 확인에 실패해 통과시켰습니다' };
    }

    return await checkNeighbors(sb, set, now, nowIso, {});
  } catch (e: any) {
    return { ok: true, duplicate: false, error: e?.message || 'idempotency error',
      reason: '중복 확인에 실패해 통과시켰습니다' };
  }
}

/**
 * 이웃 버킷에 아직 살아 있는 같은 신호가 있는가.
 *
 * 원자적 삽입이 잡지 못하는 **버킷 경계**만을 위한 검사다.
 * 승자는 먼저 만들어진 쪽으로 결정론적으로 고른다 — 두 요청이 같은
 * 목록을 보고 같은 답을 내야 하나만 살아남는다. 시각이 같으면 키
 * 문자열로 가른다(값이 무엇이든 상관없고, 양쪽이 같기만 하면 된다).
 */
async function checkNeighbors(
  sb: any, set: SignalKeySet, now: number, nowIso: string,
  extra: { reclaimed?: boolean },
): Promise<ClaimResult> {
  if (set.neighbors.length === 0) {
    return { ok: true, duplicate: false, installed: true, ...extra };
  }
  try {
    const { data, error } = await sb.from('webhook_dedup')
      .select('key, created_at')
      .in('key', set.neighbors)
      .gt('expires_at', nowIso);
    if (error || !Array.isArray(data) || data.length === 0) {
      return { ok: true, duplicate: false, installed: true, ...extra };
    }
    for (const r of data) {
      const t = Date.parse(r?.created_at ?? '');
      if (!Number.isFinite(t)) continue;
      // 저쪽이 먼저 만들어졌으면 이쪽이 재발사다.
      if (t < now || (t === now && String(r.key) < set.key)) {
        return { ok: false, duplicate: true, installed: true, ...extra,
          reason: '같은 신호가 바로 앞 시간대에 이미 처리되었습니다 (버킷 경계)' };
      }
    }
    return { ok: true, duplicate: false, installed: true, ...extra };
  } catch {
    // 보조 검사다. 실패해도 원자적 삽입은 이미 성공했으므로 진행한다.
    return { ok: true, duplicate: false, installed: true, ...extra };
  }
}

/**
 * 만료된 dedup 레코드 정리.
 *
 * **호출하는 곳이 한 군데도 없었다.** 그래서 표가 계속 자랐고, 더 나쁘게는
 * 만료 개념 자체가 동작하지 않았다. 이제 claimSignal이 만료를 직접 보므로
 * 정리는 순수한 청소지만, 안 부르면 표가 무한히 자란다.
 */
export async function cleanupDedup(sb: any, nowMs?: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const iso = new Date(Number.isFinite(nowMs as number) ? (nowMs as number) : Date.now()).toISOString();
    const { error } = await sb.from('webhook_dedup').delete().lt('expires_at', iso);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'cleanup error' };
  }
}
