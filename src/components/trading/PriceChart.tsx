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
  barsToCandles, barsToVolumes, withLivePrice, isFreshResponse,
  candlesMatchInterval, UP_COLOR, DOWN_COLOR, type Candle,
} from '@/lib/trading/candleSeries';
import {
  INDICATORS, computeIndicator, indicatorAvailable, type IndicatorId,
} from '@/lib/trading/indicators';

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
}

type LoadState = 'LOADING' | 'READY' | 'ERROR';

export function PriceChart({
  symbol, market = 'USDM', interval, onIntervalChange,
  indicators = [], onToggleIndicator, height = 320, fixtureBars,
}: PriceChartProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const lineRefs = useRef<Map<string, any>>(new Map());

  const [bars, setBars] = useState<any>(null);
  const [state, setState] = useState<LoadState>('LOADING');
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
      setBars(fixtureBars); setState('READY'); setErr(null);
      return;
    }
    let alive = true;
    const gen = ++genRef.current;
    setState('LOADING'); setErr(null);

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
          setExpectedMs(Number.isFinite(Number(j.intervalMs)) ? Number(j.intervalMs) : null);
          setState('READY');
        } else {
          setBars(null);
          setErr(String(j?.message ?? '봉을 받지 못했습니다'));
          setState('ERROR');
        }
      } catch (e: any) {
        if (!alive || !isFreshResponse(gen, genRef.current)) return;
        setBars(null);
        setErr(`봉을 받지 못했습니다 — ${String(e?.message || e).slice(0, 120)}`);
        setState('ERROR');
      }
    })();

    return () => { alive = false; };
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

  const candles = useMemo<Candle[]>(() => {
    const base = barsToCandles(bars);
    // 진행 중 봉에만 현재가를 얹는다 (다음 봉은 만들지 않는다)
    return withLivePrice(base, stream.lastPrice);
  }, [bars, stream.lastPrice]);

  const volumes = useMemo(() => barsToVolumes(bars), [bars]);

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
  }, [candles, volumes]);

  // ── 지표 ──
  useEffect(() => {
    const chart = apiRef.current;
    if (!chart) return;
    (async () => {
      const lw: any = await import('lightweight-charts');
      // 꺼진 것은 지운다
      for (const [id, s] of lineRefs.current) {
        if (indicators.indexOf(id as IndicatorId) < 0) {
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
  }, [indicators, candles]);

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
        display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px',
        borderBottom: `1px solid ${C.hair}`, overflowX: 'auto', scrollbarWidth: 'none',
      }}>
        {CHART_INTERVALS.map(iv => (
          <button key={iv.id} data-interval={iv.id}
            onClick={() => onIntervalChange?.(iv.id)}
            style={tab(interval === iv.id)}>{iv.label}</button>
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
              style={{ ...tab(on), opacity: can ? 1 : 0.4, color: on ? s.color : C.faint }}>
              {s.label}
            </button>
          );
        })}
      </div>

      {/* 차트 */}
      <div style={{ position: 'relative', height, minHeight: 0 }}>
        <div ref={boxRef} data-testid="chart-canvas" style={{ position: 'absolute', inset: 0 }}/>
        {/* **못 받은 것을 빈 차트로 두지 않는다.** 빈 차트는 "거래가 없었다"로 읽힌다 */}
        {state !== 'READY' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: state === 'ERROR' ? C.down : C.faint,
            fontSize: FS.small, textAlign: 'center', padding: 16,
          }}>
            {state === 'LOADING' ? '봉을 받는 중…' : (err ?? '봉을 받지 못했습니다')}
          </div>
        )}
        {/* venue가 엉뚱한 간격을 줬을 때. 세대 번호는 우리 실수만 막는다 */}
        {state === 'READY' && intervalOk === false && (
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
