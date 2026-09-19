// src/lib/engine/paperAvailable.ts
//
// **"지금 새 주문에 쓸 수 있는 돈"을 정하는 한 곳.**
//
// 왜 한 곳인가
// ────────────
// 이 계산은 원래 `/api/paper/account`에 한 줄로 있었고
// `/api/paper/positions`에는 아예 없었다. 그런데 사이징 슬라이더가 쓰는
// 잔고는 이 값이다 — 두 라우트가 서로 다른 답을 주면 화면마다 다른 수량이
// 나온다.
//
// 열린 포지션이 물고 있는 증거금
// ──────────────────────────────
// 잔고에서 그만큼 빼지 않으면 같은 돈으로 몇 번이고 진입할 수 있다.
//
// 못 읽은 증거금
// ──────────────
// 기존 코드는 `Number(p.margin) || 0`이었다. 증거금을 못 읽으면 **0으로
// 세어** 가용 잔고가 실제보다 커진다 — 그 상태에서 슬라이더 100%는 있지도
// 않은 돈을 배정한다. 못 읽은 것은 0이 아니므로, 한 줄이라도 못 읽으면
// 가용 잔고를 `null`(모름)로 돌린다.

export interface UsedMargin {
  /** 읽어낸 증거금 합계 */
  used: number;
  /**
   * 못 읽은 줄 수. 0이 아니면 합계를 믿으면 안 된다.
   *
   * **목록 자체를 못 받은 경우도 여기 들어온다.** 예전에는 배열이 아니면
   * `{used: 0, unreadable: 0}`을 돌려줬다 — 즉 "조회 실패"가 "포지션 0건,
   * 사용 증거금 0"과 같은 답이 됐다. 호출부가 Supabase `error`를 빠뜨리면
   * 그대로 가용 잔고가 부풀었고, 실제로 세 라우트가 전부 빠뜨리고 있었다.
   *
   * 호출부에서 `error`를 확인하는 것이 1차 방어이고, 이건 **한 곳이라도
   * 빠뜨렸을 때 돈이 늘지 않게 하는** 2차 방어다.
   */
  unreadable: number;
}

function readNum(v: any): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 열린 포지션들이 물고 있는 증거금. 못 읽은 줄을 0으로 세지 않는다. */
export function usedMarginOf(positions: any): UsedMargin {
  // 목록을 못 받았다. **0건이 아니라 모름이다.**
  if (!Array.isArray(positions)) return { used: 0, unreadable: 1 };
  let used = 0;
  let unreadable = 0;
  for (const p of positions) {
    const m = readNum(p?.margin);
    // 음수 증거금은 정상 값이 아니다 — 못 읽은 것으로 본다.
    if (m === null || m < 0) { unreadable += 1; continue; }
    used += m;
  }
  return { used, unreadable };
}

/**
 * 새 주문에 배정할 수 있는 잔고.
 *
 * 못 읽었으면 `null`이다. **0을 돌려주면 안 된다** — 화면은 0을 "돈이
 * 없다"로 읽고, 사용자는 있는 돈을 못 쓴다고 생각한다. 반대로 못 읽은
 * 증거금을 0으로 세면 없는 돈을 쓸 수 있다고 적게 된다.
 */
export function availableBalance(rawBalance: any, used: UsedMargin): number | null {
  const bal = readNum(rawBalance);
  if (bal === null) return null;
  if (used.unreadable > 0) return null;
  return Math.max(0, bal - used.used);
}

/** 라우트가 그대로 응답에 담을 수 있는 모양 */
export interface AvailableView {
  available: number | null;
  usedMargin: number | null;
  /** 왜 모르는가 — 화면이 그대로 적는다. 읽었으면 null */
  unknownReason: string | null;
}

export function availableView(rawBalance: any, positions: any): AvailableView {
  const used = usedMarginOf(positions);
  if (used.unreadable > 0) {
    return {
      available: null, usedMargin: null,
      unknownReason: `열린 포지션 ${used.unreadable}건의 증거금을 읽지 못했습니다 — `
        + '가용 잔고가 0이라는 뜻이 아닙니다',
    };
  }
  const bal = readNum(rawBalance);
  if (bal === null) {
    return {
      available: null, usedMargin: used.used,
      unknownReason: '계좌 잔고를 읽지 못했습니다 — 잔고가 0이라는 뜻이 아닙니다',
    };
  }
  return { available: Math.max(0, bal - used.used), usedMargin: used.used, unknownReason: null };
}
