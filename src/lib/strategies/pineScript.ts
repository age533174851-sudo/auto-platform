// src/lib/strategies/pineScript.ts
// BTC WUNDER AUTO COMPLETE FINAL — TradingView Pine Script v5
// GrowthPage / WunderPage 양쪽에서 공유한다.

export const PINE_SCRIPT = `//@version=5
strategy("BTC WUNDER AUTO COMPLETE FINAL", shorttitle="WUNDER", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=10,
         initial_capital=10000, commission_type=strategy.commission.percent,
         commission_value=0.05, pyramiding=3)

// ══════════════════════════════════════════════
// INPUTS
// ══════════════════════════════════════════════
i_seed          = input.float(10000,  "자동매매 시드 (USDT)")
i_totalPct      = input.float(30,     "총 진입 비율 %",   minval=1, maxval=100)
i_lev           = input.int(  3,      "레버리지",          minval=1, maxval=20)
i_e1            = input.float(40,     "1차 진입 %",        group="Scale-In")
i_e2            = input.float(30,     "2차 진입 %",        group="Scale-In")
i_e3            = input.float(30,     "3차 진입 %",        group="Scale-In")
i_weekTarget    = input.int(  10,     "주간 목표 거래수")
i_reentryBars   = input.int(  3,      "재진입 제한 봉 수")
i_blockWeekend  = input.bool( true,   "주말 차단")
i_htf           = input.timeframe("1D","상위 타임프레임")
i_rangeSL       = input.float(1.5,    "횡보 손절 %",       group="Risk")
i_trendSL       = input.float(2.5,    "추세 손절 %",       group="Risk")
i_rangeTrail    = input.float(1.0,    "횡보 트레일 %",     group="Risk")
i_trendTrail    = input.float(1.5,    "추세 트레일 %",     group="Risk")
i_be            = input.float(0.8,    "본절 이동 %",       group="Risk")
i_weakExit      = input.float(0.5,    "익절 감시 %",       group="Risk")
i_target        = input.float(3.0,    "목표 %",            group="Risk")
i_addDist       = input.float(0.5,    "추가진입 거리 %",   group="Scale-In")
i_oppExit       = input.bool( true,   "반대신호 EXIT-ALL")

// ══════════════════════════════════════════════
// INDICATORS
// ══════════════════════════════════════════════
ema20   = ta.ema(close, 20)
ema50   = ta.ema(close, 50)
ema200  = ta.ema(close, 200)
rsi14   = ta.rsi(close, 14)
[macdL, macdS, macdH] = ta.macd(close, 12, 26, 9)
[dip, dim, adx] = ta.dmi(14, 14)
atr14   = ta.atr(14)
volAvg  = ta.sma(volume, 20)
htfEma  = request.security(syminfo.tickerid, i_htf, ta.ema(close, 200))

// ── Trend detection ──────────────────────────
isBullTrend = close > ema200 and ema20 > ema50 and ema50 > ema200
isBearTrend = close < ema200 and ema20 < ema50 and ema50 < ema200
isRange     = not isBullTrend and not isBearTrend

// ── ADX filter ───────────────────────────────
adxStrong = adx > 20

// ── Volume filter ────────────────────────────
volOk = volume > volAvg * 1.2

// ── ATR filter ───────────────────────────────
atrOk = atr14 > ta.sma(atr14, 50) * 0.8

// ── HTF filter ───────────────────────────────
htfBull = close > htfEma
htfBear = close < htfEma

// ── Range logic ──────────────────────────────
rangeHigh = ta.highest(high,  50)
rangeLow  = ta.lowest( low,   50)
rangeSize = (rangeHigh - rangeLow) / rangeLow * 100
isNarrow  = rangeSize < 5.0

// ── Pullback entries ─────────────────────────
pullLong  = isBullTrend and ta.crossover( close, ema20) and rsi14 < 65 and adxStrong and volOk and atrOk and htfBull
pullShort = isBearTrend and ta.crossunder(close, ema20) and rsi14 > 35 and adxStrong and volOk and atrOk and htfBear

// ── Breakout entries ─────────────────────────
boLong  = isRange and ta.crossover( close, rangeHigh) and volOk and adxStrong
boShort = isRange and ta.crossunder(close, rangeLow)  and volOk and adxStrong

// ── Composite signals ────────────────────────
longSig  = (pullLong  or boLong)  and not isNarrow
shortSig = (pullShort or boShort) and not isNarrow

// ── Weekend block ────────────────────────────
dayOfWeek = dayofweek(time, "UTC+9")
isWeekend = i_blockWeekend and (dayOfWeek == dayofweek.saturday or dayOfWeek == dayofweek.sunday)

// ── Scale-in sizing ──────────────────────────
baseQty = i_seed * (i_totalPct / 100) * i_lev / close
qty1 = baseQty * (i_e1 / 100)
qty2 = baseQty * (i_e2 / 100)
qty3 = baseQty * (i_e3 / 100)

// ── State tracking ───────────────────────────
var int  scaleStage   = 0
var float avgEntry    = na
var float trailStop   = na
var int  lossStreak   = 0
var int  weeklyTrades = 0
var int  lastTradeBar = 0
var bool inLong       = false
var bool inShort      = false

// ── Cooldown & streak checks ─────────────────
cooldownOk    = (bar_index - lastTradeBar) >= i_reentryBars
streakOk      = lossStreak < 3
weeklyOk      = weeklyTrades < i_weekTarget

// ── Entry conditions ─────────────────────────
canLong  = longSig  and not inLong  and not inShort and cooldownOk and streakOk and weeklyOk and not isWeekend
canShort = shortSig and not inShort and not inLong  and cooldownOk and streakOk and weeklyOk and not isWeekend

// ── Scale-in (pyramiding) ─────────────────────
canAdd2L = inLong  and scaleStage == 1 and close <= avgEntry * (1 - i_addDist/100)
canAdd3L = inLong  and scaleStage == 2 and close <= avgEntry * (1 - i_addDist*2/100)
canAdd2S = inShort and scaleStage == 1 and close >= avgEntry * (1 + i_addDist/100)
canAdd3S = inShort and scaleStage == 2 and close >= avgEntry * (1 + i_addDist*2/100)

// ── Stop Loss ─────────────────────────────────
slPct = isRange ? i_rangeSL : i_trendSL
longSL  = inLong  ? avgEntry * (1 - slPct/100) : na
shortSL = inShort ? avgEntry * (1 + slPct/100) : na

// ── Trailing Stop ─────────────────────────────
trailPct = isRange ? i_rangeTrail : i_trendTrail

// ── Entries ───────────────────────────────────
if canLong
    strategy.entry("L1", strategy.long,  qty=qty1)
    scaleStage := 1
    inLong     := true
    avgEntry   := close
    lastTradeBar := bar_index
    weeklyTrades += 1

if canAdd2L
    strategy.entry("L2", strategy.long,  qty=qty2)
    scaleStage := 2

if canAdd3L
    strategy.entry("L3", strategy.long,  qty=qty3)
    scaleStage := 3

if canShort
    strategy.entry("S1", strategy.short, qty=qty1)
    scaleStage := 1
    inShort    := true
    avgEntry   := close
    lastTradeBar := bar_index
    weeklyTrades += 1

if canAdd2S
    strategy.entry("S2", strategy.short, qty=qty2)
    scaleStage := 2

if canAdd3S
    strategy.entry("S3", strategy.short, qty=qty3)
    scaleStage := 3

// ── Exits ─────────────────────────────────────
// Target exit
if inLong and close >= avgEntry * (1 + i_target/100)
    strategy.close_all(comment="목표 도달")
    inLong := false; scaleStage := 0

if inShort and close <= avgEntry * (1 - i_target/100)
    strategy.close_all(comment="목표 도달")
    inShort := false; scaleStage := 0

// Stop loss
if inLong  and close <= longSL
    strategy.close_all(comment="🛑 손절")
    inLong  := false; scaleStage := 0; lossStreak += 1

if inShort and close >= shortSL
    strategy.close_all(comment="🛑 손절")
    inShort := false; scaleStage := 0; lossStreak += 1

// Opposite signal exit
if i_oppExit
    if inLong  and shortSig
        strategy.close_all(comment="↩ 반대신호")
        inLong  := false; scaleStage := 0
    if inShort and longSig
        strategy.close_all(comment="↩ 반대신호")
        inShort := false; scaleStage := 0

// Loss streak reset on profit
if strategy.wintrades > strategy.wintrades[1]
    lossStreak := 0

// Weekly reset
newWeek = ta.change(weekofyear(time)) != 0
if newWeek
    weeklyTrades := 0

// ── Plots ─────────────────────────────────────
plot(ema20,  "EMA20",  color=color.new(color.blue,  20), linewidth=1)
plot(ema50,  "EMA50",  color=color.new(color.orange,20), linewidth=1)
plot(ema200, "EMA200", color=color.new(color.red,   10), linewidth=2)

// Entry markers
plotshape(canLong,  title="Long",  style=shape.triangleup,   location=location.belowbar, color=color.lime,  size=size.small)
plotshape(canShort, title="Short", style=shape.triangledown, location=location.abovebar, color=color.red,   size=size.small)

// ── WunderTrading Alert (복사해서 TradingView Alert에 붙여넣기) ───────
// Long Entry:
// {"code":"{{strategy.order.id}}","orderType":"openLong","amountPerTradeType":"percent","amountPerTrade":{{strategy.order.contracts}},"leverage":3,"stopLoss":2.5,"reduceOnly":false,"pos":"{{strategy.position_size}}"}
//
// Close All:
// {"code":"BTCWUNDER","orderType":"closeAll","reduceOnly":true,"pos":"0"}
`;

export default PINE_SCRIPT;
