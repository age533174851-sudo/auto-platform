'use client';
import { A } from '@/lib/theme/colors';
import React, { useState, useEffect, useCallback } from 'react';
import { getCurrentSeasonMode, getAdjustedParams, SEASON_CONFIGS, formatSeasonMode } from '@/lib/season';
import type { MarketScore } from '@/lib/market';
import type { SeasonMode } from '@/lib/season';

// 팔레트는 공용 하나만 쓴다. 복사본을 두면 테마를 바꿨을 때
// 이 화면만 옛 색으로 남고, 그 차이를 아무도 눈치채지 못한다.
import { T } from '@/lib/constants';

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
  STRONG_BULLISH: { ko:'강한 상승세',   color:T.grn,  emoji:'' },
  WEAK_BULLISH:   { ko:'약한 상승세',   color:'#6EE7B7', emoji:'' },
  SIDEWAYS:       { ko:'횡보장',       color:T.ylw,  emoji:'' },
  WEAK_BEARISH:   { ko:'약한 하락세',   color:'#FCA5A5', emoji:'' },
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

  // ── 조회 실패를 MOCK으로 조용히 바꾸지 않는다 ──
  //
  // 예전에는 `/api/market-score`가 실패하면 `getMockMarketScore()`를
  // 넣었다. 그런데 화면 제목은 그대로 "AI 시장 분석"이다.
  //
  // **사용자는 그것이 지금 시장이라고 믿는다.** 그 점수를 보고 계절
  // 전략을 켜거나 끈다 — 실제로는 아무 데이터도 없는데.
  //
  // 조용히 틀리는 쪽이 언제나 더 나쁘다. 못 읽으면 못 읽었다고 적는다.
  const [scoreError, setScoreError] = useState('');
  const [scoreAtMs, setScoreAtMs] = useState<number | null>(null);

  const fetchScore = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/market-score', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        setScore(d);
        setScoreError('');
        setScoreAtMs(Date.now());
      } else {
        // **점수를 지우고 실패를 남긴다.** 앞 값을 남겨 두면 그것이
        // 지금 시장인 줄 알고 본다.
        setScore(null);
        setScoreError(`시장 점수를 읽지 못했습니다 (HTTP ${r.status}) — 점수가 없다는 뜻이 아닙니다`);
      }
    } catch (e: any) {
      setScore(null);
      setScoreError(`시장 점수를 읽지 못했습니다 (${String(e?.message || e)})`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mounted) fetchScore();
  }, [mounted, fetchScore]);

  // ── 자동 갱신 ──
  //
  // 예전에는 마운트할 때 한 번 + 수동 새로고침뿐이었다. 시장 점수는
  // 시간이 지나면 틀린 값이 되는데, 화면은 몇 시간 전 점수를 계속
  // 보여 준다 — 그리고 언제 것인지도 안 적혀 있었다.
  useEffect(() => {
    if (!mounted) return;
    const t = setInterval(fetchScore, 60_000);
    return () => clearInterval(t);
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
          {loading ? '분석 중…' : '새로고침'}
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
                {(Array.isArray(fmt.months) ? fmt.months : []).map(m => `${m}월`).join(' ')}
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
          <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>AI 시장 분석</div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontSize:16 }}>{condInfo.emoji}</span>
            <span style={{ color:condInfo.color, fontWeight:800, fontSize:12 }}>{condInfo.ko}</span>
          </div>
        </div>

        {/* ── 못 읽었으면 그렇다고 적는다 ──
            예전에는 실패하면 MOCK 점수를 넣었고 제목은 그대로
            "AI 시장 분석"이었다. 사용자는 그것이 지금 시장이라고 믿고
            계절 전략을 켜거나 끈다 — 실제로는 아무 데이터도 없는데. */}
        {scoreError && (
          <div style={{
            background: A(T.red, '12'), border: `1px solid ${T.red}44`,
            borderRadius: 8, padding: '8px 10px', marginBottom: 10,
            color: T.red, fontSize: 10.5, lineHeight: 1.6,
          }}>
            <b>시장 점수 확인 불가</b>
            <div style={{ color: T.muted, marginTop: 2 }}>{scoreError}</div>
          </div>
        )}

        {/* Overall score gauge */}
        <div style={{ marginBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
            <span style={{ color:T.muted, fontSize:10 }}>
              시장 점수
              {scoreAtMs != null && (
                <span style={{ marginLeft: 5, fontSize: 8.5 }}>
                  · {Math.max(0, Math.round((Date.now() - scoreAtMs) / 1000))}초 전
                </span>
              )}
            </span>
            {/* **0으로 그리지 않는다.** 0은 '중립'이라는 뜻이고,
                못 읽은 것과 전혀 다르다. */}
            <span style={{ color: score == null ? T.muted : (score.overall || 0) >= 0 ? T.grn : T.red, fontWeight:700, fontSize:12 }}>
              {score == null ? '확인 불가' : `${(score.overall ?? 0) >= 0 ? '+' : ''}${score.overall ?? 0}`}
            </span>
          </div>
          <ScoreBar value={score?.overall ?? 0} color={score == null ? T.muted : T.grn}/>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:2 }}>
            <span style={{ color:T.muted, fontSize:8 }}>-100 (강한 하락)</span>
            <span style={{ color:T.muted, fontSize:8 }}>(강한 상승) +100</span>
          </div>
        </div>

        {/* Component scores */}
        {/* className이 두 번 있었다. 뒤엣것이 이기므로 **mobile-1col이
            조용히 버려져** 모바일 1단 레이아웃이 안 먹고 있었다.
            오류도 경고도 없이 스타일 하나가 사라지는 모양이다. */}
        <div className="mobile-1col season-grid" style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:6 }}>
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
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>자동 파라미터 조정</div>
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
        <div style={{ background: A(T.acl,'0D'), border:`1px solid ${A(T.acl,'25')}`, borderRadius:10, padding:'8px 12px', marginBottom:8 }}>
          <div style={{ color:T.acl, fontSize:10, fontWeight:700, marginBottom:2 }}>추천 전략</div>
          <div style={{ color:T.txt, fontSize:12, fontWeight:700 }}>{params.strategy}</div>
        </div>

        {/* Rationale */}
        <div>
          {(Array.isArray(params.rationale) ? params.rationale : []).map((r, i) => (
            <div key={i} style={{ color:T.sub, fontSize:10, padding:'2px 0', display:'flex', gap:5 }}>
              <span style={{ color:T.acl }}>→</span>{r}
            </div>
          ))}
        </div>
      </Card>

      {/* Season strategy comparison */}
      <Card style={{ marginBottom:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>시즌별 전략 비교</div>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, color:T.sub }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${T.border2}` }}>
                <th style={{ textAlign:'left', padding:'4px 6px', color:T.muted }}>항목</th>
                <th style={{ textAlign:'center', padding:'4px 8px', color:'#10B981' }}>인베스트 (3~9월)</th>
                <th style={{ textAlign:'center', padding:'4px 8px', color:'#F59E0B' }}>트레이딩 (10~2월)</th>
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
