// src/lib/engine/entry100x.ts
//
// **전용 100배의 진입 계획 — 거래소를 실제로 물어본 값으로만 만든다.**
//
// 이 파일이 있는 이유
// ───────────────────
// `sizing100x.planSize100x`는 순수 계산이다. 그 앞에 "무엇을 물어봐서
// 어떤 순서로 확인하는가"가 있어야 실제 주문이 나가는데, 그것을 라우트
// 안에 인라인으로 쓰면 두 가지가 동시에 나빠진다.
//
//   · 라우트는 시험에서 돌릴 수 없다(네트워크·DB·인증이 붙어 있다).
//     그래서 **가장 중요한 순서가 시험되지 않는 자리에 남는다**
//   · 다른 라우트가 같은 진입을 하려면 그 순서를 복제하게 된다.
//     이 저장소에서 반복된 고장이 정확히 그것이다
//
// 그래서 **의존을 주입받는다.** 실제 라우트는 거래소 모듈을 물려 주고,
// 시험은 가짜 어댑터를 물려 준다. 판단하는 코드는 한 벌이다.
//
// 순서가 계약의 일부다
// ────────────────────
//   ① 마진 모드를 되읽는다      cross거나 모르면 여기서 멈춘다
//   ② 배율을 걸고 되읽는다      정확히 요청값이 아니면 멈춘다
//   ③ 가용 잔고를 읽는다        못 읽으면 멈춘다 (0으로 눕히지 않는다)
//   ④ 기준가를 읽는다           서버가 읽은 값이다. 신호의 진입가가 아니다
//   ⑤ 크기를 만든다             planSize100x
//   ⑥ 거래소 규격으로 다듬는다   수량 단위·최소 주문
//   ⑦ 필요 증거금을 다시 잰다    다듬느라 배정을 넘었으면 멈춘다
//
// ①이 ②보다 앞인 이유: 교차 계좌에 배율부터 걸면, 막을 주문을 위해
// 계좌 설정을 먼저 바꾸는 것이 된다. 확인이 먼저다.
//
// ⑦이 필요한 이유: 거래소 수량 단위는 올림이 될 수 있다. 0.001 단위에서
// 0.0007이 0.001이 되면 명목가가 배정보다 커지고, 그 차이는 100배에서
// 그대로 증거금 초과가 된다. 다듬은 **뒤에** 다시 재야 한다.

import { planSize100x, type Sizing100xVerdict } from './sizing100x';

export type Entry100xCode =
  | 'OK'
  /** 이 계약은 증거금 배정 사이징이 아니다 — 호출부가 잘못 불렀다 */
  | 'NOT_MARGIN_ALLOCATION'
  /** 마진 모드를 읽지 못했다 */
  | 'MARGIN_MODE_UNKNOWN'
  /** 거래소 마진 모드가 격리가 아니다 */
  | 'MARGIN_MODE_NOT_ISOLATED'
  /** 배율 설정·되읽기가 요청값과 다르다 */
  | 'LEVERAGE_NOT_EXACT'
  /** 수량 계산 단계에서 막혔다 (사유는 sizing이 갖고 있다) */
  | 'SIZING_BLOCKED'
  /** 거래소 규격으로 다듬지 못했다 */
  | 'QUANTIZE_FAILED'
  /** 다듬은 수량의 필요 증거금이 배정을 넘었다 */
  | 'MARGIN_EXCEEDED';

/**
 * **거래소 상태를 바꾸는 의존.**
 *
 * 왜 목록으로 두는가: 지금은 배율 설정 하나뿐이지만, 나중에 마진 모드
 * setter 같은 쓰기가 하나 더 붙으면 "차단될 요청이 거래소를 건드렸다"는
 * 같은 결함이 조용히 되살아난다. 그때 시험이 옛 이름 하나만 세고 있으면
 * 아무도 모른다.
 *
 * 그래서 **모든 의존을 읽기/쓰기로 분류해 둔다.** 검사기가 인터페이스의
 * 칸 이름과 이 두 목록을 대조해서, 분류되지 않은 의존이 생기면 실패시킨다.
 */
export const MUTATING_DEPS = ['applyLeverage'] as const;

/** 거래소를 읽기만 하는 의존 */
export const READONLY_DEPS = [
  'observeMarginMode', 'availableUsd', 'referencePrice', 'quantize',
] as const;

export interface Entry100xDeps {
  /** 이 심볼의 거래소 마진 모드. **못 읽으면 null** */
  observeMarginMode(): Promise<'isolated' | 'cross' | null>;
  /**
   * 배율을 걸고 **독립적으로 되읽는다.**
   *
   * `futuresApplyLeverage`가 그것이다 — 설정 응답이 아니라 되읽은 값을
   * `observed`로 준다.
   */
  applyLeverage(leverage: number): Promise<{ ok: boolean; observed: number | null; message: string }>;
  /** 주문에 쓸 수 있는 잔고(USD). **못 읽으면 null** */
  availableUsd(): Promise<number | null>;
  /** 서버가 읽은 기준가(마크가 우선). **못 읽으면 null** */
  referencePrice(): Promise<number | null>;
  /** 거래소 수량 단위·최소 주문에 맞춘 수량. 못 맞추면 null */
  quantize(qty: number): Promise<{ qty: number | null; message: string }>;
}

export interface Entry100xVerdict {
  ok: boolean;
  code: Entry100xCode;
  quantity: number | null;
  leverage: number | null;
  /** 배정한 증거금(USD) */
  allocatedMargin: number | null;
  /** 다듬은 수량으로 다시 잰 필요 증거금(USD) */
  requiredMargin: number | null;
  referencePrice: number | null;
  marginMode: 'isolated' | 'cross' | null;
  message: string;
  /** 무엇을 물어보고 무엇을 얻었는지. 화면과 기록이 같은 말을 하게 한다 */
  notes: string[];
}

const fail = (
  code: Entry100xCode, message: string, notes: string[],
  partial: Partial<Entry100xVerdict> = {},
): Entry100xVerdict => ({
  ok: false, code, quantity: null, leverage: null, allocatedMargin: null,
  requiredMargin: null, referencePrice: null, marginMode: null,
  message, notes, ...partial,
});

/**
 * 이 진입의 수량·배율을 만든다.
 *
 * **fallback이 없다.** 어떤 단계에서 값을 못 얻어도 "대신 이걸 쓴다"는
 * 가지가 없고, 그것이 이 함수의 요점이다.
 *
 * @param contract        해석된 실행 계약 (leverage · sizingPolicy · marginModes)
 * @param marginAllocationPct 이 **예약에 사용자가 직접 입력한** 배정 비율.
 *                        미지정이면 null이고, 그러면 사이징이 막는다.
 */
export async function planEntry100x(
  contract: {
    leverage: number;
    sizingPolicy: string;
    marginModes: string[];
  },
  marginAllocationPct: number | null,
  deps: Entry100xDeps,
): Promise<Entry100xVerdict> {
  const notes: string[] = [];

  if (contract?.sizingPolicy !== 'MARGIN_ALLOCATION') {
    return fail('NOT_MARGIN_ALLOCATION',
      `이 계약의 사이징 정책은 ${String(contract?.sizingPolicy)}입니다 — 증거금 배정 경로가 아닙니다`,
      notes);
  }

  // ── ① 마진 모드 ──
  //
  // 계약이 허용하는 모드만 통과시킨다. 전용 100배는 격리 전용이라
  // 교차 계좌에서는 여기서 멈춘다 — 배율을 걸기 **전**이다.
  let mode: 'isolated' | 'cross' | null = null;
  try { mode = await deps.observeMarginMode(); } catch { mode = null; }
  if (mode == null) {
    return fail('MARGIN_MODE_UNKNOWN',
      '거래소 마진 모드를 읽지 못했습니다 — 모르는 담보 범위로는 주문하지 않습니다', notes);
  }
  notes.push(`마진 모드 ${mode} (되읽음)`);
  const allowed = Array.isArray(contract.marginModes) ? contract.marginModes : [];
  if (!allowed.includes(mode)) {
    return fail('MARGIN_MODE_NOT_ISOLATED',
      `거래소 마진 모드가 ${mode}인데 이 프로필은 ${allowed.join('/') || '(없음)'}만 허용합니다`
      + ' — 담보 범위가 다르면 같은 이름의 다른 전략이 됩니다',
      notes, { marginMode: mode });
  }

  // ── ② 배율 ──
  const req = Number(contract.leverage);
  let lev: { ok: boolean; observed: number | null; message: string };
  try { lev = await deps.applyLeverage(req); }
  catch (e: any) { lev = { ok: false, observed: null, message: String(e?.message || e) }; }
  if (!lev.ok || lev.observed !== req) {
    return fail('LEVERAGE_NOT_EXACT',
      `요청 ${req}배가 확인되지 않았습니다 (되읽음 ${lev.observed == null ? '실패' : `${lev.observed}배`})`
      + ` — ${lev.message}`,
      notes, { marginMode: mode });
  }
  notes.push(`배율 ${req}배 확인(되읽음)`);

  // ── ③④ 잔고 · 기준가 ──
  let avail: number | null = null;
  try { avail = await deps.availableUsd(); } catch { avail = null; }
  let price: number | null = null;
  try { price = await deps.referencePrice(); } catch { price = null; }

  // ── ⑤ 크기 ──
  const size: Sizing100xVerdict = planSize100x({
    requiredLeverage: req,
    observedLeverage: lev.observed,
    availableUsd: avail,
    marginAllocationPct,
    referencePrice: price,
  });
  if (!size.ok) {
    return fail('SIZING_BLOCKED', size.message, notes,
      { marginMode: mode, leverage: req, referencePrice: price });
  }
  notes.push(size.message);

  // ── ⑥ 거래소 규격 ──
  let q: { qty: number | null; message: string };
  try { q = await deps.quantize(size.quantity as number); }
  catch (e: any) { q = { qty: null, message: String(e?.message || e) }; }
  if (q.qty == null || !(q.qty > 0)) {
    return fail('QUANTIZE_FAILED',
      `거래소 수량 규격에 맞추지 못했습니다 — ${q.message || '사유 미상'}`,
      notes, { marginMode: mode, leverage: req, referencePrice: price });
  }
  if (q.qty !== size.quantity) notes.push(`수량을 거래소 단위로 맞췄습니다: ${size.quantity} → ${q.qty}`);

  // ── ⑦ 필요 증거금 재검증 ──
  //
  // 다듬느라 올라간 수량이 배정을 넘으면 막는다. 넘는 만큼을 사용자가
  // 허락한 적이 없다.
  const requiredMargin = (q.qty * (price as number)) / req;
  const allocated = size.allocatedMargin as number;
  if (requiredMargin > allocated) {
    return fail('MARGIN_EXCEEDED',
      `거래소 수량 단위로 맞추니 필요 증거금이 $${requiredMargin.toFixed(4)}가 되어`
      + ` 배정한 $${allocated.toFixed(4)}를 넘습니다 — 넘는 만큼은 허락받은 적이 없습니다`,
      notes, { marginMode: mode, leverage: req, referencePrice: price,
               allocatedMargin: allocated, requiredMargin });
  }

  return {
    ok: true, code: 'OK',
    quantity: q.qty,
    leverage: req,
    allocatedMargin: allocated,
    requiredMargin,
    referencePrice: price,
    marginMode: mode,
    message: `${req}배 · 수량 ${q.qty} · 증거금 $${requiredMargin.toFixed(4)} / 배정 $${allocated.toFixed(4)}`,
    notes,
  };
}
