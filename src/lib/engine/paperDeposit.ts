// src/lib/engine/paperDeposit.ts
//
// **충전이 성공했는데 실패라고 답하지 않는다.**
//
// 무엇이 있었나
// ─────────────
// `072`의 `paper_deposit`은 표를 돌려줬다:
//
//   RETURNS TABLE (applied BOOLEAN, new_balance NUMERIC, new_initial NUMERIC)
//
// `082`가 계좌 인자를 붙이면서 **반환을 바꿨다**:
//
//   DROP FUNCTION paper_deposit(UUID, NUMERIC);
//   CREATE FUNCTION paper_deposit(UUID, NUMERIC, UUID) RETURNS NUMERIC
//
// 그런데 부르는 쪽은 그대로 `row.applied !== true`를 봤다. 스칼라에는
// `applied`가 없으므로 **항상 참**이고, 라우트는 409 `not_started`를 돌려준다.
//
// 문제는 그때 **돈은 이미 들어갔다는 것**이다. RPC는 제 트랜잭션에서 커밋된다.
// 빈 Postgres에 `082`의 함수만 올려 확인했다:
//
//   호출 결과            1500
//   호출 뒤 잔고          balance=1500 initial=1500   ← 들어갔다
//   JS: row.applied      undefined
//   JS: 409 분기 진입     true                         ← 실패라고 답한다
//
// 사용자가 실패로 보고 다시 누르면 **이중 입금**이다.
//
// 여기서 정하는 규칙
// ──────────────────
// **숫자가 돌아왔으면 그 순간부터 성공이다.** 그 뒤에 무엇이 실패해도
// 실패라고 답하지 않는다 — 실패라고 답하는 순간 사용자가 다시 누르고,
// 그것이 이 고장의 진짜 피해다. 초기자본을 다시 읽지 못했으면 그 칸만
// `null`로 두고 성공을 그대로 알린다.
//
// "계좌 없음"은 이제 값이 아니라 예외로 온다
// ──────────────────────────────────────────
// `082`는 계좌를 못 찾으면 `RAISE EXCEPTION`한다(옛 판은 `applied=false`를
// 돌려줬다). 그래서 그 예외를 500이 아니라 **`NO_ACCOUNT`**로 읽어야 한다.
// 500으로 읽으면 "아직 시작하지 않았습니다"라고 안내해야 할 자리에서
// "서버 오류"가 나간다.
//
// 두 모양을 다 받는다
// ───────────────────
// 지금 계약은 스칼라 하나지만, 옛 표 모양도 받아 둔다. 이 파일이 존재하는
// 이유가 **반환 모양이 갈렸는데 한쪽만 고쳤다**는 사고이므로, 반대 방향으로
// 다시 갈리는 것도 여기서 흡수한다. 어느 모양이 정본인지는
// `scripts/check-paper-deposit-contract.mjs`가 SQL을 읽어서 확인한다.
//
// 이 파일은 챌린지를 모른다
// ─────────────────────────
// 챌린지 계좌의 돈은 PR2의 회계 경로 하나로만 움직인다. 여기서는 기존
// 기본 계좌 경로를 고치기만 한다.

export type PaperDepositCode =
  /** 들어갔다 */
  | 'APPLIED'
  /** 계좌가 없다 — 아직 모의투자를 시작하지 않았다 */
  | 'NO_ACCOUNT'
  /** 넣기 전에 멈췄다. **돈은 움직이지 않았다** */
  | 'REJECTED'
  /** 호출이 실패했다. 들어갔는지 알 수 없다 */
  | 'FAILED';

export interface PaperDepositResult {
  code: PaperDepositCode;
  /** APPLIED일 때의 새 잔고 */
  balance?: number;
  /** 다시 읽지 못했으면 **null**이다 — 0으로 적지 않는다 */
  initialBalance?: number | null;
  reason?: string;
}

/** `082`가 계좌를 못 찾았을 때 내는 예외인가 */
export function isNoAccountError(message: string): boolean {
  const m = String(message ?? '');
  return /계좌를 찾지 못했습니다/.test(m)
    || /account not found/i.test(m);
}

/**
 * RPC가 돌려준 것에서 **새 잔고**를 꺼낸다.
 *
 * 순수 함수다. 모양이 갈리는 자리가 여기 하나뿐이어야 다음에 또 갈릴 때
 * 고칠 곳이 하나다.
 *
 *   1500            → 1500          (082: RETURNS NUMERIC)
 *   '1500'          → 1500          (드라이버가 NUMERIC을 문자열로 줄 때)
 *   [1500]          → 1500          (배열로 감싸 올 때)
 *   {applied:true, new_balance:1500} → 1500   (072: RETURNS TABLE)
 *   {applied:false, ...}            → null    (072가 말하는 "계좌 없음")
 *
 * 읽지 못하면 **null**이다. 0을 돌려주면 "잔고가 0이 됐다"가 되어 조용히
 * 틀린 숫자가 화면에 뜬다.
 */
export function depositBalanceOf(data: any): number | null {
  const one = Array.isArray(data) ? data[0] : data;
  if (one == null) return null;

  if (typeof one === 'object') {
    // 옛 표 모양. `applied`가 명시적으로 false면 "계좌 없음"이다.
    if (one.applied === false) return null;
    const v = typeof one.new_balance === 'string' ? Number(one.new_balance) : one.new_balance;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  const n = typeof one === 'string' ? Number(one) : one;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * 모의 계좌에 충전한다.
 *
 * **계좌를 만들지 않는다.** 시작하지 않았는데 충전이 계좌를 만들면 사용자가
 * 고른 적 없는 종잣돈이 생긴다.
 *
 * **읽고 고쳐 쓰지 않는다.** 워커의 모의 청산과 겹치면 둘 다 옛 잔고를 읽고
 * 각자 쓴다 — 한쪽이 조용히 사라진다. 증가 연산은 `082`의 SQL 안에 있다.
 */
export async function applyPaperDeposit(
  sb: any,
  userId: string | null | undefined,
  amount: number,
): Promise<PaperDepositResult> {
  const uid = typeof userId === 'string' ? userId.trim() : '';
  if (!uid) {
    return { code: 'REJECTED', reason: '사용자를 알 수 없습니다' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { code: 'REJECTED', reason: `충전 금액이 유효하지 않습니다 (${amount})` };
  }
  if (!sb) {
    return { code: 'FAILED', reason: '데이터베이스에 연결하지 못했습니다' };
  }

  let balance: number | null = null;
  try {
    const { data, error } = await sb.rpc('paper_deposit', { p_user_id: uid, p_amount: amount });
    if (error) {
      const msg = String((error as any)?.message ?? error);
      if (isNoAccountError(msg)) {
        return { code: 'NO_ACCOUNT', reason: '모의 계좌가 없습니다' };
      }
      return { code: 'FAILED', reason: msg };
    }
    balance = depositBalanceOf(data);
    if (balance == null) {
      // 옛 표 모양의 `applied:false`가 여기로 온다.
      return { code: 'NO_ACCOUNT', reason: '모의 계좌가 없습니다' };
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (isNoAccountError(msg)) {
      return { code: 'NO_ACCOUNT', reason: '모의 계좌가 없습니다' };
    }
    return { code: 'FAILED', reason: msg };
  }

  // ★ **여기부터는 무슨 일이 있어도 성공이다.**
  //
  //   숫자가 돌아왔다는 것은 SQL이 커밋했다는 뜻이다. 이 아래에서 실패를
  //   답하면 사용자가 다시 누르고, 그러면 두 번 들어간다. 이 파일이 고치는
  //   고장이 정확히 그것이다.
  let initialBalance: number | null = null;
  try {
    const { data, error } = await sb.from('paper_accounts')
      .select('initial_balance').eq('user_id', uid).eq('is_default', true).maybeSingle();
    if (!error && data) {
      const v = typeof data.initial_balance === 'string'
        ? Number(data.initial_balance) : data.initial_balance;
      if (typeof v === 'number' && Number.isFinite(v)) initialBalance = v;
    }
  } catch {
    // 못 읽었으면 모름으로 둔다. **충전 자체는 이미 성공했다.**
  }

  return { code: 'APPLIED', balance, initialBalance };
}
