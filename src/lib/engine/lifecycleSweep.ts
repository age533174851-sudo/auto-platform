// src/lib/engine/lifecycleSweep.ts
//
// **한 회차의 생명주기 감시 전체 — 가짜 거래소·가짜 장부로 돌릴 수 있게 뗀다.**
//
// 왜 라우트에서 뗐는가
// ────────────────────
// 이 루프는 거래소를 **바꾼다.** 그런데 라우트(`exit-monitor/route.ts`) 안에
// 있으면 `next/server`를 끌고 오므로 시험 하네스가 불러올 수 없다. 그래서
// 가장 중요한 것들이 정규식 검사기밖에 못 보는 자리에 남아 있었다:
//
//   · 한 회차에 청산을 **몇 번** 보내는가 (같은 자리를 두 줄이 가리킬 때)
//   · 임차를 잃은 뒤에도 다음 후보로 넘어가 또 보내지 않는가
//   · 장부 조회 실패를 "후보 없음"으로 적지 않는가
//   · 보낸 뒤 반드시 다시 읽는가
//
// 검사기는 "그 줄이 있는가"만 본다. **횟수와 순서는 돌려 봐야 안다.**
// `entry100x` · `lifecycleAction`을 같은 이유로 같은 방식으로 뗐다.
//
// 라우트는 이제 실제 구현(거래소 어댑터·supabase)을 끼워 넣는 얇은 배선이다.
// 판단이 두 곳에 있으면 언젠가 갈린다 — 이 저장소가 이름 붙인 2번 고장이다.
import { managedCandidates, mayActOn, mutationKeyOf } from './managedPosition';
import type { ManagedPosition, OrderRowLike } from './managedPosition';
import { applyLifecycleClose } from './lifecycleAction';
import { lifecycleDecide } from './exitLifecycle';
import { lifecyclePolicyOf } from '../strategies/lifecyclePolicy';
import { moveStopSafely } from './stopMove';

/** 이 회차가 쓰는 거래소 조작. 실제 구현은 `venuePositionOps`다 */
export interface SweepVenueOps {
  readOpenPosition: (venue: any, symbol: string) => Promise<{ ok: boolean; found: boolean; [k: string]: any }>;
  closeSymbolPosition: (venue: any, symbol: string, side: 'LONG' | 'SHORT')
    => Promise<{ attempted: boolean; ok: boolean; error: string | null }>;
  liveStopPrice: (venue: any, symbol: string, side: 'LONG' | 'SHORT') => Promise<number | null>;
  placeStop: (venue: any, i: { symbol: string; positionSide: 'LONG' | 'SHORT'; stopPrice: number })
    => Promise<{ ok: boolean; orderId: string | null; message?: string }>;
  cancelOtherStops: (venue: any, symbol: string, side: 'LONG' | 'SHORT', keep: string | null)
    => Promise<{ cancelled: number; note?: string }>;
}

export interface LifecycleSweepDeps {
  /**
   * 장부에서 이번 회차가 볼 줄을 읽는다.
   *
   * **`error`를 '없음'으로 적지 않는다.** 못 읽은 것과 없는 것은 다르고,
   * 못 읽은 것을 0으로 적으면 감시가 죽은 채로 통과한다.
   */
  readRows: () => Promise<{ rows: OrderRowLike[]; error: string | null }>;
  /** 연결 하나의 거래소 자격. 못 읽으면 null — 그 줄은 손대지 않는다 */
  venueOf: (connectionId: string) => Promise<{ exchange: string; [k: string]: any } | null>;
  ops: SweepVenueOps;
  /** 최고 도달 R. 1R이 정의될 때만 불린다 */
  highWater: (p: ManagedPosition, venue: any)
    => Promise<{ highWaterR: number; lastPrice: number } | null>;
  /** 새 손절 주문 번호를 장부에 적는다 */
  recordStopOrderId: (orderRowId: string, orderId: string | null)
    => Promise<{ ok: boolean; message?: string }>;
  /** 주문을 내기 직전에 묻는 실행 권한. 안 주면 확인하지 않는다 */
  stillMine?: () => Promise<boolean>;
  /** 점검 모드 — 판단만 하고 거래소를 바꾸지 않는다 */
  dryRun?: boolean;
  nowMs?: () => number;
}

export interface LifecycleSweepResult {
  candidates: number;
  acted: number;
  skipped: any[];
  results: any[];
  summary: string;
  error: string | null;
}

/**
 * 후보를 만들고, 하나씩 판단하고, CLOSE면 청산·MOVE_STOP이면 손절을 옮긴다.
 *
 * 지키는 계약
 * ───────────
 *   ① 장부를 못 읽으면 **후보 0이 아니라 error**로 끝난다
 *   ② 같은 계좌·종목·방향은 한 회차에 **한 번만** 실행한다
 *   ③ 임차를 잃으면 그 자리에서 **회차를 끊는다** — 다음 후보로 넘어가지 않는다
 *   ④ 청산은 `lifecycleAction`이 권한 → 전송 → 재조회 순서로 한다
 */
export async function runLifecycleSweepCore(
  deps: LifecycleSweepDeps,
): Promise<LifecycleSweepResult> {
  const out: LifecycleSweepResult = {
    candidates: 0, acted: 0, skipped: [], results: [], summary: '', error: null,
  };
  const dryRun = deps.dryRun === true;
  const now = deps.nowMs ?? (() => Date.now());

  let rows: OrderRowLike[] = [];
  try {
    const r = await deps.readRows();
    // **조회 실패를 '없음'으로 적지 않는다.**
    if (r?.error) {
      out.error = String(r.error).slice(0, 200);
      out.summary = `주문 장부를 읽지 못했습니다 — ${out.error}`;
      return out;
    }
    rows = Array.isArray(r?.rows) ? r.rows : [];
  } catch (e: any) {
    out.error = String(e?.message || e).slice(0, 200);
    out.summary = `주문 장부를 읽지 못했습니다 — ${out.error}`;
    return out;
  }

  const { positions, skipped } = managedCandidates(rows);
  out.candidates = positions.length;
  out.skipped = skipped;
  if (positions.length === 0) {
    out.summary = '감시할 후보가 없습니다';
    return out;
  }

  // **같은 자리에 두 번 주문하지 않는다.** 워커가 둘 떠 있거나 한 회차에
  // 같은 포지션을 두 줄이 가리켜도 여기서 한 번만 실행한다.
  const done = new Set<string>();

  for (const p of positions) {
    const key = mutationKeyOf(p);
    if (done.has(key)) {
      out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'DUPLICATE',
        ok: true, reason: '같은 계좌·종목·방향을 이번 회차에 이미 처리했습니다' });
      continue;
    }

    try {
      const venue = await deps.venueOf(p.connectionId);
      if (!venue) {
        out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'NO_VENUE', ok: false,
          reason: '연결을 읽지 못했거나 출금 권한이 있는 키라 조회하지 않았습니다' });
        continue;
      }
      // **줄에 적힌 거래소와 연결의 거래소가 다르면 손대지 않는다.**
      if (venue.exchange !== p.exchange) {
        out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'VENUE_MISMATCH', ok: false,
          reason: `주문은 ${p.exchange}로 적혀 있는데 연결은 ${venue.exchange}입니다` });
        continue;
      }

      const live = await deps.ops.readOpenPosition(venue, p.symbol);
      // 최고 도달 R은 **1R이 정의될 때만** 뜻이 있다. 손절이 없는 계약에서
      // 이 값을 구하면 분모 없는 비율을 만드는 것이고, 그 숫자는 아래
      // 트레일링 판단에 쓰이지도 않는다(정책이 먼저 막는다).
      let hw: { highWaterR: number; lastPrice: number } | null = null;
      const hasStop = p.stopPolicy !== 'NO_FIXED_SL' && Number(p.stopLoss) > 0;
      if (live.ok && live.found && hasStop && mayActOn(p)) {
        hw = await deps.highWater(p, venue);
      }
      // 지금 거래소에 걸려 있는 손절. **못 읽으면 진입 손절을 그대로 쓴다** —
      // 방향을 같이 넘겨야 남의 조건부 주문을 이 포지션의 손절로 읽지 않는다.
      let liveStop: number | null = null;
      try { liveStop = await deps.ops.liveStopPrice(venue, p.symbol, p.side); }
      catch { liveStop = null; }

      const policy = lifecyclePolicyOf(p.strategyId);
      const v = lifecycleDecide({
        position: p, policy,
        live, highWaterR: hw?.highWaterR ?? null, lastPrice: hw?.lastPrice ?? null,
        liveStop, nowMs: now(),
      });
      // ★ **이 값이 어디서 왔는지 같이 내보낸다.**
      //
      //   `scalp`의 6시간은 `LIFECYCLE_TESTNET_V1` — 원본 진입 규칙과 무관하게
      //   검증용으로 정한 값이다(`lifecyclePolicy.ts`의 note). 출처를 안 적으면
      //   시간 청산이 일어났을 때 그것이 사용자가 정한 실전 종료 규칙처럼
      //   읽힌다. 특히 이 값 하나가 무손절 계약의 **유일한** 자동 종료다.
      const policySource = policy?.source ?? null;

      if (v.action === 'NONE') {
        out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: v.code,
          ok: true, reason: v.reason, mayCleanProtection: v.mayCleanProtection,
          stopPolicy: p.stopPolicy, policySource });
        continue;
      }
      if (dryRun) {
        out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: v.code,
          ok: true, dryRun: true, reason: `점검 모드 — ${v.reason}` });
        continue;
      }

      done.add(key);
      if (v.action === 'CLOSE') {
        // ★ **순서(권한 → 전송 → 재조회)는 `lifecycleAction`이 갖는다.**
        const act = await applyLifecycleClose({
          stillMine: deps.stillMine,
          close: () => deps.ops.closeSymbolPosition(venue, p.symbol, p.side),
          readAfter: () => deps.ops.readOpenPosition(venue, p.symbol)
            .then((x: any) => ({ ok: x.ok === true, found: x.found === true })),
        });
        if (act.code === 'LEASE_LOST') {
          // **회차를 끊는다.** 임차가 넘어갔으면 다음 후보도 내 것이 아니다.
          out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'LEASE_LOST',
            ok: false, reason: act.reason, stopPolicy: p.stopPolicy, policySource });
          break;
        }
        out.acted += 1;
        // ★ **세 가지를 섞지 않는다.**
        //
        //   attempted    거래소에 요청을 보냈는가 (보냈으면 응답을 못 받아도 true)
        //   accepted     거래소가 그 요청을 받았는가
        //   flatVerified 재조회로 포지션 0을 **확인**했는가 (못 읽으면 null)
        //
        //   `ok`는 셋이 다 참일 때만이다. 부분 종료 주문도 FILLED가 될 수
        //   있으므로 접수만으로 종료를 적지 않는다.
        const verified = act.flatVerified !== null;
        const flat = act.flatVerified === true;
        out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: v.code,
          stopPolicy: p.stopPolicy, policySource,
          attempted: act.attempted, accepted: act.accepted,
          ok: act.accepted && flat, closed: act.accepted,
          flatVerified: verified ? flat : null,
          reason: v.reason + (verified
            ? (flat ? ' — 포지션 0 확인' : ' — 아직 남아 있습니다')
            : ' — 종료 후 재조회 실패(0이라는 뜻이 아닙니다)') });
        continue;
      }

      // MOVE_STOP — 걸고 → 적고 → 치운다
      const mv = await moveStopSafely({
        symbol: p.symbol, side: p.side, newStop: v.newStop!,
        place: async (stopPrice) => {
          const r = await deps.ops.placeStop(venue, { symbol: p.symbol, positionSide: p.side, stopPrice });
          return { ok: !!r?.ok, orderId: r?.orderId ?? null, message: r?.message };
        },
        record: async (orderId) => {
          // **stop_loss는 덮어쓰지 않는다.** 그 칸은 진입 시점 값이고 1R을 정의한다.
          if (!p.orderId) return { ok: false, message: '주문 줄 id가 없어 적을 곳이 없습니다' };
          return deps.recordStopOrderId(p.orderId, orderId);
        },
        cancelOthers: async (keep) => deps.ops.cancelOtherStops(venue, p.symbol, p.side, keep),
      });
      out.acted += mv.ok ? 1 : 0;
      out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: mv.code,
        ok: mv.ok, newStop: v.newStop, newOrderId: mv.newOrderId,
        cancelledOld: mv.cancelledOld, oldStopKept: mv.oldStopKept,
        reason: `${v.reason} — ${mv.reason}` });
    } catch (e: any) {
      out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'FAILED', ok: false,
        reason: String(e?.message || e).slice(0, 160) });
    }
  }

  const unknown = out.results.filter(r => r.code === 'POSITION_UNKNOWN').length;
  out.summary = `후보 ${out.candidates}건 · 실행 ${out.acted}건`
    + (unknown > 0 ? ` · 확인 못 함 ${unknown}건` : '')
    + (out.skipped.length ? ` · 대상 아님 ${out.skipped.reduce((a, b) => a + b.count, 0)}줄` : '');
  return out;
}
