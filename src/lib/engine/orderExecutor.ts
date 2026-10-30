// src/lib/engine/orderExecutor.ts
// 실주문 실행기 (테스트넷 우선).
//
// 실행 순서 — 이 순서를 지켜야 서버가 죽어도 복구할 수 있다:
//   1. 주문 의도를 DB에 먼저 기록 (INTENT)
//   2. 같은 clientOrderId가 거래소에 이미 있는지 확인
//   3. 레버리지 설정
//   4. 거래소로 주문 전송 (SENT)
//   5. 응답 저장 (ACKED / REJECTED / UNKNOWN)
//   6. 손절·익절 부착
//   7. 실제 포지션 조회로 대조
//
// 응답을 못 받으면 절대 그냥 재시도하지 않는다 → UNKNOWN으로 두고 대조 후 판단.
import type { PositionPlan } from './riskManager';
import type { ExitPlan } from './exitPlan';
import { applyTransition, type OrderState as LifecycleState } from './orderLifecycle';
import { fillBasis, exitFromFill, roundTrigger } from './fillBasedExit';
import { readbackProtective, type ProtectiveEvidence } from './protectiveReadback';
import { protectiveClientOrderId } from './orderOwnership';
import { ownedOrderIds, cancelLedger, rollbackNote, type CancelAttempt } from './protectionLedger';
import { futuresApplyLeverage, unknownResultVerdict } from '../exchanges/futuresExec';
import { executionIdentityComplete } from '../execution/profile';
import type { StopPolicy, TakeProfitPolicy } from '../strategies/profiles';
import { stopReattachVerdict } from './stopReattach';
import { fillFactsOf } from './orderFillFacts';
import { RECONCILE_QUERY_STATUSES } from './pendingReconcile';
import { quantizeOrder } from '../exchanges/quantize';
import {
  ledgerStatusOf, ledgerStatusOfBinance, ledgerStatusOfGate, withFillEvidence,
} from './reconcileLedgerStatus';


// ── 주문 상태 어휘를 **값으로** 둔다 ──
//
// 타입만 있으면 `.in('status', [...])`로 질의하는 쪽이 목록을 손으로 적고,
// 어휘가 늘어도 그 질의는 조용히 옛 목록을 쓴다. PR #313의 계좌 용량
// 관문이 `ACKED`를 빼먹은 것이 그 모양이었다 — 빠진 방향이 **통과**였다.
// 값으로 두면 시험이 드리프트를 잡을 수 있다.
export const ORDER_STATUSES = [
  'INTENT', 'SENT', 'ACKED', 'FILLED', 'REJECTED', 'FAILED', 'UNKNOWN', 'RECONCILED',
] as const;

/** 더 움직이지 않는 상태. 이 상태의 주문은 진입을 막지 않는다 */
export const TERMINAL_ORDER_STATUSES = [
  'FILLED', 'REJECTED', 'FAILED', 'RECONCILED',
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

export interface ExecuteArgs {
  userId?: string | null;
  connectionId?: string | null;
  signalId: string;
  clientOrderId: string;
  exchange: 'binance' | 'gate';
  mode: 'TESTNET' | 'LIVE';
  plan: PositionPlan;
  /**
   * 이 주문의 의도를 **다른 트랜잭션이 이미 커밋해 두었다.**
   *
   * 097의 `ten_slot_claim`은 슬롯 예약과 `live_orders` INTENT를 한
   * 트랜잭션으로 적는다. 그 뒤에 이 함수가 불리면 같은 `client_order_id`로
   * INSERT를 또 하게 되고, UNIQUE가 깨져 23505가 난다. 지금까지 그 자리는
   * **"이미 처리된 주문"으로 끝났다** — 즉 예약은 커밋됐는데 주문은 영원히
   * 나가지 않는다. 097을 붙이면 그게 기본 동작이 된다.
   *
   * 이 값이 `true`면 커밋된 그 줄을 **이어받아** 전송을 계속한다. 다만
   * 이어받는 조건은 `canAdoptIntent()` 한 곳에만 적는다 — 보낼 주문과
   * 적힌 의도가 다르면 **다른 주문의 의도로 전송하는 일**이 된다.
   *
   * **안 넘기면 지금까지와 똑같다.** 기존 호출부의 바이트는 바뀌지 않는다.
   */
  adoptIntent?: boolean;
  /**
   * 이 주문을 낸 것이 누구인가.
   *
   * 사람이 화면을 보며 누른 것과, 아무도 안 보는 새벽에 크론이 낸 것은
   * **같은 규칙으로 다루면 안 된다.** 아래 protectionPolicy가 이 값에
   * 따라 정해진다.
   */
  source?: 'MANUAL' | 'AUTOTRADE' | 'TRADINGVIEW' | 'CREATOR_SIGNAL';
  /**
   * 손절을 못 걸었을 때 어떻게 할 것인가.
   *
   *   REQUIRED — 방금 연 포지션을 **즉시 되돌린다.** 자동매매의 기본값이다.
   *              포지션 크기 자체가 손절 거리로 역산된 값이라(허용손실 ÷
   *              손절거리), 손절이 없으면 그 크기를 정당화하는 근거가
   *              사라진다. 그리고 아무도 안 보고 있다.
   *
   *   OPTIONAL — 포지션을 **유지한다.** 사람이 화면 앞에 있고, 손절 없이
   *              들고 가겠다는 것도 그 사람의 선택이다. 다만 손절을
   *              요청했는데 못 걸린 것은 **크게 알린다** — 보호되지 않은
   *              포지션이라는 사실을 모르고 넘어가면 안 된다.
   *
   *   NONE     — 손절을 아예 시도하지 않는다.
   *
   * **기본값은 REQUIRED다.** 안 넘긴 호출부는 지금까지와 똑같이 동작한다 —
   * 정책을 새로 만들면서 기존 경로가 조용히 느슨해지면 안 된다.
   */
  protectionPolicy?: 'REQUIRED' | 'OPTIONAL' | 'NONE';
  /**
   * 이 주문의 **고정 손절 정책.** 실행 프로필 계약에서 온다.
   *
   * `protectionPolicy`와 무엇이 다른가: 그쪽은 "손절을 못 걸었을 때
   * 어떻게 할 것인가"이고, 이쪽은 "애초에 고정 손절을 쓰는 전략인가"다.
   * 둘을 한 칸으로 합치면 `NONE`이 "이번엔 실패해도 봐준다"와 "이 전략은
   * 원래 안 건다" 두 뜻을 갖게 되고, 복구 경로가 그 둘을 구분할 수 없다.
   *
   * `NO_FIXED_SL`이면 여기서 세 가지가 함께 일어난다.
   *   · `protectionPolicy`를 `NONE`으로 **덮는다** (호출부가 뭘 넘겼든)
   *   · `stopLoss`가 함께 오면 **모순이므로 주문하지 않는다** — 조용히
   *     무시하면 화면에는 손절이 있는데 거래소에는 없다
   *   · 장부에 `stop_policy`를 적어 복구 경로가 이유를 알게 한다
   *
   * 안 넘기면 지금까지와 똑같다(= 고정 손절 전략).
   */
  stopPolicy?: StopPolicy;
  /**
   * 이 주문의 **고정 익절 정책.** 실행 프로필 계약에서 온다.
   *
   * **`stopPolicy`와 별개다.** 예전에는 `protectionPolicy: 'NONE'` 하나가
   * 손절과 익절을 함께 껐는데, 그 자리에서 두 거래소가 이미 갈려 있었다 —
   * 바이낸스 경로의 익절은 `policy`를 보지 않아서 그대로 나갔고, Gate는
   * 막혔다. 같은 계약이 거래소마다 다르게 실행된 것이다.
   *
   * 이제 손절은 `stopPolicy`가, 익절은 이 값이 정한다. 안 넘기면
   * `FIXED_TP`라 기존 호출부의 동작이 바뀌지 않는다.
   */
  takeProfitPolicy?: TakeProfitPolicy;
  /**
   * **어느 실행 계약으로 여는 주문인가.** 장부에 그대로 적는다.
   *
   * 왜 정책이 아니라 identity를 따로 받는가
   * ──────────────────────────────────────
   * `stopPolicy`·`takeProfitPolicy`는 **계약이 정한 행동**이고, 이 값은
   * **계약 자체의 이름**이다. 행동만 적어 두면 나중에 그 포지션을 보는
   * 코드가 "손절이 없고 배율이 100이니 Exact100X겠지"로 되돌아간다 —
   * 이 저장소가 반복해서 금지해 온 추론이다.
   *
   * 셋은 조합 키라 **함께** 온다. 하나만으로는 계약이 정해지지 않고
   * (`MAX_LEV_100X`는 `EXACT_100X`와만 짝이다), 반쪽만 적으면 나머지를
   * 추측하게 된다 — DB의 `_complete` 제약도 같은 규칙이다.
   *
   * 안 넘기면 세 칸 모두 적지 않는다(= 계약 없이 나가던 기존 경로).
   *
   * ★ **이 값으로 판단하지 않는다.** 여기서도, 읽는 쪽에서도. 적기만 한다.
   */
  executionIdentity?: {
    profileId: string;
    presetId: string;
    contractVersion: number;
  };
  /**
   * **진입 허가가 실제로 쓴 위험 좌표.** 적기만 한다 — 이 값으로
   * 진입을 막거나 종료를 바꾸지 않는다.
   *
   * ★ 반드시 **허가 판정의 결과에서** 와야 한다. 여기서 신호를 다시
   *   계산하거나 ATR을 새로 재면, 저장된 값이 "허가를 내린 값"이
   *   아니게 되어 이 칸의 존재 이유가 사라진다.
   *
   * 안 넘기면 두 칸 모두 적지 않는다(= 기존 경로 그대로).
   */
  entryRiskSnapshot?: {
    /** 허가 판정이 쓴 변동성 위험 거리(%). 못 구했으면 null */
    adverseDistancePct: number | null;
    /** 그 주문이 입장한 RAW 청산여유(%). **EFFECTIVE가 아니다** */
    liquidationDistancePctRaw: number | null;
  };
  stopLoss?: number;
  takeProfit?: number;
  /**
   * **실제 체결가에서 보호주문 가격을 다시 계산한다.**
   *
   * 주면 `stopLoss`/`takeProfit`(판단 참고가로 계산된 값) 대신, 체결이
   * 확정된 뒤의 평균 체결가에 이 %를 적용한 값을 건다. 시장가 100배는
   * 참고가에서 밀리고, 0.2% 밀리면 −0.4% 손절이 −0.2%가 된다 —
   * 청산 거리가 0.6%인 자리에서 그건 손절이 아니다.
   *
   * **안 주면 지금까지와 똑같이 동작한다.** 기존 호출부를 바꾸지 않는다.
   */
  exitPct?: {
    stopPct: number;
    takeProfitPct?: number | null;
    /** 익절이 없으면 진입을 완료로 보지 않는가 */
    requireTakeProfit?: boolean;
  };
  /**
   * 비대칭 청산 계획. 주면 단일 익절 대신 분할 익절 사다리를 건다.
   * 손절은 이 계획에 포함돼 있어도 stopLoss와 동일하게 전량 STOP_MARKET이다.
   */
  exitPlan?: ExitPlan;
  /**
   * 주문 유형. **기본 MARKET** — 기존 호출자(daily-ladder)의 동작을 바꾸지 않는다.
   *
   * 예전에는 여기서 'MARKET'을 하드코딩했다. 수동 주문을 이 경로로 옮기면서
   * 그대로 두면 사용자가 지정가로 넣은 주문이 **조용히 시장가로 나간다.**
   * 지정가를 쓰는 이유가 '그 가격에만 사겠다'는 것이므로, 그건 주문을
   * 무시하는 것과 같다.
   */
  orderType?: 'MARKET' | 'LIMIT';
  /** LIMIT일 때 필수. 없으면 전송 전에 거부한다 */
  limitPrice?: number;
  /**
   * 청산 주문인가.
   *
   * true면 손절·익절을 **붙이지 않는다.** 나가는 주문에 보호주문을 걸면
   * 포지션이 없어진 뒤에 남아서, 다음 진입을 예상치 못하게 닫는다.
   */
  reduceOnly?: boolean;
  apiKey: string;
  apiSecret: string;
}

export interface ExecuteResult {
  ok: boolean;
  status: OrderStatus;
  clientOrderId: string;
  /**
   * **손절이 실제로 걸렸는가.**
   *
   * `slOrderId`가 있으면 걸린 것이고, 요청했는데 없으면 보호되지 않은
   * 포지션이다. 화면이 그 둘을 구분해 그릴 수 있어야 한다 — 지금까지는
   * 메시지 문자열을 읽어야만 알 수 있었다.
   */
  unprotected?: boolean;
  /**
   * 청산 뒤 **거래소에 남아 있는 수량.** 0이면 실제로 닫힌 것이 확인됐다.
   *
   * **못 읽었으면 null이다** — 0으로 적으면 '전부 닫혔다'가 사실이 되고,
   * 사용자는 확인하지 않는다. 진입에는 채우지 않는다.
   */
  remainingQty?: number | null;
  /**
   * **체결 결과가 확정됐는가.**
   *
   * false면 "아직 모른다"이지 "안 됐다"가 아니다. 화면은 이 값이
   * false인 동안 **같은 방향 재주문을 잠가야 한다** — 사용자가 "안
   * 됐네" 하고 한 번 더 누르는 사이에 앞 주문이 붙으면 포지션이 두
   * 배가 되고, 그건 사용자가 의도한 크기가 아니다.
   */
  settled?: boolean;
  exchangeOrderId?: string;
  filledQty?: number;
  avgPrice?: number;
  slOrderId?: string;
  tpOrderId?: string;
  /**
   * **거래소에서 다시 읽어 확인한** 보호주문.
   *
   * 생성 응답(`slOrderId`)은 접수를 뜻하고, 이 값은 사실을 뜻한다.
   * 진입 완료 판정(`enteredVerdict`)은 이쪽만 본다.
   */
  protection?: {
    readOk: boolean;
    stop: ProtectiveEvidence;
    takeProfit: ProtectiveEvidence;
    reason: string;
  } | null;
  /** 실제 체결가 기준으로 다시 계산한 보호주문 가격 */
  exitBasis?: {
    basisPrice: number | null; slippagePct: number | null;
    stop: number | null; takeProfit: number | null; note: string;
  } | null;
  /** 요청 배율이 거래소에서 확인됐는가. null은 모름 */
  leverageConfirmed?: boolean | null;
  /** 포지션 모드를 읽었는가. null은 모름 */
  positionModeConfirmed?: boolean | null;
  message: string;
  duplicate?: boolean;
}

// ── 018 마이그레이션 이전 스키마와의 호환 ──
//
// 복구용 컬럼(pos_qty_before 등)은 018에서 추가된다. 아직 적용되지
// 않은 DB에 그대로 쓰면 update 전체가 실패해 상태 기록까지 날아간다.
// 주문을 보냈는데 DB가 INTENT로 남는 것이 가장 나쁜 결과이므로,
// 실패하면 새 컬럼만 빼고 다시 쓴다. 마이그레이션이 적용되면 이 경로는 안 돌아간다.
const RECOVERY_COLS = ['pos_qty_before', 'resolve_attempts', 'last_resolve_at', 'needs_attention'];

async function updateOrderRow(
  sb: any, id: string, patch: Record<string, any>,
): Promise<{ ok: boolean; reason: string | null }> {
  const write = async (p: Record<string, any>) => {
    try {
      const res: any = await sb.from('live_orders').update(p).eq('id', id).select('id');
      if (res?.error) {
        return { ok: false, reason: String(res.error.message || res.error.code || 'DB 오류'),
          code: String(res.error.code ?? ''), detail: String(res.error.message ?? '') };
      }
      // null/undefined는 성공 증거가 아니다. 정확히 대상 id 한 줄만 인정.
      const rows = res?.data;
      if (!Array.isArray(rows) || rows.length !== 1 || String(rows[0]?.id) !== String(id)) {
        return { ok: false, reason: '갱신된 대상 행을 정확히 1개 확인하지 못했습니다',
          code: '', detail: '' };
      }
      return { ok: true, reason: null, code: '', detail: '' };
    } catch (e: any) {
      return { ok: false, reason: String(e?.message || e), code: '', detail: '' };
    }
  };

  const first = await write(patch);
  if (first.ok) return first;

  // 복구 전용 칸 누락이 실제로 확인된 경우에만 후퇴한다.
  // XX000/timeout/RLS 오류나 다른 칼럼 누락은 재시도로 가리지 않는다.
  const missingRecoveryColumn = (first.code === '42703' || first.code === 'PGRST204')
    && RECOVERY_COLS.some((col) => first.detail.toLowerCase().includes(col));
  if (!missingRecoveryColumn) return first;
  const legacy: Record<string, any> = {};
  let stripped = false;
  for (const [k, v] of Object.entries(patch)) {
    if (RECOVERY_COLS.includes(k)) { stripped = true; continue; }
    legacy[k] = v;
  }
  if (!stripped || Object.keys(legacy).length === 0) return first;

  const second = await write(legacy);
  if (second.ok) return { ok: true, reason: null };
  return { ok: false, reason: `${first.reason} · 복구 칸 제외 재시도: ${second.reason}` };
}

/**
 * 거래소 POST의 단일 소유권 관문.
 *
 * 읽은 INTENT가 여전히 INTENT일 때에만 SENT로 바꾸고, 실제로 변경된
 * 행 ID를 되읽어 확인한다. 오류·0행·응답 불명은 모두 전송 금지다.
 * 신규 INSERT와 097 예약 의도 adoption 모두 반드시 이 관문을 통과한다.
 *
 * SENT 선점 후 POST 전에 프로세스가 종료되면 주문이 전송되지 않았을 수도
 * 있다. 자동 재전송하지 않고 대조/사람 확인을 기다리는 보수적 선택이다.
 * 복구 컬럼(018)은 선점의 필수 조건에 포함하지 않는다.
 */
async function claimOrderDispatch(
  sb: any, id: string, patch: Record<string, any>,
): Promise<boolean> {
  try {
    const { data, error } = await sb.from('live_orders')
      .update({ ...patch, status: 'SENT' })
      .eq('id', id)
      .eq('status', 'INTENT')
      .select('id')
      .maybeSingle();
    return !error && data?.id === id;
  } catch {
    return false;
  }
}

// 수량 정밀도 보정 — 거래소는 정해진 소수점만 받는다
export function roundQuantity(qty: number, stepSize: number): number {
  if (!stepSize || stepSize <= 0) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  return Number((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}

/**
 * **청산이 실제로 됐는지 거래소에 다시 물어본다.**
 *
 * 주문이 접수됐다는 것과 포지션이 없어졌다는 것은 다른 얘기다. 부분
 * 체결로 끝나거나, 리스크 엔진이 접수 직후 취소하거나, reduceOnly가
 * 조용히 무시될 수 있다.
 *
 * 그런데 화면에는 "주문 접수"만 떴다. **닫았다고 믿고 손을 떼는 것**이
 * 이 앱에서 가장 위험한 착각이다 — 열려 있는 줄 알면 다시 누르지만,
 * 닫힌 줄 알면 아무것도 안 한다.
 *
 * 진입 쪽 되돌리기는 이미 되읽어 확인한다(7-b). 사용자가 직접 누르는
 * 청산만 안 하고 있었다.
 *
 * 못 읽으면 null이다 — 0으로 적으면 '전부 닫혔다'가 사실이 된다.
 */
async function remainingAfterClose(
  creds: { exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean },
  symbol: string,
): Promise<{ remaining: number | null; note: string }> {
  const r = await readRemaining(creds, symbol);
  // ── 전량이 닫혔으면 **남은 보호 주문을 지운다** ──
  //
  // 손절은 포지션을 닫는 주문이다. 포지션이 없어진 뒤에도 남아 있으면
  // 트리거에 닿는 순간 **반대 방향으로 새 포지션이 열린다.** 닫으려고
  // 누른 버튼이 결과적으로 포지션을 여는 것이다.
  //
  // **전량 확인된 경우에만.** 부분 청산 뒤에 지우면 남은 포지션이 보호
  // 없이 남는다 — 닫으려다 더 위험해진다.
  if (r.remaining === 0) {
    const { futuresCancelProtection } = await import('@/lib/exchanges/futuresAdapter');
    const c = await futuresCancelProtection(
      creds.exchange, creds.apiKey, creds.apiSecret, creds.testnet, symbol);
    return { remaining: 0, note: r.note + c.note };
  }
  return r;
}

/** 거래소에 남아 있는 수량만 읽는다 (정리는 위에서 한다) */
async function readRemaining(
  creds: { exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean },
  symbol: string,
): Promise<{ remaining: number | null; note: string }> {
  try {
    if (creds.exchange === 'gate') {
      const gf = await import('@/lib/exchanges/gateFutures');
      const gp = await import('@/lib/exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return { remaining: null, note: '' };
      const pos = await gf.getPositionGateFutures(creds.apiKey, creds.apiSecret, contract, creds.testnet);
      const size = Math.abs(Number(pos?.size ?? 0));
      const spec = await gf.getGateContractSpec(contract, creds.testnet);
      const base = gp.gateBaseFromContracts(size, spec);
      const left = base != null ? base : size;
      return {
        remaining: left,
        note: left === 0 ? ' · 포지션 종료 확인'
          : ` · ⚠ 아직 ${left} 남아 있습니다 — 다시 확인하세요`,
      };
    }
    const bf = await import('@/lib/exchanges/binanceFutures');
    const rr = await bf.getSymbolPositionRiskEx(creds.apiKey, creds.apiSecret, symbol, creds.testnet);
    if (!rr.risk) {
      // 조회 자체가 실패했다. **'닫혔다'고 말하지 않는다.**
      return { remaining: null, note: ` · ⚠ 종료를 확인하지 못했습니다 (${rr.error || '조회 실패'})` };
    }
    const left = Math.abs(Number(rr.risk.positionAmt) || 0);
    return {
      remaining: left,
      note: left === 0 ? ' · 포지션 종료 확인'
        : ` · ⚠ 아직 ${left} 남아 있습니다 — 다시 확인하세요`,
    };
  } catch (e: any) {
    return { remaining: null, note: ` · ⚠ 종료를 확인하지 못했습니다 (${e?.message || e})` };
  }
}

/**
 * 커밋된 의도를 이어받아도 되는가.
 *
 * **판단을 한 곳에 둔다.** 이 결정이 틀리면 "A 주문의 의도로 B 주문을
 * 전송"하거나 "이미 나간 주문을 또 보내는" 일이 된다.
 *
 * 거절하는 쪽으로 기울여 둔다:
 *   · 줄을 못 읽었으면 거절한다 (UNKNOWN을 통과로 적지 않는다)
 *   · `INTENT`가 아니면 거절한다 — 전송이 이미 있었을 수 있다
 *   · 거래소 주문 번호·전송 시각·시도 횟수가 남아 있으면 거절한다
 *   · 보낼 주문과 한 칸이라도 다르면 거절한다
 */
export function canAdoptIntent(
  prev: any,
  intent: Record<string, any>,
  expectedLimitPrice?: number | null,
): { ok: boolean; reason: string } {
  if (!prev || typeof prev !== 'object') {
    return { ok: false, reason: '커밋된 의도를 읽지 못했습니다' };
  }
  if (prev.status !== 'INTENT') {
    return { ok: false, reason: `장부 상태가 ${prev.status || '알 수 없음'}입니다 — 전송이 이미 있었을 수 있습니다` };
  }
  if (typeof prev.id !== 'string' || prev.id.length === 0) {
    return { ok: false, reason: '커밋된 의도의 DB 행 ID를 확인하지 못했습니다' };
  }
  if (prev.exchange_order_id != null || prev.sent_at != null
      || Number(prev.attempt_count ?? 0) !== 0) {
    return { ok: false, reason: '전송 흔적이 남아 있습니다 — 다시 보내지 않습니다' };
  }
  // 예약된 INTENT는 service_role로 읽힌다. client_order_id만으로 소유자를
  // 증명할 수 없으므로 인증된 호출자가 넘긴 정체성과 저장된 정체성을
  // 모두 요구한다. 어느 쪽이 비었어도 다른 주문을 이어받지 않는다.
  for (const col of ['user_id', 'connection_id', 'signal_id']) {
    if (typeof prev[col] !== 'string' || !prev[col].trim()
        || typeof intent[col] !== 'string' || !intent[col].trim()
        || prev[col] !== intent[col]) {
      return { ok: false, reason: `커밋된 의도의 ${col} 정체성을 확인하지 못했습니다` };
    }
  }
  for (const col of ['client_order_id', 'exchange', 'mode', 'symbol', 'side', 'order_type']) {
    if (String(prev[col]) !== String(intent[col])) {
      return { ok: false, reason: `적힌 의도의 ${col}가 보낼 주문과 다릅니다` };
    }
  }
  if (Boolean(prev.reduce_only) !== Boolean(intent.reduce_only)) {
    return { ok: false, reason: '적힌 의도의 청산 여부가 보낼 주문과 다릅니다' };
  }
  if (Number(prev.quantity) !== Number(intent.quantity)) {
    return { ok: false, reason: '적힌 의도의 수량이 보낼 주문과 다릅니다' };
  }
  // SQL 097은 price를 따로 저장한다. LIMIT의 가격을 대조하지 않으면
  // 같은 주문 ID/수량으로 다른 지정가를 보내는 것이 가능하다.
  // NULL과 0을 같은 값으로 취급하지 않는다.
  const sameOptionalNumber = (a: unknown, b: unknown): boolean => {
    if (a == null || b == null) return a == null && b == null;
    const x = Number(a), y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
  };
  if (intent.order_type === 'LIMIT'
      && (expectedLimitPrice == null || !Number.isFinite(Number(expectedLimitPrice)))) {
    return { ok: false, reason: '지정가 주문의 가격을 확인하지 못했습니다' };
  }
  for (const [col, expected] of [
    ['price', expectedLimitPrice ?? null],
    ['stop_loss', intent.stop_loss ?? null],
    ['take_profit', intent.take_profit ?? null],
    // 091 위험 좌표는 각각 NULL일 수 있다. 존재하는 값은 저장 INTENT와 정확히 같아야 한다.
    ['entry_adverse_distance_pct', intent.entry_adverse_distance_pct ?? null],
    ['entry_liquidation_distance_pct_raw', intent.entry_liquidation_distance_pct_raw ?? null],
  ] as const) {
    if (!sameOptionalNumber(prev[col], expected)) {
      return { ok: false, reason: `커밋된 의도의 ${col}가 보낼 주문과 다릅니다` };
    }
  }
  // NO_FIXED_SL/실행 계약은 주문 후 복구의 정체성이다. SQL이 해당 칸을
  // 아직 저장하지 않는다면 이어받기를 거절하고, 조용히 누락하지 않는다.
  for (const col of [
    'stop_policy', 'execution_profile_id', 'execution_preset_id',
    'execution_contract_version',
  ]) {
    if (String(prev[col] ?? '') !== String(intent[col] ?? '')) {
      return { ok: false, reason: `커밋된 의도의 ${col}가 보낼 계약과 다릅니다` };
    }
  }
  // 진입 주문의 예약 배율은 필수다. SQL 097도 진입의 NULL 배율을
  // 거절한다. 한쪽이 비었는데도 다른 칸만 같다는 이유로 이어받으면
  // 예약된 위험 계약을 확인하지 않고 거래소로 전송할 수 있다.
  // 청산(reduce_only)은 배율이 없을 수 있으므로 기존 허용을 유지한다.
  if (!intent.reduce_only && (intent.leverage == null || prev.leverage == null)) {
    return { ok: false, reason: '진입 주문의 예약 배율을 확인하지 못했습니다' };
  }
  if (intent.leverage != null && prev.leverage != null
      && Number(prev.leverage) !== Number(intent.leverage)) {
    return { ok: false, reason: '적힌 의도의 배율이 보낼 주문과 다릅니다' };
  }
  return { ok: true, reason: '커밋된 의도를 이어받습니다' };
}

export async function executeOrder(sb: any, args: ExecuteArgs): Promise<ExecuteResult> {
  const { clientOrderId, plan, exchange, mode, apiKey, apiSecret } = args;
  const testnet = mode !== 'LIVE';
  // 안 넘기면 REQUIRED — 기존 호출부의 동작이 바뀌지 않는다.
  //
  // **고정 손절을 쓰지 않는 프로필은 여기서 NONE으로 덮는다.** 호출부가
  // 실수로 REQUIRED를 넘겨도 마찬가지다 — 계약이 호출부보다 세다.
  const noFixedSl = args.stopPolicy === 'NO_FIXED_SL';

  // ── 실행 계약 identity — 적을 것인가, 적는다면 온전한가 ──
  //
  //   **반쪽은 받지 않는다.** 셋 중 일부만 오면 **호출부가 계약을 잘못
  //   조립한 것**이다. 그건 이 함수가 고쳐 줄 일이 아니라 거절할 일이다.
  //
  //   DB의 `_complete` 제약이 어차피 막지 않느냐고 할 수 있다. 막는다 —
  //   그리고 그 실패는 거래소 전송보다 먼저 난다(INTENT insert가 앞이다).
  //   그래도 여기서 따로 막는 이유는 **DB 제약은 마지막 방어선이지
  //   응용 검증의 대체물이 아니기 때문**이다:
  //
  //     · 제약이 없는 배포(090 미적용)에서는 반쪽이 그대로 저장된다
  //     · 제약 위반은 PostgREST 오류 문자열로 와서 호출부의 실수를
  //       "DB 오류"처럼 보이게 한다 — 무엇을 고쳐야 하는지 가린다
  //
  //   그래서 경계에서 명시적으로 fail-closed한다.
  // 온전한지는 **계약 정본이 판단한다.** 여기서 다시 세면 적는 쪽과
  // 읽는 쪽의 기준이 갈린다. (정적 import — 순수 함수 하나에 동적 로딩을
  // 쓸 이유가 없고, 별칭 동적 import는 시험 하네스에서 풀리지 않는다.)
  const ident = args.executionIdentity;
  const identOk = executionIdentityComplete(ident);
  // 진입 허가가 준 위험 좌표. **여기서 만들지 않는다 — 받기만 한다.**
  const riskSnap = args.entryRiskSnapshot;
  const policy = noFixedSl ? 'NONE' : (args.protectionPolicy ?? 'REQUIRED');
  // **익절은 따로 판단한다.** `policy === 'NONE'`으로 익절까지 끄면
  // 손절 정책 하나가 두 가지를 뜻하게 되고, 그때 바이낸스와 Gate가
  // 갈린다(바이낸스 익절은 policy를 보지 않았다). 축을 나눠서 두 거래소가
  // 같은 계약을 같게 실행하도록 한다.
  const noFixedTp = args.takeProfitPolicy === 'NO_FIXED_TP';
  const orderType = args.orderType ?? 'MARKET';
  // 청산이면 방향이 뒤집힌다. plan.side는 '무슨 포지션을 다루는가'이고
  // reduceOnly는 그것을 줄이는 주문이므로 반대 방향으로 보내야 한다.
  // 이걸 틀리면 청산 대신 **두 배로 늘린다.**
  const posSide: 'BUY' | 'SELL' = plan.side === 'LONG' ? 'BUY' : 'SELL';
  const side: 'BUY' | 'SELL' = args.reduceOnly
    ? (posSide === 'BUY' ? 'SELL' : 'BUY')
    : posSide;

  // ── 0) 사전 안전 검사 — 잘못된 값이 거래소로 나가지 않게 ──
  if (!plan.approved) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: '승인되지 않은 계획은 주문할 수 없습니다' };
  }
  // **모순은 조용히 정리하지 않는다.**
  //
  // 고정 손절을 쓰지 않는 프로필인데 손절가가 함께 왔다면, 둘 중 하나는
  // 틀린 것이고 어느 쪽인지 여기서는 알 수 없다. 손절을 버리고 진행하면
  // 화면에는 손절이 있는데 거래소에는 없고, 손절을 살리면 계약이 깨진다.
  // 어느 쪽도 조용히 고르면 안 된다.
  if (noFixedSl && args.stopLoss != null) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: '고정 손절을 쓰지 않는 프로필인데 손절가가 함께 넘어왔습니다'
        + ` (${args.stopLoss}) — 어느 쪽이 맞는지 알 수 없어 주문하지 않습니다.` };
  }
  // 익절도 같은 규칙이다. 조용히 버리면 화면에는 익절이 있고 거래소에는 없다.
  if (noFixedTp && args.takeProfit != null) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: '고정 익절을 쓰지 않는 프로필인데 익절가가 함께 넘어왔습니다'
        + ` (${args.takeProfit}) — 어느 쪽이 맞는지 알 수 없어 주문하지 않습니다.` };
  }
  // ── 분할 익절 사다리도 익절이다 ──
  //
  //   이 관문은 `args.takeProfit`(단일 익절)만 봤다. 그래서 `exitPlan`에
  //   `PARTIAL_TP`가 담겨 오면 여기를 통과하고, 전송 뒤 보호주문 단계의
  //   `else if (noFixedTp)` 한 줄에만 막혔다. 그 한 줄을 지우면 **고정
  //   익절 사다리가 거래소로 나간다** — 변이 검증에서 그 변이가 탈출했고,
  //   탈출한 이유가 "단일 익절만 넘기는 시험"이었다.
  //
  //   경계에서 막는 쪽이 낫다. 여기서 멈추면 계좌에 아무 일도 일어나지
  //   않는다(거래소 호출 0건). 뒤에서 막으면 진입은 이미 나가 있다.
  const planTpCount = (args.exitPlan?.orders ?? [])
    .filter((o: any) => o?.kind === 'PARTIAL_TP').length;
  if (noFixedTp && planTpCount > 0) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: '고정 익절을 쓰지 않는 프로필인데 분할 익절 사다리가 함께 넘어왔습니다'
        + ` (${planTpCount}단) — 어느 쪽이 맞는지 알 수 없어 주문하지 않습니다.` };
  }
  // 실행 계약 식별자도 같은 규칙이다. **반쪽은 받지 않는다.**
  //
  //   호출부가 계약을 잘못 조립한 것이므로 **경계에서 거절한다.** 거래소
  //   쓰기(배율 설정·주문 전송)는 전부 이 뒤에 있으므로, 여기서 멈추면
  //   계좌에 아무 일도 일어나지 않는다 — 시험이 호출 횟수 0으로 확인한다.
  //
  //   DB 제약에 기대지 않는 이유는 위 주석에 적었다.
  if (ident && !identOk) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: '실행 계약 식별자가 반쪽입니다 — 프로필·프리셋·버전은 함께 와야 합니다'
        + ` (프로필 ${ident.profileId || '없음'} · 프리셋 ${ident.presetId || '없음'}`
        + ` · 버전 ${ident.contractVersion ?? '없음'}). 나머지를 추측하지 않고 주문하지 않습니다.` };
  }
  if (!isFinite(plan.quantity) || plan.quantity <= 0) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: `주문 수량이 유효하지 않습니다 (${plan.quantity})` };
  }
  // 배율은 진입에만 필요하다. 청산에서 이 검사를 걸면, 거래소에서 배율을
  // 못 읽었다는 이유로 **포지션을 못 닫게 된다.** (아래 3~4단계도 같은 이유로
  // 진입에만 실행한다)
  if (!args.reduceOnly && (!isFinite(plan.leverage) || plan.leverage < 1)) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: `레버리지를 확인하지 못했습니다 (${plan.leverage}) — 주문 화면에서 배율을 직접 골라 주세요` };
  }
  if (!clientOrderId || clientOrderId.length < 4) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: 'clientOrderId가 없으면 중복 주문을 막을 수 없어 중단합니다' };
  }
  // 지정가인데 가격이 없으면 보내지 않는다. 여기서 시장가로 바꿔 보내면
  // 사용자가 지정한 가격이 무시된 채 체결된다 — 지정가를 쓴 이유가 사라진다.
  if (orderType === 'LIMIT' && (args.limitPrice == null || !isFinite(args.limitPrice) || args.limitPrice <= 0)) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: `지정가 주문에 가격이 없습니다 (${args.limitPrice}). 시장가로 바꿔 보내지 않습니다` };
  }
  // 손절 방향 재확인 (Risk Manager를 통과했더라도 마지막으로 한 번 더)
  if (args.stopLoss != null && plan.liquidationPrice > 0) {
    const badLong = plan.side === 'LONG' && args.stopLoss <= plan.liquidationPrice;
    const badShort = plan.side === 'SHORT' && args.stopLoss >= plan.liquidationPrice;
    if (badLong || badShort) {
      return { ok: false, status: 'REJECTED', clientOrderId,
        message: `손절가(${args.stopLoss})가 청산가(${plan.liquidationPrice.toFixed(2)}) 너머입니다 — 주문 중단` };
    }
  }

  // ── 1) 의도를 먼저 기록 ──
  //    UNIQUE 제약이 같은 clientOrderId 재실행을 원천 차단한다.
  const intent = {
    client_order_id: clientOrderId,
    signal_id: args.signalId,
    user_id: args.userId || null,
    connection_id: args.connectionId || null,
    exchange, mode,
    symbol: plan.symbol,
    side,
    // 하드코딩이었다. 지정가 주문을 'MARKET'으로 적으면 나중에 내역을 볼 때
    // 왜 그 가격에 체결됐는지 설명이 안 된다.
    order_type: orderType,
    // 청산 주문임을 반드시 기록한다.
    //
    // 안 적으면 상태 대조(reconcileCheck)가 이 행을 **반대 방향 진입**으로
    // 읽는다. 롱을 닫은 SELL 기록이 숏 포지션으로 잡히고, 거래소에는 그런
    // 포지션이 없으니 심각 불일치가 되어 이후 주문이 전부 막힌다.
    //
    // daily-ladder는 진입만 하므로 이 필드가 없어도 드러나지 않았다.
    // 수동 청산이 이 경로를 타면서 실제 문제가 된다.
    reduce_only: !!args.reduceOnly,
    quantity: plan.quantity,
    leverage: plan.leverage,
    stop_loss: args.stopLoss ?? null,
    take_profit: args.takeProfit ?? null,
    status: 'INTENT' as OrderStatus,
    // **NO_FIXED_SL일 때만 칸을 붙인다.**
    //
    // 항상 붙이면 078이 아직인 DB에서 **모든 주문이 실패한다.** 기존
    // 경로의 바이트를 바꾸지 않으려면 붙이지 않는 쪽이 맞다.
    //
    // 반대로 NO_FIXED_SL에서는 붙이지 못하면 실패하는 것이 **맞다** —
    // 그 칸이 없는 DB에서는 복구 경로가 이 주문을 고정 손절 주문으로
    // 읽게 되고, 그건 100배 포지션에 손절을 새로 거는 일이다.
    // 여기서 칸을 떼고 저장하는 후퇴는 만들지 않는다.
    ...(noFixedSl ? { stop_policy: 'NO_FIXED_SL' } : {}),
    // **계약이 있을 때만 붙인다.** `stop_policy`와 같은 이유다 — 항상
    // 붙이면 090가 아직인 DB에서 모든 주문이 실패한다. 계약 없이 나가던
    // 기존 경로의 바이트는 그대로 둔다.
    //
    // 반대로 계약이 있는데 못 붙이면 실패하는 것이 **맞다** — 그 칸이 없는
    // DB에서는 이 포지션이 나중에 "어느 계약의 것인지 모르는 주문"이 되고,
    // 그러면 다시 배율·손절 조합으로 추론하는 자리로 되돌아간다.
    ...(ident ? {
      execution_profile_id: ident.profileId,
      execution_preset_id: ident.presetId,
      execution_contract_version: ident.contractVersion,
    } : {}),
    // ── 진입 허가가 쓴 위험 좌표 (091) ──
    //
    // **값이 있을 때만 붙인다.** `stop_policy`·계약 세 칸과 같은 이유다 —
    // 항상 붙이면 091이 아직인 DB에서 모든 주문이 실패한다.
    //
    // 둘을 따로 붙인다. 한쪽만 구해졌을 때 저장을 통째로 실패시키면
    // **구한 값까지 버린다**(091이 CHECK 제약을 걸지 않은 것과 같은 이유).
    //
    // ★ 여기서 계산하지 않는다. 받은 값을 그대로 적는다.
    ...(riskSnap?.adverseDistancePct != null
      ? { entry_adverse_distance_pct: riskSnap.adverseDistancePct } : {}),
    ...(riskSnap?.liquidationDistancePctRaw != null
      ? { entry_liquidation_distance_pct_raw: riskSnap.liquidationDistancePctRaw } : {}),
  };

  // 097이 이미 커밋한 INTENT를 이어받을 때는 새 INTENT를 만들지 않는다.
  // 이전에는 먼저 INSERT하고 23505가 나야만 예약 의도를 읽었다.
  // 예약이 없거나 UNIQUE 제약이 없는 DB에서는 adoptIntent:true가 오히려
  // 새 INTENT를 만들어 거래소에 전송하는 fail-open 경로가 됐다.
  let row: any = null;
  let adopted: any = null;
  if (args.adoptIntent === true) {
    const { data: prev, error: readErr } = await sb.from('live_orders')
      .select('*').eq('client_order_id', clientOrderId).maybeSingle();
    const adopt = readErr
      ? { ok: false, reason: '커밋된 의도의 DB 조회가 실패했습니다' }
      : canAdoptIntent(prev, intent, args.limitPrice);
    if (!adopt.ok) {
      // 다른 사용자의 과거 체결·거래소 ID도 노출하지 않는다.
      return {
        ok: false, status: 'UNKNOWN', clientOrderId, duplicate: true,
        message: `커밋된 주문 의도를 안전하게 이어받지 못했습니다 (${adopt.reason})`,
      };
    }
    adopted = prev;
  } else {
    // 레거시 비-adoption 경로의 INSERT 및 중복 응답 의미는 유지한다.
    const { data: inserted, error: insErr } = await sb.from('live_orders')
      .insert(intent).select('id, status').single();
    if (insErr) {
      if (String(insErr.code) === '23505') {
        const { data: prev } = await sb.from('live_orders')
          .select('*').eq('client_order_id', clientOrderId).maybeSingle();
        return {
          ok: prev?.status === 'ACKED' || prev?.status === 'FILLED',
          status: (prev?.status as OrderStatus) || 'UNKNOWN',
          clientOrderId,
          exchangeOrderId: prev?.exchange_order_id,
          filledQty: prev?.filled_qty != null ? Number(prev.filled_qty) : undefined,
          avgPrice: prev?.avg_price != null ? Number(prev.avg_price) : undefined,
          duplicate: true,
          message: '이미 처리된 주문입니다 (중복 요청)',
        };
      }
      return { ok: false, status: 'FAILED', clientOrderId, message: `의도 기록 실패: ${insErr.message}` };
    }
    row = inserted;
  }

  const orderRowId = adopted ? adopted.id : row.id;

  // ── 상태 전이 검증 ──
  // 예전에는 update()가 어떤 status든 그대로 덮어썼다. 그러면 이미 FAILED로
  // 확정된 주문이 뒤늦게 도착한 응답 때문에 ACKED로 바뀌는 식의 뒤집힘이
  // 가능하다. orderLifecycle의 상태 기계를 통과한 전이만 기록한다.
  //
  // DB는 예전부터 'INTENT'를 쓰고 상태 기계는 'APPROVED'를 쓴다. 컬럼을
  // 바꾸려면 마이그레이션과 기존 행 변환이 필요하므로, 여기서 매핑만 한다.
  const toLifecycle = (s: string): LifecycleState =>
    (s === 'INTENT' ? 'APPROVED' : s === 'RECONCILED' ? 'ACKED' : s) as LifecycleState;

  let currentStatus: OrderStatus = 'INTENT';

  /**
   * 장부에 **적히지 않은** 기록들. 전송 뒤의 실패는 주문을 되돌리지
   * 못하므로 막는 대신 **크게 남긴다** — 조용히 지나가면 화면의 상태와
   * 거래소의 상태가 갈린 채로 아무도 모른다.
   */
  const persistWarn: string[] = [];

  const update = async (patch: Record<string, any>): Promise<{ ok: boolean; reason: string | null }> => {
    const next = patch.status as OrderStatus | undefined;
    let advance: OrderStatus | null = null;
    if (next && next !== currentStatus) {
      const t = applyTransition(toLifecycle(currentStatus), toLifecycle(next));
      if (!t.ok) {
        // 상태만 빼고 나머지는 기록한다. 잘못된 전이는 어딘가의 논리 오류이므로
        // 조용히 넘기지 않고 사유를 남긴다.
        try {
          const { log } = await import('@/lib/log/logger');
          log.warn('order-executor', `${clientOrderId}: ${t.reason}`);
        } catch { /* 로거 실패가 주문을 막지 않는다 */ }
        const { status: _drop, ...rest } = patch;
        if (Object.keys(rest).length === 0) return { ok: true, reason: null };
        patch = rest;
      } else {
        advance = next;
      }
    }
    const w = await updateOrderRow(sb, orderRowId, { ...patch, updated_at: new Date().toISOString() });
    // **쓰기를 확인한 뒤에만 메모리 상태를 전진시킨다.**
    //
    // 예전에는 DB보다 먼저 전진했다. 그러면 DB는 INTENT인데 메모리는
    // SENT가 되고, 다음 전이 판정이 **장부에 없는 상태**를 기준으로
    // 내려진다. 두 상태가 갈리는 바로 그 자리다.
    if (w.ok && advance) currentStatus = advance;
    if (!w.ok) {
      persistWarn.push(`${next ?? '갱신'}: ${w.reason}`);
      try {
        const { log } = await import('@/lib/log/logger');
        log.warn('order-executor', `${clientOrderId}: 장부 기록 실패 — ${w.reason}`);
      } catch { /* 로거 실패가 주문을 막지 않는다 */ }
    }
    return w;
  };

  /** 전송 뒤 기록 실패를 사용자에게 보이는 말에 붙인다 */
  const withPersistNote = (msg: string) =>
    persistWarn.length === 0 ? msg
      : `${msg} · ⚠ 장부에 기록하지 못했습니다 (${persistWarn.join(' · ')}) — 화면과 거래소가 다를 수 있으니 대조가 필요합니다`;

  const result = await (async (): Promise<ExecuteResult> => {
  try {
    if (exchange === 'binance') {
      const bf = await import('@/lib/exchanges/binanceFutures');

      // ── 2) 거래소에 이미 같은 주문이 있는지 확인 ──
      try {
        const existing = await bf.findOrderByClientId(apiKey, apiSecret, plan.symbol, clientOrderId, testnet);
        if (existing.found) {
          // ── 이 자리도 `|| '0'`이었다 ──
          //
          //   같은 멱등 키의 주문이 거래소에 이미 있을 때다. 미체결이면
          //   `avgPrice`가 '0'이고 그것이 **가격으로** 적혔다. 접수 자리와
          //   대조 자리는 고쳤는데 이 자리는 남아 있었다 — 같은 파일 안에서
          //   세 번째였다. 정본 하나로 모은다.
          const exFacts = fillFactsOf(existing.order);

          // ── 찾았다고 끝난 것은 아니다 ──
          //
          //   여기는 `status: 'RECONCILED'`를 **무조건** 적었다. 거래소가
          //   `NEW`(아직 열려 있음)나 `PARTIALLY_FILLED`(잔량이 열려
          //   있음)를 돌려줘도 종료로 적혔고, `RECONCILED`는 대조 대상이
          //   아니라 **아무도 그 주문을 다시 조회하지 않았다.** 거래소에
          //   멀쩡히 살아 있는 주문이 장부에서 끝나고, 나중에 체결돼도 그
          //   체결은 장부에 영원히 들어오지 않는다. 대조 쓰기와 같은
          //   결함이 이 자리에도 있었다 — 경로가 셋인데 하나만 고쳤던 것.
          const dup = ledgerStatusOfBinance(exFacts.exchangeStatus, exFacts.filledQty);

          // ── 상태 기계가 이 쓰기를 **조용히 버리고 있었다** ──
          //
          //   장부 줄은 아직 `INTENT`(= 상태 기계의 `APPROVED`)다. 그
          //   상태에서 나갈 수 있는 길은 `SENT`·`CANCELED`·`FAILED`뿐이라
          //   `ACKED`로 가는 전이가 거부되고, `update`가 **status만 빼고**
          //   나머지를 적었다. 그래서 이 분기는 수량·주문번호는 적으면서
          //   상태는 영원히 `INTENT`로 남겼다 — 예전 코드가 `RECONCILED`를
          //   적던 시절에도 똑같이 버려지고 있었다(둘 다 `ACKED`로 매핑된다).
          //
          //   거래소에서 그 주문을 **찾았다**는 것은 이전 시도가 실제로
          //   전송됐다는 뜻이다. 그러니 먼저 `SENT`을 적고(사실이다) 그
          //   다음에 발견한 상태로 간다. 전이표를 넓히지 않고도 네 결과
          //   (ACKED·FILLED·REJECTED·RECONCILED) 모두 통과한다.
          await update({ status: 'SENT', sent_at: new Date().toISOString() });
          await update({
            status: dup.status, exchange_order_id: String(existing.order?.orderId),
            filled_qty: exFacts.filledQty,
            avg_price: exFacts.avgPrice,
            // 끝난 것에만 종료 시각을 적는다.
            ...(dup.terminal ? { reconciled_at: new Date().toISOString() } : {}),
            ...(dup.needsAttention
              ? { needs_attention: true, error_message: dup.attentionReason }
              : {}),
          });
          return {
            // `ok`는 "이 주문이 살아 있거나 체결됐다"는 뜻이다 — 위 23505
            // 분기와 같은 규칙을 쓴다. 취소·거절로 끝난 주문을 ok:true로
            // 돌려주면 호출자가 없는 진입을 기록한다.
            ok: dup.status === 'ACKED' || dup.status === 'FILLED',
            status: dup.status, clientOrderId,
            exchangeOrderId: String(existing.order?.orderId),
            filledQty: exFacts.filledQty ?? undefined,
            avgPrice: exFacts.avgPrice ?? undefined,
            duplicate: true,
            message: '거래소에 이미 존재하는 주문 — 재전송하지 않음'
              + ` (거래소 상태 ${exFacts.exchangeStatus ?? '불명'}`
              + `${dup.terminal ? '' : ' · 아직 열려 있음'})`
              + (dup.needsAttention ? ` · ${dup.attentionReason}` : ''),
          };
        }
      } catch (e: any) {
        // 조회 자체가 실패하면 판단 불가 → 주문하지 않는다
        //
        // 인증 오류(-2015 등)면 원인 셋을 나눠 적는다. 바이낸스 원문은
        // "Invalid API-key, IP, or permissions"로 셋을 한 문장에 뭉쳐
        // 놓아서, 그대로 띄우면 무엇을 확인해야 하는지 알 수 없다.
        // 셋을 나열하는 대신 **어느 것인지 알아낸다.** 같은 키·같은 서버로
        // 잔고(읽기 권한)를 한 번 찔러 본다. 그게 되면 환경도 IP도 아니므로
        // 남는 것은 '선물 거래 권한이 꺼짐' 하나뿐이다.
        const { narrowFuturesAuthError } = await import('@/lib/exchanges/binance');
        const why = await narrowFuturesAuthError(
          String(e?.message || e), testnet,
          () => bf.getFuturesBalance(apiKey, apiSecret, testnet) as any,
        );
        await update({ status: 'FAILED', error_message: `중복 확인 실패: ${why}` });
        return { ok: false, status: 'FAILED', clientOrderId, message: `중복 확인 실패로 주문 중단: ${why}` };
      }

      // ── 3~4) 마진 타입·레버리지는 **진입에만** 설정한다 ──
      //
      // 둘 다 '어떻게 들어갈 것인가'의 설정이다. 나가는 주문에는 해당이
      // 없는데, 예전에는 청산에도 그대로 걸어 두고 실패하면 주문을 중단했다.
      // 그래서 청산이 막히는 길이 두 개 있었다:
      //   · 마진 타입: 열린 포지션이 있으면 못 바꾼다(-4047). 청산에는 항상
      //     포지션이 있으므로, CROSSED로 열린 포지션은 **닫을 수가 없었다.**
      //   · 레버리지: 거래소에서 배율을 못 읽으면 0이 내려오고 그대로 거부.
      //
      // 못 여는 것은 불편이고, **못 닫는 것은 사고다.**
      if (!args.reduceOnly) {
        // Binance는 심볼별 마진 타입 기본값이 CROSSED다. 이 호출이 없으면
        // "1회 격리 증거금" 전략이라도 실제 체결은 Cross로 나가고, 손실이
        // 증거금을 넘어 계좌 전체로 번진다. 계단식 증거금 상한과 청산가 계산이
        // 모두 isolated를 전제하므로, 설정에 실패하면 주문하지 않는다.
        // (이미 ISOLATED면 -4046이 오는데 그건 성공으로 처리된다)
        const mt = await bf.setFuturesMarginType(apiKey, apiSecret, plan.symbol, 'ISOLATED', testnet);
        if (!mt.success) {
          const reason = `ISOLATED 설정 실패로 주문 중단: ${mt.message}` +
            (mt.code === -4047 || mt.code === -4048
              ? ' (해당 심볼에 열린 포지션이나 미체결 주문이 있으면 마진 타입을 바꿀 수 없습니다)'
              : '');
          await update({ status: 'FAILED', error_message: reason });
          return { ok: false, status: 'FAILED', clientOrderId, message: reason };
        }

        // ── 배율은 **되읽어 확인한 값**으로만 통과시킨다 ──
        //
        // 여기는 `setFuturesLeverage`의 `success`만 봤다. 그 함수는 안에서
        // 되읽기는 하지만, **거래소가 요청보다 낮게 잡은 경우에도
        // `success: true`를 돌려준다**(binanceFutures.ts의 마지막 return —
        // "요청 100배 / 실제 75배 — 거래소가 낮췄습니다"). 위험이 줄어드는
        // 방향이라 일반 전략에는 맞는 판단이었다.
        //
        // 정확한 배율이 계약인 프로필에서는 맞지 않는다. 100배로 크기를
        // 정해 놓고 75배로 나가면 **사용자가 고른 전략이 아닌 다른 전략이
        // 도는 것**이다. 그 판정은 `leverageVerdict` 한 곳에 이미 있고,
        // Worker가 쓰는 `futuresPlaceOrder`는 이미 그것을 탄다. 웹만
        // 안 타고 있었다 — 같은 판단이 두 곳에 있으면 갈린다는 그 형태다.
        const lev = await futuresApplyLeverage(
          { exchange: 'binance', key: apiKey, secret: apiSecret, testnet },
          plan.symbol, plan.leverage);
        if (!lev.ok) {
          await update({ status: 'FAILED', error_message: `레버리지 확정 실패(${lev.code}): ${lev.message}` });
          return { ok: false, status: 'FAILED', clientOrderId,
            message: `레버리지를 확정하지 못해 주문을 중단합니다 — ${lev.message}` };
        }
      }

      // ── 4.5) 전송 직전 포지션 기록 ──
      //
      // 응답을 못 받았을 때(UNKNOWN) "주문이 거래소에 들어갔는가"를 판단할
      // 유일한 반대 증거다. 나중에 조회했더니 주문은 안 보이는데 포지션이
      // 변해 있다면, 주문이 들어갔거나 다른 무언가가 계좌를 건드린 것이므로
      // 자동 확정해서는 안 된다. 기준값이 없으면 그 비교 자체를 못 한다.
      // 실패해도 주문은 진행한다 — 교차 확인이 없다는 사실만 남긴다.
      let posQtyBefore: number | null = null;
      try {
        const pr: any = await bf.getFuturesPositions(apiKey, apiSecret, testnet);
        if (pr?.success) {
          const mine = (pr.positions as any[]).find(
            (p: any) => String(p.symbol).toUpperCase() === plan.symbol.toUpperCase());
          posQtyBefore = mine ? Number(mine.amount) || 0 : 0;
        }
      } catch { /* 조회 실패 시 null — 교차 확인 없이 판단하게 된다 */ }

      // ── 4.7) 거래소 규격에 맞춘다 ──
      //
      // **2026-10-16 TESTNET 실측에서 여기가 비어 있었다.**
      // 거래소가 `-1111 Precision is over the maximum defined for this
      // asset`로 거절했다. 보낸 수량은 `(증거금 × 배율) / 기준가`가
      // 만든 생 부동소수(예: 0.0033333333333333335)였다.
      //
      // 규격을 맞추는 정본은 이미 있었다 — `quantizeOrder`가
      // LOT_SIZE · MARKET_LOT_SIZE · stepSize · minQty · maxQty ·
      // minNotional · tickSize를 전부 다룬다. `placeFuturesOrderSafe`와
      // `futuresExec`는 그것을 쓰는데 **이 경로만 안 쓰고 있었다.**
      // 만들어 놓고 배선을 안 한 것이고, 그래서 실주문이 거절됐다.
      //
      // `placeFuturesOrderSafe`로 바꾸지 않는 이유: 그쪽은
      // `clientOrderId`를 받지 않는다. 멱등 키를 잃으면 재시도가 중복
      // 주문이 된다 — 정밀도를 고치려다 더 나쁜 것을 만든다.
      const filters = await bf.getSymbolFilters(plan.symbol, testnet);

      // 최소 명목가 검사에 쓸 기준가는 **거래소에서 읽는다.** 호출부가
      // 넘긴 값을 쓰면 검사가 검사 대상에게 값을 물어보는 꼴이 된다.
      // 못 읽으면 null을 넘긴다 — 정본이 "기준가 없음"으로 판정한다.
      let markPrice: number | null = null;
      if (orderType === 'MARKET' && args.reduceOnly !== true) {
        try {
          const snap = await bf.readMarketSnapshot(plan.symbol, testnet);
          markPrice = snap.snapshot?.markPrice ?? null;
        } catch { /* 못 읽으면 null — 지어내지 않는다 */ }
      }

      const qz = quantizeOrder(
        plan.quantity,
        orderType === 'LIMIT' ? (args.limitPrice ?? null) : null,
        filters,
        { orderType, reduceOnly: args.reduceOnly === true, marketReferencePrice: markPrice },
      );
      if (!qz.ok || !(Number.isFinite(Number(qz.quantity)) && Number(qz.quantity) > 0)) {
        // **보내기 전에 멈춘다.** `status: 'SENT'`를 적기 전이라
        // 장부에 "보냈다"가 남지 않는다 — 안 보낸 것을 보냈다고 적으면
        // 대조가 영영 어긋난다.
        const reason = `거래소 수량 규격을 맞추지 못해 주문을 보내지 않았습니다`
          + ` (${qz.code ?? 'QUANTIZE_FAILED'}): ${qz.reason}`;
        await update({ status: 'FAILED', error_message: reason });
        return { ok: false, status: 'FAILED', clientOrderId, message: reason };
      }
      const sendQty = qz.quantity as number;
      const sendPrice = orderType === 'LIMIT' ? (qz.price ?? args.limitPrice) : undefined;

      // ── 5) 원자적 전송 선점 → 주문 전송 ──
      // INTENT를 읽은 실행기가 여럿이어도 DB에서 단 한 실행기만
      // SENT를 선점할 수 있다. 오류·0행이면 거래소 POST는 0회다.
      const claimed = await claimOrderDispatch(sb, orderRowId, {
        sent_at: new Date().toISOString(), attempt_count: 1,
        // 규격에 맞춘 수량을 실제 전송 전에 같은 원자적 쓰기로 기록한다.
        ...(qz.changed ? { quantity: sendQty } : {}),
      });
      if (!claimed) {
        return { ok: false, status: 'UNKNOWN', clientOrderId,
          message: '주문 전송 권한을 DB에서 확정하지 못했습니다. 전송하지 않고 대조가 필요합니다.' };
      }
      currentStatus = 'SENT';
      // 018 복구 컬럼은 구형 DB에서도 선택 사항. 선점과 분리해 적는다.
      if (posQtyBefore !== null) await update({ pos_qty_before: posQtyBefore });

      let res: any;
      try {
        res = await bf.placeFuturesOrder(apiKey, apiSecret, {
          symbol: plan.symbol, side, type: orderType,
          quantity: sendQty, clientOrderId,
          ...(orderType === 'LIMIT' ? { price: sendPrice } : {}),
          ...(args.reduceOnly ? { reduceOnly: true } : {}),
        }, testnet);
      } catch (e: any) {
        // 응답을 못 받음 → 체결됐을 수도 있다. 절대 재시도하지 않고 UNKNOWN.
        await update({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
        return { ok: false, status: 'UNKNOWN', clientOrderId,
          message: '주문 전송 후 응답을 받지 못했습니다. 재시도하지 않고 대조가 필요합니다.' };
      }

      if (!res?.success) {
        // ── 실패를 **거부로 단정하지 않는다** ──
        //
        //   `placeFuturesOrder`는 타임아웃·연결 끊김도 **내부에서 잡아**
        //   `{ success: false, message }`로 돌려준다. 그래서 위 catch는
        //   돌지 않고 여기로 온다. 여기서 무조건 `REJECTED`를 적고 있었다.
        //
        //   `REJECTED`는 "거래소가 거부했다"는 뜻이고, 대조 대상도 아니며
        //   (`RECONCILE_TARGET_STATUSES`에 없다) 계좌 용량 관문의 어느
        //   목록에도 없다. 즉 **거래소에 살아 있을 수 있는 주문이
        //   "거부됨"으로 종료되고, 아무도 다시 조회하지 않고, 진입 잠금도
        //   풀린다.** 자동매매의 주 진입 경로에 그 구멍이 있었다.
        //
        //   판정은 `unknownResultVerdict` 하나를 쓴다 — 거래소가 거절한
        //   모양이 보일 때만 거부로 적는다.
        const verdict = unknownResultVerdict(res?.message);
        if (verdict.unknown) {
          await update({
            status: 'UNKNOWN',
            error_message: `결과 미확정(${verdict.evidence}): ${res?.message || '사유 미상'}`,
          });
          return { ok: false, status: 'UNKNOWN', clientOrderId,
            message: '주문 결과를 확정하지 못했습니다. 재시도하지 않고 대조가 필요합니다 — '
                   + `${res?.message || '사유 미상'}` };
        }
        await update({ status: 'REJECTED', error_message: res?.message });
        return { ok: false, status: 'REJECTED', clientOrderId, message: `거래소 거부: ${res?.message}` };
      }

      // ── 6) 접수 확인 ──
      //
      // **접수는 체결이 아니다.** 예전에는 `filled_qty: res.qty`를 적었는데
      // `placeFuturesOrder`의 `qty`는 `origQty || executedQty`라 **요청
      // 수량이 먼저** 온다. 한 주도 안 채워진 주문이 "요청만큼 체결됨"으로
      // 장부에 남고, 그 값을 ledger 세 곳이 보유 수량으로 읽었다.
      // reconcile은 ACKED를 보지 않으므로 스스로 고쳐지지도 않는다.
      //
      // 거래소가 증명한 것만 적는다. 증명하지 못한 것은 null이고 0이 아니다.
      const fill = fillFactsOf(res.raw);
      await update({
        status: fill.status, exchange_order_id: String(res.orderId),
        filled_qty: fill.filledQty, avg_price: fill.avgPrice,
        acked_at: new Date().toISOString(),
        ...(fill.exchangeStatus ? { error_message: null } : {}),
      });

      // ── 7) 손절·익절 부착 ──
      let slId: string | undefined, tpId: string | undefined;
      const closeSide: 'BUY' | 'SELL' = side === 'BUY' ? 'SELL' : 'BUY';
      let slError = '';

      // ── 보호주문도 거래소 격자 위에 올린다 ──
      //
      // 진입 수량만 맞추면 **다음 벽이 여기다.** 손절·익절의
      // `stopPrice`는 `기준가 × (1 ± 손절%)`가 만든 생 부동소수고
      // (예: 59400.000000000007), 호가 단위를 벗어나면 똑같이 -1111로
      // 거절된다. 그러면 **보호 없는 포지션이 열린 채로 남는다** —
      // 진입이 거절되는 것보다 나쁜 결과다.
      //
      // 자릿수를 새로 쓰지 않는다. 방향까지 맞추는 정본이 이미 있다:
      // `roundTrigger`는 LONG 손절을 **내리고** LONG 익절을 **올린다**
      // (SHORT는 반대). 반올림으로 처리하면 손절이 한 틱 가까워지거나
      // 익절이 한 틱 멀어져 **닿지 않는 보호주문**이 된다.
      const tick = filters?.tickSize && filters.tickSize > 0 ? filters.tickSize : null;
      /** 조건부 주문의 reduceOnly 수량에도 LOT_SIZE와 MARKET_LOT_SIZE를
       * **모두** 적용한다. MARKET_LOT_SIZE.stepSize=0은 비활성이라는 뜻이고
       * 이때도 LOT_SIZE를 반드시 지켜야 한다. 필터 조회 실패 시 청산
       * 자체를 막지 않는 기존 quantizeOrder의 reduceOnly 계약을 따른다. */
      const protQty = (q: unknown): number | undefined => {
        const n = Number(q);
        if (!Number.isFinite(n) || n <= 0) return undefined;
        const v = quantizeOrder(n, null, filters, { orderType: 'MARKET', reduceOnly: true });
        return v.ok && v.quantity != null && Number.isFinite(v.quantity) && v.quantity > 0
          ? v.quantity : undefined;
      };

      // 청산 주문에는 보호주문을 붙이지 않는다. 붙이면 포지션이 없어진 뒤에도
      // 남아서 다음 진입을 예상치 못하게 닫는다.
      if (!args.reduceOnly && args.stopLoss && policy !== 'NONE') {
        const slTrig = roundTrigger(args.stopLoss, plan.side, 'STOP', tick);
        const sl = slTrig.price == null
          ? { success: false, message: `손절가를 호가 단위에 맞추지 못했습니다: ${slTrig.note}` } as any
          : await bf.placeFuturesTPSL(apiKey, apiSecret, {
          symbol: plan.symbol, side: closeSide, stopPrice: slTrig.price, type: 'STOP_MARKET',
          // 1차는 closePosition(그때 있는 전량)이 맞다. -4120 대체 방식은
          // 거래소가 **증명한 체결 수량**만 사용한다. res.qty는 origQty를
          // 우선 돌려줄 수 있어 실제 체결 수량이 아니다. 체결 증거가 없으면
          // 추정 수량으로 reduceOnly 주문을 보내지 않는다.
          fallbackQuantity: protQty(fill.filledQty) ?? null,
        }, testnet);
        if ((sl as any)?.success) slId = String((sl as any).orderId);
        else {
          slError = String((sl as any)?.message || '원인 불명');
          // 이 환경이 조건부 주문을 아예 안 받는 경우다. 사용자가
          // 고칠 것이 **여기에는 없다** — 무엇을 해야 하는지까지 적는다.
          // 이 말이 없으면 같은 시도를 반복하게 되고, 시도마다 진입·청산
          // 수수료가 나간다(실제로 잔고가 그렇게 줄었다).
          if ((sl as any)?.envUnsupported) {
            slError += testnet
              ? ' — 이 환경에서는 거래소 손절을 걸 수 없으므로, 여기서 손절 있는 진입은 불가능합니다.'
                + ' 실전(fapi)은 STOP_MARKET을 받으므로 이 제약은 데모에만 해당합니다.'
                + ' 모의(PAPER) 모드는 앱이 직접 손절을 계산하므로 연습에 쓸 수 있습니다.'
              : ' — 거래소가 조건부 주문을 받지 않습니다. 손절 없이 진입하지 않습니다.';
          }
        }
      }
      // 익절 — exitPlan이 있으면 분할 사다리를, 없으면 기존 단일 익절을 건다.
      const tpIds: string[] = [];
      if (args.reduceOnly) {
        // 위와 같은 이유 — 나가는 주문에 익절 사다리를 걸지 않는다
      } else if (noFixedTp) {
        // 고정 익절을 쓰지 않는 계약이다. **여기가 예전에 Gate와 갈렸다** —
        // 이 자리에는 정책 검사가 없어서 익절이 그대로 나갔다.
      } else if (args.exitPlan) {
        for (const o of args.exitPlan.orders) {
          if (o.kind !== 'PARTIAL_TP') continue;   // 손절은 위에서 이미 걸었다
          const pTrig = roundTrigger(o.price, plan.side, 'TAKE_PROFIT', tick);
          if (pTrig.price == null) continue;   // 격자에 못 올리면 안 보낸다
          const partialQty = protQty(o.quantity);
          // PARTIAL_TP에 quantity를 생략하면 closePosition=true가 되어
          // 부분 익절이 전량 청산으로 바뀐다. 절대로 그대로 보내지 않는다.
          if (partialQty == null) continue;
          const r = await bf.placeFuturesTPSL(apiKey, apiSecret, {
            symbol: plan.symbol, side: closeSide, stopPrice: pTrig.price,
            type: 'TAKE_PROFIT_MARKET', quantity: partialQty,
          }, testnet);
          if ((r as any)?.success) tpIds.push(String((r as any).orderId));
          // 분할 익절 실패는 진입을 되돌릴 사유가 아니다 — 손절은 이미 걸려
          // 있으므로 손실은 고정된다. 이익 확보만 덜 되는 것이다.
        }
        tpId = tpIds[0];
      } else if (args.takeProfit) {
        const tpTrig = roundTrigger(args.takeProfit, plan.side, 'TAKE_PROFIT', tick);
        const tp = tpTrig.price == null
          ? { success: false, message: `익절가를 호가 단위에 맞추지 못했습니다: ${tpTrig.note}` } as any
          : await bf.placeFuturesTPSL(apiKey, apiSecret, {
          symbol: plan.symbol, side: closeSide, stopPrice: tpTrig.price, type: 'TAKE_PROFIT_MARKET',
        }, testnet);
        if ((tp as any)?.success) tpId = String((tp as any).orderId);
      }
      await update({ sl_order_id: slId || null, tp_order_id: tpId || null });

      // ── 7-b) 손절이 **정말** 걸려 있는지 되읽는다 ──
      //
      // 위의 `slId`는 거래소가 200을 줬다는 뜻이지, 그 주문이 지금 주문장에
      // 남아 있다는 뜻이 아니다. 리스크 엔진이 접수 직후 취소하거나,
      // reduceOnly 조건이 안 맞아 즉시 취소되거나, 다른 심볼로 들어가도
      // 응답은 성공이다. 셋 다 결과는 같다 — **손절 없는 포지션이 열려 있다.**
      //
      // 못 읽었을 때는 '없음'으로 치지 않는다. 조회 한 번 실패로 멀쩡한
      // 포지션을 시장가로 닫으면 수수료와 슬리피지를 확정 손실로 물면서
      // 아무것도 얻지 못한다. 그래서 결과가 셋이다 — 있음/없음/확인 불가.
      let stopCheckNote = '';
      if (!args.reduceOnly && args.stopLoss && slId) {
        const { verifyStopAttached, shouldUnwind } = await import('./stopVerify');
        let openOrders: any[] | null = null;
        try {
          const oo: any = await bf.getFuturesOpenOrders(apiKey, apiSecret, testnet, plan.symbol);
          // success가 false여도 orders: []를 돌려준다. 그 빈 배열을 그대로
          // 넘기면 **조회 실패가 '손절 없음'이 되어 포지션이 청산된다.**
          openOrders = oo?.success && Array.isArray(oo.orders) ? oo.orders : null;
        } catch { openOrders = null; }

        const check = verifyStopAttached(openOrders, {
          symbol: plan.symbol, side: closeSide, stopPrice: args.stopLoss,
        });
        if (shouldUnwind(check)) {
          // 아래 8)의 되돌리기 경로를 그대로 탄다. 판정을 두 곳에 적지 않는다.
          slId = undefined;
          slError = check.reason;
          // 방금 적은 sl_order_id를 지운다. 남겨 두면 나중에 대조할 때
          // 있지도 않은 주문을 "손절 걸림"으로 읽는다.
          await update({ sl_order_id: null });
        } else if (check.status === 'unknown') {
          stopCheckNote = ` · ${check.reason}`;
        }
      }

      // ── 8) 손절이 안 붙었으면 포지션을 즉시 닫는다 ──
      //
      // 예전에는 경고 문자열만 message에 붙이고 ok:true로 반환했다. 그러면
      // 호출자는 성공으로 처리하는데 실제로는 손절 없는 포지션이 열려 있다.
      // 포지션 크기 자체가 "손절 거리"로 역산된 값이므로(허용손실 ÷ 손절거리),
      // 손절이 없으면 그 크기를 정당화하는 근거가 사라진다. 방치하면 계단식
      // 1회 증거금을 넘어 손실이 커질 수 있다.
      // 진입 근거가 사라졌으므로 되돌린다.
      // ── **되돌릴지 말지는 정책이 정한다** ──
      //
      // 자동매매(REQUIRED)는 되돌린다. 포지션 크기 자체가 손절 거리로
      // 역산된 값이라(허용손실 ÷ 손절거리) 손절이 없으면 그 크기를
      // 정당화하는 근거가 사라지고, 아무도 안 보고 있다.
      //
      // 수동(OPTIONAL)은 **유지한다.** 사람이 화면 앞에 있고, 손절 없이
      // 들고 가겠다는 것도 그 사람의 선택이다. 다만 요청한 손절이 안
      // 걸렸다는 사실은 크게 알린다 — 모르고 넘어가면 안 된다.
      if (args.stopLoss && !slId && policy !== 'REQUIRED') {
        const warn = `⚠ 진입은 체결됐지만 요청한 손절이 등록되지 않았습니다`
          + (slError ? ` (${slError})` : '')
          + '. **지금 보호되지 않은 포지션입니다** — 거래소에서 직접 손절을 걸거나 포지션을 닫으세요.';
        await update({ status: 'ACKED', error_message: warn });
        return {
          ok: true, status: 'ACKED', clientOrderId,
          exchangeOrderId: res.orderId ? String(res.orderId) : undefined,
          filledQty: res.qty, avgPrice: res.avgPrice,
          tpOrderId: tpId, unprotected: true, message: warn,
        };
      }

      if (args.stopLoss && !slId) {
        let closed = false, closeErr = '';
        // reduceOnly 수량은 origQty(res.qty)가 아니라 체결 사실을 우선한다.
        // 필터를 알고 있으면 LOT_SIZE+MARKET_LOT_SIZE 격자에 내리고,
        // 필터 미상/잔량 dust는 청산 시도 자체를 막지 않는다.
        const closeQuantity = (raw: number): number => {
          const q = quantizeOrder(raw, null, filters, { orderType: 'MARKET', reduceOnly: true });
          return q.ok && q.quantity != null && q.quantity > 0 ? q.quantity : raw;
        };
        try {
          const close = await bf.placeFuturesOrder(apiKey, apiSecret, {
            symbol: plan.symbol, side: closeSide, type: 'MARKET',
            quantity: closeQuantity(fill.filledQty && fill.filledQty > 0 ? fill.filledQty : sendQty), reduceOnly: true,
            clientOrderId: `${clientOrderId}X`.slice(0, 36),
          }, testnet);
          closed = !!(close as any)?.success;
          if (!closed) closeErr = String((close as any)?.message || '');
        } catch (e: any) {
          closeErr = e?.message || String(e);
        }

        // ── **접수됐다와 없어졌다는 다르다** ──
        //
        // 거래소가 200을 줬다는 것은 주문을 받았다는 뜻이지, 포지션이
        // 사라졌다는 뜻이 아니다. 부분 체결로 끝나거나, 리스크 엔진이
        // 접수 직후 취소하거나, reduceOnly가 조용히 무시될 수 있다.
        //
        // 손절 부착 쪽은 이미 되읽어 확인한다(7-b). 되돌리기 쪽만
        // 안 하고 있었고, 그래서 화면에 "진입을 즉시 청산했습니다"가
        // 뜬 채로 포지션이 그대로 열려 있는 일이 생겼다. 그 문장은
        // 사용자가 더 확인하지 않게 만들기 때문에 특히 나쁘다.
        if (closed) {
          try {
            const after = await bf.getSymbolPositionRiskEx(apiKey, apiSecret, plan.symbol, testnet);
            const left = after.risk ? Math.abs(Number(after.risk.positionAmt) || 0) : null;
            if (left != null && left > 0) {
              closed = false;
              closeErr = `청산 주문은 접수됐는데 포지션이 ${left} 남아 있습니다`;
            }
            // 조회 자체가 실패하면 **확인하지 못한 것**이다. 접수만 보고
            // '닫았다'고 단정하지 않는다.
            else if (after.error) {
              closed = false;
              closeErr = `청산 주문은 접수됐지만 실제로 닫혔는지 확인하지 못했습니다 (${after.error})`;
            }
          } catch (e: any) {
            closed = false;
            closeErr = `청산 주문은 접수됐지만 확인에 실패했습니다 (${e?.message || e})`;
          }
        }

        // ── 닫기가 실패했다면 **정말 열려 있는지 확인한다** ──
        //
        // -2022(ReduceOnly Order is rejected)는 대부분 "줄일 포지션이
        // 없다"는 뜻이다. 진입이 체결되지 않았거나 이미 닫힌 경우다.
        // 그런데 예전에는 닫기 실패를 곧바로 "손절 없는 포지션이 열려
        // 있습니다"로 적었다. 없는 포지션을 찾으라고 보내는 것이고,
        // 사용자는 거래소를 뒤지다가 아무것도 못 찾는다.
        //
        // 반대로 정말 열려 있으면 수량을 거래소에서 읽어 **그 수량으로**
        // 한 번 더 닫는다. 우리가 들고 있던 res.qty가 부분 체결이나
        // 반올림으로 실제와 다르면 reduceOnly가 거절된다.
        let posAmt: number | null = null;
        let posErr = '';
        if (!closed) {
          try {
            const { risk, error } = await bf.getSymbolPositionRiskEx(apiKey, apiSecret, plan.symbol, testnet);
            if (error) posErr = error;
            else posAmt = risk ? Math.abs(Number(risk.positionAmt) || 0) : 0;
          } catch (e: any) { posErr = String(e?.message || e); }

          if (posAmt != null && posAmt > 0) {
            try {
              const retry = await bf.placeFuturesOrder(apiKey, apiSecret, {
                symbol: plan.symbol, side: closeSide, type: 'MARKET',
                quantity: closeQuantity(posAmt), reduceOnly: true,
                clientOrderId: `${clientOrderId}Y`.slice(0, 36),
              }, testnet);
              if ((retry as any)?.success) { closed = true; closeErr = ''; }
              else closeErr = `${closeErr} · 실제 수량(${posAmt})으로 재시도도 실패: ${(retry as any)?.message || ''}`;
            } catch (e: any) {
              closeErr = `${closeErr} · 재시도 실패: ${e?.message || e}`;
            }
          } else if (posAmt === 0) {
            // 열린 포지션이 없다. 되돌릴 것이 없으므로 '닫았다'와 같다 —
            // 다만 문구는 사실대로 적는다(아래 detail에서 구분한다).
            closed = true;
            closeErr = '';
          }
        }

        // ── 되돌릴 때 **익절도 같이 지운다** ──
        //
        // 손절을 못 걸어 포지션을 되돌리는데, 이미 걸어 둔 분할 익절은
        // 그대로 남았다. 포지션이 없어졌으니 그 주문들은 고아가 되고,
        // 다음 진입을 예상치 못하게 닫는다. Gate에서 정확히 그 모양으로
        // 조건부 주문 2건이 남았다(2026-08-15).
        let tpCleanupNote = '';
        if (tpIds.length > 0) {
          const attempts: CancelAttempt[] = [];
          for (const id of tpIds) {
            try {
              const r: any = await bf.cancelFuturesOrder(apiKey, apiSecret, plan.symbol, id, testnet);
              const okish = r?.success === true || r?.ok === true || r?.orderId != null;
              attempts.push({ id, requested: true, httpOk: !!okish, response: okish ? null : String(r?.message || '취소 실패') });
            } catch (e: any) {
              attempts.push({ id, requested: true, httpOk: false, response: String(e?.message || e) });
            }
          }
          // **취소 응답이 아니라 목록을 다시 읽어 확인한다.**
          let leftover: any[] | null = null;
          try {
            const open: any = await bf.getFuturesOpenOrders(apiKey, apiSecret, testnet, plan.symbol);
            leftover = Array.isArray(open) ? open : Array.isArray(open?.orders) ? open.orders : null;
          } catch { leftover = null; }
          const ledger = cancelLedger({ ids: tpIds, attempts, leftover });
          tpCleanupNote = ledger.ok
            ? ` · 걸어 둔 익절 ${tpIds.length}건도 취소 확인`
            : ` · ⚠ ${ledger.reason}`;
        }

        const detail = `손절 부착 실패(${slError})`;
        if (closed) {
          await update({ status: 'FAILED', error_message: `${detail} — 포지션을 즉시 청산했습니다` });
          return {
            ok: false, status: 'FAILED', clientOrderId,
            exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
            tpOrderId: tpId,
            message: posAmt === 0
              // 되돌릴 것이 없었다. '청산했다'고 적으면 하지도 않은 일을
              // 했다고 말하는 것이고, 사용자는 체결된 줄 안다.
              ? `${detail}. 거래소에 열린 포지션이 없어 되돌릴 것이 없었습니다 — 진입은 체결되지 않았습니다.${tpCleanupNote}`
              : `${detail}. 손절 없는 포지션을 남기지 않기 위해 진입을 즉시 청산했습니다.${tpCleanupNote}`,
          };
        }

        // 청산까지 실패 — 사람이 개입해야 한다
        //
        // **포지션이 열려 있다고 단정하려면 확인했어야 한다.** 확인하지
        // 못했으면 그렇게 적는다 — 없는 포지션을 찾으라고 보내면 사용자는
        // 거래소를 뒤지다가 아무것도 못 찾고, 다음부터 이 경고를 안 믿는다.
        const posLine = posAmt != null && posAmt > 0
          ? `손절 없는 포지션 ${posAmt}이(가) 열려 있습니다 — 거래소에서 직접 닫으세요.`
          : posErr
            ? `포지션이 열렸는지 확인하지 못했습니다(${posErr}) — 거래소에서 직접 확인하세요.`
            : '거래소에서 직접 확인하세요.';
        await update({ status: 'UNKNOWN', error_message: `${detail}, 자동 청산도 실패(${closeErr})` });
        return {
          ok: false, status: 'UNKNOWN', clientOrderId,
          exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
          tpOrderId: tpId,
          message: `⚠️ 긴급: ${detail}이고 자동 청산도 실패했습니다(${closeErr}). ${posLine}${tpCleanupNote}`,
        };
      }

      const exitNote = args.exitPlan
        ? ` · 분할익절 ${tpIds.length}/${args.exitPlan.orders.filter(o => o.kind === 'PARTIAL_TP').length}건` +
          (args.exitPlan.trailingQty > 0 ? ` · 잔량 ${args.exitPlan.trailingQty}는 트레일링 대기` : '')
        : '';

      // **청산이면 실제로 닫혔는지 되읽는다.** 접수됐다는 것과 없어졌다는
      // 것은 다른 얘기다 — 닫았다고 믿고 손을 떼는 것이 가장 위험하다.
      const closeCheck = args.reduceOnly
        ? await remainingAfterClose({ exchange, apiKey, apiSecret, testnet }, plan.symbol)
        : { remaining: null, note: '' };
      if (args.reduceOnly) {
        await update({ error_message: closeCheck.remaining === 0 ? null : closeCheck.note.trim() || null });
      }

      return {
        ok: true, status: 'ACKED', clientOrderId,
        exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
        slOrderId: slId, tpOrderId: tpId,
        remainingQty: closeCheck.remaining,
        // 손절이 걸렸는지 **확인하지 못했으면** 그 사실을 메시지에 남긴다.
        // 조용히 지나가면 "접수됨"만 보이고, 사용자는 손절이 확인된 줄 안다.
        message: `주문 접수 (${plan.leverage}배 · ${plan.quantity})${exitNote}${stopCheckNote}${closeCheck.note}`,
      };
    }

    // ── Gate ──
    //
    // 이 분기는 바이낸스 경로가 가진 보호를 하나도 갖고 있지 않았다:
    // 마진 모드 미확인 · 레버리지 설정 결과 무시 · 손절 미부착 ·
    // 수량을 Math.round(0.4 → 0, 1.6 → 2). 하나씩 채운다.
    const gf = await import('@/lib/exchanges/gateFutures');
    const gp = await import('@/lib/exchanges/gatePlan');
    const contract = gp.toGateContract(plan.symbol);
    if (!contract) {
      await update({ status: 'REJECTED', error_message: `Gate 계약 이름을 만들 수 없습니다 (${plan.symbol})` });
      return { ok: false, status: 'REJECTED', clientOrderId,
        message: `Gate 계약 이름을 만들 수 없습니다 (${plan.symbol})` };
    }

    // ── 수량: 기초자산 → 정수 계약 ──
    //
    // **여기가 Gate 주문이 BTC에서 한 번도 나가지 못한 이유였다.**
    //
    // `plan.quantity`는 저장소 전체에서 기초자산 수량이다(0.05 BTC). 그런데
    // Gate의 `size`는 정수 계약 수이고, 1계약이 몇 개인지는 계약마다 다르다 —
    // BTC_USDT는 0.0001이다. 예전 코드는 그 배수를 읽지 않고 0.05를 그대로
    // 계약 수로 보고 내림했다. floor(0.05) = 0 → "1계약 미만입니다"로 거부.
    // 실제로는 500계약이었어야 했다.
    //
    // SOL_USDT처럼 배수가 1인 계약에서는 우연히 맞았다. 그래서 "어떤 종목은
    // 되고 BTC만 안 되는" 모양이었고 원인을 짚을 단서가 없었다.
    //
    // **규격을 못 읽으면 주문하지 않는다.** 배수를 1로 가정하면 이번엔 반대로
    // 10000배가 나간다.
    const gspec = await gf.getGateContractSpec(contract, testnet);
    // ── **부호는 주문 방향을 따른다. 포지션 방향이 아니다.** ──
    //
    // `plan.side`는 '무슨 포지션을 다루는가'다. 진입에서는 그게 곧 주문
    // 방향이지만, **청산에서는 반대**다 — 롱을 닫는 주문은 SELL이다.
    //
    // 그런데 여기서 plan.side를 그대로 썼다. 그래서 롱 청산이 **양수
    // 계약 수**로 나갔고, Gate는 reduce_only 주문이 포지션을 늘릴 수
    // 없으므로 거부했다. 화면에서는 눌러도 아무 일이 안 일어나는 것처럼
    // 보인다 — 실제로 그 상태였다.
    //
    // 바이낸스 분기는 위에서 이미 `side`(뒤집힌 값)를 쓴다. Gate만
    // 빠져 있었다. 같은 실수를 두 번 하지 않으려면 여기서도 같은 값을
    // 봐야 한다: side === 'BUY'면 양수, 'SELL'이면 음수.
    const orderDir: 'LONG' | 'SHORT' = side === 'BUY' ? 'LONG' : 'SHORT';
    const sized = gp.gateSizeFromBase(plan.quantity, orderDir, gspec);
    if (!sized.ok) {
      await update({ status: 'REJECTED', error_message: sized.reason });
      return { ok: false, status: 'REJECTED', clientOrderId, message: sized.reason };
    }

    // 손절 방향을 미리 검사한다. 주문을 낸 뒤에 알면 이미 늦다.
    // 규격을 함께 넘겨 트리거 가격을 호가 단위에 맞춘다 — 안 맞추면
    // "trigger.price is not an integer multiple of a price unit"로 거부되고,
    // 그러면 진입은 성공한 뒤 손절만 실패해 포지션을 되돌리게 된다.
    const stopSpec = gp.gateStopSpec(plan.side, args.stopLoss ?? null, null, gspec);
    if (!args.reduceOnly && !stopSpec.ok) {
      await update({ status: 'REJECTED', error_message: stopSpec.reason });
      return { ok: false, status: 'REJECTED', clientOrderId,
        message: `손절을 걸 수 없어 진입하지 않습니다 — ${stopSpec.reason}` };
    }

    // 중복 확인. **조회에 실패하면 보내지 않는다.**
    // "없음"과 "확인 못 함"을 같이 취급하면, 레이트리밋 한 번이 중복 체결이
    // 된다 (바이낸스 경로와 같은 규칙).
    const lookup = await gf.findOrderByClientIdGateFutures(apiKey, apiSecret, contract, clientOrderId, testnet);
    if (!lookup.ok) {
      const msg = `중복 확인 실패로 주문 중단: ${lookup.error || '조회 실패'}`;
      await update({ status: 'FAILED', error_message: msg });
      return { ok: false, status: 'FAILED', clientOrderId, message: msg };
    }
    if (lookup.order) {
      const existing = lookup.order;

      // 바이낸스 멱등 경로와 **같은 규칙**이다. 여기도 찾으면 무조건
      // `RECONCILED`를 적었다. Gate는 어휘가 달라서(`open`/`finished` +
      // `finish_as`) 바이낸스 표로는 해석되지 않으므로 Gate 전용 변환을
      // 쓴다 — 예전 대조 경로가 `status:'NEW'`를 지어낸 자리가 그것이다.
      const gFill = gp.gateFillOf(existing);
      const dup = ledgerStatusOfGate({
        status: existing.status, finishAs: (existing as any).finish_as,
        filledQty: gFill.filledQty,
      });
      // 바이낸스 쪽과 같은 이유로 먼저 `SENT`을 적는다 — 찾았다는 것은
      // 이전 시도가 실제로 전송됐다는 뜻이고, `INTENT → ACKED` 전이는
      // 상태 기계가 거부해 이 쓰기가 조용히 버려졌다.
      await update({ status: 'SENT', sent_at: new Date().toISOString() });
      await update({
        status: dup.status, exchange_order_id: String(existing.id),
        filled_qty: gFill.filledQty,
        avg_price: gFill.avgPrice,
        ...(dup.terminal ? { reconciled_at: new Date().toISOString() } : {}),
        ...(dup.needsAttention
          ? { needs_attention: true, error_message: dup.attentionReason }
          : {}),
      });
      return {
        ok: dup.status === 'ACKED' || dup.status === 'FILLED',
        status: dup.status, clientOrderId, exchangeOrderId: String(existing.id),
        filledQty: gFill.filledQty ?? undefined,
        avgPrice: gFill.avgPrice ?? undefined,
        duplicate: true,
        message: '거래소에 이미 존재하는 주문'
          + ` (Gate ${existing.status ?? '불명'}`
          + `${(existing as any).finish_as ? `/${(existing as any).finish_as}` : ''}`
          + `${dup.terminal ? '' : ' · 아직 열려 있음'})`
          + (dup.needsAttention ? ` · ${dup.attentionReason}` : ''),
      };
    }

    // ── 레버리지 + 격리 확인 ──
    // 결과를 버리지 않는다. Gate에서 leverage=0은 교차 마진이고, 교차면 한
    // 종목의 손실이 지갑 전체로 번진다 (바이낸스 경로의 ISOLATED 강제와 같은 이유).
    // 청산 주문은 건너뛴다 — 나가는 주문에 배율을 다시 설정할 이유가 없다.
    if (!args.reduceOnly) {
      // 격리 여부는 `setLeverageGateFutures`가 판정한다 (Gate는 교차를
      // leverage=0으로 표현하므로 그 판정이 여기 있어야 한다).
      const isoCheck = await gf.setLeverageGateFutures(apiKey, apiSecret, contract, plan.leverage, testnet);
      if (!isoCheck.success) {
        await update({ status: 'REJECTED', error_message: isoCheck.message });
        return { ok: false, status: 'REJECTED', clientOrderId,
          message: `Gate 배율·마진 모드를 확정하지 못해 주문을 중단합니다 — ${isoCheck.message}` };
      }
      // **그런데 그 함수도 거래소가 낮춘 경우를 `success: true`로 돌려준다**
      // ("요청 100배 / 실제 75배 — 거래소가 조정했습니다"). 바이낸스 쪽과
      // 같은 이유로, 배율이 요청과 같은지는 `leverageVerdict`가 판정한다.
      const lev = await futuresApplyLeverage(
        { exchange: 'gate', key: apiKey, secret: apiSecret, testnet },
        plan.symbol, plan.leverage);
      if (!lev.ok) {
        await update({ status: 'REJECTED', error_message: `레버리지 확정 실패(${lev.code}): ${lev.message}` });
        return { ok: false, status: 'REJECTED', clientOrderId,
          message: `레버리지를 확정하지 못해 주문을 중단합니다 — ${lev.message}` };
      }
    }

    // 진입 직전 포지션 수량을 남긴다. UNKNOWN이 됐을 때 교차 확인의 기준값이다.
    let gatePosBefore: number | null = null;
    try {
      const before = await gf.getPositionGateFutures(apiKey, apiSecret, contract, testnet);
      gatePosBefore = before ? Number(before.size) || 0 : 0;
    } catch { /* 조회 실패 시 null — 교차 확인 없이 판단하게 된다 */ }

    // Gate도 Binance와 동일한 INTENT → SENT 원자적 전송 선점을 통과한다.
    const claimed = await claimOrderDispatch(sb, orderRowId, {
      sent_at: new Date().toISOString(), attempt_count: 1,
    });
    if (!claimed) {
      return { ok: false, status: 'UNKNOWN', clientOrderId,
        message: 'Gate 주문 전송 권한을 DB에서 확정하지 못했습니다. 전송하지 않고 대조가 필요합니다.' };
    }
    currentStatus = 'SENT';
    if (gatePosBefore !== null) await update({ pos_qty_before: gatePosBefore });

    let gres: any;
    try {
      gres = await gf.placeOrderGateFutures(apiKey, apiSecret, {
        contract,
        size: sized.size,
        price: orderType === 'LIMIT' ? String(args.limitPrice) : '0',
        tif: orderType === 'LIMIT' ? 'gtc' : 'ioc',
        reduceOnly: !!args.reduceOnly,
        clientOrderId,
      }, testnet);
    } catch (e: any) {
      // Gate는 HTTP 오류에서 **던진다**(`gateReq`). 그래서 정상 거절
      // (`Gate 400: BALANCE_NOT_ENOUGH`)도 여기로 온다. 전부 UNKNOWN으로
      // 묶으면 나간 적 없는 주문이 미확정으로 쌓여 다음 진입을 막는다.
      // 바이낸스 쪽과 **같은 정본**으로 가른다.
      const msg = String(e?.message || e);
      const verdict = unknownResultVerdict(msg);
      if (!verdict.unknown) {
        await update({ status: 'REJECTED', error_message: msg });
        return { ok: false, status: 'REJECTED', clientOrderId, message: `거래소 거부: ${msg}` };
      }
      await update({ status: 'UNKNOWN', error_message: `결과 미확정(${verdict.evidence}): ${msg}` });
      return { ok: false, status: 'UNKNOWN', clientOrderId,
        message: `주문 결과를 확정하지 못했습니다 — 대조 필요: ${msg}` };
    }

    // ── 체결됐는가 ──
    //
    // 시장가는 `tif: 'ioc'`로 나간다. 유동성이 없으면 Gate는 200 + `finished`에
    // `left`(미체결 수량)를 그대로 담아 돌려준다 — "정상 처리됐고 하나도 안
    // 붙었다"는 뜻이다. 이걸 ACKED로 기록하면 없는 포지션에 손절을 걸려 하고,
    // 화면에는 손절 실패라는 엉뚱한 이유가 뜬다.
    let fill = gp.gateFillOf(gres);

    // ── 접수를 체결로 치지 않는다 ──
    //
    // **화면에 이렇게 떴다:** "부분 체결 0/2079 · 손절 부착".
    // 한 문장 안에 "하나도 안 붙었다"와 "손절을 걸었다"가 같이 있다.
    //
    // 원인은 응답을 **한 번만** 읽은 것이다. 거래소는 200을 주면서 그
    // 순간의 체결량을 담아 돌려주는데, 시장가라도 그 값이 0일 수 있다 —
    // 접수와 체결 반영 사이에 짧은 지연이 있다.
    //
    // 그 0을 믿고 다음으로 가면 세 가지가 한꺼번에 틀어진다:
    //   · 화면은 '체결 0'인데 잠시 뒤 거래소에 포지션이 생긴다
    //   · 사용자가 한 번 더 누른다 → **포지션이 두 배**
    //   · 손절이 요청 수량으로 걸린다 → 실제 포지션보다 큰 보호 주문
    //
    // 그래서 확정될 때까지 다시 묻는다. 판정은 fillPoll이 한다 —
    // 여기서 규칙을 또 적으면 바이낸스 쪽과 갈린다.
    const { fillPhaseOf, shouldPoll, protectionQtyFor, FILL_POLL_DELAYS_MS } =
      await import('./fillPoll');

    let verdict = fillPhaseOf({
      filledQty: fill.filledQty, requestedQty: sized.size, status: gres?.status,
    });
    let pollNote = '';

    for (let attempt = 0; shouldPoll(verdict, attempt); attempt++) {
      await new Promise(r => setTimeout(r, FILL_POLL_DELAYS_MS[attempt]));
      try {
        const look = await gf.findOrderByClientIdGateFutures(
          apiKey, apiSecret, contract, clientOrderId, testnet);
        // **못 찾은 것을 '체결 0'으로 치지 않는다.** 조회가 실패했거나
        // 거래소가 아직 목록에 안 올렸을 수 있다.
        if (!look.ok || !look.order) continue;
        const again = gp.gateFillOf(look.order);
        verdict = fillPhaseOf({
          filledQty: again.filledQty, requestedQty: sized.size,
          status: (look.order as any)?.status,
        });
        // 다시 읽은 값이 더 최신이다. 체결가도 같이 갱신한다.
        if (again.filledQty != null) fill = again;
      } catch { /* 조회 실패는 확정이 아니다 — 다음 차례에 다시 묻는다 */ }
    }

    if (!verdict.settled) {
      // 다 물어봤는데 확정이 안 됐다. **실패로 찍지 않는다** — 재시도가
      // 열리고 그 재시도가 그대로 중복 체결이 된다. 대조가 나중에 푼다.
      pollNote = ` · ⚠ ${verdict.reason} — 결과가 확정되지 않았습니다`;
    }

    if (verdict.phase === 'UNFILLED') {
      await update({ status: 'REJECTED', exchange_order_id: String(gres?.id ?? ''),
        filled_qty: 0, error_message: verdict.reason });
      return { ok: false, status: 'REJECTED', clientOrderId,
        exchangeOrderId: gres?.id != null ? String(gres.id) : undefined, filledQty: 0,
        message: `체결되지 않았습니다 — ${verdict.reason}` };
    }

    await update({
      status: 'ACKED', exchange_order_id: String(gres?.id ?? ''),
      acked_at: new Date().toISOString(),
      // 못 읽었으면 적지 않는다 — 0으로 적으면 '체결 없음'이 사실이 된다
      ...(fill.filledQty != null ? { filled_qty: fill.filledQty } : {}),
      ...(fill.avgPrice != null ? { avg_price: fill.avgPrice } : {}),
    });

    // ── 손절 부착 ──
    //
    // 청산 주문에는 붙이지 않는다. 진입에는 반드시 붙이고, **실패하면 방금 연
    // 포지션을 즉시 닫는다** — 감사 지적 3번과 같은 규칙이다. 포지션 크기는
    // 손절이 있다는 전제로 계산됐으므로, 그 전제가 없으면 크기를 정당화할
    // 근거가 사라진다.
    //
    // Gate의 price_orders 호출은 실계좌로 검증되지 않았다. 그래서 이 되돌리기가
    // 특히 중요하다 — API 모양이 틀렸더라도 결과는 '보호 없는 포지션'이 아니라
    // '포지션 없음 + 실패 보고'가 된다.
    let gateSlId: string | undefined;
    // ── 되돌릴 때 **같이 지워야 하는 것** ──
    //
    // **2026-08-15 21:16:16에 Gate에 남은 조건부 주문 2건이 여기서 나왔다.**
    // 되읽기 실패로 포지션을 되돌리면서 방금 건 SL·TP는 그대로 뒀다.
    // 포지션이 없어졌으니 그 주문들은 아무도 청구하지 않는 고아가 되고,
    // 그 회차는 HOLDING이 된 적이 없어 settle의 정리 코드가 **실행조차
    // 되지 않는다.** 그래서 등록에 성공한 번호를 여기 모아 둔다.
    const placedProtective: string[] = [];

    /**
     * 진입을 되돌린다 — **포지션과 보호주문을 같이.**
     *
     * 취소 확인은 재조회로만 한다. 거래소가 200을 줬다는 것은 접수이지
     * 지워졌다는 뜻이 아니다.
     */
    const undoEntry = async (): Promise<{ closed: boolean; note: string }> => {
      const undo = await gf.closePositionGateFutures(apiKey, apiSecret, contract, testnet);
      const targets = ownedOrderIds({ placed: placedProtective });
      const attempts: CancelAttempt[] = [];
      for (const id of targets) {
        try {
          const r = await gf.cancelOrderGateFutures(apiKey, apiSecret, id, { bucket: 'price', testnet });
          attempts.push({ id, requested: true, httpOk: !!r.success, response: r.success ? null : r.message });
        } catch (e: any) {
          attempts.push({ id, requested: true, httpOk: false, response: String(e?.message || e) });
        }
      }
      // **취소한 뒤 다시 읽는다.** 못 읽으면 UNKNOWN이고, 그것도 통과가 아니다.
      const leftover = targets.length
        ? await gf.getPriceOrdersGateFutures(apiKey, apiSecret, contract, testnet)
        : [];
      const ledger = cancelLedger({ ids: targets, attempts, leftover });
      return { closed: !!undo.success, note: rollbackNote({ positionClosed: !!undo.success, ledger }) };
    };
    // ── 체결을 확인하기 전에는 손절을 걸지 않는다 ──
    //
    // Gate의 손절은 `auto_size: close_long|close_short`다 — **수량으로
    // 걸지 않고 발동 시점의 남은 전부를 닫는다.** 그래서 "보호 주문이
    // 포지션보다 크다"는 문제는 여기서 안 생긴다.
    //
    // 그런데 **포지션이 없을 때 거는 것**은 다른 문제다. 그 손절은
    // 고아로 남아 다음 진입을 친다 — 반대 방향으로 들어가면 즉시
    // 발동한다(orderCycle의 ORPHAN_PROTECTION이 그 자리다).
    //
    // 그리고 무엇보다, 체결 0에 '손절 부착'이라고 적으면 사용자가
    // 보호된 줄 알고 손을 뗀다. 그 한 줄이 가장 비싸다.
    const protectQty = protectionQtyFor(verdict);

    // 체결이 확정되지 않았으면 **거래소 포지션을 직접 본다.**
    //
    // 주문 응답보다 이쪽이 진짜 근거다. 체결 조회가 늦어도 포지션은
    // 이미 생겼을 수 있고, 그때 손절을 안 걸면 보호 없는 포지션이 남는다.
    // 반대로 정말 아무것도 없으면 걸어서는 안 된다 — 고아 손절이 다음
    // 진입을 친다.
    //
    // **못 읽으면 거는 쪽으로 기운다.** 있는데 안 건 것(보호 없는 포지션)이
    // 없는데 건 것(고아 손절)보다 나쁘다. 고아는 화면이 잡아내지만,
    // 보호 없는 포지션은 가격이 잡아낸다.
    let posAfter: number | null = null;
    if (!args.reduceOnly && args.stopLoss && policy !== 'NONE' && protectQty == null) {
      try {
        const p2 = await gf.getPositionGateFutures(apiKey, apiSecret, contract, testnet);
        posAfter = p2 ? Number(p2.size) || 0 : 0;
      } catch { posAfter = null; }
    }
    const nothingToProtect =
      !args.reduceOnly && args.stopLoss && policy !== 'NONE'
      && protectQty == null && posAfter === 0;

    if (nothingToProtect) {
      // 진입은 나갔는데 포지션이 없다. **'손절 부착'이라고 적지 않는다** —
      // 그 한 줄 때문에 사용자가 보호된 줄 알고 손을 뗀다.
      const warn = `체결이 확인되지 않았고 거래소에도 포지션이 없어 손절을 걸지 않았습니다`
        + ` (${verdict.reason}). 체결이 확인되면 포지션 탭에서 손절을 걸어 주세요.`;
      await update({ status: 'ACKED', exchange_order_id: String(gres?.id ?? ''),
        error_message: warn });
      return {
        ok: true, status: 'ACKED', clientOrderId,
        exchangeOrderId: gres?.id != null ? String(gres.id) : undefined,
        filledQty: verdict.filledQty ?? undefined,
        avgPrice: fill.avgPrice ?? undefined,
        settled: verdict.settled,
        unprotected: false,   // 지킬 포지션이 없다 — '보호 안 됨'이 아니다
        message: `주문 접수 (Gate · ${sized.size}계약) · ${verdict.reason}`
          + ' · 포지션 없음 · 손절 대기' + pollNote,
      };
    }
    // ── 실제 체결가에서 보호주문 가격을 다시 만든다 ──
    //
    // `stopSpec`은 판단 참고가로 계산된 값이다. 시장가 100배는 그 가격에
    // 체결되지 않는다 — 밀린 만큼 손절 거리가 달라지고, 청산 거리가
    // 0.6%인 자리에서 그건 손절이 아니라 청산이 된다.
    //
    // **`exitPct`를 안 준 호출부는 지금까지와 똑같이 동작한다.**
    let liveStopSpec = stopSpec;
    let tpSpec: ReturnType<typeof gp.gateTakeProfitSpec> | null =
      args.takeProfit != null ? gp.gateTakeProfitSpec(plan.side, args.takeProfit, null, gspec) : null;
    let exitBasis: ExecuteResult['exitBasis'] = null;

    if (!args.reduceOnly && args.exitPct && policy !== 'NONE' && !noFixedTp) {
      const basis = fillBasis({
        avgPrice: fill.avgPrice, filledQty: verdict.filledQty ?? fill.filledQty,
        settled: verdict.settled,
      });
      const e = exitFromFill({
        side: plan.side, basis,
        stopPct: args.exitPct.stopPct,
        takeProfitPct: args.exitPct.takeProfitPct ?? null,
        tickSize: Number((gspec as any)?.orderPriceRound) || null,
        // 판단 참고가. 얼마나 밀렸는지를 **기록만** 한다 — 판정에는 안 쓴다.
        referencePrice: Number((plan as any).entryPrice) || null,
      });
      if (!e.ok) {
        // **체결가를 모르면 참고가로 대신 걸지 않는다.** 그 손절은 아무
        // 근거가 없다. 자동매매(REQUIRED)에서는 방금 연 포지션을 되돌린다.
        if (policy === 'REQUIRED') {
          const undo = await undoEntry();
          const msg = `실제 체결가를 확정하지 못해 보호주문을 걸 수 없었습니다 — ${e.reason}`
            + ` · ${undo.note}`;
          await update({ status: 'FAILED', error_message: msg });
          return { ok: false, status: 'FAILED', clientOrderId,
            exchangeOrderId: gres?.id != null ? String(gres.id) : undefined, message: msg };
        }
      } else {
        liveStopSpec = gp.gateStopSpec(plan.side, e.stop, e.basisPrice, gspec);
        tpSpec = e.takeProfit != null
          ? gp.gateTakeProfitSpec(plan.side, e.takeProfit, e.basisPrice, gspec) : null;
        exitBasis = {
          basisPrice: e.basisPrice, slippagePct: e.slippagePct,
          stop: e.stop, takeProfit: e.takeProfit, note: e.note,
        };
      }
    }

    if (!args.reduceOnly && args.stopLoss && policy !== 'NONE') {
      // spec을 통째로 넘긴다. 예전에는 rule·autoSize만 spec에서 꺼내고
      // triggerPrice는 원본 손절가를 넘겨서, 호가 단위에 맞춰 둔 값이
      // 아무 데도 안 쓰였다 — 계산해 놓고 배선을 안 한 것이다.
      const sl = await gf.placeStopGateFutures(apiKey, apiSecret, {
        // **문자열을 이어 붙이지 않는다.** `…E0SL`은 소유권 형식이 아니라
        // 되읽을 때 UNKNOWN이 되고, 그러면 안전을 이유로 안 지워서
        // 거래소에 계속 쌓인다 — 실제로 스모크 SL/TP가 그렇게 남았다.
        contract, spec: liveStopSpec,
        clientOrderId: protectiveClientOrderId(clientOrderId, 'STOP_LOSS'),
      }, testnet);

      if (sl.success) {
        gateSlId = sl.orderId;
        // **등록에 성공한 번호를 즉시 적어 둔다.** 되읽기가 실패해도
        // 이 번호로는 내 주문임을 확정할 수 있다.
        if (sl.orderId) placedProtective.push(String(sl.orderId));
        await update({ sl_order_id: sl.orderId ?? null });
      } else if (policy !== 'REQUIRED') {
        // 수동 진입 — 되돌리지 않는다. 사람이 보고 있고, 되돌리면 그 사람이
        // 의도한 포지션이 수수료만 남기고 사라진다. 대신 크게 알린다.
        const warn = `⚠ 진입은 체결됐지만 요청한 손절이 등록되지 않았습니다 (${sl.message})`
          + '. **지금 보호되지 않은 포지션입니다** — 거래소에서 직접 손절을 걸거나 포지션을 닫으세요.';
        await update({ status: 'ACKED', error_message: warn });
        return {
          ok: true, status: 'ACKED', clientOrderId,
          exchangeOrderId: gres?.id != null ? String(gres.id) : undefined,
          filledQty: fill.filledQty ?? undefined,
          avgPrice: fill.avgPrice ?? undefined,
          unprotected: true, message: warn,
        };
      } else {
        const undo = await undoEntry();
        const msg = `손절을 걸지 못했습니다 — ${sl.message} · ${undo.note}`;
        await update({ status: 'FAILED', error_message: msg });
        return { ok: false, status: 'FAILED', clientOrderId,
          exchangeOrderId: String(gres?.id), message: msg };
      }
    }

    // ── 익절도 실제로 건다 ──
    //
    // **여기가 비어 있었다.** `takeProfit`과 `exitPlan`이 Gate 분기에서
    // 아무 데도 안 쓰였다 — 화면은 "익절 +0.8%"라고 적는데 거래소에는
    // 아무것도 없었다. 만들어 놓고 배선을 안 한 이 저장소의 대표 고장이다.
    //
    // 익절은 손절과 달리 **못 걸어도 포지션을 되돌리지 않는다** —
    // 이익을 확정하는 주문이지 방어선이 아니다. 다만 전략이 필수로
    // 요구하면(`requireTakeProfit`) 아래 되읽기 판정에서 걸린다.
    let gateTpId: string | undefined;
    let tpNote = '';
    if (!args.reduceOnly && !noFixedTp && tpSpec) {
      if (!tpSpec.ok) {
        tpNote = ` · ⚠ 익절을 걸지 못했습니다: ${tpSpec.reason}`;
      } else {
        const tp = await gf.placeStopGateFutures(apiKey, apiSecret, {
          contract, spec: tpSpec,
          clientOrderId: protectiveClientOrderId(clientOrderId, 'TAKE_PROFIT'),
        }, testnet);
        if (tp.success) {
          gateTpId = tp.orderId;
          if (tp.orderId) placedProtective.push(String(tp.orderId));
          await update({ tp_order_id: tp.orderId ?? null });
        } else {
          tpNote = ` · ⚠ 익절을 걸지 못했습니다: ${tp.message}`;
        }
      }
    }

    // ── 걸었다고 적기 전에 다시 읽는다 ──
    //
    // 생성 응답은 **접수**다. 트리거가 반대편이거나 포지션이 없으면
    // 접수된 주문이 조용히 사라진다. 그래서 목록을 다시 읽어 종목·닫는
    // 방향·트리거 가격으로 대조한다.
    //
    // **못 읽은 것을 '없음'으로 적지 않는다.** 그때는 위쪽 진입 완료
    // 판정이 UNKNOWN이 되고, 되돌리지도 재시도하지도 않는다.
    let protection: ExecuteResult['protection'] = null;
    if (!args.reduceOnly && policy !== 'NONE' && args.stopLoss) {
      const rows = await gf.getPriceOrdersGateFutures(apiKey, apiSecret, contract, testnet);
      const rb = readbackProtective({
        orders: rows, venue: 'gate', positionSide: plan.side,
        expectedStop: liveStopSpec.triggerPrice,
        expectedTakeProfit: tpSpec?.ok ? tpSpec.triggerPrice : null,
      });
      protection = { readOk: rb.readOk, stop: rb.stop, takeProfit: rb.takeProfit, reason: rb.reason };

      // **조회에 성공했는데 손절이 없다** — 접수는 됐지만 등록되지 않았다.
      // 이건 '모른다'가 아니라 확인된 사실이므로 REQUIRED에서는 되돌린다.
      const stopConfirmedMissing = rb.readOk && !rb.stop.found;
      const tpConfirmedMissing = rb.readOk && args.exitPct?.requireTakeProfit === true && !rb.takeProfit.found;
      if ((stopConfirmedMissing || tpConfirmedMissing) && policy === 'REQUIRED') {
        // 되읽기에서 확인된 번호도 되돌리기 대상이다. 등록 응답이 번호를
        // 안 줬는데 거래소에는 걸려 있는 경우가 그것이다 — 그 주문이
        // 8/15에 남았다.
        for (const id of ownedOrderIds({ readback: [rb.stop.orderId, rb.takeProfit.orderId] })) {
          if (!placedProtective.includes(id)) placedProtective.push(id);
        }
        const undo = await undoEntry();
        const msg = `보호주문을 거래소에서 확인하지 못했습니다 (${rb.reason}) — ${undo.note}`;
        await update({ status: 'FAILED', error_message: msg });
        return {
          ok: false, status: 'FAILED', clientOrderId,
          exchangeOrderId: gres?.id != null ? String(gres.id) : undefined,
          protection, exitBasis, message: msg,
        };
      }
    }

    const gClose = args.reduceOnly
      ? await remainingAfterClose({ exchange, apiKey, apiSecret, testnet }, plan.symbol)
      : { remaining: null, note: '' };

    return {
      ok: true, status: 'ACKED', clientOrderId,
      exchangeOrderId: gres?.id != null ? String(gres.id) : undefined,
      settled: verdict.settled,
      filledQty: verdict.filledQty ?? undefined,
      avgPrice: fill.avgPrice ?? undefined,
      slOrderId: gateSlId,
      tpOrderId: gateTpId,
      protection, exitBasis,
      // 배율·마진 모드는 위에서 `setLeverageGateFutures`가 확정했고,
      // 실패하면 주문 전에 멈춘다. 여기까지 왔으면 확인된 것이다.
      leverageConfirmed: args.reduceOnly ? null : true,
      positionModeConfirmed: true,
      remainingQty: gClose.remaining,
      // **접수와 체결을 한 문장에 섞지 않는다.** 예전에는 "부분 체결
      // 0/2079 · 손절 부착"이 한 줄에 같이 나왔다 — 둘 다 사실일 수 없다.
      message: `주문 접수 (Gate · ${sized.size}계약 = ${plan.quantity} ${plan.symbol.replace(/USDT$/, '')})`
        + ` · ${verdict.reason}`
        + (sized.reason ? ` · ${sized.reason}` : '')
        + (liveStopSpec.note ? ` · ${liveStopSpec.note}` : '')
        + (exitBasis ? ` · 실제 체결가 ${exitBasis.basisPrice} 기준`
          + (exitBasis.slippagePct != null ? ` (참고가 대비 ${exitBasis.slippagePct > 0 ? '+' : ''}${exitBasis.slippagePct}%)` : '') : '')
        + gClose.note
        + (gateSlId ? ' · 손절 부착 (전량 종료형)' : '')
        + (gateTpId ? ' · 익절 부착' : '')
        + tpNote
        + (protection ? ` · 되읽기: ${protection.reason}` : '')
        + pollNote,
    };

  } catch (e: any) {
    await update({ status: 'FAILED', error_message: e?.message || String(e) });
    return { ok: false, status: 'FAILED', clientOrderId, message: e?.message || '주문 실패' };
  }
  })();
  return { ...result, message: withPersistNote(result.message) };
}

// ── 재시작 복구: UNKNOWN/SENT 상태 주문을 거래소와 대조 ──
//
// 예전 구현은 "거래소에 주문이 안 보이면 전송되지 않은 것"으로 즉시 FAILED를
// 찍었다. 그런데 거래소가 아직 반영을 못 했거나, 조회가 실패했거나, 우리가
// 멱등 키를 안 붙여 식별을 못 하는 경우도 전부 "안 보임"으로 들어온다.
// FAILED로 찍히면 재시도가 열리고, 그 재시도가 그대로 중복 체결이 된다.
//
// 판단 규칙은 unknownResolver.ts(순수 함수)로 옮겼다. 여기서는 조회만 해서
// 넘긴다 — 규칙이 코드 안에 흩어져 있으면 테스트로 확인할 수가 없다.
export interface ReconcileResult {
  checked: number; resolved: number; stillUnknown: number;
  /**
   * 거래소에 **아직 열려 있다고 확인된** 건수.
   *
   * 미확정(`stillUnknown`)과 다르다. 이쪽은 상태를 알았고, 그 상태가
   * "아직 안 끝났다"인 것이다. 둘을 한 칸에 담으면 "모름"으로 보여서
   * 사람이 손을 대게 된다.
   */
  stillOpen: number;
  /** 자동 판단이 불가능해 사람이 봐야 하는 건수 */
  needsAttention: number;
  details: string[];
}

/**
 * **확정된 뒤에 손절이 없으면 지금 건다.**
 *
 * 왜 필요한가 — 실제로 이렇게 됐다
 * ─────────────────────────────────
 * 진입 요청이 응답을 못 받으면 executeOrder는 UNKNOWN으로 기록하고 **즉시
 * 반환한다.** 그 자리에서 끝나므로 손절 부착 단계는 **한 번도 실행되지
 * 않는다.** 그런데 주문은 거래소에 실제로 들어가 있을 수 있다.
 *
 * 그러면 이런 상태가 남는다:
 *
 *   거래소:  Positions (1) · Orders (0)     ← 포지션은 있고 손절은 없다
 *   앱:      UNKNOWN → 나중에 RECONCILED
 *
 * 대조는 주문 상태만 맞추고 끝났다. **보호되지 않은 포지션이 그대로
 * 남는다** — 그리고 아무도 그걸 다시 걸어 주지 않았다.
 *
 * 규칙
 * ────
 * · 포지션이 **실제로 있을 때만** 건다. 없는 포지션에 손절을 걸면 다음
 *   진입을 예상치 못하게 닫는다
 * · 계획에 손절가가 적혀 있을 때만 건다. 없는 값을 지어내지 않는다
 * · 실패해도 포지션을 되돌리지 않는다. 여기는 **복구**이지 진입이 아니고,
 *   이미 열려 있는 것을 닫는 판단은 사람의 몫이다. 대신 그 사실을 남긴다
 */
async function attachStopIfMissing(
  sb: any,
  creds: { exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean },
  o: any,
): Promise<string | null> {
  // **판정은 `stopReattachVerdict` 한 곳에 있다.** 여기서 조건을 다시
  // 쓰면 시험되는 규칙과 실제로 도는 규칙이 갈린다.
  const verdict = stopReattachVerdict(o);
  if (!verdict.attach) return verdict.note || null;
  const stop = verdict.stopPrice as number;

  const symbol = String(o?.symbol || '').toUpperCase();
  if (!symbol) return null;
  // 진입 방향. BUY로 들어갔으면 롱이고, 닫는 주문은 SELL이다.
  const posSide: 'LONG' | 'SHORT' = String(o?.side).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  const closeSide: 'BUY' | 'SELL' = posSide === 'LONG' ? 'SELL' : 'BUY';

  try {
    if (creds.exchange === 'gate') {
      const gf = await import('@/lib/exchanges/gateFutures');
      const gp = await import('@/lib/exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;

      // **포지션이 실제로 있는지 먼저 본다.**
      const pos = await gf.getPositionGateFutures(creds.apiKey, creds.apiSecret, contract, creds.testnet);
      const size = Number(pos?.size ?? 0);
      if (!size) return null;                     // 포지션 없음 — 걸 이유가 없다
      // 방향이 어긋나면 걸지 않는다. 반대 방향 손절은 즉시 발동한다.
      if ((size > 0 ? 'LONG' : 'SHORT') !== posSide) {
        return `손절 복구 안 함 — 기록은 ${posSide}인데 거래소 포지션은 ${size > 0 ? 'LONG' : 'SHORT'}입니다`;
      }

      const spec = await gf.getGateContractSpec(contract, creds.testnet);
      const stopSpec = gp.gateStopSpec(posSide, stop, null, spec);
      if (!stopSpec.ok) return `손절 복구 실패 — ${stopSpec.reason}`;

      const sl = await gf.placeStopGateFutures(creds.apiKey, creds.apiSecret, {
        contract, spec: stopSpec, clientOrderId: `${o.client_order_id}R`,
      }, creds.testnet);
      if (!sl.success) return `손절 복구 실패 — ${sl.message}`;
      await updateOrderRow(sb, o.id, { sl_order_id: sl.orderId ?? null });
      return `손절 복구 완료 (${stopSpec.triggerPrice})`;
    }

    const bf = await import('@/lib/exchanges/binanceFutures');
    const rr = await bf.getSymbolPositionRiskEx(creds.apiKey, creds.apiSecret, symbol, creds.testnet);
    const amt = Number(rr.risk?.positionAmt ?? 0);
    if (!amt) return null;
    if ((amt > 0 ? 'LONG' : 'SHORT') !== posSide) {
      return `손절 복구 안 함 — 기록은 ${posSide}인데 거래소 포지션은 ${amt > 0 ? 'LONG' : 'SHORT'}입니다`;
    }

    // 복구 시에도 최초 손절 부착과 동일한 격자/방향 정본을 사용한다.
    // 필터 미상 시 기존 closePosition 우선 시도는 유지한다.
    const filters = await bf.getSymbolFilters(symbol, creds.testnet);
    const tick = filters?.tickSize && filters.tickSize > 0 ? filters.tickSize : null;
    const trigger = roundTrigger(stop, posSide, 'STOP', tick);
    if (trigger.price == null) return `손절 복구 실패 — 트리거 가격을 확인할 수 없습니다: ${trigger.note}`;
    const quantized = quantizeOrder(Math.abs(amt), null, filters,
      { orderType: 'MARKET', reduceOnly: true });
    const fallbackQuantity = quantized.ok && quantized.quantity != null && quantized.quantity > 0
      ? quantized.quantity : Math.abs(amt);
    const sl: any = await bf.placeFuturesTPSL(creds.apiKey, creds.apiSecret, {
      symbol, side: closeSide, stopPrice: trigger.price, type: 'STOP_MARKET',
      fallbackQuantity,
    }, creds.testnet);
    if (!sl?.success) return `손절 복구 실패 — ${sl?.message || '원인 불명'}`;
    await updateOrderRow(sb, o.id, { sl_order_id: String(sl.orderId) });
    return `손절 복구 완료 (${stop})`;
  } catch (e: any) {
    return `손절 복구 실패 — ${e?.message || e}`;
  }
}

export async function reconcilePendingOrders(
  sb: any,
  creds: {
    exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean;
    /**
     * **누구의 주문을 대조하는가.**
     *
     * 이게 없어서 이 함수는 `status IN (SENT, UNKNOWN) AND exchange = 'binance'`로
     * **모든 사용자의 주문**을 긁어 왔다. 그리고 그것을 **한 사람의 API 키**로
     * 거래소에 물어봤다. 남의 주문은 이 계좌에 있을 리 없으니 "거래소에
     * 없음"으로 판정되고, 그 판정이 남의 행에 쓰인다.
     *
     * 서버 전용 경로라 외부에서 부를 수는 없지만, 한 사용자의 대조가 다른
     * 사용자의 장부를 바꾸는 것은 그 자체로 사고다.
     */
    userId?: string | null;
    /**
     * 어느 연결의 주문인가. 연결이 곧 거래소이자 망(실전/테스트넷)이다.
     *
     * 없으면 테스트넷에서 만든 주문을 실전 거래소에 물어보게 되고,
     * 거래소는 모른다고 답한다 — 그 기록은 영영 확정되지 않고 상태
     * 대조를 영구히 막는다. 실제로 이 계좌가 그 상태였다.
     */
    connectionId?: string | null;
  }
): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, resolved: 0, stillUnknown: 0, stillOpen: 0, needsAttention: 0, details: [] };

  // **ACKED가 빠져 있었다.**
  //
  // ACKED는 "거래소가 접수했다"는 상태다. 그 뒤 체결·취소로 넘어가는
  // 경로가 아무 데도 없어서, 한번 ACKED가 된 주문은 영원히 ACKED로
  // 남았다. 그런데 상태 대조는 ACKED를 "열려 있는 주문"이자 (수량이
  // 있으면) "보유 중인 포지션"으로 읽는다.
  //
  // 결과: 거래소에는 아무것도 없는데 앱은 계속 있다고 믿고, **신규
  // 진입이 영구히 막힌다.** [미확정 주문 확정]을 눌러도 안 풀렸다 —
  // 그 버튼이 여기를 부르는데 ACKED를 조회하지 않았으니까.
  let q = sb.from('live_orders')
    .select('*')
    .in('status', [...RECONCILE_QUERY_STATUSES])
    .eq('exchange', creds.exchange);
  // **모르면 좁히지 않는다.** 좁히지 않으면 과하게 대조할 뿐이지만,
  // 잘못 좁히면 진짜 미확정 주문을 놓친다.
  if (creds.userId) q = q.eq('user_id', creds.userId);
  if (creds.connectionId) q = q.eq('connection_id', creds.connectionId);

  const { data: pending } = await q
    .order('created_at', { ascending: true })
    .limit(50);

  if (!Array.isArray(pending) || !pending.length) return out;

  const { resolveUnknown, resolveAcked, shouldEscalate } = await import('./unknownResolver');

  // 포지션은 심볼마다 다시 부르지 않고 한 번만 읽는다. 대조 한 번에 50건이
  // 들어올 수 있어 건마다 부르면 레이트리밋에 걸린다.
  let posBySymbol: Map<string, number> | null = null;
  if (creds.exchange === 'binance') {
    try {
      const bf = await import('@/lib/exchanges/binanceFutures');
      const pr: any = await bf.getFuturesPositions(creds.apiKey, creds.apiSecret, creds.testnet);
      if (pr?.success) {
        posBySymbol = new Map(
          (pr.positions as any[]).map((p: any) => [String(p.symbol).toUpperCase(), Number(p.amount) || 0]),
        );
      }
    } catch { posBySymbol = null; }   // null이면 교차 확인 불가로 취급된다
  } else {
    // Gate도 교차 확인을 한다. 예전에는 이 분기가 없어서 '주문이 안 보임'만으로
    // 판단했다 — 조회가 늦게 반영되는 거래소에서 그건 중복 주문의 근거가 된다.
    try {
      const gf = await import('@/lib/exchanges/gateFutures');
      const rows = await gf.getPositionsGateFutures(creds.apiKey, creds.apiSecret, creds.testnet);
      posBySymbol = new Map(
        rows.map((p: any) => [String(p.contract || '').replace('_', '').toUpperCase(), Number(p.size) || 0]),
      );
    } catch { posBySymbol = null; }
  }

  for (const o of pending) {
    out.checked++;
    const attempts = Number(o.resolve_attempts) || 0;
    try {
      if (creds.exchange === 'binance') {
        const bf = await import('@/lib/exchanges/binanceFutures');

        // findOrderByClientId는 "없음"(-2013)만 found:false로 돌려주고 그 외
        // 오류는 던진다. 던진 것은 조회 실패이지 주문 없음이 아니다.
        let query: { ok: boolean; order: any | null; error?: string };
        try {
          const r = await bf.findOrderByClientId(
            creds.apiKey, creds.apiSecret, o.symbol, o.client_order_id, creds.testnet);
          query = { ok: true, order: r.found ? r.order : null };
        } catch (e: any) {
          query = { ok: false, order: null, error: e?.message || String(e) };
        }

        const sentAt = o.sent_at || o.created_at;
        const elapsedMs = sentAt ? Date.now() - new Date(sentAt).getTime() : 0;

        // 기준값이 없으면 비교 자체가 불가능하므로 교차 확인을 생략한다
        // (018 이전에 만들어진 행). 그 사실은 확정 사유에 남는다.
        const before = o.pos_qty_before;
        const position = before === null || before === undefined ? undefined : {
          qtyBefore: Number(before),
          qtyNow: posBySymbol ? (posBySymbol.get(String(o.symbol).toUpperCase()) ?? 0) : null,
        };

        // **상태마다 규칙이 다르다.**
        // SENT/UNKNOWN은 "보냈는지도 모르는" 상태라, 주문이 안 보이면
        // 전송 안 됨(FAILED)으로 확정할 수 있다.
        // ACKED는 거래소가 이미 받았다고 확인해 준 상태다. 지금 안 보이는
        // 것은 "안 들어갔다"가 아니라 "이미 끝났다"이므로 FAILED로 찍으면
        // 장부가 거짓말을 하고, FAILED는 재시도가 열리는 상태라 중복
        // 체결의 문이 된다.
        const args = { clientOrderId: o.client_order_id || null, elapsedMs, query, position };
        const verdict = String(o.status) === 'ACKED'
          ? resolveAcked(args)
          : resolveUnknown(args);

        const reFacts = query.order ? fillFactsOf(query.order) : null;

        // ── `resolved`는 "끝났다"가 아니다 ──
        //
        //   여기 있던 식은 FILLED/FAILED/REJECTED가 아닌 **모든** 확정을
        //   `RECONCILED`로 적었다. 거래소가 `NEW`를 돌려주면 판정은
        //   `ACKED`(아직 열려 있음)인데도 종료로 적힌 것이다. 그리고
        //   `RECONCILED`는 대조 대상이 아니라 아무도 다시 조회하지 않는다
        //   — 살아 있는 주문이 장부에서 사라졌다. 부분 체결도 같았다.
        //   판정→장부 변환은 reconcileLedgerStatus 하나에만 둔다.
        //   그리고 상태와 수량을 따로 적던 자리이기도 하다. 거래소가
        //   `FILLED`를 돌려주면서 수량을 주지 않으면 `status:'FILLED'` +
        //   `filled_qty: null`이라는 모순이 적혔다 — 체결 증거 없이
        //   체결을 적는 것이다. 같은 증거 규칙(withFillEvidence)을 쓴다.
        const decision = verdict.resolved
          ? withFillEvidence(ledgerStatusOf(verdict.state), reFacts ? reFacts.filledQty : null)
          : null;
        if (decision && decision.terminal) {
          const st = decision.status;
          await updateOrderRow(sb, o.id, {
            status: st,
            exchange_order_id: query.order?.orderId != null ? String(query.order.orderId) : o.exchange_order_id,
            // ── 여기도 `|| '0'`이었다 ──
            //
            //   미체결·취소된 주문의 `avgPrice`는 `'0'`이고, 그것을 가격으로
            //   적으면 0이 값이 된다. 접수 단계는 이미 고쳤는데 이 자리는
            //   남아 있었다 — 경로가 둘인데 한쪽만 고친 것이다.
            //
            //   상태는 `verdict`가 정본이고, 수량·가격은 거래소 응답이
            //   정본이다. 둘을 섞지 않는다. 부분 체결 뒤 취소된 주문의
            //   채워진 수량은 **사실이므로 보존된다**(fillFactsOf가 상태와
            //   무관하게 executedQty를 읽는다).
            filled_qty: reFacts ? reFacts.filledQty : o.filled_qty,
            avg_price: reFacts ? reFacts.avgPrice : o.avg_price,
            error_message: verdict.resolved && st === 'FAILED' ? verdict.reason : o.error_message,
            reconciled_at: new Date().toISOString(),
            resolve_attempts: attempts + 1,
            last_resolve_at: new Date().toISOString(),
            needs_attention: false,
          });
          out.resolved++;
          out.details.push(`${o.symbol} ${o.client_order_id} → ${verdict.state} (${verdict.reason})`);
          // **확정만 하고 끝내지 않는다.** 응답을 못 받아 UNKNOWN이 된
          // 주문은 손절 부착 단계에 도달한 적이 없다 — 포지션은 열렸는데
          // 보호가 없는 상태로 남는다. 여기서 한 번 더 건다.
          if (st === 'FILLED' || st === 'RECONCILED') {
            const rep = await attachStopIfMissing(sb, creds, o);
            if (rep) out.details.push(`${o.symbol} ${rep}`);
          }
        } else if (decision) {
          // ── 상태는 알았지만 아직 안 끝났다 ──
          //
          //   거래소가 `NEW`(열려 있음) 또는 `PARTIALLY_FILLED`(잔량이
          //   열려 있음)를 돌려준 경우다. 수량·가격 사실은 지금 갱신하되
          //   `reconciled_at`은 찍지 않는다 — 다음 대조가 이 줄을 다시
          //   조회해서 끝낸다. UNKNOWN으로도 적지 않는다(모르는 게 아니다).
          await updateOrderRow(sb, o.id, {
            status: decision.status,
            exchange_order_id: query.order?.orderId != null ? String(query.order.orderId) : o.exchange_order_id,
            filled_qty: reFacts ? reFacts.filledQty : o.filled_qty,
            avg_price: reFacts ? reFacts.avgPrice : o.avg_price,
            resolve_attempts: attempts + 1,
            last_resolve_at: new Date().toISOString(),
            needs_attention: false,
          });
          out.stillOpen++;
          if (decision.needsAttention) {
            // 상태와 수량이 모순이다. 열린 주문으로 두되 사람이 보게 한다.
            await updateOrderRow(sb, o.id, {
              needs_attention: true, error_message: decision.attentionReason,
            });
            out.needsAttention++;
          }
          out.details.push(
            `${o.symbol} ${o.client_order_id} → ${verdict.state} · 거래소에 아직 열려 있음`
            + ` (${decision.needsAttention ? decision.attentionReason : verdict.reason})`);
          // **부분 체결은 포지션이 생긴 것이다.** 주문이 안 끝났다는
          // 이유로 보호를 미루면 보호 없는 포지션이 남는다.
          if (reFacts && reFacts.filledQty != null && reFacts.filledQty > 0) {
            const rep = await attachStopIfMissing(sb, creds, o);
            if (rep) out.details.push(`${o.symbol} ${rep}`);
          }
        } else {
          // 확정 못 함. 시도 횟수가 넘었거나 모순이면 사람에게 넘긴다.
          const escalate = verdict.action === 'ESCALATE' || shouldEscalate(attempts + 1);
          await updateOrderRow(sb, o.id, {
            status: 'UNKNOWN',
            error_message: verdict.reason,
            resolve_attempts: attempts + 1,
            last_resolve_at: new Date().toISOString(),
            needs_attention: escalate,
          });
          out.stillUnknown++;
          if (escalate) out.needsAttention++;
          out.details.push(
            `${o.symbol} ${o.client_order_id} → 미확정${escalate ? ' ⚠ 사람 확인 필요' : ''} (${verdict.reason})`);
        }
      } else {
        const gf = await import('@/lib/exchanges/gateFutures');
        const gp = await import('@/lib/exchanges/gatePlan');
        // 계약 이름 변환은 toGateContract 한 곳에만 둔다. 예전에는 여기서
        // `replace('USDT','_USDT')`를 직접 했다 — 소문자 심볼이나 USDT가 앞에
        // 오는 이름에서 다른 결과가 나온다.
        const contract = gp.toGateContract(o.symbol);
        const hit = await gf.findOrderByClientIdGateFutures(
          creds.apiKey, creds.apiSecret, contract, o.client_order_id, creds.testnet);

        const sentAt = o.sent_at || o.created_at;
        const elapsedMs = sentAt ? Date.now() - new Date(sentAt).getTime() : 0;

        // 기준값이 없으면 비교가 불가능하므로 교차 확인을 생략한다 (바이낸스와 동일).
        const gBefore = o.pos_qty_before;
        const position = gBefore === null || gBefore === undefined ? undefined : {
          qtyBefore: Number(gBefore),
          qtyNow: posBySymbol ? (posBySymbol.get(String(o.symbol).toUpperCase()) ?? 0) : null,
        };

        // ── 주문을 찾았으면 Gate 어휘로 판정한다 ──
        //
        //   여기는 찾은 주문을 `{ status: 'NEW' }`로 **지어내서**
        //   `resolveUnknown`에 넘겼다. 바이낸스 상태표에 Gate의
        //   `open`/`finished`를 넣으면 전부 해석 불가가 되기 때문에 생긴
        //   우회였는데, 그 우회가 **끝난 주문·체결된 주문·취소된 주문을
        //   전부 "열려 있음"으로 읽게** 만들었다. 그리고 그 뒤에 장부엔
        //   종료가 적혔으니 두 거짓이 서로를 가렸다.
        //
        //   찾지 못한 경우(유예·미발견·조회 실패)의 판단은 그대로
        //   `resolveUnknown`이 한다 — 그쪽은 Gate 어휘와 무관하다.
        const gFill = hit.ok && hit.order ? gp.gateFillOf(hit.order) : null;
        let gDecision: ReturnType<typeof ledgerStatusOfGate> | null = null;
        let gReason = '';
        if (hit.ok && hit.order) {
          const finishAs = (hit.order as any).finish_as as string | undefined;
          gDecision = ledgerStatusOfGate({
            status: hit.order.status, finishAs, filledQty: gFill ? gFill.filledQty : null,
          });
          gReason = `Gate 조회로 확정: ${hit.order.status ?? '불명'}`
            + `${finishAs ? `/${finishAs}` : ''}`
            + (gDecision.needsAttention ? ` · ${gDecision.attentionReason}` : '');
        }
        const verdict = resolveUnknown({
          clientOrderId: o.client_order_id || null, elapsedMs,
          // 조회 실패를 '주문 없음'으로 넘기지 않는다 — resolveUnknown이
          // ok:false를 '확인 못 함'으로 다룬다.
          query: hit.ok
            ? { ok: true, order: null }
            : { ok: false, order: null, error: hit.error },
          position,
        });
        if (gDecision == null && verdict.resolved) {
          gDecision = { ...ledgerStatusOf(verdict.state), needsAttention: false, attentionReason: null };
          gReason = verdict.reason;
        }
        if (gDecision && gDecision.terminal) {
          await updateOrderRow(sb, o.id, {
            status: gDecision.status,
            exchange_order_id: hit.order ? String(hit.order.id) : o.exchange_order_id,
            // **체결 수량을 여기서 처음 적는다.** 예전에는 Gate 대조가
            // 수량을 아예 쓰지 않아, 부분 체결된 주문의 채워진 수량이
            // 장부에 들어오지 않았다.
            ...(gFill ? { filled_qty: gFill.filledQty, avg_price: gFill.avgPrice } : {}),
            error_message: gDecision.status === 'FAILED' ? gReason : null,
            reconciled_at: new Date().toISOString(),
            resolve_attempts: attempts + 1, last_resolve_at: new Date().toISOString(),
            needs_attention: false,
          });
          out.resolved++;
          out.details.push(`${o.symbol} ${o.client_order_id} → ${gDecision.status} (Gate: ${gReason})`);
          // 실패로 확정된 것은 포지션이 없다. 그 외에는 열려 있을 수 있으므로
          // 손절이 비어 있으면 지금 건다 — attachStopIfMissing이 포지션
          // 존재를 다시 확인한다.
          if (gDecision.status !== 'FAILED') {
            const rep = await attachStopIfMissing(sb, creds, o);
            if (rep) out.details.push(`${o.symbol} ${rep}`);
          }
        } else if (gDecision) {
          // 거래소에 아직 열려 있다. 끝났다고 적지 않고 다음 대조에 넘긴다.
          await updateOrderRow(sb, o.id, {
            status: gDecision.status,
            exchange_order_id: hit.order ? String(hit.order.id) : o.exchange_order_id,
            ...(gFill ? { filled_qty: gFill.filledQty, avg_price: gFill.avgPrice } : {}),
            resolve_attempts: attempts + 1, last_resolve_at: new Date().toISOString(),
            ...(gDecision.needsAttention
              ? { needs_attention: true, error_message: gDecision.attentionReason }
              : { needs_attention: false }),
          });
          out.stillOpen++;
          if (gDecision.needsAttention) out.needsAttention++;
          out.details.push(
            `${o.symbol} ${o.client_order_id} → ${gDecision.status} · 거래소에 아직 열려 있음 (Gate: ${gReason})`);
          // 부분 체결이면 포지션이 생긴 것이다. 포지션 존재 확인은
          // attachStopIfMissing이 직접 한다.
          const rep = await attachStopIfMissing(sb, creds, o);
          if (rep) out.details.push(`${o.symbol} ${rep}`);
        } else {
          const escalate = verdict.action === 'ESCALATE' || shouldEscalate(attempts + 1);
          await updateOrderRow(sb, o.id, {
            status: 'UNKNOWN', error_message: verdict.reason,
            resolve_attempts: attempts + 1, last_resolve_at: new Date().toISOString(),
            needs_attention: escalate,
          });
          out.stillUnknown++;
          if (escalate) out.needsAttention++;
          out.details.push(`${o.symbol} ${o.client_order_id} → 미확정 (Gate: ${verdict.reason})`);
        }
      }
    } catch (e: any) {
      out.stillUnknown++;
      out.details.push(`${o.symbol} ${o.client_order_id} → 대조 실패: ${e?.message || e}`);
    }
  }
  return out;
}
