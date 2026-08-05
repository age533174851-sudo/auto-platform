// /api/backtest — run backtest server-side using Binance kline data + engine
import { NextRequest, NextResponse } from 'next/server';
import { runBacktest, generateSyntheticCandles, type Strategy, type Candle } from '@/lib/backtest/engine';
import { fetchVenueBars } from '@/lib/markets/venueBars';
import { futuresExchangeOf } from '@/lib/exchanges/futuresAdapter';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/* Binance interval map */
const TF_MAP: Record<string, string> = {
  '15m':'15m', '1h':'1h', '4h':'4h', '1d':'1d', '1w':'1w',
};

/**
 * 캔들을 **주문이 나갈 시장에서** 가져온다.
 *
 * 예전에는 언제나 `api.binance.com/api/v3/klines`였다 — 바이낸스
 * **현물**이다. 그런데 이 백테스트는 배율과 청산가를 계산하는 선물
 * 백테스트이고, 사용자의 연결은 Gate일 수도 있다. 그러면 이런 일이 난다:
 *
 *   Gate 선물 전략을 · 바이낸스 현물 캔들로 검증한다
 *
 * 두 시장은 가격이 다르고, 갭이 다르고, 꼬리가 다르다. 손절이 닿았는지를
 * 판정하는 것이 그 꼬리다. 다른 시장의 꼬리로 판정한 손절 성적표는
 * 이 전략의 성적표가 아니다.
 *
 * **미완성 봉은 뺀다.** 마지막 봉은 아직 진행 중이라 고가·저가가 확정이
 * 아니고, 그 봉에서 손절·익절 판정을 하면 실제로 일어나지 않은 체결이
 * 성적에 들어간다. 판정은 venueBars 한 곳에 있다 — 자동매매가 쓰는
 * 것과 같은 함수여야 두 성적표를 비교할 수 있다.
 */
async function fetchVenueCandles(
  exchange: 'binance' | 'gate', symbol: string, tf: string, limit: number, testnet: boolean,
): Promise<{ candles: Candle[]; dropped: boolean; note: string }> {
  const interval = TF_MAP[tf] || '1d';
  const r = await fetchVenueBars({
    exchange, symbol, interval, limit: Math.min(limit, 1000), testnet,
  });
  // **못 읽었으면 그냥 실패다.** 빈 배열로 떨어뜨리면 위쪽에서
  // '봉이 모자랍니다'가 되고, 시세를 못 가져온 것과 시장이 조용한 것이
  // 같은 문구가 된다.
  if (!r.bars || r.bars.closes.length === 0) {
    throw new Error(r.error || `${exchange} 캔들을 읽지 못했습니다`);
  }
  const b = r.bars;
  const candles: Candle[] = b.closes.map((_c, i) => ({
    t: b.openTimes[i],
    o: b.opens[i], h: b.highs[i], l: b.lows[i], c: b.closes[i],
    v: b.volumes[i],
  })).filter(c => Number.isFinite(c.c));
  return {
    candles, dropped: r.droppedIncomplete,
    // 출처를 그대로 들고 나간다. 어느 서버의 어느 시장이었는지가
    // 성적표의 일부다 — 다른 시장의 꼬리로 판정한 손절은 이 전략의
    // 손절이 아니다.
    note: `${r.source}${r.droppedIncomplete ? ' · 진행 중인 마지막 봉 제외' : ''}`,
  };
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok:false, error:'Invalid JSON body' }, { status: 400 });
  }

  const symbol      = String(body?.symbol || 'BTCUSDT').toUpperCase();
  const strategy    = String(body?.strategy || 'ema-cross') as Strategy;
  const timeframe   = String(body?.timeframe || '1d');
  const initialCash = Number(body?.initialCash) || 1_000_000;
  const feeRate     = Number(body?.feeRate)     || 0.001;
  const leverage    = Number(body?.leverage)    || 1;
  const periodDays  = Number(body?.periodDays)  || 365;

  // Calculate limit based on timeframe + period
  const candlesPerDay: Record<string, number> = {
    '15m': 96, '1h': 24, '4h': 6, '1d': 1, '1w': 1/7,
  };
  const limit = Math.min(1000, Math.ceil(periodDays * (candlesPerDay[timeframe] ?? 1)));

  // 주문이 나갈 시장에서 캔들을 가져온다. 안 주면 바이낸스다(예전 동작).
  const exchange = futuresExchangeOf(body?.exchange) ?? 'binance';
  const testnet = body?.testnet === true;

  let candles: Candle[] = [];
  let dataSource: 'venue' | 'synthetic' = 'synthetic';
  let dataNote = '';
  let dataError: string | null = null;

  try {
    const got = await fetchVenueCandles(exchange, symbol, timeframe, limit, testnet);
    candles = got.candles;
    if (candles.length >= 30) { dataSource = 'venue'; dataNote = got.note; }
  } catch (e: any) {
    dataError = String(e?.message || e);
    console.error('[backtest] venue fetch failed:', e);
  }

  // ── 합성 캔들로 **조용히** 대체하지 않는다 ──
  //
  // 예전에는 시세를 못 받으면 난수 걸음(random walk)을 만들어 그대로
  // 돌렸다. 응답의 `source`에 'synthetic'이라고 적히긴 했지만 승률·
  // 손익비·MDD는 진짜 백테스트와 **똑같이 생긴 숫자**로 나왔다.
  //
  // 그 성적표는 이 종목에 대해 아무것도 말하지 않는다. 난수의 성적이다.
  // 그런데 화면에서는 구분이 안 되고, 사용자는 그걸 근거로 전략을 켠다.
  //
  // 그래서 명시적으로 요청했을 때만 만든다. 아니면 **실패로 끝낸다** —
  // 모른다고 말하는 편이 지어낸 답보다 낫다.
  if (candles.length < 30) {
    if (body?.allowSynthetic !== true) {
      return NextResponse.json({
        ok: false,
        error: 'candles_unavailable',
        message: `${exchange === 'gate' ? 'Gate' : 'Binance'}에서 ${symbol} ${timeframe} 캔들을 받지 못해 백테스트를 돌리지 않았습니다`
          + (dataError ? ` (${dataError})` : '')
          + '. 난수로 만든 가격으로 대신 돌리면 그 성적표는 이 종목과 무관합니다.',
        hint: '난수 가격으로라도 엔진 동작만 보려면 allowSynthetic: true를 넣으세요 — 그 결과는 전략 검증이 아닙니다.',
      }, { status: 502 });
    }
    candles = generateSyntheticCandles({
      startPrice: symbol.startsWith('BTC') ? 50_000 : 100,
      count: Math.min(periodDays, 365),
      trend: 0.3,
      volatility: 0.6,
    });
    dataSource = 'synthetic';
    dataNote = '⚠️ 난수로 만든 가격입니다 — 이 결과는 전략 검증이 아니라 엔진 동작 확인입니다';
  }

  // 청산 규칙 — 안 넘기면 엔진이 데모와 같은 기본값(손절 2% · 익절 4% ·
  // 최대보유 72시간)을 쓴다. **명시적으로 0을 넘겼을 때만** 그 규칙을 끈다.
  //
  // `Number(x) || 기본값`으로 쓰면 안 된다. 0이 falsy라 "손절 없이 돌려
  // 보겠다"는 요청이 조용히 기본값으로 바뀐다 — 사용자가 고른 것과 다른
  // 조건의 성적표가 나오고, 화면에는 아무 차이도 안 보인다.
  const numOrUndef = (v: any): number | undefined => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const result = runBacktest(candles, {
    symbol, strategy, initialCash, feeRate, leverage,
    stopPct: numOrUndef(body?.stopPct),
    takeProfitPct: numOrUndef(body?.takeProfitPct),
    maxHoldHours: numOrUndef(body?.maxHoldHours),
    // 숏. 안 주면 엔진이 배율로 판단한다(1배=현물이면 숏 없음).
    allowShort: typeof body?.allowShort === 'boolean' ? body.allowShort : undefined,
    // 수수료 말고도 나가는 것들. 안 주면 0이고, 0으로 돌았다는 사실은
    // 결과의 costNote에 남는다 — 숫자만 보면 구분이 안 되기 때문이다.
    slippagePct: numOrUndef(body?.slippagePct),
    fundingRatePct8h: numOrUndef(body?.fundingRatePct8h),
    emaFast: body?.emaFast, emaSlow: body?.emaSlow,
    rsiPeriod: body?.rsiPeriod, rsiOversold: body?.rsiOversold, rsiOverbought: body?.rsiOverbought,
    bbPeriod: body?.bbPeriod, bbStd: body?.bbStd,
    dcaIntervalDays: body?.dcaIntervalDays,
  });

  // Sample equity curve (max 100 points)
  const step = Math.max(1, Math.floor(result.equityCurve.length / 100));
  const sampledEquity = result.equityCurve.filter((_, i) => i % step === 0);

  return NextResponse.json({
    ok: true,
    source: dataSource,
    // **어느 시장의 캔들이었는지 응답에 남긴다.** 예전에는 언제나
    // 바이낸스 현물이었고 그 사실이 어디에도 안 적혀 있었다.
    dataNote,
    exchange, testnet,
    costNote: result.costNote ?? null,
    slippageCost: result.slippageCost ?? null,
    fundingPaid: result.fundingPaid ?? null,
    symbol, strategy, timeframe,
    candleCount: result.candleCount,
    summary: {
      finalEquity:    result.finalEquity,
      totalReturnPct: result.totalReturnPct,
      maxDrawdownPct: result.maxDrawdownPct,
      winRate:        result.winRate,
      totalTrades:    result.totalTrades,
      winTrades:      result.winTrades,
      loseTrades:     result.loseTrades,
      avgWinPct:      result.avgWinPct,
      avgLossPct:     result.avgLossPct,
      profitFactor:   result.profitFactor,
      sharpe:         result.sharpe,
      avgTradePct:    result.avgTradePct,
      sanityWarning:  result.sanityWarning,
      // 어떤 규칙으로 돈 성적인지 같이 보낸다. 숫자만 보내면 손절 없이
      // 돌린 결과와 손절 있는 결과가 화면에서 똑같아 보인다.
      rulesNote:      result.rulesNote,
      shortTrades:    result.shortTrades,
      stopExits:      result.stopExits,
      liqExits:       result.liqExits,
      gapExits:       result.gapExits,
    },
    equityCurve: sampledEquity,
    trades: result.trades.slice(-50), // last 50
  });
}
