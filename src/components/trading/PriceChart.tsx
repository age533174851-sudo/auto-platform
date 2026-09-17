'use client';
// src/components/trading/PriceChart.tsx
//
// **iframe이 아닌 우리 차트.**
//
// 무엇이 달라지나
// ───────────────
// 지금까지 "차트"는 TradingView **iframe**이었다. 그 안의 데이터도, 색도,
// 축도, 상호작용도 우리 것이 아니었고, 화면 안에 남의 사이트가 하나 떠
// 있는 것에 가까웠다.
//
// 여기서는 봉을 우리가 받아(`/api/market/candles`) 우리가 그린다.
// lightweight-charts는 **렌더러일 뿐**이다 — 가격을 만들지 않고, 봉을
// 보간하지 않는다.
//
// 진행 중인 봉
// ────────────
// 서버가 미완성 봉까지 준다. 그 위에 실시간 스트림의 현재가를 얹는데,
// **관측된 값으로만** 움직인다(`candleSeries.withLivePrice`) — 고가는 넘을
// 때만 올리고 저가는 밑돌 때만 내리며, 다음 봉은 만들지 않는다.
//
// 간격을 바꿀 때
// ──────────────
// 1분을 보다가 1시간으로 바꾸면 요청이 둘 떠 있는 상태가 된다. 먼저 보낸
// 1분 응답이 나중에 도착하면 1시간 차트에 1분 봉이 박히고, **축이 그럴듯해서
// 아무도 못 본다.** 요청마다 세대 번호를 붙여 지금 세대가 아닌 응답을
// 버린다(판정은 `candleSeries.isFreshResponse`에 있고 시험이 붙어 있다).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { C, FS } from '@/components/terminal/theme';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import {
  barsToCandles, barsToVolumes, isFreshResponse,
  candlesMatchInterval, UP_COLOR, DOWN_COLOR, type Candle,
} from '@/lib/trading/candleSeries';
import {
  INDICATORS, computeIndicator, indicatorAvailable, type IndicatorId,
} from '@/lib/trading/indicators';
import {
  phaseOnStart, phaseOnSuccess, phaseOnFailure, shouldClearBarsOnFailure,
  showsBlockingOverlay, staleNotice, requestKeyOf, barsMatchRequest,
  type ChartPhase,
} from '@/lib/trading/chartLoadState';

export const CHART_INTERVALS = [
  { id: '1m', label: '1m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1D' },
] as const;

export type ChartInterval = typeof CHART_INTERVALS[number]['id'];

export interface PriceChartProps {
  symbol: string;
  market?: 'SPOT' | 'USDM';
  interval: ChartInterval;
  onIntervalChange?: (i: ChartInterval) => void;
  /** 켜 둔 지표 */
  indicators?: IndicatorId[];
  onToggleIndicator?: (id: IndicatorId) => void;
  height?: number;
  /** 시험·스토리에서 봉을 주입한다. **제품 경로에서는 쓰지 않는다** */
  fixtureBars?: any;
  /**
   * 한 화면 배치용 — 지표 버튼을 한 줄로 줄인다.
   *
   * 실측에서 이 줄이 53px이었다. 지표 이름이 두 줄("MA" / "7")로 접히기
   * 때문이다. 차트에 줄 높이를 한 픽셀이라도 더 주려고 한 줄로 만든다.
   */
  denseToolbar?: boolean;
}

// 상태 판정은 `chartLoadState`에 있다. 여기서 다시 적지 않는다 —
// 갱신과 전환을 구별하는 규칙이 두 곳에 있으면 언젠가 갈린다.

export function PriceChart({
  symbol, market = 'USDM', interval, onIntervalChange,
  indicators = [], onToggleIndicator, height = 320, fixtureBars, denseToolbar,
}: PriceChartProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const lineRefs = useRef<Map<string, any>>(new Map());
  /**
   * 차트가 붙은 순간을 **상태로** 알린다.
   *
   * 여기가 고장이었다. 차트 생성은 `await import('lightweight-charts')`라
   * 비동기인데, 데이터 밀어넣기 이펙트는 `if (!seriesRef.current) return`으로
   * 시작했다. ref는 바뀌어도 이펙트를 다시 돌리지 않으므로, 봉이 차트보다
   * 먼저 도착하면 그 이펙트는 **한 번 빠져나간 뒤 다시 실행되지 않았다.**
   * 결과는 캔들이 0개도 아닌데 **하얗고 빈 차트**다 — 만들어 놓고 배선을
   * 안 한 상태다. 실측 스크린샷에서 잡았다.
   */
  const [chartEpoch, setChartEpoch] = useState(0);

  const [bars, setBars] = useState<any>(null);
  /** 이 봉이 **어느 요청의 결과인가.** 간격을 바꾸면 이전 봉은 이 화면 값이 아니다 */
  const [barsKey, setBarsKey] = useState<string | null>(null);
  /** 이펙트 안에서 읽는 사본. 상태를 의존성에 넣으면 재요청이 무한해진다 */
  const barsKeyRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<ChartPhase>('FIRST_LOAD');
  const [err, setErr] = useState<string | null>(null);
  const [expectedMs, setExpectedMs] = useState<number | null>(null);

  // 요청 세대. 간격·종목을 바꾸거나 주기 갱신할 때마다 오른다.
  const genRef = useRef(0);
  /** 주기 갱신 트리거. 값이 바뀌면 아래 fetch가 다시 돈다 */
  const [refreshTick, setRefreshTick] = useState(0);

  // 시장을 넘긴다. 예전에는 훅이 무조건 선물에 붙어서 현물 차트에는
  // 실시간 현재가를 아예 연결하지 못했다 (선물 값을 현물 봉에 얹을 수는
  // 없으니 끄는 수밖에 없었다). 이제 현물은 현물 값을 받는다.
  const stream = useBinanceStream(symbol, !fixtureBars, market);

  // ── 봉 받기 ──
  useEffect(() => {
    if (fixtureBars) {
      // **주입은 시험·스토리 전용이다.** 제품 경로는 아래 fetch만 탄다.
      const k = requestKeyOf(symbol, interval, market);
      setBars(fixtureBars); setBarsKey(k); barsKeyRef.current = k;
      setPhase(phaseOnSuccess()); setErr(null);
      return;
    }
    let alive = true;
    const gen = ++genRef.current;

    // ── 갱신인가 전환인가 ──
    //
    // 주기 갱신은 "같은 화면의 새 값"이고, 간격·종목·시장 전환은 "다른
    // 화면"이다. 실패했을 때 할 일이 정반대다 — 전자는 마지막 값을 두고,
    // 후자는 지운다(남겨 두면 다른 간격을 현재로 읽는다).
    const key = requestKeyOf(symbol, interval, market);
    const isSwitch = key !== barsKeyRef.current;
    const hasBars = barsKeyRef.current !== null;

    if (isSwitch) {
      // 이전 간격의 봉은 이 화면의 값이 아니다.
      setBars(null); setBarsKey(null); barsKeyRef.current = null;
    }
    setPhase(phaseOnStart({ isSwitch, hasBars: hasBars && !isSwitch }));
    setErr(null);

    (async () => {
      try {
        const r = await fetch(
          `/api/market/candles?symbol=${encodeURIComponent(symbol)}`
          + `&interval=${encodeURIComponent(interval)}&market=${encodeURIComponent(market)}`);
        const j = await r.json().catch(() => null);
        // ★ 지금 세대가 아니면 버린다 — 옛 간격의 봉이 박히는 것을 막는다
        if (!alive || !isFreshResponse(gen, genRef.current)) return;
        if (j?.ok && j.bars) {
          setBars(j.bars);
          setBarsKey(key); barsKeyRef.current = key;
          setExpectedMs(Number.isFinite(Number(j.intervalMs)) ? Number(j.intervalMs) : null);
          setPhase(phaseOnSuccess());
          // 여기서 READY라고 적어도, 그 봉으로 **캔들이 한 개도 안 나오면**
          // 화면은 빈 차트가 된다. 그 판정은 candles를 실제로 만들어 본 뒤에
          // 아래 useEffect가 다시 한다 — `ok: true`는 "응답을 받았다"이지
          // "그릴 것이 있다"가 아니다.
        } else {
          // **갱신 실패는 그려 둔 봉을 지우지 않는다.** 이것이 "차트 증발"이었다.
          if (shouldClearBarsOnFailure({ isSwitch })) {
            setBars(null); setBarsKey(null); barsKeyRef.current = null;
          }
          setErr(String(j?.message ?? '봉을 받지 못했습니다'));
          setPhase(phaseOnFailure({ isSwitch, hasBars: barsKeyRef.current !== null }));
        }
      } catch (e: any) {
        if (!alive || !isFreshResponse(gen, genRef.current)) return;
        if (shouldClearBarsOnFailure({ isSwitch })) {
          setBars(null); setBarsKey(null); barsKeyRef.current = null;
        }
        setErr(`봉을 받지 못했습니다 — ${String(e?.message || e).slice(0, 120)}`);
        setPhase(phaseOnFailure({ isSwitch, hasBars: barsKeyRef.current !== null }));
      }
    })();

    return () => { alive = false; };
    // `barsKey`는 **읽기만** 한다(ref로 본다). 의존성에 넣으면 성공할 때마다
    // 이펙트가 다시 돌아 무한 재요청이 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, market, fixtureBars, refreshTick]);

  // 주기 갱신 — 진행 중 봉과 새로 닫힌 봉을 **venue에서 다시 받는다.**
  //
  // **화면이 봉을 만들지 않는다.** 시간이 지났다고 봉을 붙이지 않고 venue가
  // 줄 때까지 기다린다. 그래서 이 타이머는 `setBars`를 직접 건드리지 않고
  // 위 fetch를 다시 돌릴 뿐이다 — 처음에는 여기서 객체만 복제해 리렌더를
  // 일으켰는데, 그건 **새 봉을 받지 않으면서 받은 것처럼 보이는** 코드였다.
  useEffect(() => {
    if (fixtureBars) return;
    const t = setInterval(() => setRefreshTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, [fixtureBars]);

  // ── ★ 봉은 venue가 준 것만 그린다 ──
  //
  // 예전에는 진행 중인 봉의 종가·고가·저가에 `stream.lastPrice`를 얹었다.
  // 그런데 그 값은 **체결가가 아니라 최우선 호가의 중간값**이다
  // (`useBinanceStream`의 `lastPriceKind: 'QUOTE_MID'`). venue가 거래됐다고
  // 말한 적 없는 가격으로 고가·저가를 넓히고 있었던 것이고, 그건 우리가
  // 봉을 고쳐 적는 것이다 — 실제 체결이 없었던 자리에 꼬리가 생긴다.
  //
  // 실제 체결 스트림(`@aggTrade`)을 붙이기 전까지는 **30초 venue 갱신만**
  // 쓴다. 덜 부드럽지만 화면의 모든 봉이 venue가 말한 값이다.
  // (`withLivePrice`는 그대로 둔다 — 진짜 체결가가 생기면 그때 쓴다.)
  const candles = useMemo<Candle[]>(() => barsToCandles(bars), [bars]);

  const volumes = useMemo(() => barsToVolumes(bars), [bars]);

  // ── ★ 빈 차트를 READY라고 적지 않는다 ──
  //
  // 실측에서 잡았다: 응답이 `ok: true`인데 봉의 모양이 우리가 아는 모양이
  // 아니면 캔들이 0개가 되고, 그대로 **하얗고 빈 차트**가 READY로 떴다.
  // 빈 차트는 "거래가 없었다"로 읽힌다 — 이 파일이 이미 오류 상태에서
  // 막으려던 그 오해다.
  useEffect(() => {
    if (phase !== 'READY') return;
    if (candles.length > 0) return;
    setPhase('ERROR');
    setErr('봉을 받았지만 그릴 수 있는 캔들이 없습니다 — 거래가 없었다는 뜻이 아닙니다');
  }, [phase, candles.length]);

  /** 받은 봉이 고른 간격의 것인가. 판단할 수 없으면 null — 경고하지 않는다. */
  const intervalOk = useMemo(
    () => candlesMatchInterval(candles, expectedMs), [candles, expectedMs]);

  // ── 차트 만들기 ──
  useEffect(() => {
    let disposed = false;
    let ro: any = null;
    (async () => {
      if (!boxRef.current) return;
      const lw: any = await import('lightweight-charts');
      if (disposed || !boxRef.current) return;

      const chart = lw.createChart(boxRef.current, {
        autoSize: true,
        layout: { background: { color: 'transparent' }, textColor: C.dim, attributionLogo: false },
        grid: {
          vertLines: { color: C.hair, style: 1 },
          horzLines: { color: C.hair, style: 1 },
        },
        rightPriceScale: { borderColor: C.hair },
        timeScale: { borderColor: C.hair, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
      apiRef.current = chart;

      // v5 API — `addSeries(정의, 옵션)`. v4의 addCandlestickSeries는 없다.
      seriesRef.current = chart.addSeries(lw.CandlestickSeries, {
        upColor: '#10B981', downColor: '#EF4444',
        borderUpColor: '#10B981', borderDownColor: '#EF4444',
        wickUpColor: '#10B981', wickDownColor: '#EF4444',
      });
      volRef.current = chart.addSeries(lw.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      });
      // 거래량은 아래 25%에만. 봉 위에 겹치면 저가 부근에서 꼬리와 막대가
      // 뒤섞여 09시 첫 봉을 읽을 수 없다.
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

      ro = () => chart.timeScale().fitContent();
      window.addEventListener('resize', ro);

      // **여기서 알린다.** 이 줄이 없으면 이미 도착한 봉이 영영 안 그려진다.
      if (!disposed) setChartEpoch(n => n + 1);
    })();

    return () => {
      disposed = true;
      if (ro) window.removeEventListener('resize', ro);
      try { apiRef.current?.remove(); } catch { /* 이미 정리됐다 */ }
      apiRef.current = null; seriesRef.current = null; volRef.current = null;
      lineRefs.current.clear();
    };
  }, []);

  // ── 데이터 밀어넣기 ──
  useEffect(() => {
    if (!seriesRef.current) return;
    try {
      seriesRef.current.setData(candles as any);
      volRef.current?.setData(volumes as any);
      if (candles.length) apiRef.current?.timeScale?.().fitContent();
    } catch { /* 차트가 정리되는 중이면 무시한다 */ }
  }, [candles, volumes, chartEpoch]);

  // ── 지표 ──
  useEffect(() => {
    const chart = apiRef.current;
    if (!chart) return;
    (async () => {
      const lw: any = await import('lightweight-charts');
      // ── 지울 것을 먼저 지운다 ──
      //
      // 사용자가 끈 지표뿐 아니라 **더 이상 그릴 수 없게 된 지표**도 지운다.
      //
      // 실측에서 잡힌 결함이 이것이었다: 갱신이 실패해 캔들이 0개가 됐는데,
      // 아래 루프가 `indicatorAvailable`에서 `continue`로 빠져나가는 바람에
      // **옛 데이터로 그린 MA선만 화면에 남았다.** 캔들 없는 이동평균선은
      // 근거를 볼 수 없는 선이고, 사용자는 그게 낡았다는 걸 알 방법이 없다.
      for (const [id, s] of lineRefs.current) {
        const off = indicators.indexOf(id as IndicatorId) < 0;
        const undrawable = !indicatorAvailable(id as IndicatorId, candles.length);
        if (off || undrawable) {
          try { chart.removeSeries(s); } catch { /* 이미 없다 */ }
          lineRefs.current.delete(id);
        }
      }
      for (const spec of INDICATORS) {
        if (indicators.indexOf(spec.id) < 0) continue;
        // **그릴 수 없는 지표는 켜지 않는다** — 켰는데 선이 없으면 고장으로 읽힌다
        if (!indicatorAvailable(spec.id, candles.length)) continue;
        let s = lineRefs.current.get(spec.id);
        if (!s) {
          try {
            s = chart.addSeries(lw.LineSeries, {
              color: spec.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
            });
            lineRefs.current.set(spec.id, s);
          } catch { continue; }
        }
        try { s.setData(computeIndicator(spec.id, candles) as any); } catch { /* 정리 중 */ }
      }
    })();
  }, [indicators, candles, chartEpoch]);   // 지표도 같은 이유로 chartEpoch를 본다

  const tab = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 6, minHeight: 0, cursor: 'pointer',
    border: `1px solid ${on ? C.accent : C.hair}`,
    background: on ? C.accentBg : 'transparent',
    color: on ? C.accent : C.dim, fontSize: FS.micro, fontWeight: 700,
  });

  return (
    <div data-region="price-chart" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 간격 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: denseToolbar ? 3 : 4,
        padding: denseToolbar ? '3px 6px' : '6px 8px',
        borderBottom: `1px solid ${C.hair}`, overflowX: 'auto', scrollbarWidth: 'none',
      }}>
        {CHART_INTERVALS.map(iv => (
          <button key={iv.id} data-interval={iv.id}
            onClick={() => onIntervalChange?.(iv.id)}
            style={denseToolbar ? { ...tab(interval === iv.id), padding: '2px 7px' } : tab(interval === iv.id)}>{iv.label}</button>
        ))}
        <div style={{ flex: 1, minWidth: 6 }}/>
        {INDICATORS.map(s => {
          const can = indicatorAvailable(s.id, candles.length);
          const on = indicators.indexOf(s.id) >= 0;
          return (
            <button key={s.id} data-indicator={s.id}
              onClick={() => can && onToggleIndicator?.(s.id)}
              disabled={!can}
              // 못 그리는 이유를 말한다. 그냥 비활성이면 고장으로 읽힌다.
              title={can ? s.label : `봉이 ${s.period}개 이상이어야 그릴 수 있습니다`}
              style={{
                ...tab(on), opacity: can ? 1 : 0.4, color: on ? s.color : C.faint,
                ...(denseToolbar ? { padding: '2px 5px', whiteSpace: 'nowrap' as const } : null),
              }}>
              {denseToolbar ? s.label.replace(/\s+/g, '') : s.label}
            </button>
          );
        })}
      </div>

      {/* 차트 */}
      <div style={{ position: 'relative', height, minHeight: 0 }}>
        <div ref={boxRef} data-testid="chart-canvas" data-chart-state={phase}
          style={{ position: 'absolute', inset: 0 }}/>
        {/* **보여줄 것이 있으면 덮지 않는다.**
            예전에는 30초마다 갱신이 돌 때마다 이 층이 캔들을 가렸고,
            갱신 한 번 실패하면 봉까지 지워 화면이 비었다. 이제 덮는 경우는
            최초 로딩과 "보여줄 것이 없음" 둘뿐이다(`chartLoadState`). */}
        {showsBlockingOverlay(phase) && (
          <div data-testid={phase === 'ERROR' ? 'price-chart-error' : 'price-chart-loading'} style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: phase === 'ERROR' ? C.down : C.faint,
            fontSize: FS.small, textAlign: 'center', padding: 16,
          }}>
            {phase === 'FIRST_LOAD' ? '봉을 받는 중…' : (err ?? '봉을 받지 못했습니다')}
          </div>
        )}
        {/* 낡은 값을 보고 있다는 사실은 숨기지 않는다 — 덮지도 않는다 */}
        {staleNotice(phase) && (
          <div data-testid="price-chart-stale" style={{
            position: 'absolute', top: 6, right: 8, zIndex: 3,
            background: C.raised, border: `1px solid ${C.warn}`, color: C.warn,
            borderRadius: 6, padding: '3px 7px', fontSize: FS.micro, fontWeight: 700,
          }}>{staleNotice(phase)}</div>
        )}
        {/* venue가 엉뚱한 간격을 줬을 때. 세대 번호는 우리 실수만 막는다 */}
        {phase === 'READY' && intervalOk === false && (
          <div style={{
            position: 'absolute', top: 6, left: 8, zIndex: 3,
            background: C.raised, border: `1px solid ${C.down}`, color: C.down,
            borderRadius: 6, padding: '3px 7px', fontSize: FS.micro, fontWeight: 700,
          }}>받은 봉의 간격이 다릅니다</div>
        )}
      </div>
    </div>
  );
}

export default PriceChart;
