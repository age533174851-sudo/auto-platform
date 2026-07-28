// src/lib/maintenance/retention.ts
//
// 오래된 데이터를 지울 때의 규칙.
//
// 왜 규칙을 따로 빼는가
// ─────────────────────
// 삭제는 되돌릴 수 없다. 그런데 실수는 조용하다 — `?days=0`을 한 번
// 잘못 넘기면 컷오프가 '지금'이 되어 테이블 전체가 지워지고, 응답에는
// "정리 완료 12,483건"이라고 뜬다. 성공처럼 보인다는 게 제일 나쁘다.
//
// 그래서 여기서 세 겹으로 막는다.
//   1. 보관 기간에 하한을 둔다 — 0이나 음수를 받지 않는다
//   2. 한 번에 지울 수 있는 개수에 상한을 둔다 — 버그가 있어도 한 번에
//      다 날아가지 않는다
//   3. 무엇을 지울지 미리 세어 보는 모드를 둔다

export interface RetentionRule {
  table: string;
  /** 시간 기준 컬럼 */
  column: string;
  /** 며칠 지난 것부터 지우는가 */
  days: number;
  /** 이 표를 왜 지워도 되는가 — 사람이 읽고 판단할 근거 */
  reason: string;
}

/**
 * 보관 기간 하한.
 *
 * 7일로 둔 이유: 뉴스 분석 크론이 밀리거나 실패해도 일주일이면 따라잡는다.
 * 그보다 짧게 두면 아직 분석도 못 한 기사가 지워진다 — 수집 비용만 쓰고
 * 결과는 못 얻는다.
 */
export const MIN_RETENTION_DAYS = 7;

/** 한 번에 지울 수 있는 최대 행 수 */
export const MAX_DELETE_PER_RUN = 5_000;

/**
 * 기본 규칙.
 *
 * econ_events가 없는 이유
 * ───────────────────────
 * Risk Veto가 쓰는 표다. 지난 일정도 '최근에 뭐가 있었나'를 판단하는 데
 * 쓰이고, 무엇보다 이 표는 크지 않다(하루 수십 건). 지워서 얻는 것보다
 * 잘못 지워서 잃는 것이 크다.
 */
export const DEFAULT_RULES: RetentionRule[] = [
  {
    table: 'news_articles', column: 'published_at', days: 45,
    reason: '45일 지난 기사는 화면에서 보지 않는다. 분석 결과도 같이 지워지지만 그때는 이미 값이 없다.',
  },
  {
    table: 'ai_usage', column: 'created_at', days: 90,
    reason: '비용 화면이 최대 30일까지만 본다. 90일이면 월별 비교에도 충분하다.',
  },
  {
    table: 'ai_cache', column: 'expires_at', days: 1,
    reason: '이미 만료된 캐시다. expires_at이 지난 것은 어차피 쓰이지 않는다.',
  },
];

export interface PlanItem {
  table: string;
  column: string;
  /** 이 시각 이전 행이 대상 */
  cutoff: string;
  days: number;
  reason: string;
}

export interface PlanResult {
  items: PlanItem[];
  /** 규칙이 거부된 이유. 조용히 빼면 왜 안 지워졌는지 알 수 없다 */
  rejected: { table: string; reason: string }[];
}

/**
 * 지울 대상을 정한다. **실제로 지우지는 않는다.**
 *
 * @param nowMs 기준 시각. 테스트가 시간을 고정할 수 있게 인자로 받는다.
 */
export function planCleanup(
  rules: RetentionRule[],
  nowMs: number,
  override?: { days?: number },
): PlanResult {
  const items: PlanItem[] = [];
  const rejected: { table: string; reason: string }[] = [];

  for (const r of rules) {
    const days = override?.days != null ? override.days : r.days;

    // 여기가 핵심 방어선이다. 0이나 음수를 받으면 컷오프가 현재나
    // 미래가 되어 살아 있는 데이터까지 지운다.
    if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) {
      rejected.push({
        table: r.table,
        reason: `보관 기간이 ${days}일입니다 — 최소 ${MIN_RETENTION_DAYS}일 미만은 거부합니다. 살아 있는 데이터가 지워집니다.`,
      });
      continue;
    }
    if (!r.table || !r.column) {
      rejected.push({ table: r.table || '(이름 없음)', reason: '표나 컬럼 이름이 비어 있습니다' });
      continue;
    }

    items.push({
      table: r.table, column: r.column, days,
      cutoff: new Date(nowMs - days * 86_400_000).toISOString(),
      reason: r.reason,
    });
  }

  return { items, rejected };
}

/**
 * 지울 개수가 안전한 범위인가.
 *
 * 예상보다 지나치게 많으면 멈춘다. 보관 기간이 잘못 설정됐거나 컬럼이
 * 비어 있어 전부 대상이 된 경우인데, 그대로 지우면 되돌릴 수 없다.
 */
export function checkDeleteSize(
  count: number, total: number,
): { ok: boolean; reason: string } {
  if (!Number.isFinite(count) || count < 0) {
    return { ok: false, reason: '지울 개수를 세지 못했습니다 — 세지 못한 채로 지우지 않습니다' };
  }
  if (count === 0) return { ok: true, reason: '지울 것이 없습니다' };
  if (count > MAX_DELETE_PER_RUN) {
    return {
      ok: false,
      reason: `한 번에 ${count}건은 너무 많습니다 (상한 ${MAX_DELETE_PER_RUN}). 여러 번에 나눠 지웁니다.`,
    };
  }
  // 표 전체를 지우는 상황이면 설정이 잘못됐을 가능성이 높다.
  if (total > 0 && count >= total) {
    return {
      ok: false,
      reason: `전체 ${total}건을 모두 지우려 합니다 — 보관 기간 설정을 확인하세요.`,
    };
  }
  return { ok: true, reason: '' };
}
