// src/lib/markets/venueBars.ts
//
// **신호를 계산한 시장과 주문이 나가는 시장을 같게 만든다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 자동매매 두 경로(일봉 사다리·단타)가 봉을 이렇게 가져왔다:
//
//   https://api.binance.com/api/v3/klines     ← 바이낸스 **현물**
//
// 그런데 주문은 바이낸스 **선물**이나 **Gate 선물**로 나간다. 즉:
//
//   · 현물 가격으로 돌파를 판단하고, 선물 호가로 체결한다
//   · 현물 거래량으로 힘을 재고, 선물 유동성에서 슬리피지를 먹는다
//   · Gate에서 거래하는데 판단 근거는 바이낸스다
//
// 현물과 선물은 **다른 가격**이다. 베이시스가 0.05~0.5%씩 벌어지고 변동성
// 구간에서는 더 벌어진다. 손절 폭이 1%인 전략에서 그건 무시할 수 있는
// 오차가 아니라 **손절 거리의 절반**이다. 그리고 진입가·손절가·청산 거리가
// 전부 그 값에서 나오므로, 시세가 틀리면 그 뒤가 전부 틀린다.
//
// 거래소가 다른 경우는 더 나쁘다. Gate의 BTC가 급락하는 동안 바이낸스는
// 멀쩡할 수 있고, 그러면 **일어나지 않은 신호로 주문을 낸다.**
//
// 미완성 봉
// ─────────
// 거래소 klines의 마지막 원소는 **아직 안 끝난 봉**이다. 그걸 그대로 쓰면
// '마지막 종가'가 종가가 아니라 지금 가격이다. 돌파가 생겼다 사라지고,
// 같은 봉 안에서 판정이 계속 바뀐다 — 그리고 사다리 전략은 그 값으로
// 손절가를 만든다.
//
// 여기서 잘라 낸다. 자르는 판단은 순수 함수로 빼서 테스트를 붙였다.

export interface VenueBars {
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
  /** 각 봉의 **여는** 시각 (epoch ms). 완성 여부 판단에 쓴다 */
  openTimes: number[];
}

export interface VenueBarsResult {
  bars: VenueBars | null;
  /** 어디서 읽었는지. 화면·로그가 이걸 적어야 시세 출처를 확인할 수 있다 */
  source: string;
  error: string | null;
  /** 미완성 봉을 잘라 냈는가 */
  droppedIncomplete: boolean;
}

/** 봉 길이(ms). 모르는 간격은 null — 추측해서 자르지 않는다 */
export function intervalMs(interval: string): number | null {
  const m = /^(\d+)([mhdw])$/.exec(String(interval || '').trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] === 'm' ? 60_000
    : m[2] === 'h' ? 3_600_000
    : m[2] === 'd' ? 86_400_000
    : 604_800_000;
  return n * unit;
}

/**
 * 아직 안 끝난 마지막 봉을 잘라 낸다.
 *
 * **여는 시각 + 봉 길이 > 지금**이면 그 봉은 진행 중이다.
 *
 * 간격을 못 읽으면 **자르지 않는다.** 여기서 추측해서 자르면 멀쩡한 봉을
 * 하나 잃고, 그건 지표를 한 칸씩 밀어 놓는다 — 조용히 틀리는 쪽이다.
 * 대신 잘랐는지 여부를 돌려주므로 호출부가 그 사실을 적을 수 있다.
 */
export function dropIncompleteBar<T extends { openTime: number }>(
  rows: T[], interval: string, nowMs: number,
): { rows: T[]; dropped: boolean } {
  const step = intervalMs(interval);
  if (step == null || !Array.isArray(rows) || rows.length === 0) {
    return { rows: Array.isArray(rows) ? rows : [], dropped: false };
  }
  const last = rows[rows.length - 1];
  const open = Number(last?.openTime);
  if (!Number.isFinite(open)) return { rows, dropped: false };
  // 경계에 정확히 걸린 봉(open + step === now)은 방금 닫힌 것이다. 자르지 않는다.
  if (open + step > nowMs) return { rows: rows.slice(0, -1), dropped: true };
  return { rows, dropped: false };
}

interface RawBar { openTime: number; high: number; low: number; close: number; volume: number }

function toVenueBars(rows: RawBar[]): VenueBars | null {
  const highs: number[] = [], lows: number[] = [], closes: number[] = [],
        volumes: number[] = [], openTimes: number[] = [];
  for (const r of rows) {
    if (![r.high, r.low, r.close].every(Number.isFinite)) continue;
    highs.push(r.high); lows.push(r.low); closes.push(r.close);
    volumes.push(Number.isFinite(r.volume) ? r.volume : 0);
    openTimes.push(r.openTime);
  }
  return closes.length ? { highs, lows, closes, volumes, openTimes } : null;
}

/** Gate 간격 이름. 저장소는 바이낸스 표기를 쓰므로 여기서 맞춘다 */
function gateInterval(interval: string): string | null {
  const v = String(interval || '').trim().toLowerCase();
  // Gate가 받는 값들. 여기 없는 간격은 **바꿔치지 않는다** —
  // 가까운 값으로 대신 주면 다른 시간축의 신호로 주문을 내게 된다.
  const ok = ['10s', '1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d'];
  return ok.includes(v) ? v : null;
}

/**
 * **주문이 나갈 시장에서** 봉을 읽는다.
 *
 * 실패는 null이다. 빈 배열로 돌려주면 위쪽에서 '봉이 모자랍니다'가 되어,
 * 시세를 못 가져온 것과 시장이 조용한 것이 같은 문구가 된다.
 */
export async function fetchVenueBars(opts: {
  exchange: 'binance' | 'gate';
  symbol: string;
  interval: string;
  limit: number;
  testnet: boolean;
  /** 테스트가 시계를 고정하기 위해 쓴다 */
  nowMs?: number;
}): Promise<VenueBarsResult> {
  const now = opts.nowMs ?? Date.now();
  // 미완성 봉을 하나 버리므로 하나 더 받는다. 안 그러면 지표 길이가 모자란다.
  const want = Math.max(1, Math.min(1000, Math.floor(opts.limit) + 1));

  try {
    if (opts.exchange === 'gate') {
      const gf = await import('@/lib/exchanges/gateFutures');
      const gp = await import('@/lib/exchanges/gatePlan');
      const contract = gp.toGateContract(opts.symbol);
      const gi = gateInterval(opts.interval);
      if (!contract) {
        return { bars: null, source: 'gate', droppedIncomplete: false,
          error: `Gate 계약 이름을 만들 수 없습니다 (${opts.symbol})` };
      }
      if (!gi) {
        return { bars: null, source: 'gate', droppedIncomplete: false,
          error: `Gate가 받지 않는 봉 간격입니다 (${opts.interval}) — 가까운 간격으로 `
               + '바꿔치면 다른 시간축의 신호로 주문을 내게 됩니다' };
      }
      const src = `gate:${opts.testnet ? 'demo' : 'live'}:futures:${contract}:${gi}`;
      const rows = await gf.gateReq<any[]>('GET', '/api/v4/futures/usdt/candlesticks', {
        qs: `contract=${contract}&interval=${gi}&limit=${want}`, testnet: opts.testnet,
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        return { bars: null, source: src, error: 'Gate 봉 응답이 비어 있습니다', droppedIncomplete: false };
      }
      // Gate는 시각이 **초 단위**다. ms로 비교하면 1970년으로 읽힌다.
      const parsed: RawBar[] = rows.map((k: any) => ({
        openTime: Number(k?.t) * 1000,
        high: parseFloat(k?.h), low: parseFloat(k?.l),
        close: parseFloat(k?.c), volume: parseFloat(k?.v),
      })).sort((a, b) => a.openTime - b.openTime);

      const cut = dropIncompleteBar(parsed, opts.interval, now);
      return { bars: toVenueBars(cut.rows), source: src, error: null, droppedIncomplete: cut.dropped };
    }

    // ── 바이낸스 **선물**(fapi) ──
    // 현물(api.binance.com/api/v3)이 아니다. 주문이 선물로 나가므로 시세도
    // 선물이어야 한다 — 두 시장의 가격은 베이시스만큼 다르다.
    const bf = await import('@/lib/exchanges/binanceFutures');
    // 호스트는 binanceFutures 한 곳에서 가져온다. 여기에 주소를 또 적으면
    // 데모 주소를 한쪽만 고치는 순간 시세와 주문이 다른 서버를 보게 된다.
    const host = bf.futuresBase(opts.testnet);
    const src = `binance:${opts.testnet ? 'demo' : 'live'}:futures:${opts.symbol}:${opts.interval}`;
    const r = await fetch(
      `${host}/fapi/v1/klines?symbol=${encodeURIComponent(opts.symbol)}`
      + `&interval=${encodeURIComponent(opts.interval)}&limit=${want}`,
      { signal: AbortSignal.timeout(10_000), cache: 'no-store' },
    );
    if (!r.ok) {
      return { bars: null, source: src, error: `봉 조회 실패 (HTTP ${r.status})`, droppedIncomplete: false };
    }
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { bars: null, source: src, error: '봉 응답이 비어 있습니다', droppedIncomplete: false };
    }
    const parsed: RawBar[] = data
      .filter((k: any) => Array.isArray(k) && k.length >= 6)
      .map((k: any) => ({
        openTime: Number(k[0]),
        high: parseFloat(k[2]), low: parseFloat(k[3]),
        close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));

    const cut = dropIncompleteBar(parsed, opts.interval, now);
    return { bars: toVenueBars(cut.rows), source: src, error: null, droppedIncomplete: cut.dropped };
  } catch (e: any) {
    return { bars: null, source: opts.exchange, error: String(e?.message || e), droppedIncomplete: false };
  }
}
