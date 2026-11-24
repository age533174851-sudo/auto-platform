// src/lib/supabase/cachedRead.ts
//
// **조회 실패를 "없음"으로 적지 않고, 마지막으로 알던 값을 지우지도 않는다.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// `hooks.ts`의 표 조회 다섯 곳이 이렇게 쓰고 있었다:
//
//     const { data } = await sb.from('alerts').select(...)...;
//     const alerts = data || [];
//     lsSet(KEY.alerts, alerts);        // ← 실패한 결과를 캐시에 덮어쓴다
//     return alerts;
//
// `error`를 **아예 받지 않는다.** 그래서 표가 없거나 권한이 막히거나 망이
// 끊기면 `data`가 null이 되고, 그것이 **"알림이 없습니다"로 화면에 간다.**
//
// 더 나쁜 것은 그 다음 줄이다. 실패한 빈 목록을 localStorage에 덮어쓰므로
// **마지막으로 알던 값까지 사라진다.** 지역 캐시는 조회가 실패했을 때
// 돌아갈 곳인데, 실패 경로가 그 안전망을 지운다. 다음 실패에는 돌아갈
// 곳이 없다.
//
// `check-db-columns`가 세는 "마이그레이션이 만들지 않는 표 7개"가 바로
// 이 경로들이 읽는 표다(alerts · portfolio_positions · trade_orders ·
// pnl_reports · backtest_results · watchlists · trading_strategies).
// 빈 DB 재생에서는 그 표가 없으므로 이 판정이 늘 틀린 쪽으로 기운다.
//
// 판정을 한 곳에 둔다 — 같은 모양이 다섯 곳에 있으면 언젠가 갈린다.

/** 판정 코드. **목록이 정본이다.** */
export const CACHED_READ_CODES = ['UNREAD', 'EMPTY', 'ROWS'] as const;
export type CachedReadCode = typeof CACHED_READ_CODES[number];

export interface CachedReadVerdict<T> {
  code: CachedReadCode;
  /** 서버 상태를 확인했는가. **UNREAD면 false** */
  ok: boolean;
  /** 확인한 줄. **못 읽었으면 null — 빈 배열이 아니다** */
  rows: T[] | null;
  /** 지역 캐시를 갱신해도 되는가. **못 읽었으면 안 된다** */
  mayWriteCache: boolean;
  /** 사람이 읽을 사유. **오류 원문은 담지 않는다** */
  reason: string;
}

/**
 * 조회 결과 하나를 판정한다.
 *
 * `error`가 있으면 `data`가 배열이어도 믿지 않는다 — 부분 실패에서 둘 다
 * 채워 보내는 클라이언트가 있고, 그때 절반을 전부로 적으면 "줄었다"가
 * 사실처럼 보인다.
 *
 * 사유에는 **오류 원문을 담지 않는다.** DB 오류 메시지에는 연결 문자열이
 * 섞일 수 있고, 이 사유는 화면과 로그로 나간다.
 */
export function cachedReadVerdict<T>(i: {
  data: unknown;
  error: unknown;
}): CachedReadVerdict<T> {
  const unread = (reason: string): CachedReadVerdict<T> =>
    ({ code: 'UNREAD', ok: false, rows: null, mayWriteCache: false, reason });

  if (i?.error != null) {
    // 종류만 적는다. 원문은 적지 않는다.
    return unread('서버 조회가 실패했습니다 — 마지막으로 확인한 값을 그대로 보여 줍니다');
  }
  if (!Array.isArray(i?.data)) {
    // null·undefined·객체 전부 여기로 온다. **빈 배열로 바꾸지 않는다.**
    return unread('서버가 목록을 주지 않았습니다 — 없는 것이 아니라 확인하지 못한 것입니다');
  }
  const rows = i.data as T[];
  if (rows.length === 0) {
    return { code: 'EMPTY', ok: true, rows, mayWriteCache: true,
      reason: '확인했고 줄이 없습니다' };
  }
  return { code: 'ROWS', ok: true, rows, mayWriteCache: true,
    reason: `확인했고 줄이 ${rows.length}건입니다` };
}
