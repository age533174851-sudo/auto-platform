// src/lib/engine/orderFillFacts.ts
//
// **접수(ACK)는 체결(FILL)이 아니다.**
//
// 무엇이 틀려 있었나
// ─────────────────
// `orderExecutor`의 접수 단계가 이렇게 적고 있었다:
//
//     status: 'ACKED', filled_qty: res.qty, avg_price: res.price
//
// 그런데 `placeFuturesOrder`의 `qty`는
//
//     qty: parseFloat(d.origQty || d.executedQty || '0')
//
// 즉 **요청 수량(origQty)이 먼저**다. 한 주도 채워지지 않은 주문이
// "요청만큼 체결됨"으로 장부에 남았고, 그 `filled_qty`를
// `strategies/ledger` · `my-original-v1` · `daily-ladder` 세 곳이
// 보유 수량으로 읽는다. reconcile은 ACKED를 대상으로 보지 않으므로
// 그 값은 **스스로 고쳐지지도 않는다.**
//
// `avg_price`도 같다. 미체결 주문의 `avgPrice`는 `'0.00000'`인데
// `d.avgPrice || d.price`는 문자열 `'0.00000'`을 **참으로** 보므로
// 0이 그대로 적힌다. 0은 가격이 아니라 **없음**이다.
//
// 같은 저장소의 COIN-M 경로는 이미 맞게 하고 있다
// (`filled_qty: r.filledContracts ?? null`). 경로가 둘인데 한쪽만
// 고쳐져 있던 것이다.
//
// 이 파일이 하는 일
// ────────────────
// 주문 응답에서 **거래소가 증명한 사실만** 뽑는다. 증명하지 못한 것은
// `null`이고 0이 아니다. 네트워크를 쓰지 않는 순수 함수라 시험으로
// 전수를 돌릴 수 있다.

export interface FillFacts {
  /** 우리 장부에 적을 상태. 거래소가 FILLED를 증명했을 때만 FILLED */
  status: 'ACKED' | 'FILLED';
  /** 실제로 채워진 수량. 못 읽었으면 null — 요청 수량으로 메우지 않는다 */
  filledQty: number | null;
  /** 평균 체결가. 0이나 못 읽은 것은 null */
  avgPrice: number | null;
  /** 거래소가 말한 상태 문자열. 기록·진단용 (대문자) */
  exchangeStatus: string | null;
  /** 부분 체결인가. 상태를 FILLED로 올리지 않는 근거를 남긴다 */
  partial: boolean;
}

/**
 * 응답의 숫자 칸을 **사실로만** 읽는다. 모르면 null이다.
 *
 * **내보내는 이유**: 같은 판단을 거래소 어댑터마다 다시 쓰다가 또
 * 틀렸다. `Number(null)`은 `0`이고 `Number('')`도 `0`이다 — 그래서
 * "수량을 못 읽었다"가 "체결 0"이라는 **사실**로 장부에 적혔다.
 * 이 함수 하나만 쓰면 그 함정이 한 번만 존재한다.
 */
export const numOrNull = (v: unknown, opts: { positive?: boolean } = {}): number | null => {
  if (v == null || v === '') return null;
  // **`Number`로 바꾸지 말 것.** `Number('')`과 `Number('  ')`은 `0`이고,
  // `parseFloat`는 둘 다 NaN이다. 하중을 받는 것은 이 선택이다 — 위
  // `v === ''` 가드는 그 뒤에 겹쳐 둔 것일 뿐이라 지워도 동작이 같다
  // (변이 검증에서 동치로 확인됐다). 바꾸면 "못 읽었다"가 "체결 0"이 된다.
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  if (opts.positive) return n > 0 ? n : null;
  return n >= 0 ? n : null;
};

/**
 * 주문 응답(raw)에서 체결 사실을 뽑는다.
 *
 * ★ `origQty`는 **보지 않는다.** 요청 수량은 체결의 증거가 아니다.
 */
export function fillFactsOf(raw: unknown): FillFacts {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const exchangeStatus = r.status == null || String(r.status).trim() === ''
    ? null
    : String(r.status).trim().toUpperCase();

  const filledQty = numOrNull(r.executedQty);
  // 미체결 주문의 avgPrice는 '0'이다. 0은 가격이 아니다.
  const avgPrice = numOrNull(r.avgPrice, { positive: true });

  const partial = exchangeStatus === 'PARTIALLY_FILLED';

  // **FILLED는 거래소가 FILLED라고 말하고, 채워진 수량이 0보다 클 때만이다.**
  //
  //   상태를 못 읽었으면(ACK 응답) ACKED로 둔다 — 시간이 지났다는 이유로
  //   성공으로 올리지 않는다. 부분 체결도 ACKED다: 아직 진행 중이므로
  //   계좌 용량 관문이 그것을 "진행 중 진입"으로 보고 다음 진입을 막아야 한다.
  const status: 'ACKED' | 'FILLED' =
    exchangeStatus === 'FILLED' && filledQty != null && filledQty > 0 ? 'FILLED' : 'ACKED';

  return { status, filledQty, avgPrice, exchangeStatus, partial };
}
