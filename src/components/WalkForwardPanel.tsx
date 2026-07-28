'use client';
// WalkForwardPanel — 진짜 엣지 vs 과최적화 판별.
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import { FlaskConical, ShieldCheck, AlertTriangle, Layers } from 'lucide-react';
import { runWalkForward, generate5v5Candidates, sweepParams, type WalkForwardResult, type SweepRow } from '@/lib/backtest/walkForward';
import type { DailyBar } from '@/lib/backtest/dailyStrategyBacktest';

function makeDaily(n: number, seed: number): DailyBar[] {
  const out: DailyBar[] = []; let p = 65000; let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s % 2147483648) / 2147483648; };
  let d = 0;
  while (d < n) {
    const len = 20 + Math.floor(rnd() * 60), roll = rnd();
    const drift = roll < 0.30 ? 0.003 + rnd() * 0.004 : roll < 0.55 ? -(0.003 + rnd() * 0.004)
      : roll < 0.85 ? (rnd() - 0.5) * 0.0008 : (rnd() - 0.5) * 0.006;
    const vol = roll < 0.85 ? 0.015 + rnd() * 0.02 : 0.04 + rnd() * 0.04;
    for (let i = 0; i < len && d < n; i++, d++) {
      const r = drift + (rnd() - 0.5) * 2 * vol;
      const open = p, close = Math.max(1, p * (1 + r));
      out.push({ t: d, open, close, high: Math.max(open, close) * (1 + vol * 0.5 * rnd()), low: Math.min(open, close) * (1 - vol * 0.5 * rnd()), volume: 800 + rnd() * 1200 });
      p = close;
    }
  }
  return out;
}

const RISK_META = {
  low: { label: '낮음', color: '#22C55E', icon: ShieldCheck },
  medium: { label: '보통', color: '#F59E0B', icon: AlertTriangle },
  high: { label: '높음', color: '#EF4444', icon: AlertTriangle },
};

export default function WalkForwardPanel() {
  const [years, setYears] = useState(8);
  const [folds, setFolds] = useState(4);
  const [computing, setComputing] = useState(false);
  const [wf, setWf] = useState<WalkForwardResult | null>(null);
  const [sweep, setSweep] = useState<SweepRow[] | null>(null);

  const run = () => {
    setComputing(true);
    setTimeout(() => {
      try {
        const daily = makeDaily(years * 365, 7);
        const cands = generate5v5Candidates();
        setSweep(sweepParams(daily, cands).slice(0, 5));
        setWf(runWalkForward(daily, cands, { folds, inSampleRatio: 0.7 }));
      } finally { setComputing(false); }
    }, 30);
  };

  const meta = wf ? RISK_META[wf.overfittingRisk] : null;
  const RiskIcon = meta?.icon ?? ShieldCheck;

  return (
    <div style={{ background: 'linear-gradient(145deg,var(--t-card),var(--t-bg))', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#06B6D41F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <FlaskConical size={18} color="#22D3EE" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>워크포워드 검증</div>
          <div style={{ color: T.muted, fontSize: 11 }}>진짜 엣지 vs 과최적화 구분</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 14, lineHeight: 1.45 }}>
        데이터를 학습·검증 구간으로 나눠, 학습에서 찾은 최적값이 검증에서도 유지되는지 확인합니다. 두 구간의 차이가 곡선맞추기의 크기입니다.
      </div>

      <div style={{ background: T.card, borderRadius: 10, padding: '12px', marginBottom: 12 }}>
        {[['데이터 기간', years, 2, 16, 1, setYears, `${years}년`],
          ['폴드 수', folds, 3, 8, 1, setFolds, `${folds}개`]].map(([l, v, min, max, st, setter, disp]: any) => (
          <div key={l} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: T.muted, fontSize: 10 }}>{l}</span>
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{disp}</span>
            </div>
            <input type="range" min={min} max={max} step={st} value={v}
              onChange={e => setter(Number(e.target.value))} style={{ width: '100%', accentColor: '#22D3EE' }} />
          </div>
        ))}
        <button onClick={run} disabled={computing}
          style={{ width: '100%', minHeight: 42, marginTop: 4, background: computing ? T.alt : 'linear-gradient(135deg,#06B6D4,#0891B2)', color: computing ? T.muted : '#fff', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: computing ? 'wait' : 'pointer' }}>
          {computing ? '검증 중… (45개 조합 × 폴드)' : '검증 실행'}
        </button>
      </div>

      {wf && meta && (
        <>
          <div style={{ background: meta.color + '12', border: `1px solid ${meta.color}30`, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <RiskIcon size={16} color={meta.color} />
              <span style={{ color: T.txt, fontSize: 12.5, fontWeight: 800 }}>과최적화 위험: {meta.label}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
              <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>학습 구간</div>
                <div style={{ color: T.sub, fontSize: 14, fontWeight: 800 }}>{wf.avgInSample >= 0 ? '+' : ''}{wf.avgInSample.toFixed(3)}R</div>
              </div>
              <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>검증 구간</div>
                <div style={{ color: wf.avgOutSample > 0 ? T.grn : T.red, fontSize: 14, fontWeight: 800 }}>{wf.avgOutSample >= 0 ? '+' : ''}{wf.avgOutSample.toFixed(3)}R</div>
              </div>
              <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>일관성</div>
                <div style={{ color: wf.consistency >= 60 ? T.grn : T.ylw, fontSize: 14, fontWeight: 800 }}>{wf.consistency.toFixed(0)}%</div>
              </div>
            </div>
            <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.45, marginBottom: 7 }}>{wf.verdict}</div>
            <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.45 }}>{wf.recommendation}</div>
          </div>

          {/* 폴드별 */}
          <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
              <Layers size={13} color={T.acl} />
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>폴드별 결과</span>
            </div>
            <div style={{ display: 'flex', fontSize: 9, color: T.muted, padding: '0 2px 5px', borderBottom: `1px solid ${T.border}` }}>
              <span style={{ width: 26 }}>폴드</span>
              <span style={{ flex: 1, textAlign: 'right' }}>학습</span>
              <span style={{ flex: 1, textAlign: 'right' }}>검증</span>
              <span style={{ width: 100, textAlign: 'right' }}>파라미터</span>
            </div>
            {wf.folds.map(f => (
              <div key={f.foldIndex} style={{ display: 'flex', fontSize: 10.5, padding: '6px 2px', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ width: 26, color: T.muted }}>F{f.foldIndex}</span>
                <span style={{ flex: 1, textAlign: 'right', color: T.sub }}>{f.inSampleExpectancy >= 0 ? '+' : ''}{f.inSampleExpectancy.toFixed(3)}</span>
                <span style={{ flex: 1, textAlign: 'right', color: f.outSampleExpectancy > 0 ? T.grn : T.red }}>{f.outSampleExpectancy >= 0 ? '+' : ''}{f.outSampleExpectancy.toFixed(3)}</span>
                <span style={{ width: 100, textAlign: 'right', color: T.muted, fontSize: 9.5 }}>{f.bestParamLabel}</span>
              </div>
            ))}
          </div>

          {/* 단순 스윕 비교 */}
          {sweep && (
            <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 10 }}>
              <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>단순 스윕 상위 (검증 없음)</div>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 8 }}>이 값을 그대로 쓰면 곡선맞추기입니다 — 위 검증 결과와 비교하세요</div>
              {sweep.map(r => (
                <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 10.5 }}>
                  <span style={{ color: T.muted, width: 96 }}>{r.label}</span>
                  <span style={{ color: r.expectancyR > 0 ? T.grn : T.red, flex: 1 }}>{r.expectancyR >= 0 ? '+' : ''}{r.expectancyR.toFixed(3)}R</span>
                  <span style={{ color: T.muted }}>{r.trades}거래 · 진입 {r.tradeRate.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!wf && !computing && (
        <div style={{ color: T.muted, fontSize: 11.5, textAlign: 'center', padding: '14px 0' }}>
          검증을 실행하면 어떤 파라미터가 진짜 엣지이고 어떤 게 곡선맞추기인지 알 수 있습니다.
        </div>
      )}
    </div>
  );
}
