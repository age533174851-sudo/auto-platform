'use client';
// ChallengePanel — 3개월 챌린지 시뮬레이터.
// 목표는 측정 기준이지 달성 대상이 아니다. 위험 규칙은 목표와 무관하게 유지된다.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Trophy, TrendingUp, AlertTriangle, Calculator } from 'lucide-react';
import { runChallenge, requiredEdge } from '@/lib/backtest/challengeSimulator';

export default function ChallengePanel() {
  const [horizon, setHorizon] = useState(90);
  const [runs, setRuns] = useState(200);
  const [minMargin, setMinMargin] = useState(12);
  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof runChallenge> | null>(null);

  const run = () => {
    setComputing(true);
    // 무거운 계산이므로 다음 프레임에
    setTimeout(() => {
      try {
        setResult(runChallenge({ runs, horizonDays: horizon, startCapital: 100, targetCapital: 100000, minMargin, maxLeverage: 100 }));
      } finally { setComputing(false); }
    }, 30);
  };

  const edge = useMemo(() => result
    ? requiredEdge(100, 100000, horizon, result.medianExpectancyR, 10)
    : null, [result, horizon]);

  const successColor = !result ? T.muted
    : result.successPct >= 50 ? T.grn : result.successPct >= 10 ? T.ylw : T.red;

  return (
    <div style={{ background: 'linear-gradient(145deg,var(--t-card),var(--t-bg))', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#EAB3081F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Trophy size={18} color="#FBBF24" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>챌린지 시뮬레이터</div>
          <div style={{ color: T.muted, fontSize: 11 }}>$100 → $100,000 달성 확률 측정</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 14, lineHeight: 1.45 }}>
        목표에 맞추려고 레버리지나 위험을 올리지 않습니다. 진입 조건과 위험 제한은 그대로 두고, 다양한 시장 국면에서 수백 번 돌려 분포를 봅니다.
      </div>

      {/* 설정 */}
      <div style={{ background: T.card, borderRadius: 10, padding: '12px', marginBottom: 12 }}>
        {[
          ['기간', horizon, 30, 365, 30, setHorizon, `${horizon}일`],
          ['반복 횟수', runs, 50, 500, 50, setRuns, `${runs}회`],
          ['최소 우위', minMargin, 5, 30, 1, setMinMargin, `${minMargin}점`],
        ].map(([label, val, min, max, step, setter, disp]: any) => (
          <div key={label} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: T.muted, fontSize: 10 }}>{label}</span>
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{disp}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={val}
              onChange={e => setter(Number(e.target.value))} style={{ width: '100%', accentColor: '#FBBF24' }} />
          </div>
        ))}
        <button onClick={run} disabled={computing}
          style={{ width: '100%', minHeight: 42, marginTop: 4, background: computing ? T.alt : 'linear-gradient(135deg,#F59E0B,#D97706)', color: computing ? T.muted : '#fff', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: computing ? 'wait' : 'pointer' }}>
          {computing ? '계산 중…' : '시뮬레이션 실행'}
        </button>
      </div>

      {result && (
        <>
          {/* 핵심 결과 */}
          <div style={{ background: successColor + '12', border: `1px solid ${successColor}30`, borderRadius: 12, padding: '14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ color: T.muted, fontSize: 11 }}>{result.runs}회 중 목표 달성</span>
              <span style={{ color: successColor, fontSize: 22, fontWeight: 900 }}>{result.successPct.toFixed(1)}%</span>
            </div>
            <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ width: `${result.successPct}%`, background: T.grn }} />
              <div style={{ width: `${result.survivedPct}%`, background: T.border2 }} />
              <div style={{ width: `${result.bustPct}%`, background: T.red }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
              <span style={{ color: T.grn }}>달성 {result.successPct.toFixed(1)}%</span>
              <span style={{ color: T.muted }}>생존 {result.survivedPct.toFixed(1)}%</span>
              <span style={{ color: T.red }}>파산 {result.bustPct.toFixed(1)}%</span>
            </div>
          </div>

          {/* 자본 분포 — 평균이 아니라 분위수 */}
          <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
            <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 9 }}>{horizon}일 후 자본 분포</div>
            {[
              ['하위 10%', result.p10Capital, T.red],
              ['중간값', result.medianCapital, T.sub],
              ['상위 10%', result.p90Capital, T.grn],
              ['최고', result.bestCapital, T.acl],
            ].map(([l, v, c]) => (
              <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ color: T.muted, fontSize: 11 }}>{l}</span>
                <span style={{ color: c as string, fontSize: 12.5, fontWeight: 800 }}>${(v as number).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
            ))}
            <div style={{ color: T.muted, fontSize: 10, marginTop: 8, lineHeight: 1.4 }}>
              평균이 아니라 분위수를 봅니다. 운 좋은 한 번의 결과에 속지 않기 위해서입니다.
            </div>
          </div>

          {/* 단계별 도달 */}
          <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
            <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 9 }}>단계별 도달률</div>
            {result.milestones.map(m => (
              <div key={m.level} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                <span style={{ color: T.sub, fontSize: 11, width: 68 }}>${m.level.toLocaleString()}</span>
                <div style={{ flex: 1, height: 6, background: T.alt, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${m.reachedPct}%`, background: m.reachedPct > 0 ? '#FBBF24' : 'transparent' }} />
                </div>
                <span style={{ color: m.reachedPct > 0 ? T.txt : T.muted, fontSize: 11, fontWeight: 700, width: 44, textAlign: 'right' }}>{m.reachedPct.toFixed(1)}%</span>
              </div>
            ))}
          </div>

          {/* 위험 지표 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 12 }}>
            {[
              ['최대낙폭 (중간)', `${result.medianMaxDrawdownPct.toFixed(1)}%`, T.sub],
              ['최대낙폭 (최악)', `${result.worstMaxDrawdownPct.toFixed(1)}%`, T.red],
              ['연속손실 (중간)', `${result.medianWorstStreak}회`, T.sub],
              ['연속손실 (최악)', `${result.worstStreak}회`, result.worstStreak >= 10 ? T.red : T.ylw],
              ['승률', `${result.medianWinRate.toFixed(1)}%`, T.sub],
              ['기대값', `${result.medianExpectancyR >= 0 ? '+' : ''}${result.medianExpectancyR.toFixed(3)}R`, result.medianExpectancyR > 0 ? T.grn : T.red],
            ].map(([l, v, c]) => (
              <div key={l as string} style={{ background: T.card, borderRadius: 9, padding: '9px 11px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>{l}</div>
                <div style={{ color: c as string, fontSize: 13, fontWeight: 800 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* 필요한 엣지 역산 */}
          {edge && (
            <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
                <Calculator size={13} color={T.acl} />
                <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>필요한 엣지 역산</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
                <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ color: T.muted, fontSize: 9 }}>필요 일일</div>
                  <div style={{ color: T.ylw, fontSize: 14, fontWeight: 800 }}>{edge.requiredDailyPct.toFixed(2)}%</div>
                </div>
                <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ color: T.muted, fontSize: 9 }}>필요 기대값</div>
                  <div style={{ color: T.ylw, fontSize: 14, fontWeight: 800 }}>+{edge.requiredExpectancyR.toFixed(2)}R</div>
                </div>
                <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ color: T.muted, fontSize: 9 }}>현재</div>
                  <div style={{ color: edge.currentExpectancyR > 0 ? T.grn : T.red, fontSize: 14, fontWeight: 800 }}>
                    {edge.currentExpectancyR >= 0 ? '+' : ''}{edge.currentExpectancyR.toFixed(3)}R
                  </div>
                </div>
              </div>
              <div style={{ background: T.alt, borderRadius: 8, padding: '9px 11px' }}>
                <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.45 }}>{edge.note}</span>
              </div>
            </div>
          )}

          {/* 판정 */}
          <div style={{ background: successColor + '10', borderRadius: 10, padding: '11px 13px', marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginBottom: 7 }}>
              <TrendingUp size={13} color={successColor} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.45 }}>{result.verdict}</span>
            </div>
            <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
              <AlertTriangle size={13} color={T.ylw} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.45 }}>{result.honestNote}</span>
            </div>
          </div>
        </>
      )}

      {!result && !computing && (
        <div style={{ color: T.muted, fontSize: 11.5, textAlign: 'center', padding: '14px 0' }}>
          시뮬레이션을 실행하면 달성 확률·파산률·자본 분포를 확인할 수 있습니다.
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 4 }}>
        생성된 시장 데이터 기준입니다. 실제 시장은 다르게 움직이며, 과거 성과가 미래를 보장하지 않습니다.
      </div>
    </div>
  );
}
