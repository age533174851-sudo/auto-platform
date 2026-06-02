'use client';
import React, { useState, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { safeNumber, formatKRW } from '@/lib/format';
import {
  filterCandidates, type CandidateAsset, type FilterCriteria,
  detectPullback, calcATR, calcATRExit,
  isWithinBuyMargin, planSplitBuy,
  isWithinTradingHours, DEFAULT_TRADING_WINDOWS,
  STRATEGY_PRESETS, type StrategyType,
} from '@/lib/autobot';

function toNum(v: unknown): number {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Mock candidate universe — in production fetched from /api/scanner
const MOCK_CANDIDATES: CandidateAsset[] = [
  { symbol:'005930', name:'삼성전자',    market:'KOSPI',  price: 78_500,  marketCap: 4.7e14, volume: 1.2e12, roe:11.2, opMargin:18.5, debtRatio:35,  ma5:77_800, ma20:75_200, ma60:72_100, rsi:58 },
  { symbol:'000660', name:'SK하이닉스',  market:'KOSPI',  price:195_000,  marketCap: 1.4e14, volume: 9.8e11, roe:18.7, opMargin:32.1, debtRatio:42,  ma5:198_000,ma20:190_500,ma60:175_000,rsi:65 },
  { symbol:'035420', name:'NAVER',       market:'KOSPI',  price:215_000,  marketCap: 3.5e13, volume: 4.2e11, roe:9.8,  opMargin:21.3, debtRatio:28,  ma5:212_000,ma20:208_000,ma60:202_500,rsi:62 },
  { symbol:'051910', name:'LG화학',      market:'KOSPI',  price:412_000,  marketCap: 2.9e13, volume: 3.1e11, roe:7.4,  opMargin:8.2,  debtRatio:55,  ma5:418_000,ma20:425_000,ma60:435_000,rsi:42 },
  { symbol:'247540', name:'에코프로비엠', market:'KOSDAQ', price:198_500,  marketCap: 1.9e13, volume: 5.6e11, roe:6.2,  opMargin:5.1,  debtRatio:78,  ma5:195_500,ma20:193_000,ma60:188_000,rsi:55 },
  { symbol:'091990', name:'셀트리온헬스케어',market:'KOSDAQ',price:78_300, marketCap: 1.2e13, volume: 2.4e11, roe:4.1,  opMargin:11.8, debtRatio:33,  ma5:79_200, ma20:80_100, ma60:82_500, rsi:38 },
];

export default function AutoBotLabPage() {
  const [tab, setTab] = useState<'filter'|'pullback'|'atr'|'split'|'time'|'preset'>('filter');
  const [toast, setToast] = useState('');

  /* ── 1. Filter state ── */
  const [filter, setFilter] = useState<FilterCriteria>({
    market: 'ALL',
    minMarketCap: 100_000_000_000,
    minVolume:    10_000_000_000,
    minRoe:       5,
    maxDebtRatio: 100,
    ma5OverMa20:  true,
  });

  const filteredAssets = useMemo(
    () => filterCandidates(MOCK_CANDIDATES, filter),
    [filter]
  );

  /* ── 2. Pullback state ── */
  const [maPeriod, setMaPeriod] = useState('20');
  const [minDev, setMinDev]     = useState('95');
  const [maxDev, setMaxDev]     = useState('98');
  const [pricesInput, setPricesInput] = useState('100,99,101,100.5,98,97,96,98,99,100,101,102,99.5,98.5,97.5,99,100,98,97,96.5,95');

  const pullbackResult = useMemo(() => {
    const closes = pricesInput.split(',').map(s => toNum(s)).filter(n => n > 0);
    return detectPullback({
      closes,
      maPeriod: toNum(maPeriod) || 20,
      minDeviation: toNum(minDev) / 100,
      maxDeviation: toNum(maxDev) / 100,
    });
  }, [pricesInput, maPeriod, minDev, maxDev]);

  /* ── 3. ATR state ── */
  const [atrEntry, setAtrEntry] = useState('100000');
  const [atrCurrent, setAtrCurrent] = useState('102000');
  const [atrVal, setAtrVal] = useState('2500');
  const [atrTakeMult, setAtrTakeMult] = useState('1.2');
  const [atrStopMult, setAtrStopMult] = useState('1.0');

  const atrResult = useMemo(() => calcATRExit({
    entryPrice:   toNum(atrEntry),
    currentPrice: toNum(atrCurrent),
    atr:          toNum(atrVal),
    side:         'long',
    takeMultiple: toNum(atrTakeMult),
    stopMultiple: toNum(atrStopMult),
  }), [atrEntry, atrCurrent, atrVal, atrTakeMult, atrStopMult]);

  /* ── 4. Split buy state ── */
  const [splitCapital, setSplitCapital] = useState('3000000');
  const [splitL1, setSplitL1] = useState('100000');
  const [splitL2, setSplitL2] = useState('95000');
  const [splitL3, setSplitL3] = useState('90000');

  const splitPlan = useMemo(() => planSplitBuy({
    totalCapital: toNum(splitCapital),
    splits:       3,
    priceLevels:  [toNum(splitL1), toNum(splitL2), toNum(splitL3)].filter(n => n > 0),
  }), [splitCapital, splitL1, splitL2, splitL3]);

  /* ── 5. Time window ── */
  const inWindow = useMemo(() => isWithinTradingHours(), []);

  /* ── 6. Strategy preset ── */
  const [strat, setStrat] = useState<StrategyType>('ma_pullback');
  const preset = STRATEGY_PRESETS[strat];

  const showToast = useCallback((msg: string) => {
    setToast(msg); setTimeout(() => setToast(''), 2500);
  }, []);

  const TABS = [
    { id:'filter',   label:'필터' },
    { id:'pullback', label:'눌림목' },
    { id:'atr',      label:'ATR' },
    { id:'split',    label:'분할매수' },
    { id:'time',     label:'시간대' },
    { id:'preset',   label:'전략' },
  ] as const;

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
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>AutoBot Lab</div>
        <div style={{ color: T.muted, fontSize: 10 }}>매매 로직 시뮬레이터 · 학습용</div>
      </div>

      <div style={{ background: T.ylw + '10', border:`1px solid ${T.ylw}30`,
        borderRadius: 10, padding:'8px 12px', marginBottom: 10,
        color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>
        ⚠️ 모든 로직은 <strong>학습/시뮬레이션 용도</strong>입니다. 실제 자동매매는 별도 인프라(증권사 API, 키 관리, 컴플라이언스)가 필요합니다.
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap: 4, overflowX:'auto', marginBottom: 12, paddingBottom: 4 }}>
        {TABS.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            style={{ flexShrink: 0, padding:'7px 14px', minHeight: 36,
              background: tab === t.id ? T.acg : T.alt,
              border:`1px solid ${tab === t.id ? T.acl : T.border}`,
              color: tab === t.id ? T.acl : T.muted,
              borderRadius: 20, fontSize: 11, fontWeight: 700, cursor:'pointer' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 1. Filter tab ── */}
      {tab === 'filter' && (
        <>
          <Card style={{ marginBottom: 10 }}>
            <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>다단계 종목 필터</div>

            {/* Market */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>시장</div>
              <div style={{ display:'flex', gap: 6 }}>
                {(['ALL','KOSPI','KOSDAQ'] as const).map(m => (
                  <button key={m} type="button"
                    onClick={() => setFilter(f => ({ ...f, market: m }))}
                    style={{ flex: 1, padding:'7px', minHeight: 34,
                      background: filter.market === m ? T.acg : T.alt,
                      border:`1px solid ${filter.market === m ? T.acl : T.border}`,
                      color: filter.market === m ? T.acl : T.muted,
                      borderRadius: 8, fontSize: 11, fontWeight: 700, cursor:'pointer' }}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {[
              ['최소 시가총액 (억)', filter.minMarketCap,    (v: number) => ({ minMarketCap: v }),    1e8],
              ['최소 거래대금 (억)', filter.minVolume,       (v: number) => ({ minVolume: v }),       1e8],
              ['최소 ROE (%)',       filter.minRoe,          (v: number) => ({ minRoe: v }),          1],
              ['최대 부채비율 (%)',  filter.maxDebtRatio,    (v: number) => ({ maxDebtRatio: v }),    1],
            ].map(([label, val, fn, scale]: any) => (
              <div key={label} style={{ marginBottom: 8 }}>
                <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>{label}</div>
                <input type="text" inputMode="decimal"
                  value={val != null ? String(val / scale) : ''}
                  onChange={e => setFilter(f => ({ ...f, ...fn(toNum(e.target.value) * scale) }))}
                  style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                    border:`1px solid ${T.border}`, borderRadius: 8,
                    padding:'9px 12px', color: T.txt, fontSize: 12, outline:'none' }}/>
              </div>
            ))}

            {/* MA AND condition */}
            <label style={{ display:'flex', alignItems:'center', gap: 8, padding:'8px 0', cursor:'pointer' }}>
              <input type="checkbox" checked={!!filter.ma5OverMa20}
                onChange={e => setFilter(f => ({ ...f, ma5OverMa20: e.target.checked }))}/>
              <span style={{ color: T.txt, fontSize: 12 }}>5MA &gt; 20MA (정배열)</span>
            </label>
            <label style={{ display:'flex', alignItems:'center', gap: 8, padding:'8px 0', cursor:'pointer' }}>
              <input type="checkbox" checked={!!filter.ma20OverMa60}
                onChange={e => setFilter(f => ({ ...f, ma20OverMa60: e.target.checked }))}/>
              <span style={{ color: T.txt, fontSize: 12 }}>20MA &gt; 60MA (중기 추세)</span>
            </label>
          </Card>

          <Card style={{ overflow:'hidden', padding: 0 }}>
            <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
              color: T.muted, fontSize: 10, fontWeight: 700 }}>
              필터 통과 종목 ({filteredAssets.length}/{MOCK_CANDIDATES.length})
            </div>
            {filteredAssets.length === 0 ? (
              <div style={{ padding:'30px 0', textAlign:'center', color: T.muted, fontSize: 12 }}>
                조건에 맞는 종목이 없습니다
              </div>
            ) : filteredAssets.map((a, i) => (
              <div key={a.symbol} style={{ display:'flex', justifyContent:'space-between',
                padding:'10px 14px',
                borderBottom: i < filteredAssets.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                <div>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.name}</div>
                  <div style={{ color: T.muted, fontSize: 9 }}>
                    {a.symbol} · {a.market} · ROE {a.roe}%
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                    {formatKRW(a.price)}
                  </div>
                  <div style={{ color: T.muted, fontSize: 9 }}>
                    시총 {(a.marketCap / 1e8).toFixed(0)}억
                  </div>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      {/* ── 2. Pullback tab ── */}
      {tab === 'pullback' && (
        <Card>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>눌림목 진입 (이격도)</div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>MA 기간</div>
              <input type="text" inputMode="decimal" value={maPeriod}
                onChange={e => setMaPeriod(e.target.value)}
                style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                  border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 12px',
                  color: T.txt, fontSize: 12, outline:'none' }}/>
            </div>
            <div>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>최소 이격 %</div>
              <input type="text" inputMode="decimal" value={minDev}
                onChange={e => setMinDev(e.target.value)}
                style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                  border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 12px',
                  color: T.txt, fontSize: 12, outline:'none' }}/>
            </div>
            <div>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>최대 이격 %</div>
              <input type="text" inputMode="decimal" value={maxDev}
                onChange={e => setMaxDev(e.target.value)}
                style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                  border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 12px',
                  color: T.txt, fontSize: 12, outline:'none' }}/>
            </div>
          </div>

          <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>일봉 종가 (콤마 구분, 최소 {toNum(maPeriod) || 20}개)</div>
          <textarea
            value={pricesInput}
            onChange={e => setPricesInput(e.target.value)}
            rows={3}
            style={{ width:'100%', boxSizing:'border-box', background: T.bg,
              border:`1px solid ${T.border}`, borderRadius: 8, padding:'8px 12px',
              color: T.txt, fontSize: 11, outline:'none', fontFamily:'monospace',
              resize:'vertical' }}/>

          <div style={{ marginTop: 14, padding:'12px 14px',
            background: pullbackResult.hit ? T.grn + '10' : T.alt,
            border: pullbackResult.hit ? `1px solid ${T.grn}40` : `1px solid ${T.border}`,
            borderRadius: 10 }}>
            <div style={{ color: pullbackResult.hit ? T.grn : T.muted,
              fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              {pullbackResult.hit ? '✅ 진입 시그널' : '❌ 진입 조건 외'}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 6, fontSize: 11 }}>
              <div>
                <span style={{ color: T.muted }}>현재가: </span>
                <span style={{ color: T.txt, fontFamily:'monospace' }}>{pullbackResult.currentPrice.toFixed(2)}</span>
              </div>
              <div>
                <span style={{ color: T.muted }}>MA: </span>
                <span style={{ color: T.txt, fontFamily:'monospace' }}>{pullbackResult.ma.toFixed(2)}</span>
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <span style={{ color: T.muted }}>이격도: </span>
                <span style={{ color: T.acl, fontFamily:'monospace', fontWeight: 700 }}>
                  {(pullbackResult.deviation * 100).toFixed(2)}%
                </span>
              </div>
            </div>
            <div style={{ color: T.sub, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
              {pullbackResult.reason}
            </div>
          </div>
        </Card>
      )}

      {/* ── 3. ATR tab ── */}
      {tab === 'atr' && (
        <Card>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>
            📏 ATR 동적 손익절
          </div>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 10, lineHeight: 1.5 }}>
            ATR (Average True Range): 최근 N일 평균 변동폭. 고정 % 손절 대신 변동성에 비례.
          </div>

          {[
            ['진입가',      atrEntry,   setAtrEntry],
            ['현재가',      atrCurrent, setAtrCurrent],
            ['ATR (20일)',  atrVal,     setAtrVal],
            ['익절 ATR ×',  atrTakeMult,setAtrTakeMult],
            ['손절 ATR ×',  atrStopMult,setAtrStopMult],
          ].map(([label, val, fn]: any) => (
            <div key={label} style={{ marginBottom: 8 }}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>{label}</div>
              <input type="text" inputMode="decimal" value={val}
                onChange={e => fn(e.target.value)}
                style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                  border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 12px',
                  color: T.txt, fontSize: 12, outline:'none', fontFamily:'monospace' }}/>
            </div>
          ))}

          <div style={{ marginTop: 14, padding:'12px 14px', background: T.alt, borderRadius: 10 }}>
            {[
              ['익절가 (TP)', formatKRW(atrResult.takeProfitPrice), T.grn],
              ['손절가 (SL)', formatKRW(atrResult.stopLossPrice),   T.red],
              ['현재 수익률', `${atrResult.unrealizedPct >= 0 ? '+' : ''}${atrResult.unrealizedPct.toFixed(2)}%`,
                atrResult.unrealizedPct >= 0 ? T.grn : T.red],
              ['TP까지 거리', formatKRW(atrResult.distanceToTP),    T.acl],
              ['SL까지 거리', formatKRW(atrResult.distanceToSL),    T.muted],
            ].map(([l, v, c]: any) => (
              <div key={l} style={{ display:'flex', justifyContent:'space-between',
                padding:'5px 0', borderBottom:`1px solid ${T.border}` }}>
                <span style={{ color: T.muted, fontSize: 11 }}>{l}</span>
                <span style={{ color: c, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>{v}</span>
              </div>
            ))}
            {(atrResult.shouldTakeProfit || atrResult.shouldStopLoss) && (
              <div style={{ marginTop: 8, padding:'8px 10px',
                background: atrResult.shouldTakeProfit ? T.grn + '20' : T.red + '20',
                borderRadius: 8, color: atrResult.shouldTakeProfit ? T.grn : T.red,
                fontSize: 11, fontWeight: 700, textAlign:'center' }}>
                {atrResult.shouldTakeProfit ? '익절 시그널 발동' : '🛑 손절 시그널 발동'}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── 4. Split buy tab ── */}
      {tab === 'split' && (
        <Card>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>🪜 3분할 매수 시뮬</div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>총 자본금</div>
            <input type="text" inputMode="decimal" value={splitCapital}
              onChange={e => setSplitCapital(e.target.value)}
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 12px',
                color: T.txt, fontSize: 12, outline:'none', fontFamily:'monospace' }}/>
          </div>

          {[['1차 매수가', splitL1, setSplitL1],
            ['2차 매수가', splitL2, setSplitL2],
            ['3차 매수가', splitL3, setSplitL3]].map(([l, v, fn]: any) => (
            <div key={l} style={{ marginBottom: 8 }}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>{l}</div>
              <input type="text" inputMode="decimal" value={v} onChange={e => fn(e.target.value)}
                style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                  border:`1px solid ${T.border}`, borderRadius: 8, padding:'9px 12px',
                  color: T.txt, fontSize: 12, outline:'none', fontFamily:'monospace' }}/>
            </div>
          ))}

          <div style={{ marginTop: 14 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 6 }}>분할 주문 계획</div>
            {splitPlan.map(o => (
              <div key={o.level} style={{ display:'grid', gridTemplateColumns:'40px 1fr 1fr',
                gap: 8, padding:'10px 12px', background: T.alt, borderRadius: 8,
                marginBottom: 6, alignItems:'center' }}>
                <div style={{ color: T.acl, fontSize: 14, fontWeight: 800 }}>{o.level}차</div>
                <div>
                  <div style={{ color: T.muted, fontSize: 9 }}>발동가</div>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                    {formatKRW(o.price)}
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color: T.muted, fontSize: 9 }}>{o.quantity.toFixed(2)}주</div>
                  <div style={{ color: T.acl, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                    {formatKRW(o.capital)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── 5. Time window tab ── */}
      {tab === 'time' && (
        <>
          <Card style={{ marginBottom: 10 }}>
            <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>운용 시간대</div>
            <div style={{ padding:'14px', background: inWindow ? T.grn + '15' : T.alt,
              border:`1px solid ${inWindow ? T.grn + '40' : T.border}`,
              borderRadius: 10, textAlign:'center', marginBottom: 10 }}>
              <div style={{ color: inWindow ? T.grn : T.muted, fontSize: 14, fontWeight: 800 }}>
                {inWindow ? '✅ 봇 운용 중' : '⏸ 운용 시간대 외'}
              </div>
              <div style={{ color: T.muted, fontSize: 10, marginTop: 4 }}>
                현재 KST {new Date().toLocaleTimeString('ko-KR')}
              </div>
            </div>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 6, fontWeight: 700 }}>운용 윈도우</div>
            {DEFAULT_TRADING_WINDOWS.map((w, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between',
                padding:'8px 12px', background: T.alt, borderRadius: 8, marginBottom: 6 }}>
                <span style={{ color: T.txt, fontSize: 11 }}>{w.label}</span>
                <span style={{ color: T.acl, fontSize: 11, fontFamily:'monospace' }}>
                  {String(w.startHour).padStart(2,'0')}:{String(w.startMinute).padStart(2,'0')}
                  {' ~ '}
                  {String(w.endHour).padStart(2,'0')}:{String(w.endMinute).padStart(2,'0')}
                </span>
              </div>
            ))}
            <div style={{ color: T.muted, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
              💡 장 시작 직후(9:00~9:30)와 종가 마감(15:30 이후) 변동성 큰 구간 회피.
            </div>
          </Card>
        </>
      )}

      {/* ── 6. Preset tab ── */}
      {tab === 'preset' && (
        <Card>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>전략 프리셋</div>
          {Object.values(STRATEGY_PRESETS).map(p => (
            <div key={p.id} onClick={() => setStrat(p.id)}
              style={{ padding:'12px 14px', marginBottom: 8, cursor:'pointer',
                background: strat === p.id ? T.acg : T.alt,
                border:`1px solid ${strat === p.id ? T.acl : T.border}`,
                borderRadius: 10 }}>
              <div style={{ color: strat === p.id ? T.acl : T.txt,
                fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                {p.name}
              </div>
              <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginBottom: 6 }}>
                {p.desc}
              </div>
              <div style={{ display:'flex', gap: 6, flexWrap:'wrap' }}>
                {[
                  ['익절', `ATR×${p.takeProfitMult}`],
                  ['손절', `ATR×${p.stopLossMult}`],
                  ['연속확인', `${p.confirmCount}회`],
                  ['마진', `±${(p.buyMarginPct * 100).toFixed(2)}%`],
                  ['분할', `${p.splits}차`],
                ].map(([l, v]) => (
                  <span key={l} style={{
                    background: T.bg, color: T.sub,
                    border:`1px solid ${T.border}`, borderRadius: 4,
                    padding:'2px 6px', fontSize: 9, fontFamily:'monospace' }}>
                    {l}: {v}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
