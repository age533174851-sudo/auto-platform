// src/lib/backtest/engine.ts
// Self-contained backtest engine.
//
// 청산 규칙만 밖에서 가져온다(lib/engine/exitRules) — 데모 자동매매와
// **같은 함수**를 써야 두 성적표를 비교할 수 있기 때문이다. 규칙을 두 벌
// 두면 한쪽만 고쳐지고, 그때 백테스트는 실전과 다른 기계의 성적이 된다.
import { exitOnBar, DEFAULT_EXIT } from '../engine/exitRules';

export type Strategy = 'ema-cross' | 'rsi' | 'macd' | 'bollinger' | 'dca';

export interface Candle {
  t: number;   // timestamp (ms)
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
}

export interface BacktestConfig {
  symbol:       string;
  strategy:     Strategy;
  initialCash:  number;
  feeRate:      number;     // 0.001 = 0.1%
  leverage?:    number;     // 1 = no leverage
  positionPct?: number;     // 증거금으로 쓸 balance 비율 (0~1, 기본 1=전액). risk_percent 개념
  startTs?:     number;
  endTs?:       number;
  // Strategy params
  emaFast?:     number;     // default 12
  emaSlow?:     number;     // default 26
  rsiPeriod?:   number;     // default 14
  rsiOversold?: number;     // default 30
  rsiOverbought?: number;   // default 70
  macdFast?:    number;     // default 12
  macdSlow?:    number;     // default 26
  macdSignal?:  number;     // default 9
  bbPeriod?:    number;     // default 20
  bbStd?:       number;     // default 2
  dcaIntervalDays?: number; // default 7 (for DCA)

  // ── 청산 규칙 ───────────────────────────────────────────
  //
  // 데모(paperRunner)는 손절·익절·청산가·보유시간을 다 보는데 백테스트에는
  // **넷 다 없었다.** 전략 신호로만 사고팔았다. 그 차이는 한 방향으로만
  // 작동한다 — 백테스트에는 손절로 끝나는 거래도, 청산으로 날아가는 거래도
  // 없으니 **언제나 더 좋게 나온다.** 그리고 그 성적이 전략 점수와 자금
  // 배분으로 흘러 실제 돈의 크기를 정한다.
  //
  // 판정은 `lib/engine/exitRules`가 한다 — 데모와 **같은 함수**다.
  /** 손절 폭(%). 0이나 미지정이면 손절 없이 돈다(권장하지 않음) */
  stopPct?: number;
  /** 익절 폭(%). 0이면 익절을 걸지 않는다 */
  takeProfitPct?: number;
  /** 최대 보유 시간(시간). 0이면 시간 청산 없음 */
  maxHoldHours?: number;

  /**
   * 하락 신호에 **숏으로 들어가는가.**
   *
   * 안 주면 `leverage > 1`일 때만 켠다 — 숏은 선물·마진 계좌에서만 되고,
   * 배율을 준 백테스트가 곧 그 계좌를 가정한 것이기 때문이다. 현물
   * 백테스트(1배)에 숏을 켜면 실제로는 낼 수 없는 주문의 성적이 나온다.
   *
   * 왜 필요한가: 데모 자동매매는 하락 추세에 **숏을 잡는다.** 백테스트가
   * 롱만 돌면 하락장 성적이 통째로 빠지고, 그 상태로 두 성적을 비교하면
   * "이 전략은 하락장에 거래를 안 한다"는 잘못된 결론이 나온다.
   *
   * DCA는 어떤 경우에도 숏을 안 한다 — 정기 적립 전략에 숏은 뜻이 없다.
   */
  allowShort?: boolean;

  // ── 수수료 말고도 나가는 것들 ───────────────────────────
  //
  // 지금까지 비용은 수수료 하나뿐이었다. 그런데 실제로 체결되는 가격은
  // 화면에 찍힌 가격이 아니고, 선물은 들고만 있어도 펀딩비가 나간다.
  // 둘 다 **한 방향으로만** 작동한다 — 빼면 성적이 언제나 좋아진다.
  //
  // 스캘핑처럼 손절이 0.3%인 전략에서는 이게 곁가지가 아니다.
  // 왕복 슬리피지 0.05%면 손익분기 승률이 몇 %p 움직인다.

  /**
   * 편도 슬리피지(%). 진입도 청산도 **불리한 쪽으로** 밀린다.
   *
   * 롱 진입은 더 비싸게, 롱 청산은 더 싸게. 유리한 쪽으로 밀리는 경우도
   * 물론 있지만, 그걸 평균 0으로 놓으면 시장가 주문의 성질을 지운다 —
   * 시장가는 호가를 먹고 들어가므로 기댓값이 음수다.
   *
   * 안 주면 0이다. **0을 기본으로 두는 것은 낙관이지만**, 여기서 임의의
   * 값을 넣으면 예전 결과와 말없이 달라진다. 대신 결과에 slippageApplied를
   * 실어서 0으로 돌았다는 사실이 성적표에 남게 한다.
   */
  slippagePct?: number;

  /**
   * 8시간당 펀딩비(%). 명목가 대비. 롱이 낼 때가 양수다.
   *
   * 보유 시간에 비례해 나간다. 스윙처럼 며칠씩 들고 가는 전략에서는
   * 수수료보다 클 수 있다.
   *
   * **방향을 구분한다** — 양수 펀딩에서 숏은 받는다. 둘 다 빼면
   * 숏 전략이 실제보다 나쁘게 나오고, 그것도 틀린 성적표다.
   */
  fundingRatePct8h?: number;
}

export interface Trade {
  side:    'buy' | 'sell';
  time:    number;
  price:   number;
  qty:     number;
  value:   number;
  fee:     number;
  pnl?:    number;
  netPnL?: number;
  pnlPct?: number;
  reason:  string;
}

export interface EquityPoint { t: number; equity: number; }

export interface BacktestResult {
  config:        BacktestConfig;
  candleCount:   number;
  trades:        Trade[];
  equityCurve:   EquityPoint[];
  finalEquity:   number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRate:       number;
  totalTrades:   number;
  winTrades:     number;
  loseTrades:    number;
  avgWinPct:     number;
  avgLossPct:    number;
  profitFactor:  number;
  sharpe:        number;
  avgTradePct?:  number;
  sanityWarning?: string | null;   // 비현실적 결과 자동 감지

  /** 손절로 끝난 거래 수 */
  stopExits?: number;
  /** 청산으로 끝난 거래 수 */
  liqExits?: number;
  /** 숏으로 들어간 거래 수. 0이면 하락장 성적이 안 들어간 것이다 */
  shortTrades?: number;
  /** 걸어 둔 가격에 못 받고 갭으로 밀린 청산 수 */
  gapExits?: number;
  /**
   * **이 백테스트가 데모와 같은 규칙으로 돌았는가.**
   *
   * 손절 없이 돌린 결과를 손절 있는 실전과 비교하면 안 된다. 숫자만
   * 남으면 그 차이가 안 보이므로 결과에 같이 싣는다.
   */
  rulesNote?: string | null;

  /** 슬리피지로 나간 총액. 0이면 **슬리피지를 안 넣고 돌린 것**이다 */
  slippageCost?: number;
  /** 펀딩비 순액. 양수면 냈고 음수면 받았다 */
  fundingPaid?: number;
  /**
   * **비용 모델이 무엇을 포함했는가.**
   *
   * 숫자만 남으면 슬리피지 0으로 돌린 성적표와 넣고 돌린 성적표가
   * 똑같이 생겼다. 스캘핑처럼 손절이 0.3%인 전략에서는 그 차이가
   * 손익분기 승률 몇 %p다 — 결론이 뒤집히는 크기다.
   */
  costNote?: string | null;
}

/* ─── Indicators ─────────────────────────────────────────── */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      // seed with SMA
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    if (i <= period) {
      gains += g; losses += l;
      if (i === period) {
        const avgG = gains / period, avgL = losses / period;
        const rs = avgL === 0 ? 100 : avgG / avgL;
        out.push(100 - 100 / (1 + rs));
      } else out.push(null);
    } else {
      // Wilder smoothing
      const prevAvgG = (out[i-1] !== null) ? 0 : 0; // not used
      // Simpler: recompute rolling
      const sliceG: number[] = [];
      const sliceL: number[] = [];
      for (let j = i - period + 1; j <= i; j++) {
        const d = values[j] - values[j - 1];
        sliceG.push(d > 0 ? d : 0);
        sliceL.push(d < 0 ? -d : 0);
      }
      const avgG = sliceG.reduce((a, b) => a + b, 0) / period;
      const avgL = sliceL.reduce((a, b) => a + b, 0) / period;
      const rs = avgL === 0 ? 100 : avgG / avgL;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return (emaFast[i] as number) - (emaSlow[i] as number);
  });
  const validMacd = macdLine.map(v => v ?? 0);
  const signalLine = ema(validMacd, signal);
  const histogram = macdLine.map((v, i) => v === null || signalLine[i] === null ? null : v - (signalLine[i] as number));
  return { macdLine, signalLine, histogram };
}

export function bollinger(values: number[], period = 20, std = 2) {
  const mid = sma(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); continue; }
    const slice = values.slice(i - period + 1, i + 1);
    const m = (mid[i] as number);
    const variance = slice.reduce((s, x) => s + Math.pow(x - m, 2), 0) / period;
    const stdev = Math.sqrt(variance);
    upper.push(m + stdev * std);
    lower.push(m - stdev * std);
  }
  return { mid, upper, lower };
}

/* ─── Backtest runner ───────────────────────────────────── */
export function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const safeCandles = Array.isArray(candles) ? candles.filter(c => c && Number.isFinite(c.c)) : [];
  if (safeCandles.length < 30) {
    return emptyResult(cfg);
  }

  const closes = safeCandles.map(c => c.c);
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const fee   = cfg.feeRate ?? 0.001;
  let cash    = cfg.initialCash;      // ★ balance = 현금성 총자산(equity). 진입 시 변경 안 함, 청산 시 netPnL만 반영
  let position = 0;       // 보유 수량(절대값, 레버리지 반영). 방향은 side가 갖는다
  /**
   * 지금 방향. null이면 포지션이 없다.
   *
   * 부호 있는 수량(음수=숏)으로 두지 않는 이유: 기존 코드가 `position > 0`을
   * '포지션 있음'으로 쓰고 있어서, 부호를 넣으면 숏이 '포지션 없음'으로
   * 읽히는 자리가 조용히 생긴다.
   */
  let side: 'LONG' | 'SHORT' | null = null;
  let entryPrice = 0;
  let entryFeePaid = 0;   // 진입 시 낸 수수료 (청산 netPnL에서 차감)
  let investedMargin = 0; // 현재 포지션에 투입된 증거금 누계 (DCA 한도용)
  let peakEquity = cfg.initialCash;
  let maxDrawdown = 0;
  const lev = Math.max(1, cfg.leverage ?? 1);
  const positionPct = Math.min(1, Math.max(0.01, cfg.positionPct ?? 1));  // 증거금 비율

  /* Pre-compute indicators */
  const emaF = ema(closes, cfg.emaFast ?? 12);
  const emaS = ema(closes, cfg.emaSlow ?? 26);
  const rsiSeries = rsi(closes, cfg.rsiPeriod ?? 14);
  const macdRes = macd(closes, cfg.macdFast ?? 12, cfg.macdSlow ?? 26, cfg.macdSignal ?? 9);
  const bb = bollinger(closes, cfg.bbPeriod ?? 20, cfg.bbStd ?? 2);

  const rsiOver  = cfg.rsiOversold   ?? 30;
  const rsiOverb = cfg.rsiOverbought ?? 70;

  /* DCA: buy fixed amount at interval */
  const dcaInterval = (cfg.dcaIntervalDays ?? 7) * 24 * 3600 * 1000;
  let lastDcaTs = 0;
  const dcaAmount = cfg.initialCash / 20; // 20 buys spread

  // 진입한 봉·손절·익절·청산가. 청산 규칙이 쓴다.
  let entryBarIdx = -1;
  let entryTs = 0;
  let stopPrice: number | null = null;
  let tpPrice: number | null = null;
  let liqPrice: number | null = null;
  // **기본값은 데모와 같다.** 0은 여전히 '손절 없음'이지만, 그건 명시적으로
  // 0을 넘겼을 때만이다. 안 넘기면 손절 없이 도는 것을 기본으로 두면,
  // 아무도 안 넘기고 그러면 아무것도 안 바뀐다.
  const stopPct = Math.max(0, cfg.stopPct ?? DEFAULT_EXIT.stopPct);
  const tpPct = Math.max(0, cfg.takeProfitPct ?? DEFAULT_EXIT.takeProfitPct);
  const maxHoldHours = Math.max(0, cfg.maxHoldHours ?? DEFAULT_EXIT.maxHoldHours);
  /** 손절·청산으로 닫힌 횟수. 성적표에 같이 적는다 */
  let stopExits = 0, liqExits = 0, gapExits = 0, shortTrades = 0;

  // 숏은 선물·마진에서만 된다. 명시하지 않으면 배율로 판단한다.
  const allowShort = cfg.strategy === 'dca'
    ? false
    : (cfg.allowShort ?? lev > 1);

  // ── 슬리피지·펀딩 ──
  const slipPct = Math.max(0, cfg.slippagePct ?? 0);
  const fundingPct8h = Number.isFinite(cfg.fundingRatePct8h as any) ? Number(cfg.fundingRatePct8h) : 0;
  /**
   * 체결가를 **불리한 쪽으로** 민다.
   *
   * 사는 쪽은 비싸게, 파는 쪽은 싸게. 모르는 것을 유리하게 읽으면
   * 그 성적표는 검증이 아니라 희망이다 — 이 파일이 이미 봉 안의
   * 순서에 대해 쓰고 있는 규칙과 같다.
   */
  const slip = (px: number, buying: boolean): number =>
    slipPct <= 0 ? px : px * (1 + (buying ? slipPct : -slipPct) / 100);
  /** 누적 펀딩·슬리피지 — 성적표에 얼마가 비용으로 나갔는지 남긴다 */
  let fundingPaid = 0;
  let slippageCost = 0;

  /** 청산 손익 한 곳. 롱은 (나간값-들어간값), 숏은 그 반대다 */
  const closeAt = (rawPx: number, t: number, why: string) => {
    // 롱 청산은 파는 것, 숏 청산은 사는 것이다.
    const px = slip(rawPx, side === 'SHORT');
    slippageCost += Math.abs(px - rawPx) * position;
    const exitFee = position * px * fee;
    const dir = side === 'SHORT' ? -1 : 1;
    const grossPnL = (px - entryPrice) * position * dir;

    // 펀딩은 **들고 있던 시간에 비례**한다. 양수 펀딩은 롱이 내고
    // 숏이 받는다 — 둘 다 빼면 숏 전략이 실제보다 나쁘게 나온다.
    let funding = 0;
    if (fundingPct8h !== 0 && entryTs > 0 && t > entryTs) {
      const periods = (t - entryTs) / (8 * 3600 * 1000);
      funding = (entryPrice * position) * (fundingPct8h / 100) * periods * dir;
    }
    fundingPaid += funding;

    const netPnL = grossPnL - entryFeePaid - exitFee - funding;
    const pnlPct = entryPrice > 0 ? ((px - entryPrice) / entryPrice) * 100 * lev * dir : 0;
    cash += netPnL;
    trades.push({
      // 숏 청산은 '되사기'라 buy다. side 칸이 방향이 아니라 **주문**을
      // 뜻하도록 유지한다 — 체결 목록은 실제로 낸 주문을 보여줘야 한다.
      side: side === 'SHORT' ? 'buy' : 'sell',
      time: t, price: px, qty: position, value: position * px,
      fee: exitFee, pnl: netPnL, netPnL, pnlPct, reason: why,
    });
    position = 0; side = null; entryPrice = 0; entryFeePaid = 0; investedMargin = 0;
    stopPrice = tpPrice = liqPrice = null; entryBarIdx = -1;
  };

  /** 진입 한 곳. 손절·익절·청산가를 방향에 맞춰 건다 */
  const openAt = (dir: 'LONG' | 'SHORT', rawPx: number, i: number, t: number, why: string) => {
    // 롱 진입은 사는 것, 숏 진입은 파는 것이다.
    const px = slip(rawPx, dir === 'LONG');
    const margin   = cash * positionPct;
    const notional = margin * lev;
    const qty      = notional / px;
    const f        = notional * fee;
    slippageCost += Math.abs(px - rawPx) * qty;
    position = qty; side = dir;
    entryPrice = px; entryFeePaid = f; investedMargin = margin;
    entryBarIdx = i; entryTs = t;
    const sgn = dir === 'LONG' ? 1 : -1;
    stopPrice = stopPct > 0 ? px * (1 - sgn * stopPct / 100) : null;
    tpPrice = tpPct > 0 ? px * (1 + sgn * tpPct / 100) : null;
    // 격리 증거금 기준 청산가. 유지증거금률을 모르므로 1.0%로 본다 —
    // 실제보다 **먼저** 청산되는 쪽이라 낙관으로 기울지 않는다.
    liqPrice = lev > 1 ? px * (1 - sgn * ((1 / lev) - 0.01)) : null;
    if (dir === 'SHORT') shortTrades++;
    trades.push({
      side: dir === 'SHORT' ? 'sell' : 'buy',
      time: t, price: px, qty, value: notional, fee: f, reason: why,
    });
  };

  for (let i = 0; i < safeCandles.length; i++) {
    const candle = safeCandles[i];
    const price  = candle.c;

    // ── 청산 규칙이 신호보다 먼저다 ────────────────────────
    //
    // 손절은 미룰 수 없다. 신호를 먼저 보면 "손절을 지나쳤지만 그 봉에
    // 매도 신호가 없어서 계속 들고 있었다"가 되어, 실제로는 이미 끊긴
    // 거래가 장부에서 살아남는다.
    //
    // **진입한 봉은 건너뛴다.** 그 봉의 저가는 진입 *전에* 찍힌 것일 수
    // 있어서, 들어가자마자 손절당한 것으로 계산된다.
    if (position > 0 && side && i > entryBarIdx && (stopPrice != null || tpPrice != null || maxHoldHours > 0)) {
      const hit = exitOnBar(
        { side, entry: entryPrice, stop: stopPrice, takeProfit: tpPrice,
          liquidation: liqPrice, openedAt: entryTs },
        candle, { maxHoldHours },
      );
      if (hit) {
        if (hit.reason === 'SL') stopExits++;
        if (hit.reason === 'LIQUIDATION') liqExits++;
        if (hit.gapped) gapExits++;
        closeAt(hit.price, candle.t, hit.note);
      }
    }

    let signal: 'buy' | 'sell' | null = null;
    let reason = '';

    /* Strategy logic */
    switch (cfg.strategy) {
      case 'ema-cross': {
        if (i > 0 && emaF[i] !== null && emaS[i] !== null && emaF[i-1] !== null && emaS[i-1] !== null) {
          const f0 = emaF[i-1] as number, s0 = emaS[i-1] as number;
          const f1 = emaF[i] as number,   s1 = emaS[i] as number;
          if (f0 <= s0 && f1 > s1)  { signal = 'buy';  reason = `골든크로스 (EMA${cfg.emaFast ?? 12}↑EMA${cfg.emaSlow ?? 26})`; }
          if (f0 >= s0 && f1 < s1)  { signal = 'sell'; reason = `데드크로스 (EMA${cfg.emaFast ?? 12}↓EMA${cfg.emaSlow ?? 26})`; }
        }
        break;
      }
      case 'rsi': {
        const r = rsiSeries[i];
        const rPrev = rsiSeries[i-1];
        if (r !== null && rPrev !== null) {
          if (rPrev < rsiOver  && r >= rsiOver)  { signal = 'buy';  reason = `RSI 과매도 탈출 (${r.toFixed(1)})`; }
          if (rPrev > rsiOverb && r <= rsiOverb) { signal = 'sell'; reason = `RSI 과매수 진입 (${r.toFixed(1)})`; }
        }
        break;
      }
      case 'macd': {
        const m = macdRes.histogram[i], mp = macdRes.histogram[i-1];
        if (m !== null && mp !== null) {
          if (mp <= 0 && m > 0) { signal = 'buy';  reason = 'MACD 히스토그램 양전환'; }
          if (mp >= 0 && m < 0) { signal = 'sell'; reason = 'MACD 히스토그램 음전환'; }
        }
        break;
      }
      case 'bollinger': {
        const up = bb.upper[i], lo = bb.lower[i], pup = bb.upper[i-1], plo = bb.lower[i-1];
        const pp = i > 0 ? closes[i-1] : null;
        if (up !== null && lo !== null && pup !== null && plo !== null && pp !== null) {
          if (pp <= plo && price > lo) { signal = 'buy';  reason = '볼린저 하단 반등'; }
          if (pp >= pup && price < up) { signal = 'sell'; reason = '볼린저 상단 이탈'; }
        }
        break;
      }
      case 'dca': {
        if (candle.t - lastDcaTs >= dcaInterval && cash >= dcaAmount) {
          signal = 'buy'; reason = `DCA 주기 매수 (${cfg.dcaIntervalDays ?? 7}일)`;
          lastDcaTs = candle.t;
        }
        break;
      }
    }

    /* Execute — equity 모델: 진입은 balance 불변, 청산 시에만 netPnL 반영 */

    // **반대 신호는 먼저 닫는다.** 숏을 들고 있는데 매수 신호가 오면
    // 그건 새 롱이 아니라 지금 숏을 끝내라는 뜻이다. 안 닫고 새로 열면
    // 한 계좌에 반대 포지션 둘이 생겨 손익이 서로를 지운다.
    if (position > 0 && side && ((signal === 'buy' && side === 'SHORT') || (signal === 'sell' && side === 'LONG'))) {
      closeAt(price, candle.t, reason);
    }

    if (signal === 'buy' && position === 0) {
      openAt('LONG', price, i, candle.t, reason);
    } else if (signal === 'sell' && position === 0 && allowShort) {
      // 하락 신호에 숏. 데모 자동매매가 하는 일과 같다 — 이게 없으면
      // 백테스트에서 하락장 성적이 통째로 빠진다.
      openAt('SHORT', price, i, candle.t, reason);
    } else if (signal === 'buy' && cfg.strategy === 'dca' && investedMargin + dcaAmount <= cash) {
      // DCA 누적 (증거금 누계가 balance를 넘지 않는 선까지)
      const notional = dcaAmount * lev;
      const qty = notional / price;
      const f = notional * fee;
      const newTotal = position + qty;
      entryPrice = position > 0 ? (entryPrice * position + price * qty) / newTotal : price;
      position = newTotal;
      entryFeePaid += f;
      investedMargin += dcaAmount;
      // ★ balance 변경 없음
      trades.push({ side: 'buy', time: candle.t, price, qty, value: notional, fee: f, reason });
    }
    // 롱을 매도 신호로 닫는 갈래는 위 '반대 신호는 먼저 닫는다'가 이미
    // 처리한다. 여기 한 번 더 두면 두 곳이 같은 일을 하게 되고, 언젠가
    // 한쪽만 고쳐진다.

    /* Equity tracking — balance + 미실현손익 (mark-to-market) */
    // 숏은 가격이 내려야 이익이다. 부호를 안 뒤집으면 숏이 손실일 때
    // 자산이 늘어나는 곡선이 그려진다 — 최대 낙폭이 통째로 틀어진다.
    const unrealized = position > 0
      ? (price - entryPrice) * position * (side === 'SHORT' ? -1 : 1)
      : 0;
    const equity = cash + unrealized;
    equityCurve.push({ t: candle.t, equity });
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  /* Close open position at last price */
  if (position > 0 && side) {
    const last = safeCandles[safeCandles.length - 1];
    closeAt(last.c, last.t, '백테스트 종료 청산');
  }

  /* Stats */
  const completed = trades.filter(t => t.side === 'sell' && t.pnl !== undefined);
  const wins  = completed.filter(t => (t.pnl ?? 0) > 0);
  const loses = completed.filter(t => (t.pnl ?? 0) < 0);
  const totalProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalLoss   = Math.abs(loses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const avgWinPct   = wins.length  > 0 ? wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / wins.length : 0;
  const avgLossPct  = loses.length > 0 ? loses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / loses.length : 0;
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 999 : 0);
  const winRate = completed.length > 0 ? (wins.length / completed.length) * 100 : 0;
  const finalEquity = cash;
  const totalReturnPct = ((finalEquity - cfg.initialCash) / cfg.initialCash) * 100;

  /* Sharpe (simplified — daily returns) */
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i-1].equity;
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
  }
  const avgRet = returns.length > 0 ? returns.reduce((a,b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / returns.length
    : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (avgRet / stdev) * Math.sqrt(252) : 0;

  // 평균 거래 수익률 (거래당 pnlPct 평균)
  const avgTradePct = completed.length > 0
    ? completed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / completed.length : 0;

  // 자동 검증 — 비현실적 결과 감지
  let sanityWarning: string | null = null;
  if (!isFinite(finalEquity) || finalEquity <= 0) sanityWarning = '자산 계산 오류 (비정상 값)';
  else if (Math.abs(totalReturnPct) > 1000) sanityWarning = `비현실적 수익률 (${totalReturnPct.toFixed(0)}%) — 계산 오류 또는 과최적화 의심`;
  else if (finalEquity > cfg.initialCash * 50) sanityWarning = '최종 자산이 초기 대비 50배 초과 — 계산 오류 의심';

  // 손절을 안 걸고 돌렸으면 그 사실이 성적표에 붙어 있어야 한다.
  // 데모는 손절을 걸고 도는데 백테스트만 안 걸면, 두 성적은 **다른 기계의
  // 성적**이고 비교하면 안 된다. 그런데 숫자만 보면 그 차이가 안 보인다.
  const rulesNote = stopPct > 0
    ? `손절 ${stopPct}%${tpPct > 0 ? ` · 익절 ${tpPct}%` : ' · 익절 없음'}`
      + `${maxHoldHours > 0 ? ` · 최대보유 ${maxHoldHours}시간` : ''}`
      + `${lev > 1 ? ` · ${lev}배 청산 반영` : ''}`
      + `${allowShort ? ' · 숏 포함' : ' · 롱만'}`
    : '⚠️ 손절 없이 돌렸습니다 — 데모·실전은 손절을 걸고 돕니다. 이 결과는 그쪽과 비교할 수 없습니다.';

  // **무엇을 비용으로 넣었는지 적는다.** 안 적으면 슬리피지 0짜리
  // 성적표가 넣고 돌린 것과 똑같이 생겼고, 그 둘은 다른 기계의 성적이다.
  const costNote =
    `수수료 편도 ${(fee * 100).toFixed(3)}%`
    + (slipPct > 0
        ? ` · 슬리피지 편도 ${slipPct}%`
        : ' · ⚠️ 슬리피지 0 (시장가는 호가를 먹고 들어갑니다 — 실제보다 좋게 나옵니다)')
    + (fundingPct8h !== 0
        ? ` · 펀딩 8시간당 ${fundingPct8h}%`
        : (lev > 1 ? ' · ⚠️ 펀딩비 미반영' : ''));

  return {
    config: cfg,
    candleCount: safeCandles.length,
    trades,
    equityCurve,
    finalEquity,
    totalReturnPct,
    maxDrawdownPct: maxDrawdown,
    winRate,
    totalTrades:  completed.length,
    winTrades:    wins.length,
    loseTrades:   loses.length,
    avgWinPct,
    avgLossPct,
    profitFactor,
    sharpe,
    avgTradePct,
    sanityWarning,
    stopExits, liqExits, gapExits, shortTrades, rulesNote,
    slippageCost, fundingPaid, costNote,
  };
}

function emptyResult(cfg: BacktestConfig): BacktestResult {
  return {
    config: cfg, candleCount: 0, trades: [], equityCurve: [],
    finalEquity: cfg.initialCash, totalReturnPct: 0, maxDrawdownPct: 0,
    winRate: 0, totalTrades: 0, winTrades: 0, loseTrades: 0,
    avgWinPct: 0, avgLossPct: 0, profitFactor: 0, sharpe: 0,
  };
}

/* ─── Synthetic candles generator (mock fallback) ────────── */
export function generateSyntheticCandles(opts: {
  startPrice?: number;
  count?: number;
  trend?: number;        // annual drift, e.g., 0.5 = +50%/yr
  volatility?: number;   // annual vol, e.g., 0.6 = 60%/yr
  intervalMs?: number;   // candle interval
  startTs?: number;
}): Candle[] {
  const startPrice = opts.startPrice ?? 50_000;
  const count      = opts.count      ?? 365;
  const trend      = opts.trend      ?? 0.2;
  const volatility = opts.volatility ?? 0.5;
  const intervalMs = opts.intervalMs ?? (24 * 3600 * 1000);
  const startTs    = opts.startTs    ?? (Date.now() - count * intervalMs);

  const candles: Candle[] = [];
  let price = startPrice;
  // Geometric Brownian motion daily
  const dt = intervalMs / (365 * 24 * 3600 * 1000);
  const drift = trend * dt;
  const vol = volatility * Math.sqrt(dt);

  for (let i = 0; i < count; i++) {
    const z = boxMuller();
    const ret = drift + vol * z;
    const o = price;
    const c = price * Math.exp(ret);
    const h = Math.max(o, c) * (1 + Math.abs(boxMuller()) * vol * 0.5);
    const l = Math.min(o, c) * (1 - Math.abs(boxMuller()) * vol * 0.5);
    candles.push({
      t: startTs + i * intervalMs,
      o, h, l, c,
      v: 1_000_000 * (0.5 + Math.random()),
    });
    price = c;
  }
  return candles;
}

function boxMuller(): number {
  // standard normal
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
