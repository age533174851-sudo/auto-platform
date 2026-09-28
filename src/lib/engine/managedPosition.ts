// src/lib/engine/managedPosition.ts
//
// **전략을 가리지 않고 "지금 열려 있는 포지션"을 만든다.**
//
// 왜 필요한가
// ───────────
// 청산 감시는 `ladder_daily_trades` 하나만 읽었다. 그건 계단식 전용
// 표라서 scalp·my-original-v1 포지션은 트레일링도 본전이동도 시간청산도
// 받지 못했다(#201의 커버리지 표가 그 사실을 그대로 보여 준다).
//
// 세 전략이 함께 쓰는 표는 `live_orders`다. 거기에 연결 · 거래소 · 종목 ·
// 방향 · 체결가 · 손절 · 보호주문 번호 · 전략 표식이 전부 있다.
//
// 줄이 있다고 열려 있는 것이 아니다
// ─────────────────────────────────
// `live_orders`는 **의도 장부**다. 보내기 전에 먼저 적고(INTENT),
// 응답을 못 받으면 UNKNOWN으로 남는다. 그래서 줄이 있다는 이유로
// "포지션이 열려 있다"고 읽으면 **없는 포지션의 손절을 옮기게 된다.**
//
// 여기서는 **후보만** 만든다. 실제로 열려 있는지는 그 연결·거래소에
// 물어서 확인한다(부르는 쪽이 `readback`을 넘긴다).
//
// 같은 종목을 두 전략이 자기 것이라 주장하면
// ──────────────────────────────────────────
// 거래소 선물은 대개 **net position**이다. 같은 connection + symbol에
// scalp와 my-original-v1의 줄이 둘 다 있으면, 거래소가 말하는 포지션
// 하나를 누구 것이라 할 수 없다.
//
// 그때 손절을 옮기거나 닫으면 **남의 전략 포지션을 건드리는 것**이다.
// 그래서 `OWNERSHIP_AMBIGUOUS`로 두고 아무 주문도 내지 않는다.
// 고아 보호주문 정리(#201)는 적어 둔 번호로만 하므로 그대로 돈다.
//
// ★ 고정 손절을 쓰지 않는 주문 — 인식은 하되 관리하지 않는다
// ──────────────────────────────────────────────────────────
// `stop_policy = 'NO_FIXED_SL'`인 주문은 **일부러** 진입 손절을 걸지
// 않는다. 지금까지 이 주문들이 일반 생명주기에 들어가지 않은 것은
// 정책 때문이 아니라 **우연**이었다 — 손절 값이 없어서 `NO_STOP`으로
// 걸러졌을 뿐이다.
//
// 그 우연은 참고용 손절 값이 한 번 채워지는 순간 끝난다. 그때 이 주문은
// 일반 생명주기로 들어가 highWater·6시간 시간청산·본전이동·트레일링·
// MOVE_STOP·CLOSE를 받는다. **아무도 그렇게 해 달라고 한 적이 없다.**
//
// 그래서 우연을 계약으로 바꾼다:
//
//     recognized = true      (장부에서 보이고 telemetry에 적힌다)
//     managed    = false     (일반 생명주기는 절대 건드리지 않는다)
//
// ★★ 그리고 그 줄 하나만 빼는 것으로는 부족하다
// ─────────────────────────────────────────────
// 거래소 선물은 **net position**이다. 같은 연결·종목에
//
//     A  scalp        NO_FIXED_SL
//     B  scalp        FIXED_SL
//
// 두 줄이 있을 때 A만 조용히 버리면 B가 그 자리의 **유일한 주장자**가
// 되어 `OWNED`로 승격한다. 그러면 일반 생명주기가 B의 손절을 옮기거나
// 그 종목을 닫는데, 거래소에 있는 것은 **A와 B가 합쳐진 포지션 하나**다.
// A의 노출까지 같이 움직인다.
//
// 어느 수량이 어느 줄의 것인지 증명할 방법이 없다. 그래서 자리(seat)에
// `NO_FIXED_SL` 줄이 **하나라도** 있으면 그 자리 전체를 일반 생명주기의
// 거래소 쓰기에서 유예한다 — 같은 전략의 고정 손절 줄이 함께 있어도
// 마찬가지다.
//
// 이 때문에 **자리 주장 등록이 손절 분류보다 먼저**여야 한다. 예전에는
// `NO_STOP`이 주장 등록보다 앞에 있어서, 걸러진 줄이 자리에서도 사라졌다.

import { strategyOf } from '../strategies/ledger';

export type OwnershipCode =
  /** 이 연결·종목에 이 전략의 줄만 있다 */
  | 'OWNED'
  /** 여러 전략이 같은 자리를 주장한다. **손대지 않는다** */
  | 'OWNERSHIP_AMBIGUOUS'
  /** 주인을 모른다 (표식이 없는 옛 줄) */
  | 'OWNER_UNKNOWN';

/**
 * 일반 생명주기가 이 포지션을 **관리해도 되는가.**
 *
 * 소유권(`OwnershipCode`)과 **다른 질문**이다. 소유권은 "이 자리가 누구
 * 것인가"이고, 이쪽은 "누구 것인지 알아도 건드려도 되는가"다. 둘을 한
 * 값에 합치면 `NO_FIXED_SL` 유예가 "주인을 모른다"로 읽혀 나중에 주인을
 * 알아내는 개선이 유예를 풀어 버린다.
 */
export type ManagementCode =
  /** 일반 생명주기가 평소처럼 관리한다 */
  | 'MANAGED'
  /**
   * 이 자리에 **관리 계약이 깨진 노출**이 섞여 있다. 손대지 않는다.
   *
   * ★ 이름이 `NO_FIXED_SL_...`이면 안 된다. 막는 이유는 하나가 아니다 —
   *   고정 손절을 안 쓰기로 한 줄도, 쓰기로 해 놓고 값이 없는 줄도 똑같이
   *   "관리할 수 없는 노출"이다. 앞 이름으로 뒤 경우까지 막으면 **동작은
   *   맞는데 이름이 거짓말을 한다.** 왜 막혔는지는 `deferred`의 원래
   *   코드가 말한다.
   */
  | 'UNMANAGED_SEAT_DEFERRED';

/**
 * 인식은 했지만 관리하지 않는 줄. **버린 것이 아니라 유예한 것이다.**
 *
 * `skipped`(칸이 모자라 판단 못 한 줄)와 섞지 않는다 — 섞으면 "일부러
 * 관리하지 않음"이 "뭔가 빠져서 실패함"으로 읽힌다.
 */
export type DeferralCode =
  /** 고정 손절을 안 쓰는 주문. 일반 종료 권한이 아직 연결되지 않았다 */
  | 'NO_FIXED_SL_EXIT_UNWIRED'
  /** 고정 손절을 안 쓴다는데 손절 값이 적혀 있다 — 계약과 장부가 어긋난다 */
  | 'NO_FIXED_SL_STOP_CONFLICT'
  /** 고정 손절을 쓴다는데 값이 없다. 추측하지 않는다 */
  | 'FIXED_SL_MISSING_STOP'
  /** 모르는 정책 이름. **추측하지 않는다** */
  | 'STOP_POLICY_UNKNOWN';

export interface DeferredRow {
  code: DeferralCode;
  connectionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  strategyId: string | null;
  orderId: string | null;
  reason: string;
}

/** `live_orders`에서 여기서 쓰는 칸만 */
export interface OrderRowLike {
  id?: string;
  connection_id: string | null;
  exchange: string | null;
  symbol: string | null;
  side: string | null;
  /** 체결가. 못 받았으면 null */
  avg_price: number | string | null;
  price?: number | string | null;
  stop_loss: number | string | null;
  /**
   * `FIXED_SL` · `NO_FIXED_SL` · null(옛 줄). migration 078의 칸이다.
   *
   * **null과 `NO_FIXED_SL`은 다르다.** null은 "정책을 안 적던 시절의 줄"
   * 이고, `NO_FIXED_SL`은 "고정 손절을 안 쓰기로 정한 줄"이다. null을
   * 전부 막으면 기존 고정 손절 전략이 통째로 관리에서 빠진다.
   */
  stop_policy?: string | null;
  sl_order_id?: string | null;
  tp_order_id?: string | null;
  status: string | null;
  reduce_only?: boolean | null;
  /** **진입 시각은 이 값이다.** created_at은 INTENT 시점이다 */
  acked_at: string | null;
  created_at?: string | null;
  signal_id?: string | null;
  strategy_id?: string | null;
}

export interface ManagedPosition {
  connectionId: string;
  exchange: 'binance' | 'gate';
  symbol: string;
  strategyId: string | null;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  /** 진입(체결) 시각 ms */
  openedAt: number;
  ownedProtectionIds: string[];
  ownership: { code: OwnershipCode; reason: string; claimants: string[] };
  /**
   * 일반 생명주기가 건드려도 되는가. 소유권과 **따로** 본다.
   * `mayActOn`이 둘 다 통과할 때만 참이다.
   */
  management: { code: ManagementCode; reason: string };
  /** 어느 줄에서 왔는가 — 기록·중복 방지에 쓴다 */
  orderId: string | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 진입으로 볼 수 있는 상태. **UNKNOWN은 포함하지 않는다** */
const ENTERED = new Set(['FILLED', 'ACKED', 'RECONCILED']);

function venueOf(v: any): 'binance' | 'gate' | null {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'binance') return 'binance';
  if (s === 'gate' || s === 'gateio' || s === 'gate.io') return 'gate';
  return null;   // **모르는 거래소를 바이낸스로 읽지 않는다**
}

function sideOf(v: any): 'LONG' | 'SHORT' | null {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'BUY' || s === 'LONG') return 'LONG';
  if (s === 'SELL' || s === 'SHORT') return 'SHORT';
  return null;
}

export interface CandidateSkip { code: string; count: number; reason: string }

/**
 * 적힌 손절 정책. **모르는 이름을 고정 손절로 읽지 않는다.**
 *
 * 빈 글자는 "안 적힘"(null)과 같게 본다 — 옛 줄이 빈 문자열로 남아 있을
 * 수 있고, 그걸 모르는 정책으로 읽으면 멀쩡한 legacy 줄이 통째로 막힌다.
 */
function stopPolicyOf(v: any): 'FIXED_SL' | 'NO_FIXED_SL' | 'UNKNOWN' | null {
  if (v == null) return null;
  const t = String(v).trim().toUpperCase();
  if (t === '') return null;
  if (t === 'FIXED_SL') return 'FIXED_SL';
  if (t === 'NO_FIXED_SL') return 'NO_FIXED_SL';
  return 'UNKNOWN';
}

/**
 * 주문 장부 → 감시 후보.
 *
 * **여기서 거래소에 묻지 않는다.** 순수 함수라 테스트가 값만으로 돌린다.
 * 실제로 열려 있는지는 부르는 쪽이 확인한다.
 *
 * 세 갈래로 나눈다 — 셋은 **다른 뜻**이다:
 *
 *   positions  일반 생명주기가 관리한다
 *   deferred   인식했고 열려 있다고 보지만 **일부러** 관리하지 않는다
 *   skipped    칸이 모자라 판단하지 못했다
 *
 * `deferred`를 `skipped`에 넣으면 "정책상 관리 안 함"이 "뭔가 빠져서
 * 실패함"으로 읽힌다. 운영자가 고칠 것이 없는데 고치려 든다.
 */
export function managedCandidates(rows: OrderRowLike[] | null | undefined): {
  positions: ManagedPosition[];
  deferred: DeferredRow[];
  skipped: CandidateSkip[];
} {
  const skip = new Map<string, CandidateSkip>();
  const note = (code: string, reason: string) => {
    const cur = skip.get(code);
    if (cur) cur.count += 1; else skip.set(code, { code, count: 1, reason });
  };

  const list = Array.isArray(rows) ? rows : [];
  // (연결 · 종목)마다 어느 전략들이 주장하는가
  const claims = new Map<string, Set<string>>();
  /**
   * 이 자리에 **관리할 수 없는 노출**이 있는가 (net position 보호).
   *
   * 자리마다 사유 코드를 모아 둔다 — 두 질문을 분리해서 답한다:
   *   "이 줄 자체는 왜 유예인가"   → `deferred[].code`
   *   "이 자리를 왜 못 건드리는가" → 여기 모인 코드들
   */
  const unmanagedSeats = new Map<string, Set<DeferralCode>>();
  const blockSeat = (key: string, code: DeferralCode) => {
    if (!unmanagedSeats.has(key)) unmanagedSeats.set(key, new Set());
    unmanagedSeats.get(key)!.add(code);
  };
  const deferred: DeferredRow[] = [];
  const keep: Array<{ row: OrderRowLike; pos: Omit<ManagedPosition, 'ownership' | 'management'> }> = [];

  for (const r of list) {
    // 청산 주문은 진입이 아니다.
    if (r?.reduce_only === true) { note('REDUCE_ONLY', '청산 주문은 진입이 아닙니다'); continue; }

    const status = String(r?.status || '').toUpperCase();
    if (!ENTERED.has(status)) {
      // **UNKNOWN을 진입으로도 미진입으로도 읽지 않는다.** 대조(reconcile)가
      // 상태를 확정한 뒤에 다시 후보가 된다.
      note('NOT_ENTERED', `체결이 확인된 주문만 봅니다 (지금 ${status || '상태 없음'})`);
      continue;
    }

    const connectionId = String(r?.connection_id || '').trim();
    if (!connectionId) {
      // **연결을 추측하지 않는다.**
      note('NO_CONNECTION', '어느 계좌인지 적혀 있지 않아 손대지 않습니다');
      continue;
    }
    const exchange = venueOf(r?.exchange);
    if (!exchange) {
      // **거래소를 추측하지 않는다.**
      note('NO_VENUE', '어느 거래소인지 알 수 없어 손대지 않습니다');
      continue;
    }
    const symbol = String(r?.symbol || '').trim().toUpperCase();
    const side = sideOf(r?.side);
    const entryPrice = num(r?.avg_price) ?? num(r?.price);
    const stopLoss = num(r?.stop_loss);
    // **진입 시각은 acked_at이다.** created_at은 보내기 전에 적는 INTENT
    // 시점이라 체결 시각이 아니다 — 시간청산의 기준으로 쓰면 안 된다.
    const openedAt = r?.acked_at ? Date.parse(String(r.acked_at)) : NaN;

    if (!symbol || !side || entryPrice == null || entryPrice <= 0) {
      note('INCOMPLETE', '종목·방향·체결가 중 빠진 것이 있어 판단하지 않습니다');
      continue;
    }

    // ══════════════════════════════════════════════════════════
    // ★ 자리 주장을 **먼저** 등록한다
    // ══════════════════════════════════════════════════════════
    //
    //   여기까지 왔으면 이 줄은 **실재하는 노출**이다 — 체결이 확인됐고
    //   연결·거래소·종목·방향·체결가가 전부 있다. 관리할 수 있느냐는
    //   아직 모르지만, 거래소의 net position에 이 줄의 몫이 들어 있다는
    //   것은 이미 정해졌다.
    //
    //   예전에는 손절 검사가 이보다 **앞**이었다. 그래서 손절이 없는 줄이
    //   자리에서도 사라졌고, 같은 자리의 다른 줄이 유일한 주장자가 되어
    //   `OWNED`로 승격했다. 관리 가능 여부가 소유권을 조용히 바꾼 것이다.
    //
    //   "이 자리를 누가 주장하나"가 "이 줄을 관리할 수 있나"보다 먼저다.
    const strategyId = strategyOf(r);
    const key = `${connectionId}|${symbol}`;
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key)!.add(strategyId ?? '(주인 모름)');

    // ── 손절 정책 × 손절 값 ──
    const policy = stopPolicyOf(r?.stop_policy);
    const hasStop = stopLoss != null && stopLoss > 0;
    const defer = (code: DeferralCode, reason: string) => {
      deferred.push({ code, connectionId, symbol, side, strategyId,
        orderId: r?.id ? String(r.id) : null, reason });
    };

    if (policy === 'NO_FIXED_SL') {
      // ★ **이 자리 전체를 유예한다.** 이 줄만 빼면 같은 net position의
      //   다른 줄이 그 노출까지 대신 건드린다.
      blockSeat(key, hasStop ? 'NO_FIXED_SL_STOP_CONFLICT' : 'NO_FIXED_SL_EXIT_UNWIRED');
      if (hasStop) {
        // 계약은 "고정 손절 없음"인데 장부에 값이 있다. 어느 쪽이 참인지
        // 알 수 없으므로 **일반 손절로 읽지 않는다** — 읽으면 그 값으로
        // 1R이 정의되고 트레일링·시간청산이 붙는다.
        defer('NO_FIXED_SL_STOP_CONFLICT',
          '고정 손절을 쓰지 않는 주문인데 장부에 손절 값이 적혀 있습니다'
          + ' — 계약과 장부가 어긋나 일반 생명주기에 넣지 않습니다');
      } else {
        defer('NO_FIXED_SL_EXIT_UNWIRED',
          '고정 손절을 쓰지 않는 주문입니다 — 전용 종료 권한이 아직 연결되지 않아'
          + ' 일반 생명주기로 관리하지 않습니다 (인식은 하고 있습니다)');
      }
      continue;
    }

    if (policy === 'UNKNOWN') {
      // **모르는 정책을 고정 손절로 읽지 않는다.** DB CHECK가 막더라도
      // 코드는 스스로 닫혀 있어야 한다.
      defer('STOP_POLICY_UNKNOWN',
        `손절 정책 이름을 모릅니다 (${String(r?.stop_policy).slice(0, 40)})`
        + ' — 추측하지 않고 관리하지 않습니다');
      continue;
    }

    if (policy === 'FIXED_SL' && !hasStop) {
      // 고정 손절을 쓰기로 해 놓고 값이 없다. 예전에는 `NO_STOP`으로
      // 뭉개져 "칸이 빈 줄"과 구별되지 않았다 — 그건 고쳐야 할 상태다.
      // ★ **이 자리도 막는다.** 고정 손절을 쓴다고 적혀 있는데 값이 없으면
      //   그 줄 역시 **관리 계약이 깨진 노출**이다. 이 줄만 버리고 같은
      //   자리의 멀쩡한 고정 손절 줄을 관리하면, net position에서 어느
      //   수량이 어느 줄 것인지 나눌 수 없어 깨진 노출까지 닫거나 손절을
      //   옮기게 된다. 막는 **이유**는 NO_FIXED_SL과 다르지만 결과는 같다.
      blockSeat(key, 'FIXED_SL_MISSING_STOP');
      defer('FIXED_SL_MISSING_STOP',
        '고정 손절을 쓰는 주문인데 손절 값이 없습니다 — 1R을 정의할 수 없어'
        + ' 관리하지 않습니다 (확인이 필요합니다)');
      continue;
    }

    if (!hasStop) {
      // 정책이 안 적힌 옛 줄 + 손절 없음. **기존 의미 그대로 둔다.**
      note('NO_STOP', '진입 손절이 없어 R을 정의할 수 없습니다');
      continue;
    }

    if (!Number.isFinite(openedAt)) {
      // **추측하지 않는다.** created_at으로 대체하면 시간청산이 앞당겨진다.
      note('NO_ENTRY_TIME', '체결 시각(acked_at)이 없어 보유 시간을 셀 수 없습니다');
      continue;
    }

    const ids = [r?.sl_order_id, r?.tp_order_id]
      .map(v => String(v ?? '').trim())
      .filter(v => v && v !== 'null' && v !== 'undefined');

    keep.push({ row: r, pos: {
      connectionId, exchange, symbol, strategyId, side,
      entryPrice, stopLoss: stopLoss as number, openedAt,
      ownedProtectionIds: ids,
      orderId: r?.id ? String(r.id) : null,
    } });
  }

  const positions: ManagedPosition[] = keep.map(({ pos }) => {
    const seat = `${pos.connectionId}|${pos.symbol}`;
    const claimants = Array.from(claims.get(seat) ?? []);
    let ownership: ManagedPosition['ownership'];
    if (claimants.length > 1) {
      // **거래소 선물은 net position이다.** 하나뿐인 포지션을 둘이
      // 자기 것이라 하면, 손절을 옮기는 순간 남의 것을 건드린다.
      ownership = { code: 'OWNERSHIP_AMBIGUOUS', claimants,
        reason: `같은 계좌·종목을 ${claimants.length}개 전략이 주장합니다 `
          + `(${claimants.join(' · ')}) — 어느 쪽 포지션인지 증명할 수 없어 주문을 내지 않습니다` };
    } else if (!pos.strategyId) {
      ownership = { code: 'OWNER_UNKNOWN', claimants,
        reason: '주문에 전략 표식이 없어 어느 전략의 포지션인지 알 수 없습니다' };
    } else {
      ownership = { code: 'OWNED', claimants, reason: '이 계좌·종목을 주장하는 전략이 하나뿐입니다' };
    }

    // ★ 자리에 **관리할 수 없는 노출**이 섞여 있으면, 주인이 분명해도
    //   막힌 **이유**를 사유에 적는다 — "왜 이 자리를 못 건드리나"는
    //   "왜 저 줄이 유예인가"와 다른 질문이고, 둘 다 답할 수 있어야 한다.
    //   일반 생명주기는 손대지 않는다. 거래소가 주는 것은 합쳐진 포지션
    //   하나뿐이라 어느 수량이 누구 몫인지 증명할 수 없다.
    const why = unmanagedSeats.get(seat);
    const management: ManagedPosition['management'] = why
      ? { code: 'UNMANAGED_SEAT_DEFERRED',
          reason: '같은 계좌·종목에 일반 생명주기가 관리할 수 없는 주문이 함께 있습니다'
            + ` (${Array.from(why).join(' · ')})`
            + ' — 거래소 포지션은 합쳐져 있어 이 줄만 따로 관리하면 그쪽 노출까지'
            + ' 건드리게 되므로 일반 생명주기를 유예합니다' }
      : { code: 'MANAGED', reason: '일반 생명주기가 관리합니다' };

    return { ...pos, ownership, management };
  });

  return { positions, deferred, skipped: Array.from(skip.values()) };
}

/**
 * 이 포지션에 주문을 내도 되는가.
 *
 * **두 관문을 모두 통과해야 한다** — 주인이 분명하고(`OWNED`), 자리가
 * 유예 상태가 아니어야 한다. 하나로 합치지 않는 이유는 위 `ManagementCode`
 * 주석에 적었다.
 *
 * 부르는 쪽이 하나뿐인 함수라, 여기에 조건을 더하면 모든 경로가 같이
 * 보호된다 — 라우트마다 따로 검사하면 언젠가 한쪽만 고쳐진다.
 */
export function mayActOn(
  p: Pick<ManagedPosition, 'ownership'> & Partial<Pick<ManagedPosition, 'management'>>,
): boolean {
  if (p?.ownership?.code !== 'OWNED') return false;
  // 관리 판정이 **없으면** 통과시키지 않는다 — 옛 모양의 객체가 흘러들어와
  // 유예를 우회하는 길을 열어 두지 않는다.
  return p?.management?.code === 'MANAGED';
}

/**
 * 같은 (연결 · 종목)에 두 번 주문하지 않게 하는 열쇠.
 *
 * 워커가 둘 떠 있거나 한 회차에 같은 자리를 두 줄이 가리켜도, 이 값으로
 * 한 번만 실행한다. **종목만으로 만들지 않는다** — 다른 계좌의 같은
 * 종목은 다른 포지션이다.
 */
export function mutationKeyOf(p: Pick<ManagedPosition, 'connectionId' | 'symbol' | 'side'>): string {
  return `${p.connectionId}|${p.symbol}|${p.side}`;
}
