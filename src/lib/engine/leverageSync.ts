// src/lib/engine/leverageSync.ts
//
// **주문 직전에 배율을 맞추고, 맞춰졌는지 되읽어 확인한다.**
//
// 무엇이 문제였나
// ───────────────
// 점검 목록의 배율 항목은 `blocking: false`다. 즉 거래소가 5배인데 계획이
// 50배여도 **경고만 뜨고 주문은 그대로 나간다.**
//
// 그러면 무슨 일이 나나. 수량은 손절 거리에서 역산된 값이고(허용손실 ÷
// 손절거리), 필요 증거금은 명목가 ÷ 배율이다. 배율이 10분의 1이면 필요
// 증거금이 **열 배**가 된다. 대개는 거래소가 증거금 부족으로 거부하는데,
// 그 거부는 "왜 안 됐는지 모르겠다"로 화면에 남는다. 통과하는 경우에는
// 계좌의 훨씬 큰 부분이 한 자리에 묶인다 — 어느 쪽도 계획한 것이 아니다.
//
// 왜 '설정했다'로 끝내면 안 되나
// ──────────────────────────────
// 거래소에 배율 변경을 보내고 200을 받는 것과, 그 계좌의 배율이 지금
// 그 값인 것은 다른 사실이다. 열린 포지션이 있으면 거부되고, 심볼별
// 상한에 걸리면 잘리고, 교차/격리에 따라 다르게 적용된다. 셋 다 응답은
// 성공일 수 있다.
//
// 이 저장소에서 반복해서 난 실패가 정확히 이 모양이다 —
// **"요청은 성공했는데 실제로는 안 되어 있다."** 그래서 되읽는다.
//
// 무엇을 하지 않는가
// ──────────────────
// **배율을 맞췄다는 이유로 청산 안전 검사를 통과시키지 않는다.** 50배가
// 손절보다 청산이 먼저 오는 구조라면 그건 배율이 안 맞아서가 아니라
// 그 조합이 성립하지 않는 것이다. 이 파일은 '의도한 배율이 실제로
// 걸렸는가'만 답한다.

export type LeverageSyncCode =
  /** 이미 의도한 값이었다 */
  | 'ALREADY_MATCHED'
  /** 바꿨고 되읽어 확인했다 */
  | 'CHANGED'
  /** 지금 배율을 못 읽었다 */
  | 'READ_FAILED'
  /** 변경 요청이 거부됐다 */
  | 'WRITE_FAILED'
  /** 바꾼 뒤 되읽었는데 여전히 다르다 */
  | 'VERIFY_MISMATCH'
  /** 바꾼 뒤 되읽지 못했다 */
  | 'VERIFY_UNREADABLE'
  /** 의도한 배율이 숫자가 아니다 */
  | 'BAD_INTENDED';

export interface LeverageSyncResult {
  ok: boolean;
  code: LeverageSyncCode;
  intended: number | null;
  /** 시작할 때의 거래소 배율. 못 읽었으면 null */
  before: number | null;
  /** 끝났을 때의 거래소 배율. 못 읽었으면 null */
  after: number | null;
  reason: string;
  /** 거래소가 준 오류 원문. 뭉개지 않는다 */
  exchangeMessage?: string;
}

export interface LeverageSyncDeps {
  /** 지금 배율을 읽는다. **못 읽으면 null** — 0이나 1로 눕히면 안 된다 */
  read: () => Promise<number | null>;
  /** 배율을 바꾼다 */
  write: (leverage: number) => Promise<{ ok: boolean; message?: string }>;
}

export interface LeverageSyncOptions {
  /**
   * 지금 이 심볼에 포지션이 열려 있는가.
   *
   * 열려 있으면 거래소가 배율 변경을 거부하는 경우가 많다. 그 사실을
   * 사유에 적어야 "왜 안 바뀌지"가 안 된다. 판정 자체는 바뀌지 않는다 —
   * 못 맞췄으면 못 맞춘 것이다.
   */
  positionOpen?: boolean;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 배율은 정수로 비교한다. 거래소가 5를 '5.0'으로 주는 경우가 있다 */
const norm = (v: number | null): number | null =>
  v == null ? null : Math.round(v);

/**
 * 의도한 배율이 실제로 걸리게 한다.
 *
 * 거래소를 직접 안 부른다 — 읽기·쓰기를 인자로 받는다. 그래야 실제
 * 왕복 없이 각 실패 경로에 테스트가 붙고, Binance와 Gate가 같은 규칙을
 * 쓴다. 규칙이 거래소마다 따로 있으면 한쪽만 고쳐진다.
 */
export async function ensureLeverage(
  intendedRaw: any,
  deps: LeverageSyncDeps,
  opts: LeverageSyncOptions = {},
): Promise<LeverageSyncResult> {
  const intended = norm(num(intendedRaw));

  if (intended == null || intended < 1) {
    // **모르는 배율로 주문하지 않는다.** 계획이 배율을 안 정했으면
    // 수량 계산의 전제도 없다.
    return {
      ok: false, code: 'BAD_INTENDED', intended: null, before: null, after: null,
      reason: `의도한 배율이 숫자가 아닙니다 (${intendedRaw}) — 이 값 없이는 크기를 정당화할 수 없습니다`,
    };
  }

  let before: number | null = null;
  try { before = norm(await deps.read()); } catch { before = null; }

  if (before == null) {
    // 못 읽은 것을 '맞다'로도 '다르다'로도 읽지 않는다. 둘 다 틀린 행동을
    // 만든다 — 맞다고 보면 안 맞는 배율로 나가고, 다르다고 보면 멀쩡한
    // 계좌에 불필요한 변경을 쏜다.
    return {
      ok: false, code: 'READ_FAILED', intended, before: null, after: null,
      reason: '거래소 배율을 읽지 못했습니다 — 모르는 배율로는 주문하지 않습니다',
    };
  }

  if (before === intended) {
    return {
      ok: true, code: 'ALREADY_MATCHED', intended, before, after: before,
      reason: `${intended}배 — 이미 의도한 값입니다`,
    };
  }

  let w: { ok: boolean; message?: string };
  try { w = await deps.write(intended); }
  catch (e: any) { w = { ok: false, message: e?.message || String(e) }; }

  if (!w.ok) {
    return {
      ok: false, code: 'WRITE_FAILED', intended, before, after: before,
      // **거래소 원문을 그대로 올린다.** 뭉개면 무엇을 고쳐야 할지 알 수 없다.
      exchangeMessage: w.message,
      reason: `배율을 ${before}배에서 ${intended}배로 바꾸지 못했습니다`
        + (opts.positionOpen ? ' — 열린 포지션이 있으면 거래소가 거부합니다' : '')
        + (w.message ? ` (${w.message})` : ''),
    };
  }

  // ── 바꿨다고 믿지 않는다 ──
  //
  // 변경 응답이 성공이어도 실제로 안 걸리는 경우가 있다. 심볼별 상한에
  // 잘리거나, 열린 포지션 때문에 무시되거나, 교차/격리에 따라 다르게
  // 적용된다. 셋 다 응답은 200이다.
  let after: number | null = null;
  try { after = norm(await deps.read()); } catch { after = null; }

  if (after == null) {
    return {
      ok: false, code: 'VERIFY_UNREADABLE', intended, before, after: null,
      reason: '배율을 바꾼 뒤 다시 읽지 못했습니다 — 실제로 걸렸는지 확인되지 않았습니다',
    };
  }

  if (after !== intended) {
    return {
      ok: false, code: 'VERIFY_MISMATCH', intended, before, after,
      reason: `배율 변경을 보냈지만 거래소는 여전히 ${after}배입니다 (의도 ${intended}배)`
        + (opts.positionOpen ? ' — 열린 포지션이 있으면 바뀌지 않습니다' : '')
        + ' — 거래소 상한에 걸렸을 수 있습니다',
    };
  }

  return {
    ok: true, code: 'CHANGED', intended, before, after,
    reason: `배율을 ${before}배 → ${intended}배로 맞췄습니다 (되읽어 확인)`,
  };
}

/** 화면·응답에 실을 요약 한 줄 */
export function leverageSyncSummary(r: LeverageSyncResult | null | undefined): string {
  if (!r) return '배율을 확인하지 않았습니다';
  return r.ok ? r.reason : `🛑 ${r.reason}`;
}

/**
 * Gate 계약을 **격리로 돌릴 때 쓸 배율.** 쓸 수 없으면 ok=false.
 *
 * Gate는 마진 모드를 배율로 표현한다(0 = 교차, 1 이상 = 격리). 그래서
 * '격리로 바꾼다'는 '지금 배율을 다시 건다'이고, 그 배율은 **지금 포지션에서
 * 읽은 값**이어야 한다.
 *
 * 실제로 있던 고장
 * ────────────────
 * 예전 라우트는 "못 읽으면 1배"였다. `getPositionGateFutures`는 오류를
 * 삼키고 null을 주므로 조회가 한 번 실패하면 `leverage=1`을 **거래소에
 * 썼다.** 100배로 열린 포지션이라면 사용자가 고른 배율이 조회 실패 하나로
 * 1배가 된다 — 확인하지 못한 값을 기본값으로 눕힌 것이다.
 *
 *   · 못 읽음 / 칸 없음 / 깨진 값 / 1 미만의 양수 → **쓰지 않는다** (ok=false)
 *   · 0 (Gate가 말한 교차)                         → 1배 격리 (예전 동작 유지)
 *   · 1 이상                                       → 그 배율 그대로
 */
export function gateIsolateLeverage(
  pos: { leverage?: unknown } | null | undefined,
): { ok: true; leverage: number; reason: string } | { ok: false; leverage: null; reason: string } {
  const unknown = (why: string) => ({
    ok: false as const, leverage: null,
    reason: `Gate 포지션의 지금 배율을 ${why} — 배율을 지어내 거래소에 쓰지 않습니다. `
      + '격리 전환을 하지 않았습니다',
  });
  if (!pos) return unknown('읽지 못했습니다');
  const raw = pos.leverage;
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    return unknown('응답에서 찾지 못했습니다');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return unknown(`해석하지 못했습니다 (${String(raw)})`);
  // 0은 '모름'이 아니라 Gate가 확인해 준 교차다.
  if (n === 0) {
    return { ok: true, leverage: 1, reason: '교차(leverage=0)였습니다 — 1배 격리로 돌립니다' };
  }
  if (n < 1) return unknown(`해석하지 못했습니다 (${String(raw)})`);
  return { ok: true, leverage: Math.round(n), reason: `지금 배율 ${Math.round(n)}배를 유지합니다` };
}
