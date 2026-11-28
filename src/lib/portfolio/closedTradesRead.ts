// src/lib/portfolio/closedTradesRead.ts
//
// **청산된 모의 거래를 전부 읽는다 — 못 읽었으면 그렇다고 말한다.**
//
// 무엇이 있었나
// ─────────────
// 배분 라우트(`/api/portfolio/allocation`)는 `.order(asc).limit(5000)` 한
// 번으로 읽었다. 그런데 Supabase(PostgREST)는 한 응답을 **1000행으로
// 자른다**(`max_rows`; `engine/paperBotPerf.ts`가 이미 그 상한을 다룬다).
// 오름차순이라 잘리는 쪽은 **가장 최근 거래**였고, 잘렸다는 표시는 어디에도
// 없었다 — 배분표는 옛 성적만 보고 "지금" 돈을 나눴다.
//
// 어떻게 읽는가
// ─────────────
//   · `range()`로 페이지를 넘긴다. **빈 페이지가 올 때까지** 넘긴다 —
//     "요청한 크기보다 적게 왔으면 끝"으로 판단하면, 서버 상한이 페이지보다
//     작은 날(예: 500) 첫 페이지에서 끝난 것으로 착각한다.
//   · 정렬은 `closed_at, id`. 같은 시각에 닫힌 거래가 페이지 경계에서
//     빠지거나 겹치지 않게 한다.
//   · 한 페이지라도 실패하면 **앞 페이지만으로 ok를 주지 않는다.**
//   · `maxRows`를 넘으면 잘린 기록이다 — ok:false. 일부만으로 점수를 매기면
//     누적손익이 틀려 낙폭 근사까지 틀린다.

export const CLOSED_TRADES_PAGE = 1000;
export const CLOSED_TRADES_MAX = 20_000;

/**
 * 한 덩어리 모양이다(판별 유니온이 아니다) — 이 저장소의 tsc 설정에서는
 * `!r.ok`로 좁혀지지 않는다. ok가 false면 rows는 **null**이다: 앞 페이지만
 * 쥔 채 그것을 쓰는 길을 남기지 않는다.
 */
export interface ClosedTradesRead {
  ok: boolean;
  rows: any[] | null;
  reason: string | null;
  /** maxRows를 넘어 읽기를 멈췄다 */
  truncated: boolean;
}

const fail = (reason: string, truncated = false): ClosedTradesRead =>
  ({ ok: false, rows: null, reason, truncated });

export async function readClosedPaperRows(sb: any, q: {
  userId: string;
  accountId: string;
  sinceIso: string;
  pageSize?: number;
  maxRows?: number;
}): Promise<ClosedTradesRead> {
  const pageSize = Math.max(1, Math.floor(q.pageSize ?? CLOSED_TRADES_PAGE));
  const maxRows = Math.max(1, Math.floor(q.maxRows ?? CLOSED_TRADES_MAX));
  const rows: any[] = [];
  for (;;) {
    const from = rows.length;
    let res: any;
    try {
      res = await sb.from('paper_positions')
        .select('id, strategy_id, realized_pnl, closed_at')
        .eq('user_id', q.userId).eq('paper_account_id', q.accountId).eq('status', 'closed')
        .gte('closed_at', q.sinceIso)
        .order('closed_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
    } catch (e: any) {
      return fail(String(e?.message || e));
    }
    if (res?.error) return fail(String(res.error.message || res.error));
    if (!Array.isArray(res?.data)) {
      return fail('청산 기록 응답이 목록이 아닙니다');
    }
    const page = res.data;
    if (page.length === 0) return { ok: true, rows, reason: null, truncated: false };
    rows.push(...page);
    if (rows.length > maxRows) {
      return fail(`청산 기록이 ${maxRows.toLocaleString('en-US')}건을 넘어 전부 읽지 않았습니다`, true);
    }
  }
}
