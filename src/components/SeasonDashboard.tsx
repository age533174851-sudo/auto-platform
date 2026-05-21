'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { getCurrentSeasonMode, getAdjustedParams, SEASON_CONFIGS, formatSeasonMode } from '@/lib/season';
import { getMockMarketScore } from '@/lib/market';
import type { MarketScore } from '@/lib/market';
import type { SeasonMode } from '@/lib/season';

const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E',
  txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F', prp:'#7C3AED',
} as const;

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:'14px 16px', ...style }}>{children}</div>;
}

function ScoreBar({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  const pct = Math.abs(value) / max * 100;
  const isNeg = value < 0;
  return (
    <div style={{ height:6, background:T.alt, borderRadius:3, overflow:'hidden', position:'relative' }}>
      <div style={{
        position:'absolute',
        left: isNeg ? `${50 - pct/2}%` : '50%',
        width: `${pct/2}%`,
        height:'100%',
        background: isNeg ? T.red : color,
        borderRadius:3,
        transition:'width .5s, left .5s',
      }}/>
      {/* Center line */}
      <div style={{ position:'absolute', left:'50%', top:0, width:1, height:'100%', background:T.border2 }}/>
    </div>
  );
}

const CONDITION_LABELS: Record<string, { ko: string; color: string; emoji: string }> = {
  STRONG_BULLISH: { ko:'강한 상승세',   color:T.grn,  emoji:'🚀' },
  WEAK_BULLISH:   { ko:'약한 상승세',   color:'#6EE7B7', emoji:'📈' },
  SIDEWAYS:       { ko:'횡보장',       color:T.ylw,  emoji:'↔️' },
  WEAK_BEARISH:   { ko:'약한 하락세',   color:'#FCA5A5', emoji:'📉' },
  STRONG_BEARISH: { ko:'강한 하락세',   color:T.red,  emoji:'🔻' },
};

const VOL_LABELS: Record<string, { ko: string; color: string }> = {
  LOW:     { ko:'낮음',   color:T.grn  },
  MEDIUM:  { ko:'보통',   color:T.acl  },
  HIGH:    { ko:'높음',   color:T.ylw  },
  EXTREME: { ko:'극단적', color:T.red  },
};

export default function SeasonDashboard() {
  const [mounted,  setMounted]  = useState(false);
  const [score,    setScore]    = useState<MarketScore | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [season,   setSeason]   = useState<SeasonMode>('INVEST');
  const [manualSeason, setManual] = useState<SeasonMode | null>(null);

  useEffect(() => {
    setMounted(true);
    setSeason(getCurrentSeasonMode());
  }, []);

  const fetchScore = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/market-score');
      if (r.ok) {
        const d = await r.json();
        setScore(d);
      } else {
        setScore(getMockMarketScore());
      }
    } catch {
      setScore(getMockMarketScore());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mounted) fetchScore();
  }, [mounted, fetchScore]);

  if (!mounted) return (
    <div style={{ textAlign:'center', color:T.muted, padding:'40px 0' }}>시즌 분석 로딩 중…</div>
  );

  const activeSeason = manualSeason || season;
  const seasonFmt    = formatSeasonMode(activeSeason);
  const cond         = score?.condition || 'SIDEWAYS';
  const vol          = score?.volatility || 'MEDIUM';
  const trend        = score?.trend || 'NONE';
  const params       = getAdjustedParams(activeSeason, cond, vol, trend);
  const condInfo     = CONDITION_LABELS[cond] || CONDITION_LABELS.SIDEWAYS;
  const volInfo      = VOL_LABELS[vol] || VOL_LABELS.MEDIUM;

  return (
    <div style={{ color:T.txt }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <div style={{ width:34, height:34, borderRadius:10, background:`linear-gradient(135deg,${seasonFmt.color},${T.prp})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>
          {seasonFmt.emoji}
        </div>
        <div>
          <div style={{ fontWeight:900, fontSize:15, color:T.txt }}>시즌 전략 모드</div>
          <div style={{ color:T.muted, fontSize:10 }}>시장 상황 × 계절에 따른 자동 전략 전환</div>
        </div>
        <button onClick={fetchScore} disabled={loading}
          style={{ marginLeft:'auto', padding:'5px 12px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, fontSize:10, cursor:'pointer' }}>
          {loading ? '분석 중…' : '🔄 새로고침'}
        </button>
      </div>

      {/* Season selector */}
      <div style={{ display:'flex', gap:8, marginBottom:12 }}>
        {(['INVEST','TRADING'] as const).map(s => {
          const fmt = formatSeasonMode(s);
          const active = activeSeason === s;
          const isCurrent = s === season;
          return (
            <div key={s}
              onClick={() => setManual(s === season ? null : s)}
              style={{
                flex:1, padding:'12px', borderRadius:12, cursor:'pointer',
                background: active ? fmt.color+'18' : T.card,
                border: `2px solid ${active ? fmt.color : T.border}`,
              }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                <span style={{ fontSize:18 }}>{fmt.emoji}</span>
                <div>
                  <div style={{ color: active ? fmt.color : T.txt, fontWeight:800, fontSize:12 }}>{fmt.name}</div>
                  {isCurrent && <div style={{ color:T.acl, fontSize:8, fontWeight:700 }}>현재 시즌</div>}
                </div>
              </div>
              <div style={{ color:T.muted, fontSize:9, lineHeight:1.4 }}>
                {fmt.months.map(m => `${m}월`).join(' ')}
              </div>
              <div style={{ marginTop:4, display:'flex', gap:3, flexWrap:'wrap' }}>
                {fmt.focus.slice(0,2).map(f => (
                  <span key={f} style={{ background:fmt.color+'20', color:fmt.color, fontSize:8, padding:'1px 5px', borderRadius:4 }}>{f}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Market score */}
      <Card style={{ marginBottom:10 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>📊 AI 시장 분석</div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontSize:16 }}>{condInfo.emoji}</span>
            <span style={{ color:condInfo.color, fontWeight:800, fontSize:12 }}>{condInfo.ko}</span>
          </div>
        </div>

        {/* Overall score gauge */}
        <div style={{ marginBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
            <span style={{ color:T.muted, fontSize:10 }}>시장 점수</span>
            <span style={{ color: (score?.overall||0) >= 0 ? T.grn : T.red, fontWeight:700, fontSize:12 }}>
              {score?.overall ?? 0 >= 0 ? '+' : ''}{score?.overall ?? 0}
            </span>
          </div>
          <ScoreBar value={score?.overall ?? 0} color={T.grn}/>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:2 }}>
            <span style={{ color:T.muted, fontSize:8 }}>-100 (강한 하락)</span>
            <span style={{ color:T.muted, fontSize:8 }}>(강한 상승) +100</span>
          </div>
        </div>

        {/* Component scores */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
          {score && [
            { label:'EMA 추세', v: score.components.ema, color:T.acl },
            { label:'일목구름', v: score.components.ichimoku, color:T.prp },
            { label:'모멘텀', v: score.momentum, color:T.ylw },
            { label:'펀딩 바이어스', v: score.fundingBias, color:'#FB923C' },
            { label:'거래량 품질', v: score.volumeQuality - 50, color:T.grn },
          ].map(c => (
            <div key={c.label} style={{ padding:'6px 8px', background:T.alt, borderRadius:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                <span style={{ color:T.muted, fontSize:9 }}>{c.label}</span>
                <span style={{ color:c.v >= 0 ? c.color : T.red, fontSize:9, fontWeight:700 }}>{c.v >= 0 ? '+' : ''}{c.v}</span>
              </div>
              <ScoreBar value={c.v} color={c.color}/>
            </div>
          ))}
          <div style={{ padding:'6px 8px', background:T.alt, borderRadius:8 }}>
            <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>변동성</div>
            <div style={{ color:volInfo.color, fontWeight:800, fontSize:11 }}>{volInfo.ko}</div>
          </div>
        </div>
      </Card>

      {/* Adjusted parameters */}
      <Card style={{ marginBottom:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>⚙️ 자동 파라미터 조정</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:10 }}>
          {[
            { label:'적용 레버리지', value:`${params.leverage}x`, color: params.leverage > 5 ? T.ylw : T.grn },
            { label:'손절폭', value:`${(params.stopLossWidth*100).toFixed(1)}%`, color:T.acl },
            { label:'목표폭', value:`${(params.takeProfitWidth*100).toFixed(1)}%`, color:T.grn },
            { label:'리스크 배율', value:`${params.riskMultiplier}x`, color: params.riskMultiplier < 0.7 ? T.red : params.riskMultiplier > 1.1 ? T.grn : T.ylw },
            { label:'숏 허용', value: params.allowShort ? '✅' : '❌', color: params.allowShort ? T.grn : T.muted },
            { label:'DCA', value: params.dcaEnabled ? '✅' : '❌', color: params.dcaEnabled ? T.grn : T.muted },
          ].map(m => (
            <div key={m.label} style={{ background:T.alt, borderRadius:8, padding:'7px 8px', textAlign:'center' }}>
              <div style={{ color:T.muted, fontSize:8, marginBottom:2 }}>{m.label}</div>
              <div style={{ color:m.color, fontWeight:800, fontSize:12 }}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* Strategy */}
        <div style={{ background: T.acl+'0D', border:`1px solid ${T.acl}25`, borderRadius:10, padding:'8px 12px', marginBottom:8 }}>
          <div style={{ color:T.acl, fontSize:10, fontWeight:700, marginBottom:2 }}>🎯 추천 전략</div>
          <div style={{ color:T.txt, fontSize:12, fontWeight:700 }}>{params.strategy}</div>
        </div>

        {/* Rationale */}
        <div>
          {params.rationale.map((r, i) => (
            <div key={i} style={{ color:T.sub, fontSize:10, padding:'2px 0', display:'flex', gap:5 }}>
              <span style={{ color:T.acl }}>→</span>{r}
            </div>
          ))}
        </div>
      </Card>

      {/* Season strategy comparison */}
      <Card style={{ marginBottom:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>📅 시즌별 전략 비교</div>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, color:T.sub }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${T.border2}` }}>
                <th style={{ textAlign:'left', padding:'4px 6px', color:T.muted }}>항목</th>
                <th style={{ textAlign:'center', padding:'4px 8px', color:'#10B981' }}>🌱 인베스트 (3~9월)</th>
                <th style={{ textAlign:'center', padding:'4px 8px', color:'#F59E0B' }}>⚡ 트레이딩 (10~2월)</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['기본 레버리지', `${SEASON_CONFIGS.INVEST.defaultLeverage}x`, `${SEASON_CONFIGS.TRADING.defaultLeverage}x`],
                ['최대 레버리지', `${SEASON_CONFIGS.INVEST.maxLeverage}x`, `${SEASON_CONFIGS.TRADING.maxLeverage}x`],
                ['손절폭', `${(SEASON_CONFIGS.INVEST.stopLossWidth*100).toFixed(0)}%`, `${(SEASON_CONFIGS.TRADING.stopLossWidth*100).toFixed(0)}%`],
                ['현물 비중', `${SEASON_CONFIGS.INVEST.spotAllocation}%`, `${SEASON_CONFIGS.TRADING.spotAllocation}%`],
                ['거래 빈도', SEASON_CONFIGS.INVEST.tradeFrequency, SEASON_CONFIGS.TRADING.tradeFrequency],
                ['숏 허용', SEASON_CONFIGS.INVEST.allowShort ? '✅' : '❌', SEASON_CONFIGS.TRADING.allowShort ? '✅' : '❌'],
                ['DCA', SEASON_CONFIGS.INVEST.dcaEnabled ? '✅' : '❌', SEASON_CONFIGS.TRADING.dcaEnabled ? '✅' : '❌'],
              ].map(([label, invest, trading]) => (
                <tr key={label} style={{ borderBottom:`1px solid ${T.border}` }}>
                  <td style={{ padding:'5px 6px', color:T.sub }}>{label}</td>
                  <td style={{ textAlign:'center', padding:'5px 8px', color:activeSeason==='INVEST'?'#10B981':T.sub, fontWeight:activeSeason==='INVEST'?700:400 }}>{invest}</td>
                  <td style={{ textAlign:'center', padding:'5px 8px', color:activeSeason==='TRADING'?'#F59E0B':T.sub, fontWeight:activeSeason==='TRADING'?700:400 }}>{trading}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Market condition guide */}
      <Card>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>🗺️ 시장 상황별 전략</div>
        {Object.entries(CONDITION_LABELS).map(([key, info]) => (
          <div key={key} style={{
            padding:'8px 10px', borderRadius:8, marginBottom:5,
            background: key === cond ? info.color+'12' : T.alt,
            border: `1px solid ${key === cond ? info.color+'50' : T.border}`,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
              <span>{info.emoji}</span>
              <span style={{ color: key === cond ? info.color : T.sub, fontWeight: key === cond ? 700 : 400, fontSize:11 }}>
                {info.ko} {key === cond && '← 현재'}
              </span>
            </div>
            <div style={{ color:T.muted, fontSize:9, lineHeight:1.5 }}>
              {key === 'STRONG_BULLISH' && '레버리지↑ · DCA 매집 · 브레이크아웃 · 롱 중심'}
              {key === 'WEAK_BULLISH'   && '풀백 롱 · 추세 추종 · 기본 레버리지'}
              {key === 'SIDEWAYS'       && '레인지 거래 · 평균회귀 · 레버리지↓'}
              {key === 'WEAK_BEARISH'   && '방어 모드 · 숏 바이어스 · 현금 비중↑'}
              {key === 'STRONG_BEARISH' && '숏 중심 · 레버리지 최소화 · 현금 보유'}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
