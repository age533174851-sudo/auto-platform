'use client';
import React, { useState, useEffect } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { getSeasonSignals, SEASON_STANCE_COLOR, SEASON_STANCE_LABEL, type SeasonSignal } from '@/lib/season/equitySeason';
import { CalendarRange, TrendingUp, Layers, AlertTriangle } from 'lucide-react';

export default function SeasonalityPage() {
  const [overheated, setOverheated] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { setNow(new Date()); }, []);

  const sig = getSeasonSignals(now, { sector: 'AI·반도체', overheated });
  const monthName = `${now.getMonth() + 1}월`;

  const SignalCard = ({ s, icon: Icon }: { s: SeasonSignal; icon: any }) => {
    const c = SEASON_STANCE_COLOR[s.stance];
    return (
      <div style={{ background: T.alt, borderRadius: 12, padding: '13px 15px', borderLeft: `3px solid ${c}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon size={15} color={c} strokeWidth={2.2} />
            <span style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{s.label}</span>
          </div>
          <span style={{ background: c + '22', color: c, fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 6 }}>
            {SEASON_STANCE_LABEL[s.stance]}
          </span>
        </div>
        <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.5 }}>{s.reason}</div>
      </div>
    );
  };

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CalendarRange size={20} color={T.acl} /> 계절성 분석
        </div>
        <div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>현재 {monthName} · 전체 시장과 섹터를 분리해서 판단</div>
      </div>

      {/* 전체 시장 */}
      <Card style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 8, letterSpacing: 0.5 }}>전체 시장 (S&P500)</div>
        <SignalCard s={sig.market} icon={TrendingUp} />
      </Card>

      {/* 섹터 */}
      <Card style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: T.muted, fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>섹터 (AI·반도체·성장주)</span>
          <button onClick={() => setOverheated(!overheated)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, background: overheated ? T.ylw + '20' : T.alt, border: `1px solid ${overheated ? T.ylw : T.border}`, borderRadius: 7, padding: '4px 10px', color: overheated ? T.ylw : T.muted, fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>
            <AlertTriangle size={11} /> 과열 {overheated ? 'ON' : 'OFF'}
          </button>
        </div>
        <SignalCard s={sig.sector} icon={Layers} />
        <div style={{ color: T.muted, fontSize: 9, marginTop: 6, lineHeight: 1.4 }}>
          전년도 급등 종목은 '과열 ON'으로 두면 11~2월 차익실현 경고가 반영됩니다.
        </div>
      </Card>

      {/* 종합 조언 */}
      <Card style={{ padding: '13px 15px', marginBottom: 10, background: T.acg }}>
        <div style={{ color: T.acl, fontWeight: 800, fontSize: 12, marginBottom: 5 }}>종합 판단</div>
        <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.6 }}>{sig.advice}</div>
      </Card>

      {/* 자동매매 주의 */}
      <div style={{ background: T.ylw + '12', border: `1px solid ${T.ylw}30`, borderRadius: 10, padding: '11px 13px' }}>
        <div style={{ color: T.ylw, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>계절성 단독 사용 금지</div>
        <div style={{ color: T.sub, fontSize: 10, lineHeight: 1.6 }}>
          계절성은 참고 지표입니다. 추세·과열도·거래량·VIX·금리·실적 일정·뉴스 감성을 함께 보고 판단하세요.
          "11~4월 강세"는 S&P500 전체 경향이고, 급등한 성장주는 1~2월 조정 가능성이 큽니다.
        </div>
      </div>
    </div>
  );
}
