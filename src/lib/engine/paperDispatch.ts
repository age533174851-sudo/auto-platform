// src/lib/engine/paperDispatch.ts
//
// **모의 자동매매를 켜면 아무 일도 일어나지 않고 있었다.**
//
// 전수 추적 결과
// ──────────────
// 사용자가 자동매매 화면에서 '모의'를 고르면 `autotrade_schedules.mode`에
// `'PAPER'`가 저장되고, 워커가 그 줄을 집어 평가한다. 여기까지는 돈다.
// 그다음이 없었다:
//
//   daily-ladder  gateOrder('PAPER') → disposition 'RECORD'
//                 → live_orders에 INTENT 한 줄. **모의 계좌는 그대로**
//   scalp         RECORD면 아무것도 안 하고 200으로 끝. **기록조차 없다**
//   my-original-v1 **모드 관문이 아예 없다** → PAPER인데
//                 executeOrder(mode:'TESTNET')로 **거래소 테스트넷 실주문**
//
// 즉 세 전략이 모의 모드에서 서로 다른 세 가지 일을 했고, 그중 어느
// 것도 "모의 계좌에 체결한다"가 아니었다. 모의 잔고·손익은 영원히
// 변하지 않고, 사용자는 자동매매가 도는 줄 안다.
//
// 그리고 my-original-v1은 사용자가 **모의를 골랐는데 거래소 계좌를
// 건드린다.** 실제 돈은 아니지만, 고르지 않은 계좌에서 주문이 나가는
// 것은 그 자체가 사고다.
//
// 무엇을 바꾸나
// ─────────────
// **판단은 그대로 두고 실행 어댑터만 가른다.** 같은 전략·같은 평가·같은
// 관문을 통과한 뒤, 마지막에 어디로 체결할지만 다르다:
//
//   TESTNET / LIVE  → 거래소로 주문 (executeOrder)
//   PAPER           → 앱 안 장부에 체결 (openPaperPosition)
//   SHADOW_LIVE     → 기록만 (그게 이 모드의 정의다)
//   UI_DEMO         → 아무것도
//
// 이 판정을 세 라우트가 각자 적으면 언젠가 한 곳만 고쳐진다.
import { capability, type OperatingMode } from './operatingMode';

export type PaperDispatchCode =
  /** 모의 계좌에 체결한다 */
  | 'FILL_PAPER'
  /** 보냈어야 할 주문을 기록만 한다 (Shadow Live) */
  | 'RECORD_ONLY'
  /** 아무것도 하지 않는다 (UI 데모) */
  | 'NOTHING'
  /** 체결에 필요한 값이 없다 — **성공으로 적지 않는다** */
  | 'NO_PLAN'
  /** 거래소로 보내는 모드다 — 이 판정의 대상이 아니다 */
  | 'NOT_PAPER';

export interface PaperDispatchVerdict {
  code: PaperDispatchCode;
  /** 모의 장부에 체결해야 하는가 */
  fill: boolean;
  reason: string;
}

/**
 * 이 모드는 모의 장부에 체결해야 하는가.
 *
 * **`sendsOrders`가 참이면 여기 오면 안 된다.** 거래소로 나가는 주문을
 * 모의 장부에도 적으면 같은 거래가 두 장부에 생긴다.
 */
export function paperDispatchVerdict(i: {
  mode: OperatingMode;
  /** 진입 계획이 있는가. 없으면 체결할 것이 없다 */
  hasPlan: boolean;
  /** 체결 기준가. **없으면 지어내지 않는다** */
  entryPrice: number | null | undefined;
}): PaperDispatchVerdict {
  const cap = capability(i.mode);

  if (cap.sendsOrders) {
    return { code: 'NOT_PAPER', fill: false,
      reason: `${i.mode}는 거래소로 주문을 보내는 모드입니다` };
  }
  if (i.mode === 'UI_DEMO') {
    return { code: 'NOTHING', fill: false,
      reason: 'UI 데모는 주문도 장부도 만들지 않습니다' };
  }
  if (i.mode === 'SHADOW_LIVE') {
    // **모의 장부에 적지 않는다.** Shadow Live는 실계좌로 판단하되 보내지
    // 않는 모드다 — 그 결과를 모의 잔고에 반영하면 두 실험이 섞인다.
    return { code: 'RECORD_ONLY', fill: false,
      reason: 'Shadow Live — 보냈어야 할 주문을 기록만 합니다' };
  }
  if (!i.hasPlan) {
    return { code: 'NO_PLAN', fill: false,
      reason: '진입 계획이 없어 모의 체결을 만들지 않았습니다' };
  }
  const px = Number(i.entryPrice);
  if (!Number.isFinite(px) || px <= 0) {
    // **가격을 못 구했으면 체결을 지어내지 않는다.** 지어낸 체결가 위에
    // 쌓인 손익은 아무 뜻이 없고, 사용자는 그걸 성적표로 읽는다.
    return { code: 'NO_PLAN', fill: false,
      reason: '체결 기준가를 구하지 못해 모의 체결을 만들지 않았습니다 — 0으로 적지 않습니다' };
  }
  return { code: 'FILL_PAPER', fill: true, reason: '모의 계좌에 체결합니다' };
}

/**
 * 장부 환경. **MOCK · TESTNET · LIVE는 절대 합산하지 않는다.**
 *
 * `envOfMode`는 PAPER를 'TESTNET'으로 눕혔다. 그러면 모의 자동매매의
 * 기록이 테스트넷 장부에 섞이고, 그 뒤로는 둘을 못 가른다.
 */
export function ledgerEnvOfMode(mode: any): 'MOCK' | 'TESTNET' | 'LIVE' {
  const m = String(mode || '').toUpperCase();
  if (m.startsWith('LIVE') || m === 'SHADOW_LIVE') return 'LIVE';
  if (m === 'PAPER' || m === 'UI_DEMO') return 'MOCK';
  return 'TESTNET';
}

export interface PaperEntryResult {
  ok: boolean;
  code: PaperDispatchCode | 'FILLED' | 'FAILED' | 'DUPLICATE';
  positionId: string | null;
  fill: any | null;
  reason: string;
}

/**
 * 모의 계좌에 진입을 체결한다.
 *
 * **실패를 성공으로 적지 않는다.** 체결이 안 됐는데 `executed: true`를
 * 돌려주면 화면에 포지션이 생긴 것처럼 보이고, 사용자는 없는 포지션의
 * 손익을 본다.
 */
export async function dispatchPaperEntry(sb: any, i: {
  userId: string;
  mode: OperatingMode;
  strategyId: string;
  /** 같은 행동은 같은 id — 재시도해도 두 번 체결되지 않는다 */
  signalId: string;
  plan: any | null;
  entryPrice: number | null | undefined;
  stopLoss?: number | null;
  takeProfit?: number | null;
  bucket?: string | null;
  market?: string;
  marginMode?: 'ISOLATED' | 'CROSSED';
}): Promise<PaperEntryResult> {
  const v = paperDispatchVerdict({
    mode: i.mode, hasPlan: !!i.plan, entryPrice: i.entryPrice,
  });
  if (!v.fill) {
    return { ok: true, code: v.code, positionId: null, fill: null, reason: v.reason };
  }

  try {
    const { openPaperPosition } = await import('./paperStore');
    const r = await openPaperPosition(sb, {
      userId: i.userId,
      signalId: i.signalId,
      strategyId: i.strategyId,
      bucket: i.bucket ?? null,
      plan: i.plan,
      entryPrice: Number(i.entryPrice),
      stopLoss: i.stopLoss ?? undefined,
      takeProfit: i.takeProfit ?? undefined,
      market: i.market,
      marginMode: i.marginMode,
    });
    if (r.duplicate) {
      // **이미 체결된 신호는 성공이다.** 멱등이란 그런 뜻이다 — 다만
      // 새로 생긴 것처럼 적지 않는다.
      return { ok: true, code: 'DUPLICATE', positionId: null, fill: null,
        reason: '이미 체결된 신호입니다 — 다시 체결하지 않았습니다' };
    }
    if (!r.ok) {
      return { ok: false, code: 'FAILED', positionId: null, fill: null,
        reason: `모의 체결에 실패했습니다 — ${String(r.error ?? '').slice(0, 160)}` };
    }
    return { ok: true, code: 'FILLED', positionId: r.positionId ?? null, fill: r.fill ?? null,
      reason: '모의 계좌에 체결했습니다' };
  } catch (e: any) {
    return { ok: false, code: 'FAILED', positionId: null, fill: null,
      reason: `모의 체결에 실패했습니다 — ${String(e?.message || e).slice(0, 160)}` };
  }
}
