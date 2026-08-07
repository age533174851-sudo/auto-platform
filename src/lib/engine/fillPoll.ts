// src/lib/engine/fillPoll.ts
//
// **접수와 체결은 다른 사건이다.**
//
// 실제로 화면에 이렇게 떴다:
//
//   주문 접수 (Gate · 2079계약 = 0.2079 BTC) · 부분 체결 0/2079 · 손절 부착
//
// 한 문장 안에 "하나도 안 붙었다"와 "손절을 걸었다"가 같이 있다. 둘 다
// 사실일 수 없다 — 없는 포지션에는 걸 것이 없다.
//
// 무슨 일이 있었나
// ────────────────
// 주문 응답을 **한 번만** 읽고 끝냈다. 거래소는 200을 주면서 그 순간의
// 체결량을 담아 돌려주는데, 시장가라도 그 값이 0일 수 있다 — 접수와
// 체결·포지션 반영 사이에 짧은 지연이 있기 때문이다.
//
// 그 0을 그대로 믿고 다음 단계로 갔다. 그래서:
//
//   · 화면은 '체결 0'이라고 적는데 거래소에는 잠시 뒤 포지션이 생긴다
//   · 사용자는 안 됐다고 보고 **한 번 더 누른다** → 포지션이 두 배가 된다
//   · 손절은 요청 수량으로 걸린다 → 실제 포지션보다 큰 보호 주문
//
// 세 번째가 특히 조용하다. 보호 주문이 포지션보다 크면 발동 시 거부되거나
// 반대 포지션이 열린다(#76에서 고친 그 자리다).
//
// 이 파일이 하는 일
// ─────────────────
// **관측한 사실만 받아서 판정한다.** 거래소를 안 부른다 — 그래야 "0을
// 체결로 치지 않는가", "다 못 읽었을 때 실패로 찍지 않는가"에 테스트를
// 붙일 수 있다.
//
// 규칙 하나: **0 체결은 상태와 무관하게 '아직'이다.** 거래소가 끝났다고
// 말한 경우(finished·cancelled)에만 '확정 미체결'이고, 그 외에는 더
// 기다려야 하는 상태다. 0을 '체결됨'으로도 '실패'로도 읽으면 안 된다 —
// 앞은 없는 포지션에 손절을 걸고, 뒤는 재시도를 열어 중복 체결을 만든다.

/**
 * 재조회 간격(ms).
 *
 * 짧게 시작해서 늘린다. 대부분은 첫 두 번 안에 끝나고, 그때마다 4초를
 * 기다리게 하면 쓸 수 없는 화면이 된다. 반대로 250ms로만 스무 번 두드리면
 * 레이트리밋을 쓴다.
 *
 * 합이 약 7.75초다. 그 안에 확정 안 되면 실패가 아니라 **모름**이다.
 */
export const FILL_POLL_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

export type FillPhase =
  /** 접수됐고 아직 체결이 안 보인다. **더 기다려야 한다** */
  | 'ACCEPTED'
  /** 일부만 붙었다 */
  | 'PARTIAL'
  /** 요청 수량이 다 붙었다 */
  | 'FILLED'
  /** 거래소가 끝났다고 말했고 체결이 0이다 — 확정 미체결 */
  | 'UNFILLED'
  /** 체결량을 읽지 못했다 */
  | 'UNKNOWN';

export interface FillObservation {
  /** 이번에 읽은 체결 수량. **못 읽었으면 null** — 0과 다르다 */
  filledQty?: number | null;
  /** 요청한 수량 */
  requestedQty?: number | null;
  /** 거래소가 말한 주문 상태 (Gate: open·finished·cancelled) */
  status?: string | null;
}

export interface FillVerdict {
  phase: FillPhase;
  filledQty: number | null;
  requestedQty: number | null;
  /** 아직 안 붙은 수량. 못 구하면 null */
  remainingQty: number | null;
  /** 더 물어볼 필요가 없는가 */
  settled: boolean;
  /** 사람이 읽는 한 줄 */
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 거래소가 "이 주문은 끝났다"고 말했는가 */
export function isTerminalStatus(v: any): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'finished' || s === 'cancelled' || s === 'canceled'
    || s === 'expired' || s === 'rejected';
}

/** 수량 비교는 상대 오차로 — 거래소마다 자릿수가 다르다 */
function qtyClose(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale < 1e-6;
}

/**
 * 지금 이 주문이 어느 단계인가.
 *
 * **접수를 체결로 치지 않는다.** HTTP 200과 주문 번호는 "받았다"는 뜻이지
 * "붙었다"가 아니다.
 */
export function fillPhaseOf(o: FillObservation | null | undefined): FillVerdict {
  const filled = num(o?.filledQty);
  const req = num(o?.requestedQty);
  const reqAbs = req == null ? null : Math.abs(req);
  const terminal = isTerminalStatus(o?.status);

  if (filled == null) {
    return {
      phase: 'UNKNOWN', filledQty: null, requestedQty: reqAbs, remainingQty: null,
      // **확정이 아니다.** 못 읽은 것을 실패로 찍으면 재시도가 열리고,
      // 그 재시도가 그대로 중복 체결이 된다.
      settled: false,
      reason: '체결 수량을 읽지 못했습니다 — 없다는 뜻이 아닙니다',
    };
  }

  const f = Math.abs(filled);
  const remaining = reqAbs == null ? null : Math.max(0, reqAbs - f);

  if (f <= 0) {
    return terminal
      ? {
          phase: 'UNFILLED', filledQty: 0, requestedQty: reqAbs, remainingQty: reqAbs,
          settled: true,
          reason: `주문이 끝났는데 체결이 0입니다 (${o?.status}) — 포지션이 생기지 않았습니다`,
        }
      : {
          phase: 'ACCEPTED', filledQty: 0, requestedQty: reqAbs, remainingQty: reqAbs,
          // **여기가 이 파일의 핵심이다.** 0을 체결로도 실패로도 읽지 않는다.
          settled: false,
          reason: '접수됐지만 아직 체결이 확인되지 않았습니다',
        };
  }

  if (reqAbs != null && qtyClose(f, reqAbs)) {
    return {
      phase: 'FILLED', filledQty: f, requestedQty: reqAbs, remainingQty: 0,
      settled: true, reason: `${f} 전량 체결`,
    };
  }
  if (reqAbs != null && f > reqAbs) {
    // 요청보다 많이 붙었다. 있을 일이 아니지만, 있으면 그대로 적는다 —
    // 조용히 요청 수량으로 깎으면 보호 주문이 실제보다 작아진다.
    return {
      phase: 'FILLED', filledQty: f, requestedQty: reqAbs, remainingQty: 0,
      settled: true, reason: `요청 ${reqAbs}보다 많은 ${f}가 체결됐습니다 — 거래소 값을 그대로 씁니다`,
    };
  }

  return {
    phase: 'PARTIAL', filledQty: f, requestedQty: reqAbs, remainingQty: remaining,
    // 끝났다고 말했으면 더 붙지 않는다. 아니면 남은 것이 붙을 수 있다.
    settled: terminal,
    reason: terminal
      ? `${f}${reqAbs != null ? `/${reqAbs}` : ''} 체결로 끝났습니다 — 나머지는 취소됐습니다`
      : `${f}${reqAbs != null ? `/${reqAbs}` : ''} 부분 체결 · 나머지 대기 중`,
  };
}

/** 이번 판정에서 더 물어볼 것인가 */
export function shouldPoll(v: FillVerdict, attempt: number): boolean {
  if (v.settled) return false;
  return attempt < FILL_POLL_DELAYS_MS.length;
}

/**
 * 이 상태에서 보호 주문을 **얼마로** 걸 것인가.
 *
 * **없는 것에는 걸지 않는다.** 요청 수량으로 걸면 실제 포지션보다 큰
 * 보호 주문이 되고, 발동 시 거부되거나 반대 포지션이 열린다.
 *
 * 부분 체결이면 **붙은 만큼만** 건다. 나머지가 나중에 붙으면 그때
 * 수량이 어긋나는데, 그건 protectionRepair가 잡는 상태이고 '보호가
 * 아예 없는 것'보다 낫다.
 */
export function protectionQtyFor(v: FillVerdict): number | null {
  if (v.filledQty == null || v.filledQty <= 0) return null;
  return v.filledQty;
}

/** 화면에 적을 한 줄. **접수와 체결을 한 문장에 섞지 않는다** */
export function fillLabel(v: FillVerdict): string {
  switch (v.phase) {
    case 'FILLED': return '체결 완료';
    case 'PARTIAL': return v.settled ? '부분 체결로 종료' : '부분 체결 · 진행 중';
    case 'UNFILLED': return '체결되지 않음';
    case 'ACCEPTED': return '접수됨 · 체결 확인 중';
    default: return '결과 확인 중';
  }
}

/**
 * 같은 방향 재주문을 잠글 것인가.
 *
 * 체결이 확정되기 전에는 사용자가 "안 됐네" 하고 한 번 더 누른다. 그
 * 사이에 앞 주문이 붙으면 **포지션이 두 배**가 된다 — 그리고 그건
 * 사용자가 의도한 크기가 아니다.
 *
 * 확정된 뒤에는 잠그지 않는다. 일부러 더 사는 것을 막으면 안 된다.
 */
export function shouldLockReorder(v: FillVerdict): boolean {
  return !v.settled;
}
