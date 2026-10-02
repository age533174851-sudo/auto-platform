// src/lib/engine/venuePositionOps.ts
//
// **포지션 생명주기가 거래소에 묻는 네 가지.**
//
//   1. 지금 이 종목에 뭐가 열려 있나          readOpenPosition
//   2. 그걸 전량 닫아라                        closeSymbolPosition
//   3. 걸려 있는 조건부 주문을 다 보여 달라    readProtectiveOrders
//   4. 이 id들만 취소해라                      cancelProtectiveOrders
//
// 판정은 전부 순수 함수(positionLifecycle · orderOwnership ·
// protectiveReadback)가 하고, 이 파일은 **묻고 답을 그 모양으로 옮기는
// 일만** 한다. 두 거래소의 응답 차이를 여기 한 곳에서만 흡수한다 —
// 라우트마다 각자 흡수하면 한쪽만 고쳐진다.
//
// 규칙 하나: **실패를 빈 값으로 돌려주지 않는다.**
// 조회 실패는 `ok: false`이거나 `null`이고, 그건 '없다'와 다르다.
// 이 구분이 무너지면 살아 있는 포지션 위로 신규 진입이 나간다.

import { openPositionOf, type OpenPosition } from './positionLifecycle';

export interface VenueCreds {
  exchange: 'binance' | 'gate';
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

/**
 * **이 계좌에 청산 주문을 보내도 되는가 — 종료 경로의 단일 관문.**
 *
 * 판정은 `futuresExec.closeModeVerdict`가 갖고(진입 판정 옆에 있다),
 * 여기서는 모드를 읽어 그 판정에 넘긴다.
 *
 * ★ **reduceOnly라고 안전한 것이 아니다.** 단방향 전용 파라미터 조합을
 *   양방향 계좌에 보내면 거부가 아니라 반대 포지션이 될 수 있다. 그래서
 *   `reduceOnly`를 쓰는 **모든** 종료 경로가 이 관문을 지나야 한다 —
 *   계단식(ladder) 경로가 이것을 건너뛰고 직접 주문을 내고 있었다.
 */
export async function closeModeGate(
  c: VenueCreds, positionSide: 'LONG' | 'SHORT' | null,
): Promise<{ ok: boolean; message: string; code: string; strandsOpenPosition: boolean }> {
  const fa = await import('../exchanges/futuresAdapter');
  const fx = await import('../exchanges/futuresExec');
  const pm = await fa.futuresPositionMode(
    c.exchange as any, c.apiKey, c.apiSecret, c.testnet);
  const v = fx.closeModeVerdict({
    exchange: c.exchange, mode: pm.mode as any,
    positionSide, error: pm.error,
  });
  return { ok: v.ok, message: v.message, code: v.code,
    strandsOpenPosition: v.strandsOpenPosition };
}

/**
 * 이 오류가 **접수 여부를 모른다**는 뜻인가.
 *
 * 타임아웃·연결 끊김을 "거부됐다"로 적으면 안 나간 것으로 읽혀 같은
 * 자리에 또 보낸다. 판정은 `futuresExec.unknownResultVerdict` 하나를 쓴다 —
 * 이 저장소에 이미 있는 분류다.
 */
async function isAmbiguousSend(msg: string | null | undefined): Promise<boolean> {
  if (!msg) return false;
  try {
    const fx = await import('../exchanges/futuresExec');
    return fx.unknownResultVerdict(String(msg)).unknown === true;
  } catch { return false; }
}

/** 지금 열려 있는 포지션 (방향 포함) */
export async function readOpenPosition(c: VenueCreds, symbol: string): Promise<OpenPosition> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return { ok: false, found: false, qty: null, side: null, error: `계약 이름을 만들 수 없습니다 (${symbol})` };
      const pos = await gf.getPositionGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
      // **null은 조회 실패다.** getPositionGateFutures는 예외를 삼키고
      // null을 준다 — 그걸 '포지션 없음'으로 읽으면 이 PR의 사고가 그대로다.
      if (pos == null) {
        return { ok: false, found: false, qty: null, side: null, error: 'Gate 포지션 조회 실패' };
      }
      const size = Number((pos as any).size);
      if (!Number.isFinite(size)) {
        return { ok: true, found: true, qty: null, side: null, error: null };
      }
      // 계약 수를 기초자산 수량으로 되돌린다. 단위가 섞이면 "0.002가
      // 남았다"가 "2계약이 남았다"로 읽힌다.
      const spec = await gf.getGateContractSpec(contract, c.testnet).catch(() => null);
      const base = spec ? gp.gateBaseFromContracts(Math.abs(size), spec) : Math.abs(size);
      if (Math.abs(size) <= 0) return { ok: true, found: false, qty: 0, side: null, error: null };
      return {
        ok: true, found: true,
        qty: Number.isFinite(Number(base)) && Number(base) > 0 ? Number(base) : Math.abs(size),
        side: size > 0 ? 'LONG' : 'SHORT', error: null,
      };
    }
    const bf = await import('../exchanges/binanceFutures');
    const res = await bf.getFuturesPositions(c.apiKey, c.apiSecret, c.testnet);
    return openPositionOf(res, symbol);
  } catch (e: any) {
    return { ok: false, found: false, qty: null, side: null, error: String(e?.message || e) };
  }
}

/**
 * 이 종목의 포지션을 전량 닫는다.
 *
 * **접수와 체결을 섞지 않는다.** 돌려주는 `ok`는 "거래소가 청산 주문을
 * 접수했다"이고, 닫혔는지는 호출부가 `closeVerdict`로 재조회해 확인한다.
 */
export async function closeSymbolPosition(
  c: VenueCreds, symbol: string,
  /** 바이낸스는 어느 쪽 포지션을 닫는지 알아야 한다. Gate는 auto_size가 정한다 */
  positionSide?: 'LONG' | 'SHORT' | null,
): Promise<{ attempted: boolean; ok: boolean; error: string | null; ambiguous?: boolean }> {
  try {
    // ── ★ 계좌의 포지션 모드를 **먼저 읽는다** ──
    //
    // 아래 전송은 단방향 전용 조합이다:
    //   Binance  reduceOnly: true, positionSide 없음
    //   Gate     size: 0, auto_size: close_long|close_short
    //
    // 양방향(헤지) 계좌에서 이 모양이 어떻게 처리되는지는 공식 문서로
    // 확인하지 못했다. 틀린 조합은 거부가 아니라 **반대 방향 신규 진입**이
    // 될 수 있다 — 거부는 불편이고 반대 포지션은 사고다.
    //
    // 이 저장소에는 모드를 읽는 함수가 이미 있었다(`futuresPositionMode`,
    // 못 읽으면 null). 그런데 **종료 경로가 그것을 부르지 않았다.**
    // 만들어 놓고 안 이은 상태였고, 그게 이 수정이 막는 고장이다.
    //
    // 판정은 여기 없다 — `futuresExec.closeModeVerdict`가 진입 판정
    // (`positionModeVerdict`) **옆에** 있다. 두 판정이 흩어지면 한쪽만
    // 고쳐지고, 그때 "열 수는 있는데 닫을 수는 없는" 상태가 생긴다.
    const cm = await closeModeGate(c, positionSide ?? null);
    if (!cm.ok) return { attempted: false, ok: false, error: cm.message };

    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return { attempted: false, ok: false, error: `계약 이름을 만들 수 없습니다 (${symbol})` };
      const r = await gf.closePositionGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
      return { attempted: true, ok: r.success === true, error: r.success ? null : r.message,
        ambiguous: r.success ? false : await isAmbiguousSend(r.message) };
    }
    const bf = await import('../exchanges/binanceFutures');
    const r: any = await bf.closePositionPercent(c.apiKey, c.apiSecret, symbol, positionSide, 100, c.testnet);
    const ok = r?.success === true || r?.ok === true;
    const msg = ok ? null : String(r?.message || r?.error || '청산 주문 실패');
    return { attempted: true, ok, error: msg,
      ambiguous: ok ? false : await isAmbiguousSend(msg) };
  } catch (e: any) {
    // **예외를 '안 보냈다'로도 '거부됐다'로도 적지 않는다.** 보내고
    // 응답을 못 받았을 수도 있다 — 그 구분은 재조회가 한다.
    return { attempted: true, ok: false, error: String(e?.message || e), ambiguous: true };
  }
}

// ── 전용 종료 권한용: 준비 / 전송을 나눈다 ──
//
// `closeSymbolPosition`은 모드 조회와 포지션 조회를 **전송 직전에** 한다.
// 그래서 "쓰기 직전에 울타리 재확인"을 그 앞에 두어도, 확인과 실제 주문
// 사이에 네트워크 왕복이 두 번 남는다. 느린 실행자가 그 창에서 깨어나면
// 울타리를 확인하고도 남의 포지션에 주문을 낸다.
//
// 그래서 **읽는 일을 전부 앞으로** 모은다:
//
//   prepareSymbolClose   모드·노출·규격을 전부 읽고 payload를 만든다
//   ── 여기서 울타리를 다시 확인한다 (네트워크 왕복 0) ──
//   sendSymbolClose      주문 하나만 보낸다
//
// payload를 만드는 곳은 여전히 `binanceFutures.prepareClosePosition`
// 한 곳이다 — 수량·반대방향·reduceOnly 규칙이 두 벌이 되지 않는다.

export interface PreparedSymbolClose {
  venue: 'binance' | 'gate';
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  /** 보낼 수량. **지금 관측한 노출에서 왔다** */
  quantity: number | null;
  /** 보낼 주문 방향 — 포지션의 반대 */
  orderSide: 'BUY' | 'SELL' | null;
  reduceOnly: true;
  observedQty: number | null;
  /**
   * 멱등 키. **같은 종료 의도면 같은 값이다.**
   *
   * DB 울타리는 거래소를 막지 못한다 — 재검증 **직후** 임차가 넘어가면
   * 낡은 실행자도 요청을 보낼 수 있다. 같은 식별자를 쓰면 거래소가
   * 둘째를 거부하므로 **주문은 하나만 생긴다.**
   */
  clientOrderId: string | null;
  /** 거래소에서 읽은 계좌 포지션 모드 */
  positionMode: 'ONE_WAY' | 'HEDGE' | null;
  /** 거래소별 전송에 필요한 내부 값 */
  inner: unknown;
}

export type PrepareCloseCode =
  | 'READY'
  /** 거래소에 포지션이 없다 — 보낼 주문이 없다. **실패가 아니다** */
  | 'ALREADY_FLAT'
  /** 포지션·모드를 읽지 못했다. **flat이 아니다** */
  | 'READ_FAILED'
  /** 모드를 확인하지 못했거나 양방향이다 */
  | 'MODE_BLOCKED'
  /** 장부와 거래소의 방향이 다르다 */
  | 'SIDE_MISMATCH';

/**
 * 청산을 **준비한다.** 거래소를 바꾸지 않는다.
 *
 * 모드 관문(`closeModeGate`)을 여기서 지난다 — 전송 시점이 아니라.
 * 판정 자체는 `futuresExec.closeModeVerdict` 한 곳 그대로다.
 */
export async function prepareSymbolClose(
  c: VenueCreds, symbol: string, positionSide: 'LONG' | 'SHORT',
  /**
   * 이 종료 의도의 멱등 키를 만든다. **관측한 수량을 받아서** 만든다 —
   * 같은 순간 같은 노출을 본 실행자끼리 같은 값이 나와야 한다.
   *
   * 안 주면 붙이지 않는다(기존 호출부 동작 불변). 전용 종료 권한은
   * 반드시 준다.
   */
  intentIdFor: ((observedQty: number) => string) | null = null,
): Promise<{ code: PrepareCloseCode; prepared: PreparedSymbolClose | null; message: string }> {
  const blank = (positionMode: 'ONE_WAY' | 'HEDGE' | null): PreparedSymbolClose => ({
    venue: c.exchange, symbol, positionSide,
    quantity: null, orderSide: null, reduceOnly: true,
    observedQty: null, clientOrderId: null, positionMode, inner: null,
  });
  try {
    // ── 모드 관문을 **먼저** ──
    const cm = await closeModeGate(c, positionSide);
    if (!cm.ok) {
      return { code: 'MODE_BLOCKED', prepared: blank(null), message: cm.message };
    }

    if (c.exchange === 'gate') {
      // Gate는 `auto_size`가 잔여 부호에서 수량을 정한다 — 미리 만들 payload가
      // 없다. 노출만 확인해 두고 전송은 기존 경로를 쓴다.
      const live = await readOpenPosition(c, symbol);
      if (live.ok !== true) {
        return { code: 'READ_FAILED', prepared: blank('ONE_WAY'),
          message: live.error || 'Gate 포지션 조회 실패' };
      }
      if (!live.found) {
        return { code: 'ALREADY_FLAT', prepared: blank('ONE_WAY'), message: '이미 포지션이 없습니다' };
      }
      if (live.side != null && live.side !== positionSide) {
        return { code: 'SIDE_MISMATCH', prepared: blank('ONE_WAY'),
          message: `방향 불일치 — 장부 ${positionSide}, 거래소 ${live.side}` };
      }
      return {
        code: 'READY', message: 'Gate 전량 청산 준비',
        prepared: { ...blank('ONE_WAY'), quantity: live.qty,
          orderSide: positionSide === 'LONG' ? 'SELL' : 'BUY',
          observedQty: live.qty,
          clientOrderId: intentIdFor && live.qty != null ? intentIdFor(live.qty) : null,
          inner: { kind: 'gate' } },
      };
    }

    const bf = await import('../exchanges/binanceFutures');
    // 멱등 키는 **관측한 노출**로 만든다. 먼저 한 번 읽어 수량을 알아야
    // 하므로, 조회를 두 번 하지 않도록 조회 결과를 받아 다시 만든다.
    const probe = await bf.prepareClosePosition(
      c.apiKey, c.apiSecret, symbol, positionSide, 100, c.testnet);
    const prep = (intentIdFor && probe.ok && probe.prepared)
      ? { ...probe, prepared: { ...probe.prepared,
          clientOrderId: intentIdFor(probe.prepared.observedQty) } }
      : probe;
    if (!prep.ok) {
      const mismatch = /방향 불일치/.test(prep.message);
      return { code: mismatch ? 'SIDE_MISMATCH' : 'READ_FAILED',
        prepared: blank('ONE_WAY'), message: prep.message };
    }
    if (prep.alreadyFlat || !prep.prepared) {
      return { code: 'ALREADY_FLAT', prepared: blank('ONE_WAY'), message: prep.message };
    }
    return {
      code: 'READY', message: prep.message,
      prepared: {
        venue: 'binance', symbol: prep.prepared.symbol, positionSide,
        quantity: prep.prepared.quantity, orderSide: prep.prepared.side,
        reduceOnly: true, observedQty: prep.prepared.observedQty,
        clientOrderId: prep.prepared.clientOrderId ?? null,
        positionMode: 'ONE_WAY', inner: prep.prepared,
      },
    };
  } catch (e: any) {
    return { code: 'READ_FAILED', prepared: blank(null), message: String(e?.message || e) };
  }
}

/**
 * 준비된 청산을 **보낸다.** 여기서는 읽지 않는다 — 주문 하나뿐이다.
 *
 * 돌려주는 `ok`는 "거래소가 접수했다"이고 닫혔는지는 호출부가 재조회로
 * 확인한다. `ambiguous`는 **접수 여부를 모른다**는 뜻이다.
 */
export async function sendSymbolClose(
  c: VenueCreds, prepared: PreparedSymbolClose,
): Promise<{ attempted: boolean; ok: boolean; error: string | null; ambiguous?: boolean }> {
  try {
    if (prepared.venue === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(prepared.symbol);
      if (!contract) {
        return { attempted: false, ok: false, error: `계약 이름을 만들 수 없습니다 (${prepared.symbol})` };
      }
      const r = await gf.closePositionGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
      return { attempted: true, ok: r.success === true, error: r.success ? null : r.message,
        ambiguous: r.success ? false : await isAmbiguousSend(r.message) };
    }
    const bf = await import('../exchanges/binanceFutures');
    const r = await bf.sendPreparedClose(
      c.apiKey, c.apiSecret, prepared.inner as any, c.testnet);
    const ok = r?.success === true;
    const msg = ok ? null : String(r?.message || '청산 주문 실패');
    return { attempted: true, ok, error: msg,
      ambiguous: ok ? false : await isAmbiguousSend(msg) };
  } catch (e: any) {
    // **예외를 '안 보냈다'로도 '거부됐다'로도 적지 않는다.**
    return { attempted: true, ok: false, error: String(e?.message || e), ambiguous: true };
  }
}

/**
 * 걸려 있는 조건부 주문.
 *
 * **null은 '못 읽음'이고 `[]`는 '없음'이다.** 이 둘을 섞으면 조회 실패가
 * "보호주문 0건"으로 그려진다.
 */
export async function readProtectiveOrders(c: VenueCreds, symbol: string): Promise<any[] | null> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      return await gf.getPriceOrdersGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
    }
    const bf = await import('../exchanges/binanceFutures');
    const r: any = await bf.getFuturesOpenOrders(c.apiKey, c.apiSecret, c.testnet, symbol);
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.orders)) return r.orders;
    return null;
  } catch { return null; }
}

/**
 * **이 id들만** 취소한다. 목록을 통째로 지우지 않는다.
 *
 * `cancelAll`은 같은 계좌의 다른 전략이 걸어 둔 손절까지 지운다.
 * 그래서 호출부(`orphanCleanupPlan`)가 내 것이라고 확인한 id만 온다.
 */
export async function cancelProtectiveOrders(
  c: VenueCreds, symbol: string, ids: string[],
): Promise<{ cancelled: string[]; failed: Array<{ id: string; error: string }> }> {
  const cancelled: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      if (c.exchange === 'gate') {
        const gf = await import('../exchanges/gateFutures');
        const r = await gf.cancelOrderGateFutures(c.apiKey, c.apiSecret, id, { bucket: 'price', testnet: c.testnet });
        if (r.success) cancelled.push(id); else failed.push({ id, error: r.message });
      } else {
        const bf = await import('../exchanges/binanceFutures');
        const r: any = await bf.cancelFuturesOrder(c.apiKey, c.apiSecret, symbol, id, c.testnet);
        if (r?.success === true || r?.ok === true || r?.orderId != null) cancelled.push(id);
        else failed.push({ id, error: String(r?.message || r?.error || '취소 실패') });
      }
    } catch (e: any) {
      failed.push({ id, error: String(e?.message || e) });
    }
  }
  return { cancelled, failed };
}

/**
 * **이 id들만 취소하고, 재조회로 사라진 것까지 확인한다.**
 *
 * `cancelProtectiveOrders`는 거래소가 200을 주면 취소된 것으로 적었다.
 * 200은 **접수**다. 2026-08-15에 Gate 조건부 주문 2건이 그 뒤에도
 * 남았고, 장부에는 정리된 것으로 적혀 있었다.
 *
 * 그래서 여기서는 한 바퀴가 이렇게 돈다:
 *
 *   요청 → 거래소 응답 → **목록 재조회** → 아직 있으면 다시 요청
 *
 * `attempts`번까지만 돈다(기본 3). **끝까지 남으면 그건 FAIL이지
 * PASS가 아니다** — 판정은 `cancelLedger`가 한다. 목록을 못 읽으면
 * UNKNOWN이고, 그것도 통과가 아니다.
 *
 * `cancelAll`은 쓰지 않는다. 같은 계좌의 다른 전략이 걸어 둔 손절까지
 * 지운다 — 호출부가 내 것이라고 확인한 id만 온다.
 */
export async function cancelExact(
  c: VenueCreds, symbol: string, ids: string[],
  opts: { attempts?: number } = {},
): Promise<{
  attempts: Array<{ id: string; requested: boolean; httpOk: boolean; response: string | null; tries: number }>;
  /** 마지막으로 읽은 조건부 주문 목록. **null이면 못 읽었다** */
  leftover: any[] | null;
  rounds: number;
}> {
  const maxRounds = Math.max(1, Math.min(5, Math.round(Number(opts?.attempts) || 3)));
  const wanted = (Array.isArray(ids) ? ids : []).map(v => String(v ?? '').trim()).filter(Boolean);
  const record = new Map<string, { id: string; requested: boolean; httpOk: boolean; response: string | null; tries: number }>();
  for (const id of wanted) record.set(id, { id, requested: false, httpOk: false, response: null, tries: 0 });

  let leftover: any[] | null = null;
  let rounds = 0;
  let pending = [...wanted];

  while (pending.length > 0 && rounds < maxRounds) {
    rounds++;
    for (const id of pending) {
      const r = record.get(id)!;
      r.tries++;
      try {
        if (c.exchange === 'gate') {
          const gf = await import('../exchanges/gateFutures');
          const res = await gf.cancelOrderGateFutures(c.apiKey, c.apiSecret, id, { bucket: 'price', testnet: c.testnet });
          r.requested = true; r.httpOk = !!res.success;
          r.response = res.success ? `취소 접수 (${res.bucket})` : res.message;
        } else {
          const bf = await import('../exchanges/binanceFutures');
          const res: any = await bf.cancelFuturesOrder(c.apiKey, c.apiSecret, symbol, id, c.testnet);
          const okish = res?.success === true || res?.ok === true || res?.orderId != null;
          r.requested = true; r.httpOk = !!okish;
          r.response = okish ? '취소 접수' : String(res?.message || res?.error || '취소 실패');
        }
      } catch (e: any) {
        r.requested = true; r.httpOk = false; r.response = String(e?.message || e);
      }
    }

    // **여기가 핵심이다.** 요청 결과가 아니라 목록을 다시 읽어 확인한다.
    leftover = await readProtectiveOrders(c, symbol);
    if (leftover == null) break;   // 못 읽었다 — 더 지워도 확인할 수 없다
    const present = leftover.map(row => String((row as any)?.id ?? (row as any)?.orderId ?? '')).filter(Boolean);
    pending = pending.filter(id => present.includes(id));
  }

  return { attempts: [...record.values()], leftover, rounds };
}

// ── 청산 감시가 묻는 것 ─────────────────────────────
//
// exit-monitor는 오래 Binance 함수를 직접 불렀다. 진입은 Gate로 나가는데
// 트레일링·본전이동·손절 확인은 바이낸스에 물어보는 상태였고, 화면에는
// "청산 감시 정상"이 떠 있었다. 아래 셋이 그 자리를 메운다.

export interface GuardSnapshot {
  /** 조회가 성공했는가 */
  ok: boolean;
  /** 그 종목의 포지션이 있는가 */
  found: boolean;
  side: 'LONG' | 'SHORT' | null;
  entryPrice: number | null;
  /** **못 읽으면 null이다.** 0으로 눕히면 "청산가를 지났다"가 된다 */
  markPrice: number | null;
  liquidationPrice: number | null;
  marginType: string | null;
  /** 이 포지션을 닫는 손절이 거래소에 살아 있는가. **못 읽으면 null** */
  hasProtectiveStop: boolean | null;
  error: string | null;
}

/** `BTC_USDT` · `BTC/USDT` · `btcusdt` 를 한 모양으로 */
const norm = (v: any): string => String(v ?? '').toUpperCase().replace(/[_/\-\s]/g, '');

const EMPTY_SNAPSHOT = (error: string | null): GuardSnapshot => ({
  ok: false, found: false, side: null, entryPrice: null, markPrice: null,
  liquidationPrice: null, marginType: null, hasProtectiveStop: null, error,
});

/**
 * 사고 점검이 보는 한 장면.
 *
 * **거래소를 가리지 않는다.** 포지션은 `futuresListPositions`(공용)이,
 * 손절 존재는 `readProtectiveOrders` + 판별표가 답한다.
 *
 * Gate는 포지션 응답에 지금 가격이 없다 — ticker를 따로 읽는다.
 * 그래도 못 읽으면 **null로 남긴다.** 0으로 채우면 멀쩡한 포지션이
 * "청산가 도달"로 읽혀 강제 청산된다.
 */
export async function readGuardSnapshot(c: VenueCreds, symbol: string): Promise<GuardSnapshot> {
  try {
    const { futuresListPositions } = await import('../exchanges/futuresExec');
    const res = await futuresListPositions({
      exchange: c.exchange, key: c.apiKey, secret: c.apiSecret, testnet: c.testnet,
    } as any);
    if (!res?.ok) return EMPTY_SNAPSHOT(res?.error ?? '포지션 조회 실패');

    const want = norm(symbol);
    const p = (res.positions || []).find((x: any) => norm(x?.symbol) === want);
    if (!p) return { ...EMPTY_SNAPSHOT(null), ok: true, found: false };

    // 지금 가격. Gate는 포지션에 없으므로 ticker로 채운다.
    let mark = Number((p as any).markPrice);
    if (!Number.isFinite(mark) || mark <= 0) {
      const t = await tickerOf(c, symbol);
      mark = t == null ? NaN : t;
    }

    // 이 포지션을 닫는 손절이 있는가. **못 읽으면 null이다** —
    // 없는 것으로 읽으면 "손절이 사라졌다"로 포지션을 닫는다.
    const orders = await readProtectiveOrders(c, symbol);
    let hasStop: boolean | null = null;
    if (orders != null && (p as any).side) {
      const { readbackProtective } = await import('./protectiveReadback');
      const rb = readbackProtective({
        orders, venue: c.exchange, positionSide: (p as any).side,
      });
      hasStop = rb.stop.found;
    }

    return {
      ok: true, found: true,
      side: (p as any).side ?? null,
      entryPrice: numOrNull((p as any).entryPrice),
      markPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
      liquidationPrice: numOrNull((p as any).liquidationPrice),
      marginType: (p as any).marginType ?? null,
      hasProtectiveStop: hasStop,
      error: null,
    };
  } catch (e: any) {
    return EMPTY_SNAPSHOT(String(e?.message || e));
  }
}

const numOrNull = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 지금 가격. **못 읽으면 null** */
export async function tickerOf(c: VenueCreds, symbol: string): Promise<number | null> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const t: any = await gf.getTickerGateFutures(contract, c.testnet);
      const n = Number(t?.mark_price ?? t?.last);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const bf = await import('../exchanges/binanceFutures');
    const n = await bf.getFuturesTicker(symbol, c.testnet);
    return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
  } catch { return null; }
}

/**
 * 지금 거래소에 **실제로 걸려 있는** 손절 트리거 가격.
 *
 * 트레일링이 이 값을 읽는다. DB의 `stop_loss`는 진입 시점 값이고 1R을
 * 정의하므로, 그 칸을 옮길 때마다 덮어쓰면 1R이 매번 커져 트레일링이
 * 한 번 움직인 뒤 멈춘다.
 *
 * **못 읽으면 null이다** — 0을 주면 손절이 바닥에 있는 것으로 읽힌다.
 */
export async function liveStopPrice(
  c: VenueCreds, symbol: string, positionSide: 'LONG' | 'SHORT',
): Promise<number | null> {
  const orders = await readProtectiveOrders(c, symbol);
  if (orders == null) return null;
  const { readbackProtective } = await import('./protectiveReadback');
  const rb = readbackProtective({ orders, venue: c.exchange, positionSide });
  return rb.stop.found ? rb.stop.triggerPrice : null;
}

/**
 * 손절을 새로 건다.
 *
 * **거래소별 분기는 `futuresSetTpsl` 한 곳에 있다** — 여기서 다시 짜면
 * 진입 경로와 청산 감시가 서로 다른 방식으로 손절을 걸게 된다.
 */
export async function placeStop(
  c: VenueCreds,
  i: { symbol: string; positionSide: 'LONG' | 'SHORT'; stopPrice: number; refPrice?: number | null },
): Promise<{ ok: boolean; orderId: string | null; message: string }> {
  try {
    const { futuresSetTpsl } = await import('../exchanges/futuresExec');
    const r: any = await futuresSetTpsl({
      exchange: c.exchange, key: c.apiKey, secret: c.apiSecret, testnet: c.testnet,
    } as any, {
      symbol: i.symbol, positionSide: i.positionSide,
      tpPrice: null, slPrice: i.stopPrice, refPrice: i.refPrice ?? null,
    } as any);
    const id = r?.sl?.orderId ?? r?.sl?.id ?? null;
    return { ok: r?.ok === true, orderId: id != null ? String(id) : null,
      message: String(r?.message ?? '') };
  } catch (e: any) {
    return { ok: false, orderId: null, message: String(e?.message || e) };
  }
}

/**
 * 이 포지션을 닫는 손절 중 **방금 건 것 말고** 전부 취소한다.
 *
 * `keepId`가 null이면 아무것도 취소하지 않는다 — 무엇을 남겨야 할지
 * 모르는 채로 지우면 손절이 없는 포지션이 된다.
 * **익절과 분할 사다리는 건드리지 않는다.**
 */
export async function cancelOtherStops(
  c: VenueCreds, symbol: string, positionSide: 'LONG' | 'SHORT', keepId: string | null,
): Promise<{ cancelled: number; note: string }> {
  if (!keepId) return { cancelled: 0, note: '남길 손절을 모르므로 아무것도 취소하지 않았습니다' };
  const orders = await readProtectiveOrders(c, symbol);
  if (orders == null) return { cancelled: 0, note: '주문 목록을 읽지 못해 옛 손절을 취소하지 못했습니다' };

  const { gateProtectiveKind } = await import('../exchanges/gatePlan');
  const { binanceProtectiveKind } = await import('./protectiveReadback');
  const ids: string[] = [];
  for (const row of orders) {
    const cls = c.exchange === 'binance' ? binanceProtectiveKind(row) : gateProtectiveKind(row);
    if (cls.kind !== 'STOP' || cls.closes !== positionSide) continue;
    const id = String((c.exchange === 'binance' ? (row?.orderId ?? row?.id) : row?.id) ?? '');
    if (!id || id === keepId) continue;
    ids.push(id);
  }
  if (ids.length === 0) return { cancelled: 0, note: '취소할 옛 손절이 없습니다' };
  const r = await cancelProtectiveOrders(c, symbol, ids);
  return {
    cancelled: r.cancelled.length,
    note: r.failed.length
      ? `옛 손절 ${r.failed.length}건을 취소하지 못했습니다 — 손절이 둘 남습니다(위험하지는 않습니다)`
      : `옛 손절 ${r.cancelled.length}건 취소`,
  };
}

/** 계약 규격의 호가 단위. 못 읽으면 null — 보정 없이 그대로 간다 */
export async function readTickSize(c: VenueCreds, symbol: string): Promise<number | null> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const spec = await gf.getGateContractSpec(contract, c.testnet);
      const t = Number((spec as any)?.orderPriceRound);
      return Number.isFinite(t) && t > 0 ? t : null;
    }
    const bf = await import('../exchanges/binanceFutures');
    const f = await bf.getSymbolFilters(symbol, c.testnet);
    const t = Number(f?.tickSize);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}
