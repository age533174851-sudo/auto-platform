// src/lib/exchanges/futuresExec.ts
//
// **선물 주문을 실제로 내보내는 쪽. 거래소와 무관하게.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// `futuresAdapter.ts`는 주문 **앞에서 읽는 것**(포지션·잔고·규격·배율)을
// 거래소와 무관하게 만들었다. 그런데 **내보내는 쪽**은 아직 두 벌이었다:
//
//   · 웹(Vercel)  → `src/lib/engine/orderExecutor.ts` 안에 binance/gate 분기
//   · 워커(Fly)   → `worker/src/binance.ts` — **바이낸스 전용**
//
// 워커는 `./binance`를 직접 import해서 모든 job을 바이낸스 함수로 실행했고,
// 모니터도 `exchange_id = 'binance'`만 조회했다. 그 상태로 Gate 연결의 job이
// 큐에 들어가면 **Gate 키를 들고 바이낸스에 서명 요청을 보낸다.** 인증이
// 실패하면 다행이고, 실패하지 않는 조합이 하나라도 있으면 남의 계좌에
// 주문이 나간다.
//
// 그래서 실행 경로도 한 벌로 모은다. 여기 있는 함수는 **웹이 쓰는 바로 그
// 거래소 모듈**(`binanceFutures.ts` · `gateFutures.ts` · `gatePlan.ts` ·
// `quantize.ts`)을 부른다. 워커용 사본을 따로 두지 않는다 — 이 저장소에서
// 반복된 사고가 정확히 그 모양이었다: **경로가 둘인데 한쪽만 고침.**
//
// 모르는 거래소는 막는다
// ──────────────────────
// `futuresExchangeOf`가 null이면 **UNSUPPORTED_EXCHANGE로 거절한다.**
// 바이낸스로 떨어뜨리지 않는다. 기본값으로 떨어뜨리는 코드는 평소에는
// 아무 일도 없다가, 새 거래소가 하나 들어오는 날 조용히 사고가 된다.
//
// 확인하지 못한 것은 통과가 아니다
// ────────────────────────────────
// 수량 규격을 못 읽었으면 그렇게 적고, 배율을 되읽지 못했으면 주문하지
// 않는다. 응답을 못 받았으면 **재시도하지 않는다** — 다시 보내는 것은
// 중복 체결이고, 그건 실패보다 나쁘다.

import { quantizeOrder } from './quantize';
import {
  futuresExchangeOf, futuresExchangeName, futuresPositionRisk,
  futuresSetLeverage, futuresSymbolFilters, futuresClosePosition,
  futuresPositionMode,
  type FuturesExchange,
} from './futuresAdapter';

// ── 거래소 결정 ──────────────────────────────────────

/** 지원하지 않는 거래소를 만났을 때 쓰는 코드. 화면·로그·job.error가 같은 말을 쓴다 */
export const UNSUPPORTED_EXCHANGE = 'UNSUPPORTED_EXCHANGE';

export interface ExchangeResolution {
  exchange: FuturesExchange | null;
  code: string;
  message: string;
}

/**
 * 연결의 `exchange_id` → 이 실행기가 다룰 수 있는 거래소.
 *
 * **null이면 실행하지 않는다.** fallback 없음. 이 함수가 이 파일에 있는
 * 이유는 하나다 — 부르는 쪽이 "모르면 binance"라고 쓸 자리를 아예 없애기
 * 위해서다.
 */
export function resolveExecExchange(rawExchangeId: any): ExchangeResolution {
  const ex = futuresExchangeOf(rawExchangeId);
  if (!ex) {
    const shown = rawExchangeId == null || rawExchangeId === ''
      ? '(비어 있음)' : String(rawExchangeId);
    return {
      exchange: null,
      code: UNSUPPORTED_EXCHANGE,
      message: `이 실행기가 지원하지 않는 거래소입니다: ${shown}. `
             + '지원: 바이낸스 선물 · 게이트아이오 선물. '
             + '다른 거래소의 키로 바이낸스에 주문을 보내지 않기 위해 실행하지 않습니다.',
    };
  }
  return { exchange: ex, code: 'OK', message: futuresExchangeName(ex) };
}

/** 거래소가 서로 다를 때 쓰는 코드 */
export const EXCHANGE_MISMATCH = 'EXCHANGE_MISMATCH';

export interface ExchangeMatch {
  ok: boolean;
  code: 'OK' | 'JOB_EXCHANGE_MISSING' | typeof EXCHANGE_MISMATCH | typeof UNSUPPORTED_EXCHANGE;
  message: string;
}

/**
 * **잡이 적어 둔 거래소와 연결의 거래소가 같은가.**
 *
 * jobs 행에는 `exchange` 칸이 따로 있다. 적재하는 쪽(웹)과 실행하는 쪽(워커)이
 * 다른 시점에 도는데, 그 사이에 연결이 바뀌거나 잘못된 connection_id가 들어가면
 * **바이낸스용으로 만든 잡이 Gate 연결로 실행된다.** 그러면 수량 단위가
 * 10,000배 어긋나고(Gate는 정수 계약), 그 전에 서명이 실패하면 다행이다.
 *
 * 잡에 거래소가 안 적혀 있으면(옛 행) 연결을 따른다 — 그건 모순이 아니다.
 * 적혀 있는데 다르면 **실행하지 않는다.** 어느 쪽이 맞는지 여기서 고를 수 없다.
 */
export function jobExchangeCheck(jobExchange: any, connExchange: any): ExchangeMatch {
  const conn = futuresExchangeOf(connExchange);
  if (!conn) {
    return { ok: false, code: UNSUPPORTED_EXCHANGE,
      message: resolveExecExchange(connExchange).message };
  }
  const raw = jobExchange == null ? '' : String(jobExchange).trim();
  if (!raw) {
    return { ok: true, code: 'JOB_EXCHANGE_MISSING',
      message: `잡에 거래소가 적혀 있지 않아 연결의 거래소(${futuresExchangeName(conn)})를 씁니다` };
  }
  const job = futuresExchangeOf(raw);
  if (job !== conn) {
    return {
      ok: false, code: EXCHANGE_MISMATCH,
      message: `잡은 ${raw}용인데 연결은 ${futuresExchangeName(conn)}입니다. `
             + '어느 쪽이 맞는지 여기서 고를 수 없어 실행하지 않습니다 — '
             + '다른 거래소의 키로 주문이 나가는 것을 막습니다.',
    };
  }
  return { ok: true, code: 'OK', message: futuresExchangeName(conn) };
}

/** 주문을 낼 대상. 키·시크릿은 부르는 쪽이 복호화해서 넘긴다 */
export interface ExecTarget {
  exchange: FuturesExchange;
  key: string;
  secret: string;
  testnet: boolean;
}

// ── 배율 검증 ────────────────────────────────────────

export interface LeverageVerdict {
  /** 이 배율로 주문을 내도 되는가 */
  ok: boolean;
  code:
    | 'NOT_REQUESTED'       // 배율을 지정하지 않았다 — 거래소 설정 그대로 간다
    | 'MATCH'               // 요청 = 실제. 이것만 통과다
    | 'VENUE_CAPPED'        // 거래소가 더 낮게 잡았다 — 요청과 다르므로 막는다
    | 'HIGHER_THAN_REQUESTED'  // 실제가 더 높다 — 청산가가 계산보다 가깝다
    | 'UNVERIFIED';         // 확인하지 못했다
  /** **독립적으로 되읽어 확인한** 배율. 못 읽었으면 null */
  observed: number | null;
  message: string;
}

/**
 * **요청한 배율과 거래소의 실제 배율을 대조한다. 같을 때만 통과한다.**
 *
 * 왜 되읽는가
 * ───────────
 * 설정 요청이 200을 받은 것과 배율이 그 값이 된 것은 다르다. 실제로
 * 이 계좌에서 "거래소 100배 · 의도 50배"가 화면에 떴다. 배율이 다르면
 * 계산한 모든 것이 틀린다 — 청산가도, 필요 증거금도, 손절이 청산 안쪽인지도.
 * 100배에서 청산 거리는 1%보다 좁은데 손절을 1.57%에 걸어 두면 손절이
 * 작동하기 전에 청산된다.
 *
 * 왜 '더 낮은 것'도 막는가
 * ────────────────────────
 * 처음에는 실제가 요청보다 **낮으면** 통과시켰다. 청산가가 오히려 멀어지니
 * 안전하다고 봤다. 그 판단이 틀렸다.
 *
 * 100배로 잡은 전략은 **수량을 100배 기준으로 계산한다.** 거래소가 75배로
 * 깎으면 같은 수량에 증거금이 1.33배 더 필요하고, 위험 금액·목표 수익·
 * 손절 거리 대비 기대값이 전부 전략이 계산한 것과 달라진다. 즉 사용자가
 * 검증한 그 전략이 아니라 **다른 전략**이 도는 것이다. 화면에는 100배
 * 전략이 실행 중이라고 뜬 채로.
 *
 * 그래서 요청과 실제가 다르면 방향에 관계없이 막는다. 사용자가 만든
 * 100배 설정은 **그대로 둔다** — 우리가 낮추지도, 낮아진 값으로 대신
 * 실행하지도 않는다. 어느 쪽으로 갈지는 사용자가 정한다.
 *
 * 왜 설정 응답을 근거로 쓰지 않는가
 * ─────────────────────────────────
 * 설정 응답은 "요청을 받았다"이지 "그 값이 됐다"가 아니다. 그것으로
 * 판정하면 되읽기 검사가 있으나 마나다 — **독립적으로 되읽은 값이
 * 없으면 UNVERIFIED다.** 확인하지 못한 것은 통과가 아니다.
 *
 * @param applied  설정 응답이 알려준 값. **판정에 쓰지 않는다.** 메시지에만 남긴다
 * @param observed 독립적으로 되읽은 값. 판정은 오직 이것으로 한다
 */
export function leverageVerdict(
  requested: number | null | undefined,
  applied: number | null | undefined,
  observed: number | null | undefined,
): LeverageVerdict {
  const req = Number(requested);
  if (!Number.isFinite(req) || req <= 0) {
    return { ok: true, code: 'NOT_REQUESTED', observed: null,
      message: '배율을 지정하지 않아 거래소 설정을 그대로 씁니다' };
  }

  const obs = Number(observed);
  const actual = Number.isFinite(obs) && obs > 0 ? obs : null;

  // 설정 응답 값은 참고로만 적는다. 판정에는 절대 쓰지 않는다.
  const app = Number(applied);
  const appNote = Number.isFinite(app) && app > 0 ? ` (설정 응답은 ${app}배였습니다)` : '';

  if (actual == null) {
    return {
      ok: false, code: 'UNVERIFIED', observed: null,
      message: `요청 ${req}배가 실제로 적용됐는지 **되읽어 확인하지 못했습니다**${appNote}. `
             + '설정 응답은 "요청을 받았다"이지 "그 값이 됐다"가 아니므로 근거로 쓰지 않습니다. '
             + '배율을 모르면 청산가도 필요 증거금도 계산할 수 없어 주문하지 않습니다.',
    };
  }

  if (actual > req) {
    return {
      ok: false, code: 'HIGHER_THAN_REQUESTED', observed: actual,
      message: `거래소 배율이 ${actual}배인데 요청은 ${req}배입니다(되읽음)${appNote}. `
             + '실제가 더 높으면 청산가가 계산한 자리보다 가까워 주문하지 않습니다.',
    };
  }

  if (actual < req) {
    return {
      ok: false, code: 'VENUE_CAPPED', observed: actual,
      message: `요청 ${req}배인데 거래소 실제 배율은 ${actual}배입니다(되읽음)${appNote} — `
             + `거래소가 이 종목·수량에 상한을 걸었습니다. `
             + `${actual}배로는 같은 수량에 증거금이 ${(req / actual).toFixed(2)}배 더 들고, `
             + '위험 금액과 기대값이 전략이 계산한 것과 달라집니다 — '
             + `사용자가 검증한 ${req}배 전략이 아니라 다른 전략이 도는 셈이라 주문하지 않습니다. `
             + '전략 설정은 그대로 두었습니다. 수량을 줄이거나, 배율을 직접 조정하거나, '
             + '다른 종목을 쓸지는 사용자가 정할 일입니다.',
    };
  }

  return { ok: true, code: 'MATCH', observed: actual,
    message: `배율 ${actual}배 확인(되읽음)` };
}

/**
 * 배율을 설정하고 **되읽어 확인한다.** 두 거래소 다.
 *
 * `futuresSetLeverage`는 설정만 한다. 여기서 `futuresPositionRisk`로 한 번 더
 * 물어본다 — 같은 응답을 두 번 읽는 것이 아니라 **다른 엔드포인트**에
 * 물어보는 것이라, 설정 응답이 낙관적일 때 그것을 잡는다.
 */
export async function futuresApplyLeverage(
  t: ExecTarget, symbol: string, leverage: number | null | undefined,
): Promise<LeverageVerdict> {
  const req = Number(leverage);
  if (!Number.isFinite(req) || req <= 0) return leverageVerdict(null, null, null);

  let applied: number | null = null;
  let setMsg = '';
  try {
    const r = await futuresSetLeverage(t.exchange, t.key, t.secret, symbol, req, t.testnet);
    applied = r.leverage ?? null;
    setMsg = r.message || '';
    if (!r.success && applied == null) {
      return {
        ok: false, code: 'UNVERIFIED', observed: null,
        message: `배율 ${req}배 설정에 실패했습니다: ${setMsg || '사유 미상'}`,
      };
    }
  } catch (e: any) {
    setMsg = String(e?.message || e);
  }

  // 되읽기. 실패해도 던지지 않는다 — 설정 응답으로 판정하고, 그 사실을 적는다.
  let observed: number | null = null;
  try {
    const rr = await futuresPositionRisk(t.exchange, t.key, t.secret, symbol, t.testnet);
    observed = rr.risk?.leverage ?? null;
  } catch { observed = null; }

  const v = leverageVerdict(req, applied, observed);
  if (v.code === 'UNVERIFIED' && setMsg) {
    return { ...v, message: `${v.message} (설정 응답: ${setMsg})` };
  }
  return v;
}

// ── 포지션 모드 ──────────────────────────────────────

export interface PositionModeVerdict {
  ok: boolean;
  mode: 'ONE_WAY' | 'HEDGE' | null;
  code: 'ONE_WAY' | 'HEDGE_BLOCKED' | 'UNKNOWN';
  message: string;
}

/**
 * **이 실행기는 단방향(One-way) 주문만 만든다. 확인될 때만 신규 진입한다.**
 *
 * 헤지 모드 계좌에 단방향 주문을 보내면 어떻게 되는가
 * ──────────────────────────────────────────────────
 * 바이낸스는 `positionSide` 없는 주문을 거부한다(-4061). 거부는 안전하지만
 * 이유가 "주문 실패"로만 보여서, 사용자가 키·수량·잔고를 뒤지게 된다 —
 * 거기엔 고칠 것이 없다. 그래서 **확인된 헤지 모드는 여기서 막고 그렇게
 * 적는다.**
 *
 * 왜 '못 읽음'도 막는가
 * ─────────────────────
 * 처음에는 못 읽으면 진행시켰다. "어차피 거래소가 거부할 뿐 조용히 틀리지는
 * 않는다"고 봤다. 그 판단이 틀렸다 — 거절만 나는 것이 아니다. Gate는 이중
 * 모드에서 방향 인자를 다르게 해석하고, 그 경우 **의도와 다른 쪽 포지션이
 * 열릴 수 있다.** 조용히 틀리는 쪽이 언제나 더 나쁘다.
 *
 * 그리고 이 검사는 **신규 진입에만** 건다. 청산(reduceOnly)은 모드를 못
 * 읽어도 그대로 나간다 — 못 여는 것은 불편이고 못 닫는 것은 사고다.
 * 조회 한 번 실패로 새 포지션은 안 열리지만, 이미 연 것은 언제나 닫힌다.
 */
export function positionModeVerdict(
  mode: 'ONE_WAY' | 'HEDGE' | null | undefined, error?: string | null,
): PositionModeVerdict {
  if (mode === 'HEDGE') {
    return {
      ok: false, mode: 'HEDGE', code: 'HEDGE_BLOCKED',
      message: '이 계좌가 헤지 모드(양방향)입니다. 이 실행기는 단방향 주문만 만들기 때문에 '
             + '거래소에서 포지션 모드를 단방향(One-way)으로 바꾸세요. '
             + '키·수량·잔고 문제가 아닙니다.',
    };
  }
  if (mode === 'ONE_WAY') {
    return { ok: true, mode: 'ONE_WAY', code: 'ONE_WAY', message: '포지션 모드 단방향 확인' };
  }
  return {
    ok: false, mode: null, code: 'UNKNOWN',
    message: `포지션 모드를 읽지 못했습니다${error ? ` (${error})` : ''}. `
           + '헤지 모드였다면 이 단방향 주문이 의도와 다른 쪽 포지션을 열 수 있어 '
           + '신규 진입을 하지 않습니다 — 확인하지 못한 것은 통과가 아닙니다. '
           + '(청산은 이 검사를 받지 않습니다. 열린 포지션은 언제나 닫을 수 있습니다.)',
  };
}

/**
 * 모드 조회는 주문마다 하지 않는다. 계좌 설정이라 자주 바뀌지 않는다.
 *
 * **실패는 캐시하지 않는다.** 못 읽음이 신규 진입을 막게 됐으므로, 실패를
 * 60초 담아 두면 순간적인 조회 오류 하나가 그 시간 내내 진입을 막는다.
 * 성공한 값만 담고, 실패는 다음 주문에서 다시 물어본다.
 */
const _modeCache: Record<string, { mode: 'ONE_WAY' | 'HEDGE'; at: number }> = {};
const MODE_TTL_MS = 60_000;

export async function futuresCheckPositionMode(
  t: ExecTarget, nowMs = Date.now(),
): Promise<PositionModeVerdict> {
  // 키 전체를 캐시 열쇠에 넣지 않는다. 앞 8자로 계좌를 구분하기에 충분하다.
  const cacheKey = `${t.exchange}:${t.testnet ? 'demo' : 'live'}:${t.key.slice(0, 8)}`;
  const hit = _modeCache[cacheKey];
  if (hit && nowMs - hit.at < MODE_TTL_MS) return positionModeVerdict(hit.mode, null);
  try {
    const r = await futuresPositionMode(t.exchange, t.key, t.secret, t.testnet);
    if (r.mode === 'ONE_WAY' || r.mode === 'HEDGE') {
      _modeCache[cacheKey] = { mode: r.mode, at: nowMs };
    }
    return positionModeVerdict(r.mode, r.error);
  } catch (e: any) {
    return positionModeVerdict(null, String(e?.message || e));
  }
}

/** 테스트에서 계좌 설정을 바꿔 가며 확인할 때 쓴다 */
export function __clearPositionModeCache() {
  for (const k of Object.keys(_modeCache)) delete _modeCache[k];
}

// ── 수량 규격 ────────────────────────────────────────

export interface SizingResult {
  ok: boolean;
  /** 실제로 보낼 기초자산 수량. Gate도 여기까지는 기초자산이다 */
  baseQty: number | null;
  /** Gate에 보낼 부호 있는 계약 수. 바이낸스는 null */
  gateSize: number | null;
  /** 지정가일 때 호가 단위에 맞춘 가격 */
  price: number | null;
  /** 규격을 실제로 적용했는가. false면 거래소가 거부할 수 있다 */
  applied: boolean;
  /** 사람이 읽는 한 줄. 값이 바뀌었으면 반드시 여기 적힌다 */
  note: string;
}

/**
 * 주문 수량을 거래소 규격에 맞춘다.
 *
 * Gate는 **정수 계약**이다. 1계약이 0.0001 BTC라서, 배수를 모르는 채로
 * 0.05를 그대로 보내면 0계약(거부)이거나 500 BTC(의도의 10,000배)가 된다.
 * 그래서 배수를 못 읽으면 **주문하지 않는다.**
 *
 * 바이낸스는 연속 수량이라 `quantizeOrder`의 stepSize 내림으로 끝난다.
 */
export async function futuresSizeOrder(
  t: ExecTarget, symbol: string, quantity: number, price?: number | null,
): Promise<SizingResult> {
  const filters = await futuresSymbolFilters(t.exchange, symbol, t.testnet).catch(() => null);
  const q = quantizeOrder(quantity, price ?? null, filters);
  if (!q.ok || q.quantity == null) {
    return { ok: false, baseQty: null, gateSize: null, price: q.price,
      applied: q.applied, note: q.reason };
  }

  if (t.exchange !== 'gate') {
    return { ok: true, baseQty: q.quantity, gateSize: null, price: q.price,
      applied: q.applied, note: q.reason };
  }

  // Gate: 기초자산 수량 → 부호 있는 계약 수. 이 변환은 gatePlan 한 곳에만 있다.
  const gf = await import('./gateFutures');
  const gp = await import('./gatePlan');
  const contract = gp.toGateContract(symbol);
  if (!contract) {
    return { ok: false, baseQty: null, gateSize: null, price: q.price, applied: false,
      note: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` };
  }
  const spec = await gf.getGateContractSpec(contract, t.testnet).catch(() => null);
  if (!spec) {
    return { ok: false, baseQty: null, gateSize: null, price: q.price, applied: false,
      note: 'Gate 계약 규격(1계약당 수량)을 읽지 못해 주문하지 않습니다 — '
          + '수량 단위를 모르는 채로 보내면 의도와 전혀 다른 크기가 나갑니다' };
  }
  // 부호는 아래 futuresPlaceOrder가 side를 보고 붙인다. 여기서는 크기만 본다.
  const sized = gp.gateSizeFromBase(q.quantity, 'LONG', spec);
  if (!sized.ok) {
    return { ok: false, baseQty: null, gateSize: null, price: q.price, applied: true,
      note: sized.reason };
  }
  const contracts = Math.abs(sized.size);
  const mult = Number(spec.quantoMultiplier);
  return {
    ok: true,
    baseQty: contracts * mult,
    gateSize: contracts,
    price: q.price,
    applied: true,
    note: q.changed ? `${q.reason} · ${sized.reason}` : sized.reason,
  };
}

// ── 주문 ─────────────────────────────────────────────

export type ExecStatus =
  | 'FILLED'     // 체결됐다
  | 'ACKED'      // 접수됐다(지정가 등). 체결은 아직
  | 'UNFILLED'   // 주문은 끝났는데 한 계약도 안 붙었다 — 포지션이 없다
  | 'REJECTED'   // 거래소가 거절했다. 돈은 안 나갔다
  | 'UNKNOWN';   // **응답을 못 받았다.** 나갔는지 모른다

export interface PlaceOrderInput {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  /** 기초자산 수량 (0.05 BTC). 계약 수가 아니다 */
  quantity: number;
  price?: number | null;
  reduceOnly?: boolean;
  /** 멱등 키. **없으면 UNKNOWN에서 대조할 방법이 없다** */
  clientOrderId?: string | null;
  leverage?: number | null;
}

export interface PlaceOrderOutcome {
  ok: boolean;
  status: ExecStatus;
  orderId: string | null;
  clientOrderId: string | null;
  /** 체결된 기초자산 수량. 못 읽으면 null — 0이 아니다 */
  filledQty: number | null;
  avgPrice: number | null;
  /** 수량 규격·배율에서 일어난 일. 값이 바뀌었으면 반드시 여기 있다 */
  notes: string[];
  error: string | null;
}

const fail = (
  status: ExecStatus, error: string, notes: string[] = [], clientOrderId: string | null = null,
): PlaceOrderOutcome => ({
  ok: false, status, orderId: null, clientOrderId, filledQty: null, avgPrice: null, notes, error,
});

/**
 * 선물 주문 하나. 두 거래소 다.
 *
 * 순서가 곧 안전장치다
 * ────────────────────
 *  1. 포지션 모드 확인 — 헤지 모드면 단방향 주문이 거부된다
 *  2. 배율 설정 + **되읽어 확인** — 여기서 막히면 주문은 안 나간다
 *  3. 수량 규격 적용 — Gate는 정수 계약으로, 바이낸스는 stepSize로
 *  4. 주문 전송
 *  5. 체결량 확인 — Gate의 ioc는 200을 주면서 하나도 안 붙을 수 있다
 *
 * **응답을 못 받으면 UNKNOWN이다.** 다시 보내지 않는다. 부르는 쪽이
 * `futuresFindOrderByClientId`로 대조해야 한다.
 */
export async function futuresPlaceOrder(
  t: ExecTarget, input: PlaceOrderInput,
): Promise<PlaceOrderOutcome> {
  const notes: string[] = [];
  const cid = input.clientOrderId ? String(input.clientOrderId) : null;

  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return fail('REJECTED', `수량이 유효하지 않습니다 (${input.quantity})`, notes, cid);
  }

  // 1) 포지션 모드. 확인된 헤지 모드면 여기서 막는다 — 아래로 내려가면
  //    거래소가 -4061로 거부하고, 그 문구로는 원인을 찾을 수 없다.
  //    **청산(reduceOnly)은 검사하지 않는다.** 못 닫게 만드는 검사는 두지 않는다.
  if (!input.reduceOnly) {
    const pm = await futuresCheckPositionMode(t);
    if (pm.code !== 'ONE_WAY') notes.push(pm.message);
    if (!pm.ok) return fail('REJECTED', pm.message, notes, cid);
  }

  // 2) 배율. reduceOnly(청산)에는 손대지 않는다 — 닫는 주문의 배율을 바꿀
  //    이유가 없고, 여기서 막히면 **닫지 못하게 된다.**
  if (!input.reduceOnly && input.leverage != null) {
    const lv = await futuresApplyLeverage(t, input.symbol, input.leverage);
    notes.push(lv.message);
    if (!lv.ok) return fail('REJECTED', lv.message, notes, cid);
  }

  // 3) 수량 규격
  const sized = await futuresSizeOrder(t, input.symbol, qty, input.price);
  if (sized.note) notes.push(sized.note);
  if (!sized.ok || sized.baseQty == null) {
    return fail('REJECTED', sized.note || '수량을 거래소 규격에 맞추지 못했습니다', notes, cid);
  }

  // 4) 전송
  if (t.exchange === 'gate') {
    const gf = await import('./gateFutures');
    const gp = await import('./gatePlan');
    const contract = gp.toGateContract(input.symbol);
    if (!contract) return fail('REJECTED', `Gate 계약 이름을 만들 수 없습니다 (${input.symbol})`, notes, cid);
    if (sized.gateSize == null || sized.gateSize <= 0) {
      return fail('REJECTED', 'Gate 계약 수를 계산하지 못했습니다', notes, cid);
    }
    // Gate의 size 부호가 곧 방향이다. 매수는 양수, 매도는 음수.
    const size = input.side === 'BUY' ? sized.gateSize : -sized.gateSize;
    try {
      const res = await gf.placeOrderGateFutures(t.key, t.secret, {
        contract, size,
        price: input.type === 'LIMIT' && sized.price != null ? String(sized.price) : '0',
        tif: input.type === 'LIMIT' ? 'gtc' : 'ioc',
        reduceOnly: !!input.reduceOnly,
        clientOrderId: cid ?? undefined,
      }, t.testnet);

      const fillView = gp.gateFillOf(res);
      const specForBase = await gf.getGateContractSpec(contract, t.testnet).catch(() => null);
      const filledBase = fillView.filledQty == null
        ? null : gp.gateBaseFromContracts(fillView.filledQty, specForBase);

      if (fillView.unfilled) {
        return {
          ok: false, status: 'UNFILLED',
          orderId: res?.id != null ? String(res.id) : null,
          clientOrderId: cid, filledQty: 0, avgPrice: fillView.avgPrice, notes,
          error: fillView.reason,
        };
      }
      return {
        ok: true,
        status: input.type === 'LIMIT' && (filledBase == null || filledBase === 0) ? 'ACKED' : 'FILLED',
        orderId: res?.id != null ? String(res.id) : null,
        clientOrderId: cid, filledQty: filledBase, avgPrice: fillView.avgPrice, notes, error: null,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      const u = unknownResultVerdict(msg);
      return fail(u.unknown ? 'UNKNOWN' : 'REJECTED', msg, notes, cid);
    }
  }

  // 바이낸스
  const bf = await import('./binanceFutures');
  try {
    const r = await bf.placeFuturesOrder(t.key, t.secret, {
      symbol: input.symbol, side: input.side, type: input.type,
      quantity: sized.baseQty,
      price: input.type === 'LIMIT' && sized.price != null ? sized.price : undefined,
      reduceOnly: !!input.reduceOnly,
      clientOrderId: cid ?? undefined,
    }, t.testnet);

    if (!r.success) {
      const u = unknownResultVerdict(r.message || '');
      return fail(u.unknown ? 'UNKNOWN' : 'REJECTED', r.message || '주문 실패', notes, cid);
    }
    const executed = Number((r.raw as any)?.executedQty);
    const filled = Number.isFinite(executed) ? executed : null;
    const px = Number(r.price);
    return {
      ok: true,
      status: input.type === 'LIMIT' && (filled == null || filled === 0) ? 'ACKED' : 'FILLED',
      orderId: r.orderId != null ? String(r.orderId) : null,
      clientOrderId: cid, filledQty: filled,
      avgPrice: Number.isFinite(px) && px > 0 ? px : null,
      notes, error: null,
    };
  } catch (e: any) {
    const msg = String(e?.message || e);
    const u = unknownResultVerdict(msg);
    return fail(u.unknown ? 'UNKNOWN' : 'REJECTED', msg, notes, cid);
  }
}

// ── UNKNOWN 판정 ─────────────────────────────────────

export interface UnknownVerdict {
  /** 거래소가 받았는지 **모르는** 상태인가 */
  unknown: boolean;
  reason: string;
}

/**
 * 실패 문구가 "거절"인지 "모름"인지 가른다.
 *
 * 이 구분이 곧 재시도 여부다. 거절은 돈이 안 나갔으니 다시 보내도 되고,
 * 모름은 **이미 나갔을 수 있으니 다시 보내면 중복 체결이다.**
 *
 * 예전에는 워커 안에 정규식이 인라인으로 박혀 있었다. 웹 경로에는 없었다 —
 * 같은 판정이 한쪽에만 있으면 다른 쪽은 언젠가 중복 주문을 낸다.
 */
export function unknownResultVerdict(errorText: string | null | undefined): UnknownVerdict {
  const s = String(errorText || '');
  if (!s) return { unknown: false, reason: '' };
  const hit = /응답\s*없음|응답을\s*받지\s*못|타임아웃|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|socket hang up|network\s*error|fetch failed|aborted/i
    .test(s);
  return {
    unknown: hit,
    reason: hit
      ? '거래소 응답을 받지 못했습니다. 주문이 나갔는지 알 수 없어 재시도하지 않습니다 — '
        + 'clientOrderId로 대조해야 합니다.'
      : '',
  };
}

export interface ReconcileDecision {
  action: 'ALREADY_PLACED' | 'NOT_PLACED' | 'STILL_UNKNOWN';
  /** 다시 보내도 되는가. STILL_UNKNOWN이면 절대 안 된다 */
  mayResend: boolean;
  message: string;
}

/**
 * UNKNOWN 뒤에 clientOrderId로 대조한 결과 → 다음 행동.
 *
 * **조회 실패와 '없음'을 구분한다.** 둘을 같이 취급하면, 레이트리밋 한 번이
 * 그대로 중복 체결이 된다.
 */
export function reconcileDecision(
  lookup: { ok: boolean; found: boolean } | null | undefined,
): ReconcileDecision {
  if (!lookup || lookup.ok !== true) {
    return {
      action: 'STILL_UNKNOWN', mayResend: false,
      message: '거래소에서 주문을 조회하지 못했습니다. 나갔는지 여전히 모르므로 '
             + '다시 보내지 않습니다 — 거래소 화면에서 직접 확인하세요.',
    };
  }
  if (lookup.found) {
    return {
      action: 'ALREADY_PLACED', mayResend: false,
      message: '같은 clientOrderId의 주문이 거래소에 이미 있습니다. 다시 보내지 않습니다.',
    };
  }
  return {
    action: 'NOT_PLACED', mayResend: true,
    message: '거래소에 그 주문이 없습니다. 나가지 않은 것이 확인됐으므로 다시 보낼 수 있습니다.',
  };
}

/**
 * clientOrderId로 주문을 찾는다. 두 거래소 다.
 *
 * **조회 실패(ok:false)와 없음(ok:true, found:false)은 다른 값이다.**
 */
export async function futuresFindOrderByClientId(
  t: ExecTarget, symbol: string, clientOrderId: string,
): Promise<{ ok: boolean; found: boolean; order: any; error: string | null }> {
  if (!clientOrderId) {
    return { ok: false, found: false, order: null,
      error: 'clientOrderId가 없어 대조할 수 없습니다' };
  }
  try {
    if (t.exchange === 'gate') {
      const gf = await import('./gateFutures');
      const gp = await import('./gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) {
        return { ok: false, found: false, order: null,
          error: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` };
      }
      const r = await gf.findOrderByClientIdGateFutures(
        t.key, t.secret, contract, clientOrderId, t.testnet);
      return { ok: r.ok, found: !!r.order, order: r.order, error: r.error ?? null };
    }
    const bf = await import('./binanceFutures');
    const r = await bf.findOrderByClientId(t.key, t.secret, symbol, clientOrderId, t.testnet);
    return { ok: true, found: !!r.found, order: r.order ?? null, error: null };
  } catch (e: any) {
    return { ok: false, found: false, order: null, error: String(e?.message || e) };
  }
}

// ── 포지션 · 미체결 ──────────────────────────────────

export interface ExecPosition {
  /** 거래소가 쓰는 이름 그대로 (Gate는 'BTC_USDT') */
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** 기초자산 수량(절대값). Gate도 계약 수가 아니라 기초자산이다 */
  amount: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
}

/**
 * 열린 포지션 목록. 두 거래소 다.
 *
 * **실패를 빈 배열로 돌려주지 않는다.** 빈 배열은 "포지션이 없다"는 뜻이고,
 * 그걸 Ghost Sync가 읽으면 "거래소에서 사라졌다"는 경고를 모든 포지션에
 * 대해 쏜다. 0과 모름은 다른 값이다.
 */
export async function futuresListPositions(
  t: ExecTarget,
): Promise<{ ok: boolean; positions: ExecPosition[]; error: string | null }> {
  try {
    if (t.exchange === 'gate') {
      const gf = await import('./gateFutures');
      const gp = await import('./gatePlan');
      const rows = await gf.getPositionsGateFutures(t.key, t.secret, t.testnet);
      const out: ExecPosition[] = [];
      for (const p of rows) {
        const spec = await gf.getGateContractSpec(p.contract, t.testnet).catch(() => null);
        const base = gp.gateBaseFromContracts(Number(p.size), spec);
        const lev = Number(p.leverage);
        const entry = Number(p.entry_price);
        const pnl = Number(p.unrealised_pnl);
        const liq = Number(p.liq_price);
        out.push({
          symbol: p.contract,
          side: Number(p.size) > 0 ? 'LONG' : 'SHORT',
          // 배수를 못 읽으면 **null이다.** 계약 수를 수량 칸에 적지 않는다.
          amount: base == null ? null : Math.abs(base),
          entryPrice: Number.isFinite(entry) && entry > 0 ? entry : null,
          markPrice: null,
          unrealizedPnl: Number.isFinite(pnl) ? pnl : null,
          // Gate는 leverage 0이 교차 마진이다. 0을 배율로 적지 않는다.
          leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
          liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : null,
        });
      }
      return { ok: true, positions: out, error: null };
    }

    const bf = await import('./binanceFutures');
    const r: any = await bf.getFuturesPositions(t.key, t.secret, t.testnet);
    if (!r?.success) {
      return { ok: false, positions: [], error: r?.message || '포지션 조회 실패' };
    }
    const out: ExecPosition[] = ((r.positions || []) as any[]).map((p: any) => ({
      symbol: String(p.symbol),
      side: p.side === 'SHORT' ? 'SHORT' : 'LONG',
      amount: Number.isFinite(p.amount) ? Math.abs(Number(p.amount)) : null,
      entryPrice: Number.isFinite(p.entryPrice) ? Number(p.entryPrice) : null,
      markPrice: Number.isFinite(p.markPrice) ? Number(p.markPrice) : null,
      unrealizedPnl: Number.isFinite(p.unrealizedPnl) ? Number(p.unrealizedPnl) : null,
      leverage: Number.isFinite(p.leverage) && Number(p.leverage) > 0 ? Number(p.leverage) : null,
      liquidationPrice: Number.isFinite(p.liquidationPrice) && Number(p.liquidationPrice) > 0
        ? Number(p.liquidationPrice) : null,
    }));
    return { ok: true, positions: out, error: null };
  } catch (e: any) {
    return { ok: false, positions: [], error: String(e?.message || e) };
  }
}

/**
 * 남은 포지션·미체결 수. 킬스위치가 "정말 비었는가"를 이걸로 판정한다.
 *
 * **못 세면 null이다.** 0으로 적으면 "다 닫혔다"가 사실이 되고, 킬스위치가
 * 잔여를 남긴 채 완료로 보고한다.
 */
export async function futuresCountOpen(
  t: ExecTarget,
): Promise<{ positions: number | null; orders: number | null; error: string | null }> {
  try {
    if (t.exchange === 'gate') {
      const gf = await import('./gateFutures');
      const [pos, ord] = await Promise.all([
        gf.getPositionsGateFutures(t.key, t.secret, t.testnet),
        gf.getOpenOrdersGateFutures(t.key, t.secret, t.testnet),
      ]);

      // ── 조건부 주문도 미체결이다 ──
      //
      // 손절이 `price_orders`에만 남아 있으면 일반 주문 목록은 비어
      // 보이고, 킬스위치가 '정리 완료'라고 말한다.
      //
      // **예전에는 계약을 추측해서 훑었다.** 포지션과 일반 주문에 등장한
      // 계약만 물어봤는데, 그러면 이런 상태에 눈이 먼다:
      //
      //   포지션      0
      //   일반 주문   0
      //   조건부      손절 1개  ← 이 계약을 알아낼 단서가 아무 데도 없다
      //
      // 훑을 계약이 하나도 없으니 조건부 0건이 되고 `clean: true`가 된다.
      // **킬스위치의 최종 보증이 거기서 깨진다.**
      //
      // 그래서 계약을 추측하는 단계 자체를 없앤다 — `contract` 없이
      // 전부 물어본다. 그 조회가 실패하면 계약별 조회로 내려가되,
      // **그때는 "0건"이라고 말하지 않는다.**
      const all = await gf.getAllPriceOrdersGateFutures(t.key, t.secret, t.testnet);
      if (all != null) {
        return { positions: pos.length, orders: ord.length + all.length, error: null };
      }

      const contracts = new Set<string>();
      for (const p of pos) contracts.add(String(p.contract));
      for (const o of ord) if (o?.contract) contracts.add(String(o.contract));

      let priceOrders = 0;
      let priceUnknown = false;
      for (const c of contracts) {
        const rows = await gf.getPriceOrdersGateFutures(t.key, t.secret, c, t.testnet);
        // null은 **조회 실패**다. 0으로 세면 "남은 손절이 없다"가 사실이 된다.
        if (rows == null) { priceUnknown = true; continue; }
        priceOrders += rows.length;
      }

      // **훑을 계약이 없었던 것은 "없다"가 아니다.**
      //
      // 전체 조회가 실패했고 계약도 못 찾았으면, 조건부 주문이 있는지
      // 없는지 **아무것도 확인하지 않은 것**이다. 이걸 0으로 적으면
      // 정확히 이 PR이 고치려는 오판이 된다.
      const blind = contracts.size === 0;
      return {
        positions: pos.length,
        orders: (priceUnknown || blind) ? null : ord.length + priceOrders,
        error: blind
          ? '조건부 주문(손절·익절) 전체 조회에 실패했고 훑을 계약도 찾지 못했습니다 — '
            + '남은 손절이 없다는 뜻이 아닙니다'
          : priceUnknown
            ? '조건부 주문(손절·익절)을 일부 계약에서 조회하지 못했습니다 — 미체결 수를 확정할 수 없습니다'
            : null,
      };
    }
    const bf = await import('./binanceFutures');
    const r = await bf.countOpen(t.key, t.secret, t.testnet);
    return { positions: r.positions, orders: r.orders, error: null };
  } catch (e: any) {
    return { positions: null, orders: null, error: String(e?.message || e) };
  }
}

// ── 손절 · 익절 ──────────────────────────────────────

export interface TpslInput {
  symbol: string;
  /** 보호할 포지션의 방향 */
  positionSide: 'LONG' | 'SHORT';
  tpPrice?: number | null;
  slPrice?: number | null;
  /** 기준가(있으면). 방향이 뒤집힌 트리거를 여기서 잡는다 */
  refPrice?: number | null;
  /** 바이낸스 대체 시도에 쓸 수량 */
  quantity?: number | null;
  clientOrderId?: string | null;
  /**
   * 기존 보호 주문을 지우고 다시 건다.
   *
   * SET_TPSL은 같은 포지션에 여러 번 올 수 있다(손절 이동·본전 이동).
   * 지우지 않으면 손절이 여러 개 쌓이고, 포지션이 닫힌 뒤에도 남은 하나가
   * 트리거에 닿아 **반대 방향으로 새 포지션을 연다.**
   *
   * 전량 청산용(closePosition/auto_size)만 지운다 — 분할 익절 사다리와
   * 사용자가 직접 건 지정가는 남긴다.
   */
  replaceExisting?: boolean;
}

export interface TpslOutcome {
  ok: boolean;
  tp: { ok: boolean; orderId: string | null; message: string } | null;
  sl: { ok: boolean; orderId: string | null; message: string } | null;
  message: string;
}

/**
 * 손절·익절을 건다. 두 거래소 다.
 *
 * **못 여는 것은 불편이고 못 닫는 것은 사고다.** 이 함수가 Gate에서 안 돌면
 * 열 수는 있는데 보호가 없는 포지션이 남는다.
 *
 * 방향 판정은 `gateStopSpec` · `gateTakeProfitSpec` 한 곳에만 있다 —
 * 부등호를 여기서 다시 쓰면 언젠가 익절이 손절 자리에 걸린다.
 */
export async function futuresSetTpsl(t: ExecTarget, input: TpslInput): Promise<TpslOutcome> {
  const hasTp = input.tpPrice != null && Number(input.tpPrice) > 0;
  const hasSl = input.slPrice != null && Number(input.slPrice) > 0;
  if (!hasTp && !hasSl) {
    return { ok: false, tp: null, sl: null, message: '걸 손절·익절 가격이 없습니다' };
  }

  if (t.exchange === 'gate') {
    const gf = await import('./gateFutures');
    const gp = await import('./gatePlan');
    const contract = gp.toGateContract(input.symbol);
    if (!contract) {
      return { ok: false, tp: null, sl: null,
        message: `Gate 계약 이름을 만들 수 없습니다 (${input.symbol})` };
    }
    const spec = await gf.getGateContractSpec(contract, t.testnet).catch(() => null);

    if (input.replaceExisting) {
      // Gate의 조건부 주문은 전부 전량 청산형이다. 계약 단위로 지운다.
      try {
        await gf.gateReq<any[]>('DELETE', '/api/v4/futures/usdt/price_orders', {
          key: t.key, secret: t.secret, qs: `contract=${contract}`, testnet: t.testnet,
        });
      } catch { /* 못 지웠으면 아래에서 새로 걸린다 — 중복이 남는 편이 보호가 없는 것보다 낫다 */ }
    }

    let tp: TpslOutcome['tp'] = null;
    let sl: TpslOutcome['sl'] = null;

    if (hasTp) {
      const s = gp.gateTakeProfitSpec(input.positionSide, input.tpPrice, input.refPrice, spec);
      if (!s.ok) tp = { ok: false, orderId: null, message: s.reason };
      else {
        const r = await gf.placeStopGateFutures(t.key, t.secret, {
          contract, spec: s,
          clientOrderId: input.clientOrderId ? `${input.clientOrderId}TP` : undefined,
        }, t.testnet);
        tp = { ok: r.success, orderId: r.orderId ?? null,
          message: s.note ? `${r.message} · ${s.note}` : r.message };
      }
    }
    if (hasSl) {
      const s = gp.gateStopSpec(input.positionSide, input.slPrice, input.refPrice, spec);
      if (!s.ok) sl = { ok: false, orderId: null, message: s.reason };
      else {
        const r = await gf.placeStopGateFutures(t.key, t.secret, {
          contract, spec: s,
          clientOrderId: input.clientOrderId ? `${input.clientOrderId}SL` : undefined,
        }, t.testnet);
        sl = { ok: r.success, orderId: r.orderId ?? null,
          message: s.note ? `${r.message} · ${s.note}` : r.message };
      }
    }
    return tpslOutcome(tp, sl);
  }

  // 바이낸스: 포지션을 닫는 방향이므로 side가 뒤집힌다.
  const closeSide: 'BUY' | 'SELL' = input.positionSide === 'LONG' ? 'SELL' : 'BUY';
  const bf = await import('./binanceFutures');

  if (input.replaceExisting) {
    // **전량 청산용(closePosition:true)만** 지운다. 분할 익절 사다리와
    // 사용자가 직접 건 주문은 이 함수의 책임이 아니다.
    try { await bf.cancelOpenTPSL(t.key, t.secret, input.symbol, t.testnet); }
    catch { /* 조회 실패 시 건너뛴다 — 남의 주문을 지우는 것보다 중복이 낫다 */ }
  }

  let tp: TpslOutcome['tp'] = null;
  let sl: TpslOutcome['sl'] = null;

  if (hasTp) {
    const r = await bf.placeFuturesTPSL(t.key, t.secret, {
      symbol: input.symbol, side: closeSide, stopPrice: Number(input.tpPrice),
      type: 'TAKE_PROFIT_MARKET', fallbackQuantity: input.quantity ?? null,
    }, t.testnet);
    tp = { ok: !!r.success, orderId: r.orderId != null ? String(r.orderId) : null, message: r.message };
  }
  if (hasSl) {
    const r = await bf.placeFuturesTPSL(t.key, t.secret, {
      symbol: input.symbol, side: closeSide, stopPrice: Number(input.slPrice),
      type: 'STOP_MARKET', fallbackQuantity: input.quantity ?? null,
    }, t.testnet);
    sl = { ok: !!r.success, orderId: r.orderId != null ? String(r.orderId) : null, message: r.message };
  }
  return tpslOutcome(tp, sl);
}

function tpslOutcome(tp: TpslOutcome['tp'], sl: TpslOutcome['sl']): TpslOutcome {
  const parts: string[] = [];
  if (tp) parts.push(`익절: ${tp.message}`);
  if (sl) parts.push(`손절: ${sl.message}`);
  // **손절이 실패하면 전체 실패다.** 익절만 걸린 포지션은 보호가 없는
  // 포지션이고, 화면에는 'TP/SL 설정됨'으로 뜬다.
  const ok = (!sl || sl.ok) && (!tp || tp.ok);
  return { ok, tp, sl, message: parts.join(' · ') };
}

/** 포지션 하나를 비율만큼 닫는다. `futuresAdapter`의 판정을 그대로 쓴다 */
export async function futuresClosePositionPct(
  t: ExecTarget, symbol: string, pct: number,
): Promise<{ ok: boolean; message: string }> {
  const r = await futuresClosePosition(t.exchange, t.key, t.secret, t.testnet, symbol, pct);
  return { ok: r.success, message: r.message };
}
