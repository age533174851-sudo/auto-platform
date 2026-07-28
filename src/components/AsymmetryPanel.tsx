'use client';
import { A } from '@/lib/theme/colors';
// AsymmetryPanel — "손실은 고정, 이익은 열어둔다".
// 배율로 비대칭을 만들려는 시도가 왜 실패하는지, 진짜 비대칭이 어디서 나오는지 보여준다.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Scale, TrendingUp, AlertTriangle, Infinity as InfinityIcon } from 'lucide-react';
import { comparePayoff, initPosition, processBar, rToPrice, type AsymmetricConfig } from '@/lib/engine/asymmetricExit';

const MMR = 0.005;

export default function AsymmetryPanel() {
  const [leverage, setLeverage] = useState(10);
  const [targetPct, setTargetPct] = useState(5);
  const [winRate, setWinRate] = useState(40);
  const [peakR, setPeakR] = useState(12);

  // 배율로 비대칭 만들기 시도 → 기대값 계산
  const levAnalysis = useMemo(() => {
    const liqDist = (1 / leverage - MMR) * 100;
    const pWin = liqDist / (targetPct + liqDist);
    const gain = targetPct * leverage;
    const ev = pWin * gain - (1 - pWin) * 100;
    return { liqDist, pWin: pWin * 100, gain, ev };
  }, [leverage, targetPct]);

  // 비대칭 청산 시뮬
  const sim = useMemo(() => {
    const cfg: AsymmetricConfig = {
      side: 'LONG', entryPrice: 65000, stopPrice: 64350, quantity: 1,
      breakEvenAtR: 1, trailStartR: 2, trailDistanceR: 1,
    };
    let st = initPosition(cfg);
    const events: string[] = [];
    const path: number[] = [];
    for (let r = 0.5; r <= peakR; r += 0.7) path.push(r);
    path.push(peakR, peakR - 1.5);
    path.forEach((r, i) => {
      const px = rToPrice(cfg, r);
      const res = processBar(cfg, st, { high: px, low: px * 0.9985, close: px }, i);
      st = res.state;
      res.actions.forEach(a => { if (a.closeQty > 0 || a.note.includes('트레일링 시작') || a.note.includes('본전')) events.push(a.note); });
    });
    return { realizedR: st.realizedR, highWaterR: st.highWaterR, events };
  }, [peakR]);

  const payoff = useMemo(() => comparePayoff(winRate / 100, 2, Math.max(3, peakR * 0.6)), [winRate, peakR]);
  const evColor = levAnalysis.ev >= 0 ? T.grn : T.red;

  return (
    <div style={{ background: 'linear-gradient(145deg,var(--t-card),var(--t-bg))', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#22C55E1F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Scale size={18} color="#4ADE80" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>비대칭 손익 구조</div>
          <div style={{ color: T.muted, fontSize: 11 }}>손실은 고정, 이익은 열어둔다</div>
        </div>
      </div>

      {/* 배율로 비대칭? */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>① 배율을 올리면 비대칭이 생길까?</div>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 10 }}>손실은 증거금(-100%)으로 막히고 이익은 배율만큼 커진다 — 겉보기엔 유리해 보인다</div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: T.muted, fontSize: 10 }}>배율</span>
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{leverage}배</span>
            </div>
            <input type="range" min={2} max={100} step={1} value={leverage}
              onChange={e => setLeverage(Number(e.target.value))} style={{ width: '100%', accentColor: '#4ADE80' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: T.muted, fontSize: 10 }}>목표 상승</span>
              <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{targetPct}%</span>
            </div>
            <input type="range" min={1} max={20} step={1} value={targetPct}
              onChange={e => setTargetPct(Number(e.target.value))} style={{ width: '100%', accentColor: '#4ADE80' }} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 8 }}>
          {[
            ['도달 시 수익', `+${levAnalysis.gain.toFixed(0)}%`, T.grn],
            ['최대 손실', '-100%', T.red],
            ['청산까지', `${levAnalysis.liqDist.toFixed(2)}%`, levAnalysis.liqDist < 2 ? T.red : T.sub],
            ['도달 확률', `${levAnalysis.pWin.toFixed(1)}%`, levAnalysis.pWin < 30 ? T.red : T.sub],
          ].map(([l, v, c]) => (
            <div key={l as string} style={{ background: T.alt, borderRadius: 8, padding: '7px 10px' }}>
              <div style={{ color: T.muted, fontSize: 9 }}>{l}</div>
              <div style={{ color: c as string, fontSize: 14, fontWeight: 800 }}>{v}</div>
            </div>
          ))}
        </div>

        <div style={{ background: evColor + '12', border: `1px solid ${evColor}30`, borderRadius: 9, padding: '10px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: T.sub, fontSize: 11.5 }}>1회 기대값</span>
            <span style={{ color: evColor, fontSize: 16, fontWeight: 900 }}>{levAnalysis.ev >= 0 ? '+' : ''}{levAnalysis.ev.toFixed(1)}%</span>
          </div>
          <div style={{ color: T.muted, fontSize: 10, marginTop: 5, lineHeight: 1.4 }}>
            {leverage >= 50
              ? `+${levAnalysis.gain.toFixed(0)}%를 먹으려면 그 전에 ${levAnalysis.liqDist.toFixed(2)}% 역방향을 안 건드려야 합니다. 도달 확률 ${levAnalysis.pWin.toFixed(0)}%.`
              : `배율을 올리면 이익도 손실도 같이 커지고, 청산 거리가 짧아져 도달 확률이 떨어집니다.`}
          </div>
        </div>
      </div>

      {/* 진짜 비대칭 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <InfinityIcon size={13} color={T.grn} />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>② 진짜 비대칭은 청산 구조에서 나온다</span>
        </div>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 10 }}>
          손절은 진입 시 고정하고 절대 넓히지 않는다 · 일부는 분할 익절로 확보 · 나머지는 트레일링으로 상단을 연다
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: T.muted, fontSize: 10 }}>만난 추세 크기</span>
            <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{peakR}R</span>
          </div>
          <input type="range" min={2} max={30} step={1} value={peakR}
            onChange={e => setPeakR(Number(e.target.value))} style={{ width: '100%', accentColor: '#4ADE80' }} />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, background: T.alt, borderRadius: 9, padding: '9px 11px' }}>
            <div style={{ color: T.muted, fontSize: 9.5 }}>고정 익절 2R</div>
            <div style={{ color: T.sub, fontSize: 15, fontWeight: 900 }}>+2.00R</div>
          </div>
          <div style={{ flex: 1, background: A(T.grn,'14'), border: `1px solid ${A(T.grn,'30')}`, borderRadius: 9, padding: '9px 11px' }}>
            <div style={{ color: T.muted, fontSize: 9.5 }}>비대칭 (트레일링)</div>
            <div style={{ color: T.grn, fontSize: 15, fontWeight: 900 }}>+{sim.realizedR.toFixed(2)}R</div>
          </div>
        </div>

        {sim.events.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {sim.events.slice(0, 4).map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '2px 0' }}>
                <span style={{ width: 4, height: 4, borderRadius: '50%', background: T.grn, flexShrink: 0, marginTop: 6 }} />
                <span style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.4 }}>{e}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: T.alt, borderRadius: 8, padding: '9px 11px' }}>
          <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.45 }}>
            손실은 어느 쪽이든 <b style={{ color: T.red }}>-1R로 동일</b>합니다. 차이는 이익 쪽에서만 생깁니다.
          </span>
        </div>
      </div>

      {/* 기대값 비교 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>③ 승률이 낮아도 기대값이 높아진다</div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: T.muted, fontSize: 10 }}>승률</span>
            <span style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{winRate}%</span>
          </div>
          <input type="range" min={25} max={70} step={1} value={winRate}
            onChange={e => setWinRate(Number(e.target.value))} style={{ width: '100%', accentColor: '#4ADE80' }} />
        </div>
        {payoff.map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: i === 0 ? `1px solid ${T.border}` : 'none' }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: T.txt, fontSize: 11.5, fontWeight: 700 }}>{p.label}</div>
              <div style={{ color: T.muted, fontSize: 9.5 }}>승률 {p.winRate.toFixed(0)}% · 평균 +{p.avgWinR.toFixed(1)}R</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: p.expectancyR >= 0 ? T.grn : T.red, fontSize: 14, fontWeight: 900 }}>
                {p.expectancyR >= 0 ? '+' : ''}{p.expectancyR.toFixed(2)}R
              </div>
              <div style={{ color: T.muted, fontSize: 9 }}>PF {p.profitFactor.toFixed(2)}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: '#F59E0B10', borderRadius: 10, padding: '11px 13px' }}>
        <AlertTriangle size={14} color="#F59E0B" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.5 }}>
          트레일링은 승률을 낮춥니다 — 되돌림에 걸려 일찍 나오는 경우가 늘어납니다.
          대신 큰 추세를 만났을 때 상한 없이 따라갑니다. 손절을 나중에 넓히면 이 구조 전체가 무너집니다.
        </span>
      </div>
    </div>
  );
}
