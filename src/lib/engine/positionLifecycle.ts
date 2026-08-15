// src/lib/engine/positionLifecycle.ts
//
// **어제 포지션이 안 닫혔는데 오늘 신호가 그대로 나갔다.**
//
// 실제로 일어난 일
// ────────────────
// 전날 BTCUSDT SHORT · ETHUSDT SHORT가 정상 청산되지 않은 상태에서
// 다음 거래일 신규 신호가 그대로 실행됐다. 결과가 심볼마다 달랐다:
//
//   BTCUSDT  기존 SHORT + 같은 방향 SHORT → **수량이 약 2배가 됐다.**
//            사용자가 정한 크기는 증거금 구간이 정한 한 번치인데,
//            장부에도 화면에도 "2배로 들어갔다"는 말이 없다.
//
//   ETHUSDT  기존 SHORT + 반대 LONG → ONE_WAY netting으로 상계되어
//            **0.01 ETH LONG 찌꺼기**가 남았다. 진입도 청산도 아닌
//            수량이고, 아무 전략도 이걸 자기 것으로 알지 못한다.
//
// 두 결과 모두 "주문이 실패했다"가 아니다. **거래소는 시킨 대로 했다.**
// 시키기 전에 확인하지 않은 것이 고장이다.
//
// 그래서 이 파일이 정하는 것
// ──────────────────────────
// 신규 진입 전에 **반드시** 세 가지를 값으로 확정한다:
//   1. 지금 이 종목에 열린 포지션이 있는가 (조회가 성공했는가부터)
//   2. 있다면 어느 방향인가
//   3. 그 상태에서 지금 신호로 들어가도 되는가
//
// 그리고 반대 방향일 때는 **한 번의 시장가 주문으로 뒤집지 않는다.**
// ONE_WAY netting에 기대면 위 ETHUSDT 찌꺼기가 그대로 다시 난다.
// 닫는 것과 여는 것은 다른 주문이고, 그 사이에 **닫혔다는 증거**와
// **옛 보호주문이 치워졌다는 증거**가 들어가야 한다.
//
// 규칙 하나로 줄이면
// ──────────────────
// **모르면 안 들어간다.** 조회 실패·방향 불명·청산 미확인은 전부
// '없다'가 아니라 '모른다'이고, 모르는 상태에서의 신규 진입은
// 위 두 사고를 그대로 재현한다.

import type { CloseVerdict } from './closeEvidence';

/**
 * 지금 거래소에 열려 있는 포지션.
 *
 * `PositionRead`(closeEvidence)와 달리 **방향을 갖는다.** 청산 판정은
 * 방향이 없어도 되지만(있으면 닫는다), 진입 판정은 방향이 없으면 아무
 * 결정도 할 수 없다 — 같은 방향이면 추가진입이고 반대면 반전이다.
 */
export interface OpenPosition {
  /** **조회 자체가 성공했는가.** false면 아래 값은 전부 사실이 아니다 */
  ok: boolean;
  /** 그 종목에 포지션이 있는가 */
  found: boolean;
  /** 수량(절대값). 줄은 있는데 수량을 못 읽었으면 null */
  qty: number | null;
  /** 방향. 못 읽으면 null — **0으로 눕히지 않는다** */
  side: 'LONG' | 'SHORT' | null;
  error?: string | null;
}

/** `BTC_USDT` · `BTC/USDT` · `btcusdt` 를 한 모양으로 */
function norm(s: any): string {
  return String(s ?? '').toUpperCase().replace(/[_/\-\s]/g, '');
}

/**
 * 거래소 응답 → 방향까지 가진 포지션.
 *
 * 두 거래소의 모양을 여기 한 곳에서만 읽는다:
 *   · Gate     `{ contract, size }` — size 부호가 방향이다(음수 = SHORT)
 *   · Binance  `{ symbol, positionAmt }` 또는 어댑터가 정규화한 `{ amount, side }`
 *
 * **배열이 아닌 것을 '없음'으로 읽지 않는다.** 조회 실패를 '포지션 없음'
 * 으로 읽으면 이 파일이 막으려는 사고가 그대로 돌아온다.
 */
export function openPositionOf(res: any, symbol: string): OpenPosition {
  const okFlag = res?.ok === true || res?.success === true;
  const list = Array.isArray(res?.positions) ? res.positions
    : Array.isArray(res) ? res : null;
  if ((!okFlag && !Array.isArray(res)) || list == null) {
    return {
      ok: false, found: false, qty: null, side: null,
      error: String(res?.error || res?.message || '포지션 조회 실패'),
    };
  }

  const want = norm(symbol);
  for (const p of list) {
    if (norm(p?.symbol ?? p?.contract) !== want) continue;

    const raw = p?.positionAmt ?? p?.amount ?? p?.size ?? p?.qty;
    const n = Number(raw);

    // **줄이 있는데 수량을 못 읽으면 '있다 · 모른다'다.** 0으로 보면
    // 없는 것이 되고, 그 위에서 신규 진입이 나간다.
    if (!Number.isFinite(n)) {
      return { ok: true, found: true, qty: null, side: sideOf(p, null), error: null };
    }
    if (Math.abs(n) <= 0) continue;   // 0짜리 줄은 포지션이 아니다

    return { ok: true, found: true, qty: Math.abs(n), side: sideOf(p, n), error: null };
  }
  return { ok: true, found: false, qty: 0, side: null, error: null };
}

/** 방향의 근거는 명시 필드 우선, 없으면 수량 부호 */
function sideOf(p: any, n: number | null): 'LONG' | 'SHORT' | null {
  const s = String(p?.side ?? p?.positionSide ?? '').toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'LONG';
  if (s === 'SHORT' || s === 'SELL') return 'SHORT';
  if (n != null && Number.isFinite(n) && n !== 0) return n > 0 ? 'LONG' : 'SHORT';
  return null;
}

// ── 진입 관문 ────────────────────────────────────────

export type EntryGateCode =
  /** 열린 것이 없다 — 바로 진입해도 된다 */
  | 'PROCEED'
  /** 같은 방향 포지션이 이미 있다. **추가진입은 전략이 명시 허용해야 한다** */
  | 'SAME_SIDE_BLOCKED'
  /** 반대 방향이다 — 반전 절차를 밟아야 한다. 시장가 상계 금지 */
  | 'REVERSAL_REQUIRED'
  /** 조회에 실패했다 */
  | 'POSITION_UNKNOWN'
  /** 포지션은 있는데 방향이나 수량을 못 읽었다 */
  | 'POSITION_AMBIGUOUS';

export interface EntryGateVerdict {
  /** **지금 이 순간 신규 진입 주문을 내도 되는가** */
  ok: boolean;
  code: EntryGateCode;
  /** 반전 절차를 밟으면 열릴 수 있는가 */
  needsReversal: boolean;
  reason: string;
}

/**
 * 신규 진입을 내도 되는가.
 *
 * **이 함수가 false를 주면 어떤 이유로도 주문을 내지 않는다.**
 * "어차피 반대 주문이니 netting되겠지"가 ETHUSDT 찌꺼기를 만들었다.
 */
export function entryGate(i: {
  read: OpenPosition;
  desiredSide: 'LONG' | 'SHORT';
  /** 전략이 **명시적으로** 피라미딩을 허용했는가. 기본은 금지 */
  pyramiding?: boolean;
}): EntryGateVerdict {
  const read = i.read;

  // 1. 조회부터 실패했다. **없는 것으로 치지 않는다.**
  if (!read || read.ok !== true) {
    return {
      ok: false, code: 'POSITION_UNKNOWN', needsReversal: false,
      reason: `현재 포지션을 조회하지 못했습니다 (${read?.error || '사유 없음'}) — `
        + '조회 실패는 "포지션 없음"이 아닙니다. 신규 진입을 내지 않습니다',
    };
  }

  // 2. 열린 것이 없다 — 유일하게 바로 통과하는 길이다.
  if (!read.found) {
    return { ok: true, code: 'PROCEED', needsReversal: false,
      reason: '열린 포지션이 없습니다 — 신규 진입할 수 있습니다' };
  }

  // 3. 있는데 방향이나 수량을 못 읽었다. **어느 쪽도 결정할 수 없다.**
  if (read.side == null || read.qty == null) {
    return {
      ok: false, code: 'POSITION_AMBIGUOUS', needsReversal: false,
      reason: `${read.side == null ? '방향' : '수량'}을 읽지 못한 포지션이 있습니다 — `
        + '같은 방향이면 추가진입이고 반대면 반전입니다. 구분하지 못하면 들어가지 않습니다',
    };
  }

  // 4. 같은 방향. **추가진입은 기본 금지다.**
  //
  //    BTCUSDT가 2배가 된 자리다. 같은 방향 주문은 거래소에서 그냥
  //    더해지고, 어디에도 "2배가 됐다"는 기록이 남지 않는다.
  if (read.side === i.desiredSide) {
    if (i.pyramiding === true) {
      return { ok: true, code: 'PROCEED', needsReversal: false,
        reason: `같은 방향(${read.side}) 포지션 ${read.qty}이 있지만 전략이 추가진입을 허용했습니다` };
    }
    return {
      ok: false, code: 'SAME_SIDE_BLOCKED', needsReversal: false,
      reason: `이미 같은 방향(${read.side}) 포지션 ${read.qty}이 열려 있습니다 — `
        + '전략이 추가진입(피라미딩)을 명시적으로 허용하지 않으면 더 넣지 않습니다. '
        + '전날 이 자리에서 수량이 2배가 됐습니다',
    };
  }

  // 5. 반대 방향. **시장가 반대 주문으로 상계하지 않는다.**
  return {
    ok: false, code: 'REVERSAL_REQUIRED', needsReversal: true,
    reason: `반대 방향(${read.side}) 포지션 ${read.qty}이 열려 있습니다 — `
      + '반대 주문으로 상계(netting)하면 찌꺼기 포지션이 남습니다. '
      + '먼저 전량 청산하고 0을 확인한 뒤에만 새로 진입합니다',
  };
}

// ── 반전 절차 ────────────────────────────────────────

/**
 * 반전은 반드시 이 순서를 지난다. **건너뛸 수 있는 단계가 없다.**
 *
 *   OPEN_OLD                  기존 포지션이 있다
 *   CLOSE_REQUESTED           청산 주문을 보냈다 (접수는 체결이 아니다)
 *   CLOSE_FILL_CONFIRMED      청산이 거절되지 않았음을 확인했다
 *   POSITION_ZERO_CONFIRMED   **거래소 재조회로 0을 봤다** — 여기가 핵심이다
 *   OLD_PROTECTION_CLEANED    옛 SL/TP를 치웠다
 *   READY_TO_OPEN             이제 새로 열어도 된다
 */
export type ReversalStage =
  | 'OPEN_OLD'
  | 'CLOSE_REQUESTED'
  | 'CLOSE_FILL_CONFIRMED'
  | 'POSITION_ZERO_CONFIRMED'
  | 'OLD_PROTECTION_CLEANED'
  | 'READY_TO_OPEN';

export const REVERSAL_ORDER: ReversalStage[] = [
  'OPEN_OLD', 'CLOSE_REQUESTED', 'CLOSE_FILL_CONFIRMED',
  'POSITION_ZERO_CONFIRMED', 'OLD_PROTECTION_CLEANED', 'READY_TO_OPEN',
];

export interface ReversalEvidence {
  /** 청산 주문을 보냈는가 */
  closeRequested?: boolean | null;
  /** 거래소가 청산 주문을 접수했는가. **null은 모른다** */
  closeAccepted?: boolean | null;
  /** closeEvidence의 판정. 여기서 다시 계산하지 않는다 */
  closeVerdict?: CloseVerdict | null;
  /**
   * 옛 보호주문 정리 결과.
   *   true   내가 만든 것을 정확히 취소했고 남은 것이 없다
   *   false  남아 있다
   *   null   **확인하지 못했다** — 통과가 아니다
   */
  protectionCleaned?: boolean | null;
}

export interface ReversalVerdict {
  /** 지금 새 포지션을 열어도 되는가 */
  ok: boolean;
  /** 어디까지 왔는가 */
  stage: ReversalStage;
  /** 왜 멈췄는가. ok면 'READY' */
  code: 'READY' | 'CLOSE_NOT_REQUESTED' | 'CLOSE_NOT_ACCEPTED' | 'CLOSE_UNKNOWN'
    | 'STILL_OPEN' | 'PROTECTION_NOT_CLEANED' | 'PROTECTION_UNKNOWN';
  reason: string;
}

/**
 * 반전이 어디까지 왔는가.
 *
 * **어느 단계든 '모른다'면 멈춘다.** 이 저장소에서 조용히 틀리는 쪽이
 * 언제나 더 나빴다 — 여기서 모르는 것을 통과시키면 그 결과가 실계좌의
 * 두 배 포지션이나 찌꺼기 포지션이다.
 */
export function reversalProgress(e: ReversalEvidence | null | undefined): ReversalVerdict {
  const ev = e ?? {};

  if (ev.closeRequested !== true) {
    return { ok: false, stage: 'OPEN_OLD', code: 'CLOSE_NOT_REQUESTED',
      reason: '기존 포지션에 청산 주문을 아직 보내지 않았습니다' };
  }
  if (ev.closeAccepted == null) {
    return { ok: false, stage: 'CLOSE_REQUESTED', code: 'CLOSE_UNKNOWN',
      reason: '청산 주문의 접수 여부를 확인하지 못했습니다 — 보냈다는 것만으로 닫혔다고 하지 않습니다' };
  }
  if (ev.closeAccepted !== true) {
    return { ok: false, stage: 'CLOSE_REQUESTED', code: 'CLOSE_NOT_ACCEPTED',
      reason: '청산 주문이 거절됐습니다 — 기존 포지션이 그대로 남아 있습니다' };
  }

  // **여기가 이 파일의 이유다.** 접수(HTTP 200)와 포지션 0은 다른 사실이고,
  // 그 판정은 closeEvidence 한 곳에만 있다.
  const cv = ev.closeVerdict ?? null;
  if (!cv) {
    return { ok: false, stage: 'CLOSE_FILL_CONFIRMED', code: 'CLOSE_UNKNOWN',
      reason: '청산 뒤 포지션을 재조회하지 않았습니다 — 0을 직접 보기 전에는 새로 열지 않습니다' };
  }
  if (!cv.closed) {
    const unknown = cv.code === 'READ_FAILED' || cv.code === 'RECONCILE_REQUIRED';
    return {
      ok: false, stage: 'CLOSE_FILL_CONFIRMED',
      code: unknown ? 'CLOSE_UNKNOWN' : 'STILL_OPEN',
      reason: `기존 포지션이 닫힌 것으로 확인되지 않았습니다 — ${cv.reason}`,
    };
  }

  // 포지션은 0이다. 그런데 옛 보호주문이 남아 있으면 새 포지션을 친다 —
  // 반대 방향으로 들어가면 걸자마자 발동할 수도 있다.
  if (ev.protectionCleaned == null) {
    return { ok: false, stage: 'POSITION_ZERO_CONFIRMED', code: 'PROTECTION_UNKNOWN',
      reason: '옛 보호주문이 치워졌는지 확인하지 못했습니다 — '
        + '남은 조건부 주문은 새로 연 포지션을 예상치 못하게 닫습니다' };
  }
  if (ev.protectionCleaned !== true) {
    return { ok: false, stage: 'POSITION_ZERO_CONFIRMED', code: 'PROTECTION_NOT_CLEANED',
      reason: '옛 보호주문이 아직 남아 있습니다 — 치운 뒤에 새로 엽니다' };
  }

  return { ok: true, stage: 'READY_TO_OPEN', code: 'READY',
    reason: '기존 포지션 0 확인 · 옛 보호주문 정리 완료 — 신규 진입할 수 있습니다' };
}

/**
 * 진입 관문 + 반전 절차를 한 값으로.
 *
 * 라우트가 두 함수를 각자 부르고 각자 해석하면, 한쪽만 고쳐지는 그
 * 익숙한 고장이 난다. **결정은 여기 하나에서 나온다.**
 */
export function lifecycleGate(i: {
  read: OpenPosition;
  desiredSide: 'LONG' | 'SHORT';
  pyramiding?: boolean;
  /** 반전을 이미 시도했다면 그 증거 */
  reversal?: ReversalEvidence | null;
}): { ok: boolean; code: EntryGateCode | ReversalVerdict['code']; stage: ReversalStage | null; reason: string } {
  const gate = entryGate({ read: i.read, desiredSide: i.desiredSide, pyramiding: i.pyramiding });
  if (gate.ok) return { ok: true, code: gate.code, stage: null, reason: gate.reason };
  if (!gate.needsReversal) {
    return { ok: false, code: gate.code, stage: null, reason: gate.reason };
  }
  const rv = reversalProgress(i.reversal);
  return { ok: rv.ok, code: rv.code, stage: rv.stage, reason: `${gate.reason} · ${rv.reason}` };
}

/**
 * **청산은 진입 관문에 걸리지 않는다.**
 *
 * 배율 불일치·포지션 모드 조회 실패 같은 신규진입 검사가 reduceOnly
 * 청산까지 막으면, 열린 포지션을 못 닫는 상태가 된다.
 * **못 여는 것은 불편이고 못 닫는 것은 사고다.**
 */
export function exitBlockedBy(gate: { ok: boolean; code: string } | null | undefined): boolean {
  void gate;
  return false;
}
