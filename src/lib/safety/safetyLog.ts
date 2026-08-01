// src/lib/safety/safetyLog.ts
//
// **안전장치가 발동한 기록** — 무엇을 남길지 정하는 순수 함수 + 읽기/쓰기.
//
// 왜 만드는가
// ───────────
// 주문이 막히면 409를 돌려주고 끝이었다. 어디에도 안 남는다. 그래서
// 화면은 설정값만 보여줄 수 있었고, 설정값만 보이면 사람은 그것이 돌고
// 있다고 믿는다.
//
// 오늘 하루에만 "켜져 있다고 믿었는데 한 번도 안 돈" 안전장치를 여섯 개
// 찾았다. 전부 에러가 안 나고 화면이 멀쩡했다. **한 번도 발동한 적 없는
// 안전장치는 작동한다고 말할 수 없다.**
//
// 기록 실패가 매매를 막지는 않는다
// ────────────────────────────────
// 차단은 이미 일어난 뒤다. 여기서 실패해도 주문이 나가지는 않는다.
// 다만 **조용히 넘기지 않는다** — 못 적었으면 응답에 그렇게 남긴다.
// 안 그러면 "기록이 없다"가 '발동 안 함'과 '못 적음' 둘 다를 뜻하게 되고,
// 이 파일이 없애려는 모호함이 그대로 돌아온다.

export interface BlockedCheck {
  id: string;
  label?: string;
  status: string;
  detail?: string;
  blocks?: boolean;
}

export interface SafetyEventRow {
  kind: string;
  label: string | null;
  status: string;
  market: string | null;
  symbol: string | null;
  reason: string | null;
}

export interface EventContext {
  market?: string | null;
  symbol?: string | null;
}

/**
 * 체크리스트 결과에서 **남길 줄**을 고른다.
 *
 * 막은 항목 하나당 한 줄이다. 합쳐서 한 줄로 적으면 어느 안전장치가 실제로
 * 일하는지 알 수 없다 — 그걸 알려고 만든 표다.
 *
 * 통과는 적지 않는다. 통과까지 적으면 주문 로그가 되고 '발동'이 묻힌다.
 */
export function blockEventsFrom(
  results: BlockedCheck[] | null | undefined,
  ctx: EventContext = {},
): SafetyEventRow[] {
  const list = Array.isArray(results) ? results : [];
  const market = ctx.market ? String(ctx.market) : null;
  const symbol = ctx.symbol ? String(ctx.symbol) : null;

  return list
    // `blocks`가 참인 것만. status가 fail이어도 막지 않는 항목이 있고
    // (경고), 그건 발동이 아니다.
    .filter(r => r && r.blocks === true && r.id)
    .map(r => ({
      kind: String(r.id),
      label: r.label ? String(r.label) : null,
      // 'fail'과 'unknown'을 합치지 않는다. 앞은 한도에 걸린 것이고
      // 뒤는 확인을 못 한 것이다 — 고치는 방법이 완전히 다르다.
      status: String(r.status || 'unknown'),
      market, symbol,
      reason: r.detail ? String(r.detail) : null,
    }));
}

/** 화면 한 줄: 이 안전장치가 마지막으로 언제 발동했나 */
export interface SafetyStatus {
  kind: string;
  label: string | null;
  /**
   * 마지막 발동 시각(ms). **null은 두 가지 뜻이 아니다** — `known`이
   * false면 못 읽은 것이고, true인데 null이면 진짜로 한 번도 없는 것이다.
   */
  lastAtMs: number | null;
  lastStatus: string | null;
  lastReason: string | null;
  /** 최근 기간 발동 횟수 */
  count: number;
  /** 이력을 실제로 읽었는가. false면 아래 숫자를 믿으면 안 된다 */
  known: boolean;
}

/**
 * 행 목록을 항목별 요약으로 접는다.
 *
 * 순수 함수로 두는 이유: "한 번도 없음"과 "못 읽음"을 화면이 구분해서
 * 그려야 하는데, 그 구분이 두 곳에 있으면 언젠가 한쪽만 고쳐진다.
 */
export function summarizeSafetyEvents(
  rows: Array<{ kind: string; label?: string | null; status?: string | null; reason?: string | null; occurred_at?: any }> | null,
  kinds: Array<{ id: string; label: string }>,
): SafetyStatus[] {
  const known = Array.isArray(rows);
  const byKind = new Map<string, SafetyStatus>();

  for (const k of kinds) {
    byKind.set(k.id, {
      kind: k.id, label: k.label,
      lastAtMs: null, lastStatus: null, lastReason: null,
      count: 0, known,
    });
  }

  for (const r of (rows || [])) {
    const kind = String(r?.kind || '');
    if (!kind) continue;
    let cur = byKind.get(kind);
    if (!cur) {
      // 표에는 있는데 목록에 없는 항목 — 버리지 않는다. 검사 이름이
      // 바뀌었을 때 옛 기록이 조용히 사라지면 안 된다.
      cur = {
        kind, label: r?.label ? String(r.label) : null,
        lastAtMs: null, lastStatus: null, lastReason: null, count: 0, known,
      };
      byKind.set(kind, cur);
    }
    cur.count += 1;
    const t = Date.parse(String(r?.occurred_at ?? ''));
    if (Number.isFinite(t) && (cur.lastAtMs == null || t > cur.lastAtMs)) {
      cur.lastAtMs = t;
      cur.lastStatus = r?.status ? String(r.status) : null;
      cur.lastReason = r?.reason ? String(r.reason) : null;
    }
  }

  return [...byKind.values()];
}

// ── IO ──────────────────────────────────────────────────────
//
// 기록은 **주문 흐름을 막지 않는다.** 차단은 이미 일어난 뒤고, 여기서
// 실패해도 주문이 나가지는 않는다. 다만 조용히 넘기지 않고 성공 여부를
// 돌려준다 — 호출자가 응답에 적을 수 있게.

/** 막힌 항목들을 남긴다. 돌려주는 값은 '몇 줄 적었나'와 실패 이유 */
export async function recordSafetyBlocks(
  sb: any,
  userId: string,
  results: BlockedCheck[] | null | undefined,
  ctx: EventContext = {},
): Promise<{ saved: number; error: string | null }> {
  const rows = blockEventsFrom(results, ctx);
  if (rows.length === 0) return { saved: 0, error: null };
  try {
    const { error } = await (sb as any).from('safety_events').insert(
      rows.map(r => ({ ...r, user_id: userId })),
    );
    if (error) throw new Error(error.message);
    return { saved: rows.length, error: null };
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 표가 없으면 무엇을 해야 하는지 적는다. '기록 실패'만 남기면
    // 마이그레이션을 안 돌린 것인지 다른 문제인지 알 수 없다.
    const missing = /safety_events/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg);
    return {
      saved: 0,
      error: missing
        ? 'safety_events 표가 없습니다 — 마이그레이션 026을 적용하세요'
        : msg,
    };
  }
}

/**
 * 최근 이력을 읽는다.
 *
 * **못 읽으면 null을 돌려준다.** 빈 배열로 바꾸면 화면이 "한 번도 발동한
 * 적 없음"으로 그리고, 그건 이 기능이 없애려던 바로 그 거짓말이다.
 */
export async function readSafetyEvents(
  sb: any, userId: string, sinceMs: number, limit = 500,
): Promise<Array<Record<string, any>> | null> {
  try {
    const { data, error } = await (sb as any).from('safety_events')
      .select('kind, label, status, reason, market, symbol, occurred_at')
      .eq('user_id', userId)
      .gte('occurred_at', new Date(sinceMs).toISOString())
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}
