// src/lib/engine/lifecycleRows.ts
//
// **DB가 코드보다 뒤처져도 이미 열린 포지션은 계속 관리한다.**
//
// 무엇을 막는가
// ─────────────
// 감시 회차는 `live_orders`를 한 번 읽어서 시작한다. 그 조회에 새 칸을
// 넣으면, **그 칸이 아직 없는 DB에서는 조회 전체가 실패한다** —
// PostgREST는 모르는 칼럼 하나에 쿼리를 통째로 거절한다.
//
// 코드가 마이그레이션보다 먼저 배포되는 창은 실재한다(이 저장소는 그
// 순서를 강제하지 않는다). 그 창에서 조회가 죽으면 회차가 즉시 끝나고,
// **이미 열려 있는 포지션의 청산·보호·복구가 전부 멈춘다.**
//
// 그건 `migrationStatus`가 세워 둔 불변식과 정면으로 충돌한다:
//
//     막는 것은 **새로 여는 것뿐이다.** 이미 열린 포지션의 청산·보호·
//     복구는 계속 동작합니다.
//
// 못 여는 것은 불편이고, 열린 것을 못 닫는 것은 사고다. 그래서 새 칸을
// 넣은 조회가 **그 칸이 없어서** 실패했을 때만 옛 모양으로 한 번 더
// 읽는다.
//
// ★ 왜 "그 칸이 없어서"를 좁게 판정하는가
// ───────────────────────────────────────
// 아무 실패에나 재시도하면 **권한 오류·연결 끊김·다른 칼럼 오타**까지
// "마이그레이션이 아직인가 보다"로 읽힌다. 그러면 진짜 고장이 조용한
// 후퇴로 덮이고, 화면에는 정상 회차로 보인다.
//
// 그래서 두 가지가 **함께** 맞을 때만 후퇴한다:
//   · 오류 코드가 "그런 칼럼 없음"(42703) 또는 스키마 캐시 미스(PGRST204)
//   · 그 메시지가 **089가 더한 세 칸 중 하나**를 가리킨다
//
// 다른 칼럼이 없다는 오류는 후퇴 대상이 아니다 — 그건 이 파일이 모르는
// 진짜 고장이다.
//
// ★ 후퇴했을 때 identity를 지어내지 않는다
// ────────────────────────────────────────
// 옛 모양으로 읽은 줄에는 세 칸이 아예 없다. 그대로 둔다 —
// `executionIdentityOf()`가 자연스럽게 `null`을 준다. 여기서 "scalp니까
// Exact100X겠지"로 채우면 PR2가 없애려던 추론이 되살아난다.

/** 089가 더한 칸. 이 이름들이 실패 사유에 있어야만 후퇴한다 */
export const IDENTITY_COLUMNS = [
  'execution_profile_id',
  'execution_preset_id',
  'execution_contract_version',
] as const;

/** 진입 당시 계약까지 읽는 모양 (089 적용 후) */
export const LIFECYCLE_SELECT_IDENTITY =
  'id, connection_id, exchange, symbol, side, avg_price, price, stop_loss, '
  + 'stop_policy, '
  + 'execution_profile_id, execution_preset_id, execution_contract_version, '
  + 'sl_order_id, tp_order_id, status, reduce_only, acked_at, created_at, signal_id';

/**
 * 089 이전 DB가 읽을 수 있는 모양.
 *
 * **새 칸 셋만 빠졌고 나머지는 같다.** 여기서 다른 칸까지 빼면 후퇴가
 * 조용한 기능 축소가 된다 — 예를 들어 `stop_policy`를 함께 빼면
 * `NO_FIXED_SL` 주문이 일반 생명주기로 들어간다(PR1이 막은 그 고장).
 */
export const LIFECYCLE_SELECT_LEGACY =
  'id, connection_id, exchange, symbol, side, avg_price, price, stop_loss, '
  + 'stop_policy, '
  + 'sl_order_id, tp_order_id, status, reduce_only, acked_at, created_at, signal_id';

/** 어떤 모양으로 읽었는가. **관측할 수 있어야 한다** */
export type LifecycleProjection =
  /** 계약까지 읽었다 (089 적용됨) */
  | 'IDENTITY'
  /** 089가 아직이라 옛 모양으로 읽었다 — identity는 전부 null이다 */
  | 'LEGACY';

export interface LifecycleRowsResult {
  rows: any[];
  /** 못 읽었으면 `null` */
  projection: LifecycleProjection | null;
  /** 못 읽은 이유. 읽었으면 `null` */
  error: string | null;
}

/**
 * 이 실패가 **089가 아직이라서**인가.
 *
 * 좁게 판정한다 — 넓히면 진짜 고장이 후퇴로 덮인다.
 */
export function isMissingIdentityColumn(err: any): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').trim().toUpperCase();
  const text = `${err.message ?? ''} ${err.details ?? ''} ${err.hint ?? ''}`.toLowerCase();

  // ① "그런 칼럼 없음"인가.
  //    42703  = PostgreSQL undefined_column
  //    PGRST204 = PostgREST 스키마 캐시에서 칼럼을 못 찾음
  const missingColumn = code === '42703' || code === 'PGRST204'
    // 코드가 없는 클라이언트도 있다. 그때는 문구로 본다.
    || (!code && /(column|칼럼).*(does not exist|not found)|schema cache/.test(text));
  if (!missingColumn) return false;

  // ② 없다는 그 칼럼이 **089의 것**인가. 다른 칼럼이면 우리 문제가 아니다.
  return IDENTITY_COLUMNS.some(c => text.includes(c));
}

/**
 * 감시 회차가 볼 주문 줄을 읽는다.
 *
 * 계약까지 읽어 보고, **그 칸이 없어서** 실패했을 때만 옛 모양으로 한 번
 * 더 읽는다. 다른 실패는 그대로 실패다.
 *
 * @param query 한 모양을 읽는다. 라우트가 Supabase 체인을 넘긴다 —
 *              여기서 체인을 만들지 않으므로 시험이 값만으로 돌린다.
 */
export async function loadLifecycleRows(
  query: (select: string) => Promise<{ data: any; error: any }>,
): Promise<LifecycleRowsResult> {
  let first: { data: any; error: any };
  try {
    first = await query(LIFECYCLE_SELECT_IDENTITY);
  } catch (e: any) {
    if (!isMissingIdentityColumn(e)) {
      return { rows: [], projection: null, error: String(e?.message || e).slice(0, 200) };
    }
    first = { data: null, error: e };
  }

  if (!first.error) {
    return { rows: Array.isArray(first.data) ? first.data : [], projection: 'IDENTITY', error: null };
  }
  if (!isMissingIdentityColumn(first.error)) {
    // **다른 고장은 후퇴하지 않는다.** 권한·연결·다른 칼럼 오류를
    // "마이그레이션이 아직"으로 읽으면 진짜 원인이 가려진다.
    return { rows: [], projection: null, error: String(first.error?.message ?? first.error).slice(0, 200) };
  }

  // 089가 아직이다 — 옛 모양으로 한 번 더. 이미 열린 포지션은 계속 관리한다.
  try {
    const second = await query(LIFECYCLE_SELECT_LEGACY);
    if (second.error) {
      return { rows: [], projection: null, error: String(second.error?.message ?? second.error).slice(0, 200) };
    }
    return { rows: Array.isArray(second.data) ? second.data : [], projection: 'LEGACY', error: null };
  } catch (e: any) {
    return { rows: [], projection: null, error: String(e?.message || e).slice(0, 200) };
  }
}
