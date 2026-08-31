// src/lib/engine/paperCapacity.ts
//
// **모의 계좌의 크기 정본은 모의 계좌다.**
//
// 무엇이 있었나
// ─────────────
// `buildRiskContext`에는 PAPER 분기가 없었다. 그래서 모의 자동매매의
// 포지션 크기가 **거래소 잔고**나, 그것도 못 읽으면 **폴백 $10,000**에서
// 나왔다. 모의 계좌가 3,000으로 줄어도 크기는 10,000 기준으로 잡혔다.
//
// 그러면 두 가지가 동시에 깨진다:
//
//   복리    번 만큼 커지고 잃은 만큼 작아져야 하는데, 계좌와 무관한
//           숫자에서 크기가 나오므로 아무 일도 일어나지 않는다
//   수익률  `(balance − initial)/initial`은 실제 계좌에서 나오는데,
//           크기는 다른 숫자에서 나온다 — 두 값이 같은 세계를 말하지 않는다
//
// 그리고 잔고 검사 자체가 없었다. 계좌보다 큰 포지션이 열릴 수 있었다.
//
// 무엇을 하는가
// ─────────────
// 크기 산정에 넣을 자산·가용 증거금을 **모의 장부에서** 읽는다. 못 읽으면
// 폴백으로 채우지 않고 '모름'으로 둔다 — 확인하지 못한 것은 통과가 아니다.
//
// 복리 배율 같은 것을 새로 만들지 않는다. 이미 있는 위험 엔진에
// **진짜 잔고와 진짜 가용 증거금을 넣어 주면** 크기는 저절로 따라온다
// (`planPosition`이 `availableMargin ?? accountEquity`를 예산으로 쓴다).
//
// 마지막 판단은 여기가 아니다
// ───────────────────────────
// 이 파일의 계산은 **미리보기(preflight)**다. 동시에 들어온 두 신호는 같은
// 가용 증거금을 보고 둘 다 통과할 수 있다. 최종 권한은 진입 트랜잭션
// 안에서 계좌 줄을 잠근 채 하는 검사다(마이그레이션 075).

export type PaperCapacity =
  | {
      known: true;
      /** 정산된 현재 잔고 (USDT) */
      balance: number;
      /** 열린 포지션이 물고 있는 증거금 합 */
      usedMargin: number;
      /** 새 포지션에 쓸 수 있는 예산 */
      available: number;
    }
  | { known: false; reason: string };

/**
 * 숫자로 읽되 **빈 값을 0으로 접지 않는다.**
 *
 * `Number(null)`도 `Number('')`도 0이다. 그 한 줄이 빠지면 '못 읽음'이
 * '잔고 0'이 되고, 이 파일이 가르려던 구분이 사라진다 — 잔고 판정에서
 * 이미 한 번 겪은 고장이다.
 */
const num = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 잔고와 사용 증거금에서 가용 예산을 낸다.
 *
 * **0과 '모름'은 다르다.** 잔고 0은 확인된 사실이라 known이고, 조회에
 * 실패한 것은 known이 아니다. 여기서 `?? 10000` 같은 값을 채우면 그
 * 구분이 사라진다.
 */
export function paperCapacityOf(i: {
  balance: unknown; usedMargin: unknown;
}): PaperCapacity {
  const balance = num(i?.balance);
  if (balance == null || balance < 0) {
    return { known: false, reason: '모의 계좌 잔고를 확인하지 못했습니다' };
  }
  const used = num(i?.usedMargin);
  if (used == null || used < 0) {
    return { known: false, reason: '모의 포지션이 쓰고 있는 증거금을 확인하지 못했습니다' };
  }
  // 음수 예산은 뜻이 없다. 이미 잔고보다 많이 물고 있으면 0이다.
  return { known: true, balance, usedMargin: used, available: Math.max(0, balance - used) };
}

export type CapacityVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 이 주문을 받을 공간이 있는가.
 *
 * **진입 수수료까지 포함한다.** 수수료는 같은 트랜잭션에서 잔고에서
 * 빠지므로, 증거금만 보면 체결 직후 잔고가 물고 있는 증거금보다 작아질 수
 * 있다:
 *
 *   잔고 100 · 기존 증거금 90 · 새 증거금 10 · 수수료 0.1
 *   → 증거금만 보면 90 + 10 ≤ 100 이라 통과
 *   → 체결 뒤 잔고 99.9인데 물고 있는 증거금은 100
 *
 * 이 함수는 미리보기이고, 같은 식이 진입 트랜잭션 안에서 다시 판정된다.
 */
export function capacityVerdict(i: {
  balance: unknown; usedMargin: unknown; margin: unknown; entryFee: unknown;
}): CapacityVerdict {
  const cap = paperCapacityOf({ balance: i?.balance, usedMargin: i?.usedMargin });
  if (cap.known !== true) return { ok: false, reason: cap.reason };
  const margin = num(i?.margin);
  const fee = num(i?.entryFee);
  if (margin == null || margin < 0) return { ok: false, reason: '필요 증거금을 확인하지 못했습니다' };
  if (fee == null || fee < 0) return { ok: false, reason: '진입 수수료를 확인하지 못했습니다' };
  if (cap.usedMargin + margin + fee > cap.balance) {
    return {
      ok: false,
      reason: `모의 계좌의 가용 증거금이 부족합니다 — 필요 ${(margin + fee).toFixed(2)}, `
            + `가용 ${(cap.balance - cap.usedMargin).toFixed(2)} (수수료 포함)`,
    };
  }
  return { ok: true };
}

/**
 * 모의 장부에서 자산과 사용 증거금을 읽는다.
 *
 * **거래소를 부르지 않는다.** 모의 계좌의 크기를 거래소 잔고로 정하면
 * 다른 장부의 사실로 이 장부의 주문을 만드는 것이다 — C3에서 실행 가격에
 * 대해 없앤 것과 같은 종류의 고장이다.
 *
 * 계좌가 없으면 `known: false`다. 여기서 만들지 않는다(071).
 */
export async function readPaperCapacity(
  sb: any, userId: string | null | undefined,
): Promise<PaperCapacity> {
  if (!sb || !userId) {
    return { known: false, reason: '모의 계좌를 조회할 수 없습니다 (사용자 미지정)' };
  }
  let balance: unknown;
  try {
    const { data, error } = await sb.from('paper_accounts')
      .select('balance').eq('user_id', userId).maybeSingle();
    if (error) return { known: false, reason: '모의 계좌 조회에 실패했습니다' };
    if (!data) {
      return { known: false, reason: '모의 계좌가 없습니다 — 먼저 모의투자를 시작하세요' };
    }
    balance = (data as any).balance;
  } catch {
    return { known: false, reason: '모의 계좌 조회에 실패했습니다' };
  }

  let usedMargin = 0;
  try {
    const { data, error } = await sb.from('paper_positions')
      .select('margin').eq('user_id', userId).eq('status', 'open');
    // 조회가 실패하면 **0으로 두지 않는다.** 0은 '아무것도 안 물고 있다'로
    // 읽히는데, 실제로는 모르는 것이다. 그 차이만큼 크게 주문된다.
    if (error || !Array.isArray(data)) {
      return { known: false, reason: '모의 포지션 조회에 실패했습니다' };
    }
    for (const row of data) {
      const m = num((row as any)?.margin);
      if (m == null) return { known: false, reason: '모의 포지션의 증거금을 읽지 못했습니다' };
      usedMargin += m;
    }
  } catch {
    return { known: false, reason: '모의 포지션 조회에 실패했습니다' };
  }

  return paperCapacityOf({ balance, usedMargin });
}
