'use client';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import PortfolioBacktestView from '../PortfolioBacktestView';
import { StrategyLeg } from '@/lib/backtest/portfolio';
import CompoundAnalysisView from '../CompoundAnalysisView';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { safeNumber, formatKRW, safePercent } from '@/lib/format';
import { validateBacktest } from '@/lib/backtest/validation';
import { DurationPicker } from '@/components/inputs/QuickInput';

type Strategy = 'ema-cross' | 'rsi' | 'macd' | 'bollinger' | 'dca';

const STRATEGIES: { id: Strategy; label: string; desc: string; icon: string }[] = [
  { id:'ema-cross', label:'EMA 골든/데드크로스', desc:'단기 EMA가 장기 EMA 교차 시점에서 매매', icon:'' },
  { id:'rsi',       label:'RSI 과매도/과매수',  desc:'RSI 30 미만 진입, 70 초과 청산',          icon:'' },
  { id:'macd',      label:'MACD 히스토그램',    desc:'MACD 히스토그램 부호 전환 시 매매',         icon:'' },
  { id:'bollinger', label:'볼린저 밴드',         desc:'하단 반등 매수, 상단 이탈 매도',           icon:'' },
  { id:'dca',       label:'DCA 적립식',         desc:'정해진 주기마다 일정 금액 매수',           icon:'' },
];

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT'];
const TIMEFRAMES = [
  { id:'15m', label:'15분' },
  { id:'1h',  label:'1시간' },
  { id:'4h',  label:'4시간' },
  { id:'1d',  label:'일봉' },
  { id:'1w',  label:'주봉' },
];
const PERIODS = [
  { days: 30,  label:'1개월' },
  { days: 90,  label:'3개월' },
  { days: 180, label:'6개월' },
  { days: 365, label:'1년' },
  { days: 730, label:'2년' },
];

interface BacktestResponse {
  ok: boolean;
  source: 'binance' | 'synthetic';
  symbol: string;
  strategy: Strategy;
  timeframe: string;
  candleCount: number;
  summary: {
    finalEquity: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    winRate: number;
    totalTrades: number;
    winTrades: number;
    loseTrades: number;
    avgWinPct: number;
    avgLossPct: number;
    profitFactor: number;
    sharpe: number;
  };
  equityCurve: { t: number; equity: number }[];
  trades: Array<{
    side: 'buy'|'sell'|'long'|'short';
    time?: number;
    date?: string;
    price?: number;
    entry?: number;
    exit?: number;
    qty: number;
    leverage?: number;
    grossPnL?: number;
    fees?: number;
    slippage?: number;
    funding?: number;
    netPnL?: number;
    pnl?: number;
    pnlPct?: number;
    reason?: string;
    exitReason?: string;
    strategy?: string;
  }>;
}

export default function BacktestPage() {
  const [symbol,    setSymbol]    = useState('BTCUSDT');
  const [strategy,  setStrategy]  = useState<Strategy>('ema-cross');
  const [timeframe, setTimeframe] = useState('1d');
  const [periodDays,setPeriodDays]= useState(365);
  const [initialCash, setInitialCash] = useState('1000000');
  const [feeRate,   setFeeRate]   = useState('0.1');
  const [leverage,  setLeverage]  = useState('1');

  const [loading,   setLoading]   = useState(false);
  const [result,    setResult]    = useState<BacktestResponse | null>(null);
  const [portfolioMode, setPortfolioMode] = useState(false);
  const [portfolioLegs, setPortfolioLegs] = useState<StrategyLeg[] | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [error,     setError]     = useState('');
  const [toast,     setToast]     = useState('');
  const [loadedFromStrategy, setLoadedFromStrategy] = useState<{ name: string; id: string } | null>(null);

  const showToast = useCallback((m: string) => {
    setToast(m); setTimeout(() => setToast(''), 2500);
  }, []);

  // sessionStorage에 전략이 있으면 자동 로드 (StrategyBuilderPage → 백테스트 버튼)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem('tg_backtest_strategy');
      if (!raw) return;
      const strat = JSON.parse(raw);
      if (!strat || typeof strat !== 'object') return;

      // 심볼 매핑 (UserStrategy.asset → BacktestPage SYMBOL)
      if (strat.asset && strat.market === 'crypto') {
        const candidate = String(strat.asset).toUpperCase().replace(/USDT$/, '') + 'USDT';
        if (SYMBOLS.includes(candidate)) setSymbol(candidate);
      }

      // 시간 단위 매핑
      if (typeof strat.timeframe === 'string' && TIMEFRAMES.some(t => t.id === strat.timeframe)) {
        setTimeframe(strat.timeframe);
      }

      // 지표 → 백테스트 전략 매핑 (첫 번째 indicator 기준)
      const firstInd = Array.isArray(strat.conditions) ? strat.conditions[0]?.indicator : null;
      const indMap: Record<string, Strategy> = {
        'RSI':      'rsi',
        'MACD':     'macd',
        'EMA':      'ema-cross',
        'MA_Cross': 'ema-cross',
        'SMA':      'ema-cross',
        'BB':       'bollinger',
      };
      const mapped = firstInd ? indMap[firstInd] : null;
      if (mapped) setStrategy(mapped);

      // 주문 금액
      if (strat.order?.amount && typeof strat.order.amount === 'number') {
        setInitialCash(String(strat.order.amount));
      }

      setLoadedFromStrategy({ name: strat.name || '전략', id: strat.id || '' });
      showToast(`✅ "${strat.name || '전략'}" 자동 로드`);

      // 한 번 로드 후 제거 (뒤로가기 → 다시 들어와도 재로딩 안 함)
      window.sessionStorage.removeItem('tg_backtest_strategy');
    } catch {}
  }, [showToast]);

  const runBacktest = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol, strategy, timeframe, periodDays,
          initialCash: safeNumber(initialCash, 1_000_000),
          feeRate:     safeNumber(feeRate, 0.1) / 100,
          leverage:    safeNumber(leverage, 1),
        }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.error || '백테스트 실패');
      }
      setResult(data);
      showToast(`✅ ${data.source === 'binance' ? '실제 데이터' : '시뮬레이션 데이터'} 백테스트 완료`);
    } catch (e: any) {
      console.error('[backtest]', e);
      setError(e?.message || '오류 발생');
      showToast('❌ 백테스트 실패');
    } finally {
      setLoading(false);
    }
  }, [symbol, strategy, timeframe, periodDays, initialCash, feeRate, leverage, showToast]);

  // 포트폴리오 백테스트: 여러 전략을 동시 실행 → 합산
  const runPortfolio = useCallback(async () => {
    setPortfolioLoading(true);
    setError('');
    const combo: { id: Strategy; name: string; weight: number }[] = [
      { id: 'ema-cross', name: 'EMA 추세', weight: 40 },
      { id: 'rsi', name: 'RSI 역추세', weight: 35 },
      { id: 'bollinger', name: '볼린저 돌파', weight: 25 },
    ];
    try {
      const legs: StrategyLeg[] = [];
      for (const c of combo) {
        const res = await fetch('/api/backtest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, strategy: c.id, timeframe, periodDays, initialCash: safeNumber(initialCash, 1_000_000), feeRate: safeNumber(feeRate, 0.1) / 100, leverage: safeNumber(leverage, 1) }),
          signal: AbortSignal.timeout(25000),
        });
        const data = await res.json();
        if (data?.ok && Array.isArray(data.equityCurve)) {
          legs.push({ id: c.id, name: c.name, weightPct: c.weight, equityCurve: data.equityCurve });
        }
      }
      if (legs.length < 2) throw new Error('포트폴리오 백테스트에 전략이 부족합니다');
      setPortfolioLegs(legs);
      showToast(`✅ ${legs.length}개 전략 포트폴리오 백테스트 완료`);
    } catch (e: any) {
      setError(e?.message || '포트폴리오 백테스트 실패');
      showToast('❌ 포트폴리오 백테스트 실패');
    } finally {
      setPortfolioLoading(false);
    }
  }, [symbol, timeframe, periodDays, initialCash, feeRate, leverage, showToast]);

  /* Equity curve SVG */
  const equitySvg = useMemo(() => {
    if (!result || !Array.isArray(result.equityCurve) || result.equityCurve.length < 2) return null;
    const pts = result.equityCurve;
    const W = 320, H = 100;
    const ys = pts.map(p => p.equity);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = maxY - minY || 1;
    const stepX = W / (pts.length - 1);
    const d = pts.map((p, i) => {
      const x = i * stepX;
      const y = H - ((p.equity - minY) / span) * H;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const finalUp = ys[ys.length-1] >= ys[0];
    const color = finalUp ? T.grn : T.red;
    return (
      <svg width="100%" height={H + 10} viewBox={`0 0 ${W} ${H + 10}`}
        style={{ display:'block' }} preserveAspectRatio="none">
        <path d={d} fill="none" stroke={color} strokeWidth="2"/>
        <path d={d + ` L ${W} ${H} L 0 ${H} Z`} fill={color} opacity="0.1"/>
      </svg>
    );
  }, [result]);

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top: 16, left:'50%', transform:'translateX(-50%)',
          background: T.acl, color:'#fff', padding:'10px 18px', borderRadius: 12,
          fontSize: 13, fontWeight: 700, zIndex: 999 }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>백테스트</div>
        <div style={{ color: T.muted, fontSize: 10 }}>전략을 과거 데이터로 검증</div>
      </div>

      {/* 자동 로드된 전략 배지 */}
      {loadedFromStrategy && (
        <Card style={{ marginBottom: 10, background: T.prp + '10', border: `1px solid ${T.prp}30` }}>
          <div style={{ display:'flex', alignItems:'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🤖</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: T.prp, fontWeight: 800, fontSize: 11 }}>전략 자동 로드됨</div>
              <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{loadedFromStrategy.name}</div>
            </div>
            <button onClick={() => setLoadedFromStrategy(null)}
              style={{ background: 'transparent', color: T.muted, border: 'none', cursor: 'pointer', fontSize: 16, padding: 4 }}
              aria-label="배지 닫기">×</button>
          </div>
          <div style={{ color: T.muted, fontSize: 10, marginTop: 5, lineHeight: 1.5 }}>
            전략의 지표/시간단위/금액이 자동 채워졌습니다. 필요시 수동으로 조정하세요.
          </div>
        </Card>
      )}

      {/* Strategy selection */}
      <Card style={{ marginBottom: 10 }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>전략 선택</div>
        {STRATEGIES.map(s => (
          <div key={s.id} onClick={() => setStrategy(s.id)}
            style={{ display:'flex', alignItems:'center', gap: 10,
              padding:'10px 12px', borderRadius: 10, marginBottom: 5,
              background: strategy === s.id ? T.acg : T.alt,
              border:`1px solid ${strategy === s.id ? T.acl : T.border}`,
              cursor:'pointer' }}>
            <span style={{ fontSize: 18 }}>{s.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ color: strategy === s.id ? T.acl : T.txt,
                fontSize: 12, fontWeight: 700 }}>{s.label}</div>
              <div style={{ color: T.muted, fontSize: 10 }}>{s.desc}</div>
            </div>
            {strategy === s.id && (
              <span style={{ color: T.acl, fontSize: 16, fontWeight: 800 }}>✓</span>
            )}
          </div>
        ))}
      </Card>

      {/* Config */}
      <Card style={{ marginBottom: 10 }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>설정</div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 5 }}>종목 (Binance)</div>
          <div style={{ display:'flex', gap: 4, flexWrap:'wrap' }}>
            {SYMBOLS.map(s => (
              <button key={s} type="button" onClick={() => setSymbol(s)}
                style={{ padding:'6px 10px', minHeight: 32,
                  background: symbol === s ? T.acg : T.alt,
                  border:`1px solid ${symbol === s ? T.acl : T.border}`,
                  color: symbol === s ? T.acl : T.muted,
                  borderRadius: 16, fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8, marginBottom: 10 }}>
          <div>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>타임프레임</div>
            <select value={timeframe} onChange={e => setTimeframe(e.target.value)}
              style={{ width:'100%', background: T.bg, border:`1px solid ${T.border}`,
                borderRadius: 8, padding:'9px 10px', color: T.txt, fontSize: 12, outline:'none' }}>
              {TIMEFRAMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 6 }}>백테스트 기간 (자유 선택)</div>
          <DurationPicker value={periodDays} onChange={setPeriodDays} />
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>초기자금 (₩)</div>
            <input type="text" inputMode="decimal"
              value={initialCash}
              onChange={e => setInitialCash(e.target.value.replace(/[^\d]/g, ''))}
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 10px',
                color: T.txt, fontSize: 11, outline:'none', fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}/>
          </div>
          <div>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>수수료 %</div>
            <input type="text" inputMode="decimal"
              value={feeRate}
              onChange={e => setFeeRate(e.target.value.replace(/[^\d.]/g, ''))}
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 10px',
                color: T.txt, fontSize: 11, outline:'none', fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}/>
          </div>
          <div>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>레버리지</div>
            <input type="text" inputMode="decimal"
              value={leverage}
              onChange={e => setLeverage(e.target.value.replace(/[^\d]/g, ''))}
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 10px',
                color: T.txt, fontSize: 11, outline:'none', fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}/>
          </div>
        </div>
      </Card>

      {/* Run button */}
      <button type="button" onClick={runBacktest} disabled={loading}
        style={{ width:'100%', padding:'14px', minHeight: 50, marginBottom: 12,
          background: loading ? T.alt : 'linear-gradient(135deg,#2563EB,#10B981)',
          color:'#fff', border:'none', borderRadius: 12,
          fontWeight: 800, fontSize: 14, cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.7 : 1 }}>
        {loading ? '⏳ 백테스트 실행 중…' : '백테스트 실행'}
      </button>

      {/* 포트폴리오 백테스트 */}
      <button type="button" onClick={runPortfolio} disabled={portfolioLoading}
        style={{ width:'100%', padding:'12px', minHeight: 46, marginBottom: 12,
          background: portfolioLoading ? T.alt : T.card, border:`1px solid ${T.acl}`,
          color: T.acl, borderRadius: 12, fontWeight: 800, fontSize: 13,
          cursor: portfolioLoading ? 'wait' : 'pointer', opacity: portfolioLoading ? 0.7 : 1,
          display:'flex', alignItems:'center', justifyContent:'center', gap: 7 }}>
        {portfolioLoading ? '⏳ 여러 전략 동시 실행 중…' : '📊 다중 전략 포트폴리오 백테스트'}
      </button>

      {/* 포트폴리오 결과 */}
      {portfolioLegs && (
        <PortfolioBacktestView legs={portfolioLegs} initialCapital={safeNumber(initialCash, 1_000_000)} />
      )}

      {/* Error */}
      {error && (
        <Card style={{ background: T.red+'10', border:`1px solid ${T.red}30`, marginBottom: 10 }}>
          <div style={{ color: T.red, fontSize: 12, fontWeight: 700 }}>⚠️ {error}</div>
        </Card>
      )}

      {/* Result */}
      {result && (
        <>
          {/* Data source banner */}
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
            padding:'8px 12px', background: T.alt, borderRadius: 10, marginBottom: 10,
            fontSize: 10, color: T.muted }}>
            <span>{result.candleCount}개 캔들 · {result.symbol}</span>
            <span style={{
              color: result.source === 'binance' ? T.grn : T.ylw,
              fontWeight: 700,
            }}>
              {result.source === 'binance' ? '실제 Binance 데이터' : '시뮬레이션 데이터'}
            </span>
          </div>

          {/* Summary card */}
          <Card style={{ marginBottom: 10,
            borderLeft:`3px solid ${result.summary.totalReturnPct >= 0 ? T.grn : T.red}` }}>
            {(result.summary as any).sanityWarning && (
              <div style={{ background: T.red+'15', border:`1px solid ${T.red}40`, borderRadius: 8, padding:'8px 10px', marginBottom: 10 }}>
                <div style={{ color: T.red, fontSize: 11, fontWeight: 800 }}>⚠️ {(result.summary as any).sanityWarning}</div>
                <div style={{ color: T.muted, fontSize: 9, marginTop: 3 }}>이 결과는 신뢰할 수 없습니다. 레버리지·수량·기간 설정을 확인하세요.</div>
              </div>
            )}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline',
              marginBottom: 12 }}>
              <span style={{ color: T.muted, fontSize: 11 }}>총 수익률</span>
              <span style={{ color: result.summary.totalReturnPct >= 0 ? T.grn : T.red,
                fontSize: 24, fontWeight: 900, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                {safePercent(result.summary.totalReturnPct)}
              </span>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap: 8 }}>
              {[
                { label:'최종 자산',   value: formatKRW(result.summary.finalEquity), color: T.txt },
                { label:'최대 낙폭(MDD)', value: safePercent(-Math.abs(result.summary.maxDrawdownPct)), color: T.red },
                { label:'승률',       value: safePercent(result.summary.winRate),    color: result.summary.winRate >= 50 ? T.grn : T.red },
                { label:'손익비',     value: result.summary.profitFactor.toFixed(2), color: result.summary.profitFactor >= 1.5 ? T.grn : result.summary.profitFactor >= 1 ? T.ylw : T.red },
                { label:'거래 횟수',  value: `${result.summary.totalTrades}회`,      color: T.txt },
                { label:'샤프 지수',  value: result.summary.sharpe.toFixed(2),       color: result.summary.sharpe >= 1 ? T.grn : T.muted },
              ].map(m => (
                <div key={m.label} style={{ background: T.alt, borderRadius: 8, padding:'8px 10px' }}>
                  <div style={{ color: T.muted, fontSize: 9 }}>{m.label}</div>
                  <div style={{ color: m.color, fontSize: 13, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Equity curve */}
            {equitySvg && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop:`1px solid ${T.border}` }}>
                <div style={{ color: T.muted, fontSize: 10, marginBottom: 6 }}>자산 곡선</div>
                {equitySvg}
              </div>
            )}
          </Card>

          {/* 복리 성장 분석 */}
          <CompoundAnalysisView
            totalReturnPct={result.summary.totalReturnPct}
            periodDays={periodDays}
            initialCapital={result.summary.finalEquity && result.summary.totalReturnPct ? Math.round(result.summary.finalEquity / (1 + result.summary.totalReturnPct / 100)) : 10000000}
          />

          {/* 실전 적합도 판정 */}
          {(() => {
            const v = validateBacktest({
              totalTrades:  result.summary.totalTrades,
              winRate:      result.summary.winRate,
              profitFactor: result.summary.profitFactor,
              maxDrawdown:  Math.abs(result.summary.maxDrawdownPct),
              sharpeRatio:  result.summary.sharpe,
              totalReturn:  result.summary.totalReturnPct,
            } as any);
            return (
              <Card style={{ marginBottom: 10, borderLeft: `3px solid ${v.gradeColor}` }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 10 }}>
                  <span style={{ color: T.txt, fontWeight: 800, fontSize: 13 }}>실전 적합도</span>
                  <span style={{ padding:'3px 10px', borderRadius: 6, background: v.gradeColor + '22', color: v.gradeColor, fontSize: 12, fontWeight: 900 }}>
                    {v.gradeLabel} · {v.score}점
                  </span>
                </div>

                {/* 점수 바 */}
                <div style={{ height: 8, background: T.alt, borderRadius: 4, overflow:'hidden', marginBottom: 10 }}>
                  <div style={{ width: `${v.score}%`, height:'100%', background: v.gradeColor, transition:'width .3s' }}/>
                </div>

                {v.fatal.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {v.fatal.map((f, i) => (
                      <div key={i} style={{ color: T.red, fontSize: 11, lineHeight: 1.5 }}>{f}</div>
                    ))}
                  </div>
                )}
                {v.warnings.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {v.warnings.map((w, i) => (
                      <div key={i} style={{ color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>{w}</div>
                    ))}
                  </div>
                )}
                {v.passed.length > 0 && (
                  <div style={{ marginBottom: 8, display:'flex', flexWrap:'wrap', gap: 4 }}>
                    {v.passed.map((p, i) => (
                      <span key={i} style={{ color: T.grn, fontSize: 9, background: T.grn+'15', padding:'2px 7px', borderRadius: 4 }}>✓ {p}</span>
                    ))}
                  </div>
                )}

                <div style={{ padding:'8px 11px', background: v.gradeColor + '10', border:`1px solid ${v.gradeColor}30`, borderRadius: 7, color: T.sub, fontSize: 11, lineHeight: 1.5 }}>
                  {v.canGoLive ? '✅' : '⛔'} {v.recommendation}
                </div>
              </Card>
            );
          })()}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8, marginBottom: 10 }}>
            <Card style={{ background: T.grn + '10', border:`1px solid ${T.grn}30` }}>
              <div style={{ color: T.grn, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>승리</div>
              <div style={{ color: T.txt, fontSize: 18, fontWeight: 900 }}>{result.summary.winTrades}건</div>
              <div style={{ color: T.grn, fontSize: 11, marginTop: 2 }}>
                평균 +{Math.abs(result.summary.avgWinPct).toFixed(2)}%
              </div>
            </Card>
            <Card style={{ background: T.red + '10', border:`1px solid ${T.red}30` }}>
              <div style={{ color: T.red, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>패배</div>
              <div style={{ color: T.txt, fontSize: 18, fontWeight: 900 }}>{result.summary.loseTrades}건</div>
              <div style={{ color: T.red, fontSize: 11, marginTop: 2 }}>
                평균 {result.summary.avgLossPct.toFixed(2)}%
              </div>
            </Card>
          </div>

          {/* Recent trades */}
          {Array.isArray(result.trades) && result.trades.length > 0 && (
            <Card style={{ overflow:'hidden', padding: 0 }}>
              <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
                color: T.muted, fontSize: 10, fontWeight: 700 }}>
                거래 로그 (디버그)
              </div>
              <div style={{ maxHeight: 320, overflowY:'auto' }}>
                {result.trades.slice().reverse().slice(0, 30).map((t, i) => {
                  const isLong = t.side === 'long' || t.side === 'buy';
                  const entry = t.entry ?? t.price ?? 0;
                  const exit = t.exit ?? 0;
                  const net = t.netPnL ?? t.pnl ?? 0;
                  const pct = entry > 0 && exit > 0 ? ((isLong ? (exit-entry) : (entry-exit)) / entry) * 100 * (t.leverage || 1) : (t.pnlPct ?? 0);
                  return (
                    <div key={i} style={{ padding:'9px 14px', borderBottom:`1px solid ${T.border}` }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 3 }}>
                        <div style={{ display:'flex', alignItems:'center', gap: 6 }}>
                          <span style={{ background: isLong ? T.grn+'20' : T.red+'20', color: isLong ? T.grn : T.red,
                            fontSize: 9, fontWeight: 800, padding:'2px 7px', borderRadius: 4 }}>
                            {isLong ? 'LONG' : 'SHORT'}{t.leverage ? ` ${t.leverage}x` : ''}
                          </span>
                          {t.date && <span style={{ color: T.muted, fontSize: 9 }}>{t.date}</span>}
                        </div>
                        <span style={{ color: net >= 0 ? T.grn : T.red, fontSize: 12, fontWeight: 800, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                          {net >= 0 ? '+' : ''}{Math.round(net).toLocaleString('ko-KR')}원
                        </span>
                      </div>
                      <div style={{ display:'flex', gap: 10, flexWrap:'wrap', fontSize: 9, color: T.muted, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                        {entry > 0 && <span>진입 ${entry.toFixed(0)}</span>}
                        {exit > 0 && <span>청산 ${exit.toFixed(0)}</span>}
                        <span style={{ color: pct >= 0 ? T.grn : T.red }}>{safePercent(pct)}</span>
                        {t.qty != null && <span>수량 {t.qty}</span>}
                        {(t.fees || t.slippage || t.funding) != null && (
                          <span>비용 {Math.round((t.fees||0)+(t.slippage||0)+(t.funding||0)).toLocaleString('ko-KR')}원</span>
                        )}
                      </div>
                      {(t.reason || t.exitReason) && (
                        <div style={{ color: T.muted, fontSize: 9, marginTop: 2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {t.strategy ? `${t.strategy} · ` : ''}{t.exitReason || t.reason}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Disclaimer */}
          <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.6,
            padding:'10px 12px', background: T.alt, borderRadius: 10, marginTop: 10 }}>
            ⚠️ 백테스트는 <strong>과거 데이터</strong> 기준 시뮬레이션입니다.
            실제 거래에서는 슬리피지·체결지연·세금 등으로 결과가 달라질 수 있으며,
            과거 성과가 미래 수익을 보장하지 않습니다.
          </div>
        </>
      )}
    </div>
  );
}
