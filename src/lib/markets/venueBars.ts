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
  /**
   * 시가.
   *
   * 예전에는 없었다. 그래서 이 봉을 쓰는 쪽은 갭을 볼 수 없었다 —
   * 전일 종가와 오늘 시가 사이에 손절가가 있으면 그 손절은 **걸어 둔
   * 가격에 안 받는다.** 시가가 없으면 그 사실을 모른 채 손절가에
   * 정확히 나간 것으로 계산되고, 성적표는 실제보다 좋아진다.
   */
  opens: number[];
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

interface RawBar { openTime: number; open: number; high: number; low: number; close: number; volume: number }

function toVenueBars(rows: RawBar[]): VenueBars | null {
  const opens: number[] = [], highs: number[] = [], lows: number[] = [], closes: number[] = [],
        volumes: number[] = [], openTimes: number[] = [];
  for (const r of rows) {
    if (![r.high, r.low, r.close].every(Number.isFinite)) continue;
    // 시가를 못 읽으면 종가로 채우지 않는다 — 그러면 갭이 0으로 보인다.
    // 대신 저가·고가 사이로 잘라 두어, 갭 판정이 없는 쪽(불리하지 않은
    // 쪽)으로만 기울게 한다.
    opens.push(Number.isFinite(r.open) ? r.open : r.close);
    highs.push(r.high); lows.push(r.low); closes.push(r.close);
    volumes.push(Number.isFinite(r.volume) ? r.volume : 0);
    openTimes.push(r.openTime);
  }
  return closes.length ? { opens, highs, lows, closes, volumes, openTimes } : null;
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
/**
 * 바이낸스 봉을 **어디서** 받아 올 것인가.
 *
 * 왜 따로 떼어 냈나
 * ─────────────────
 * 이 판단이 `fetchVenueBars` 안에 묻혀 있는 동안 아무도 시험하지 못했다.
 * 그 함수는 `@/lib/exchanges/*`를 동적으로 부르는데 시험 하네스에는 그
 * 별칭이 없어서 아예 실행되지 않기 때문이다. **그래서 시장이 뒤바뀐
 * 채로 통과했다** — `/api/market/candles`가 `market=SPOT`을 검사하고
 * 응답에 적기까지 하면서 정작 아래로는 넘기지 않았고, 이 함수의 바이낸스
 * 경로는 fapi 전용이었다.
 *
 * 판단만 순수 함수로 꺼내 놓으면 시험이 붙는다. 호스트는 인자로 받는다 —
 * 선물 주소는 `binanceFutures` 한 곳이 정하고 여기에 다시 적지 않는다.
 *
 * 현물에는 데모 서버가 없다. `testnet`은 현물 주소를 바꾸지 않고, 그
 * 사실이 `source`에 그대로 남는다.
 */
export function binanceKlinesUrl(i: {
  market?: 'SPOT' | 'USDM';
  /** `binanceFutures.futuresBase(testnet)`가 준 값 */
  futuresHost: string;
  testnet: boolean;
  symbol: string;
  interval: string;
  limit: number;
  startTimeMs?: number | null;
  endTimeMs?: number | null;
}): { url: string; source: string } {
  // **`Number(null)`은 0이다.** 먼저 걸러 내지 않으면 "구간 없음"이
  // `startTime=0`이 되어 1970년부터 달라는 뜻이 된다 — 조회는 성공하고
  // 응답만 엉뚱해서, 자동매매·백테스트가 조용히 다른 구간을 본다.
  // 이 저장소가 반복해서 밟은 함정이고 여기서도 한 번 밟았다.
  const num = (v: any): number | null => {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const st = num(i.startTimeMs);
  const et = num(i.endTimeMs);
  const range = (st != null ? `&startTime=${Math.floor(st)}` : '')
    + (et != null ? `&endTime=${Math.floor(et)}` : '');
  const q = `symbol=${encodeURIComponent(i.symbol)}`
    + `&interval=${encodeURIComponent(i.interval)}&limit=${i.limit}${range}`;

  // 현물이라고 **말했을 때만** 현물이다. 기본은 선물 — 자동매매·백테스트·
  // 신호 장부가 이 인자 없이 부르고, 그쪽 주문은 선물로 나간다.
  if (i.market === 'SPOT') {
    return {
      url: `https://api.binance.com/api/v3/klines?${q}`,
      source: `binance:live:spot:${i.symbol}:${i.interval}`,
    };
  }
  return {
    url: `${i.futuresHost}/fapi/v1/klines?${q}`,
    source: `binance:${i.testnet ? 'demo' : 'live'}:futures:${i.symbol}:${i.interval}`,
  };
}

export async function fetchVenueBars(opts: {
  exchange: 'binance' | 'gate';
  symbol: string;
  interval: string;
  limit: number;
  testnet: boolean;
  /** 테스트가 시계를 고정하기 위해 쓴다 */
  nowMs?: number;
  /**
   * 구간 조회 — **과거 시점의 봉**을 가져온다.
   *
   * 안 주면 예전과 같이 가장 최근 limit개를 가져온다. 크리에이터 장부는
   * "그 사람이 말한 그 시각의 가격"이 필요해서 이게 있어야 한다 —
   * 최신 봉으로 대신 계산하면 몇 달 전 발언을 오늘 가격으로 채점하게 된다.
   */
  startTimeMs?: number | null;
  endTimeMs?: number | null;
  /**
   * 진행 중인 봉을 남길 것인가. **기본은 남기지 않는다 — 기존 계약 그대로다.**
   *
   * 판정·백테스트는 완성된 봉만 봐야 한다. 미완성 봉의 고가·저가·종가는
   * 아직 움직이는 값이라, 그걸로 손절 도달을 판정하면 실제로는 닿지 않은
   * 손절이 닿은 것으로 적힌다.
   *
   * 반면 **실시간 차트는 그 봉이 있어야 한다.** 지금 만들어지고 있는 봉을
   * 안 그리면 차트가 늘 한 칸 뒤처져 보이고, 그 빈자리를 화면이 스스로
   * 채우기 시작하면 그때부터 우리가 봉을 지어내는 것이다.
   *
   * 그래서 **부르는 쪽이 고르게 한다.** 값을 안 주면 지금까지와 같다.
   */
  keepIncomplete?: boolean;
  /**
   * 어느 시장의 봉인가. **기본은 선물(`USDM`)이다 — 기존 계약 그대로다.**
   *
   * 이 인자가 없던 동안 `/api/market/candles`는 `market=SPOT`을 받아
   * 검증하고 응답에 `market: 'SPOT'`이라고 **적기까지 했지만**, 여기로는
   * 넘기지 않았다. 이 함수의 바이낸스 경로는 fapi 전용이라 현물 화면이
   * 선물 봉을 그렸다.
   *
   * 그래서 한 화면에서 가격 시장이 갈렸다:
   *
   *   차트   = 선물 봉        (fapi klines)
   *   헤더·호가 = 현물         (`streamEndpoints`)
   *   PAPER 체결 = 현물        (`paperPriceSource`)
   *
   * 셋 다 오류를 내지 않는다. 베이시스만큼 조용히 다를 뿐이다.
   *
   * 자동매매·백테스트·신호 장부는 이 인자를 주지 않는다 — 그쪽 주문은
   * 선물로 나가므로 시세도 선물이어야 하고, 기본값이 그 계약을 지킨다.
   */
  market?: 'SPOT' | 'USDM';
}): Promise<VenueBarsResult> {
  const now = opts.nowMs ?? Date.now();
  // 미완성 봉을 하나 버리므로 하나 더 받는다. 안 그러면 지표 길이가 모자란다.
  const want = Math.max(1, Math.min(1000, Math.floor(opts.limit) + 1));
  const st = Number.isFinite(Number(opts.startTimeMs)) ? Number(opts.startTimeMs) : null;
  const et = Number.isFinite(Number(opts.endTimeMs)) ? Number(opts.endTimeMs) : null;

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
      // Gate의 from/to는 **초**다. ms로 넘기면 서기 5만년을 조회한다.
      // 그리고 from을 주면 Gate는 limit을 무시하므로 둘을 같이 보내지 않는다.
      const gq = st != null || et != null
        ? `contract=${contract}&interval=${gi}`
          + (st != null ? `&from=${Math.floor(st / 1000)}` : '')
          + (et != null ? `&to=${Math.floor(et / 1000)}` : '')
        : `contract=${contract}&interval=${gi}&limit=${want}`;
      const rows = await gf.gateReq<any[]>('GET', '/api/v4/futures/usdt/candlesticks', {
        qs: gq, testnet: opts.testnet,
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        return { bars: null, source: src, error: 'Gate 봉 응답이 비어 있습니다', droppedIncomplete: false };
      }
      // Gate는 시각이 **초 단위**다. ms로 비교하면 1970년으로 읽힌다.
      const parsed: RawBar[] = rows.map((k: any) => ({
        openTime: Number(k?.t) * 1000,
        open: parseFloat(k?.o), high: parseFloat(k?.h), low: parseFloat(k?.l),
        close: parseFloat(k?.c), volume: parseFloat(k?.v),
      })).sort((a, b) => a.openTime - b.openTime);

      // **부르는 쪽이 고른다.** 기본은 지금까지처럼 잘라 낸다.
      const cut = opts.keepIncomplete
        ? { rows: parsed, dropped: false }
        : dropIncompleteBar(parsed, opts.interval, now);
      return { bars: toVenueBars(cut.rows), source: src, error: null, droppedIncomplete: cut.dropped };
    }

    // ── 바이낸스 ──
    // 어느 시장인지는 `binanceKlinesUrl`이 정한다. **판단은 그 한 곳에만
    // 있고 시험이 붙어 있다** — 여기 묻어 두면 또 아무도 안 본다.
    const bf = await import('@/lib/exchanges/binanceFutures');
    // 호스트는 binanceFutures 한 곳에서 가져온다. 여기에 주소를 또 적으면
    // 데모 주소를 한쪽만 고치는 순간 시세와 주문이 다른 서버를 보게 된다.
    // 바이낸스는 ms다. Gate와 단위가 다르다 — 한쪽 규칙을 다른 쪽에 쓰면
    // 조회 구간이 통째로 어긋나고, 그때 응답은 비어 있을 뿐 오류가 아니라서
    // '시장이 조용했다'로 읽힌다.
    const { url, source: src } = binanceKlinesUrl({
      market: opts.market,
      futuresHost: bf.futuresBase(opts.testnet),
      testnet: opts.testnet,
      symbol: opts.symbol, interval: opts.interval, limit: want,
      startTimeMs: st, endTimeMs: et,
    });
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
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
        open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]),
        close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));

    const cut = opts.keepIncomplete
      ? { rows: parsed, dropped: false }
      : dropIncompleteBar(parsed, opts.interval, now);
    return { bars: toVenueBars(cut.rows), source: src, error: null, droppedIncomplete: cut.dropped };
  } catch (e: any) {
    return { bars: null, source: opts.exchange, error: String(e?.message || e), droppedIncomplete: false };
  }
}
