'use client';
// StrategyProfilesPanel — 고위험 단타 / 저위험 스윙 프로필을 분리 표시.
// 규칙 엔진(buildOrder)으로 프로필 한도 내 주문을 만들고, 프로필별 격리 리스크
// (PnL·MDD·일손실·킬스위치)를 독립 추적. 각 프로필 성적표(표본수 n 포함) 표시.
import React, { useState, useCallback } from 'react';
import { T } from '@/lib/constants';
import { listProfiles, type StrategyProfile, type StrategyType } from '@/lib/strategies/profiles';
import { buildOrder, type Signal } from '@/lib/strategies/ruleEngine';
import {
  loadProfileRisk, recordProfileTrade, canProfileEnter,
  resetProfileKill, resetProfileRisk, winRate, type ProfileRiskState,
} from '@/lib/strategies/profileRisk';

const AI_SOURCES = ['claude', 'gpt', 'gemini', 'grok'];
const SIM_PRICE = 140_000_000;

export default function StrategyProfilesPanel() {
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const showToast = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(''), 2600); }, []);
  void tick;

  // 규칙 엔진으로 1건 시뮬 진입→청산 (프로필 한도 적용 + 격리 기록)
  const simTrade = (p: StrategyProfile) => {
    const can = canProfileEnter(p.id);
    if (!can.allowed) { showToast(`${p.label} 진입 차단: ${can.reason}`); return; }
    const eq = loadProfileRisk(p.id).equity;
    const sig: Signal = {
      bias: Math.random() > 0.5 ? 'long' : 'short',
      desiredLeverage: p.maxLeverage + 20,   // 일부러 상한 초과 요구 → clamp 확인
      aiSource: AI_SOURCES[Math.floor(Math.random() * AI_SOURCES.length)],
    };
    const built = buildOrder({ signal: sig, profile: p, equityKRW: eq, price: SIM_PRICE });
    if (!built.ok) { showToast(`주문 거부: ${built.reason}`); return; }
    // 무작위 승패: 익절(+TP%) 또는 손절(-SL%) — notional 기준(레버리지 반영)
    const win = Math.random() < 0.5;
    const pnlPct = win ? p.takeProfitPct : -p.stopLossPct;
    const pnl = Math.round(built.order.notionalKRW * (pnlPct / 100));
    const s = recordProfileTrade(p.id, pnl);
    showToast(`${p.label}: ${sig.bias} ${built.order.leverage}x → ${win ? '익절' : '손절'} ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString('ko-KR')}원`);
    if (s.killed) showToast(`⛔ ${p.label} 킬스위치: ${s.killedReason}`);
    refresh();
  };

  const box: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginBottom: 12 };
  const chip = (label: string, val: string, c = T.txt) => (
    <div style={{ background: T.alt, borderRadius: 8, padding: '6px 8px' }}>
      <div style={{ fontSize: 8, color: T.muted }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: c }}>{val}</div>
    </div>
  );
  const btn = (bg: string): React.CSSProperties => ({ padding: '7px 10px', borderRadius: 8, border: 'none', background: bg, color: '#fff', fontSize: 11, fontWeight: 800, cursor: 'pointer' });

  return (
    <div>
      {toast && <div style={{ position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 9999, background: '#111', color: '#fff', padding: '10px 16px', borderRadius: 10, fontSize: 12, fontWeight: 700, maxWidth: '90vw', textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>{toast}</div>}

      <div style={{ fontSize: 14, fontWeight: 800, color: T.txt, marginBottom: 10 }}>⚙️ 전략 프로필 (포트폴리오 봇)</div>

      {listProfiles().map(p => {
        const s: ProfileRiskState = loadProfileRisk(p.id);
        const isScalp = p.id === 'SCALP_HIGH_LEV';
        const accent = isScalp ? T.red : T.grn;
        return (
          <div key={p.id} style={box}>
            {/* 헤더 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: T.txt }}>{p.label}</span>
                <span style={{ background: accent + '20', color: accent, fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>{isScalp ? 'HIGH LEV' : 'LOW LEV'}</span>
                {s.killed && <span style={{ background: T.red, color: '#fff', fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>KILLED</span>}
              </div>
            </div>

            {/* 프로필 파라미터 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 8 }}>
              {chip('레버리지', `${p.leverage}~${p.maxLeverage}x`, accent)}
              {chip('자산비중', `${p.maxPortfolioPct}%`)}
              {chip('1회위험', `${p.riskPercentPerTrade}%`)}
              {chip('마진', p.marginModes.join('/'))}
              {chip('익절', `${p.takeProfitPct}%`)}
              {chip('손절', `${p.stopLossPct}%`)}
              {chip('주문', p.orderType === 'post_only_limit' ? 'PostOnly' : p.orderType === 'limit' ? '지정가' : '시장가')}
              {chip('일손실한도', `${p.dailyLossLimitPct}%`)}
            </div>

            {/* 프로필별 격리 성적표 */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 9, color: T.muted, marginBottom: 6 }}>성적표 (이 프로필 전용 계좌 · 표본 n={s.tradeCount})</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                {chip('누적손익', `${s.realizedPnL >= 0 ? '+' : ''}${Math.round(s.realizedPnL).toLocaleString('ko-KR')}`, s.realizedPnL >= 0 ? T.grn : T.red)}
                {chip('승률', s.tradeCount > 0 ? `${winRate(s).toFixed(0)}% (${s.winCount}/${s.tradeCount})` : '-')}
                {chip('MDD', `-${s.maxDrawdown.toFixed(1)}%`, T.red)}
                {chip('오늘손익', `${s.dayPnL >= 0 ? '+' : ''}${Math.round(s.dayPnL).toLocaleString('ko-KR')}`, s.dayPnL >= 0 ? T.grn : T.red)}
              </div>
              {s.tradeCount < 20 && s.tradeCount > 0 && (
                <div style={{ fontSize: 8, color: T.muted, marginTop: 5 }}>⚠️ 표본 {s.tradeCount}건 — 20건 미만은 우연일 수 있음 (승률 신뢰 낮음)</div>
              )}
              {s.killed && <div style={{ fontSize: 9, color: T.red, marginTop: 5 }}>⛔ {s.killedReason}</div>}
            </div>

            {/* 액션 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => simTrade(p)} style={btn(accent)} disabled={s.killed} >모의 진입 시뮬 (규칙엔진)</button>
              {s.killed && <button onClick={() => { resetProfileKill(p.id); refresh(); showToast('킬스위치 해제'); }} style={btn(T.muted)}>킬스위치 해제</button>}
              <button onClick={() => { resetProfileRisk(p.id); refresh(); showToast(`${p.label} 계좌 리셋`); }} style={btn(T.alt2 || '#334155')}>계좌 리셋</button>
            </div>

            <div style={{ fontSize: 9, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>{p.description}</div>
          </div>
        );
      })}

      <div style={{ ...box, background: T.alt }}>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
          <b style={{ color: T.txt }}>규칙 엔진 원칙:</b> AI/신호는 방향·국면만 제시하고, 레버리지·수량·손절은 프로필이 강제합니다.
          AI가 상한을 초과 요구해도 자동 clamp됩니다 (예: 100x 요청 → 스캘핑 50x로 제한).
          두 프로필의 <b style={{ color: T.txt }}>포지션·손익·MDD·킬스위치는 완전히 분리</b>되어, 한쪽이 정지돼도 다른 쪽은 계속 운용됩니다.
        </div>
      </div>
    </div>
  );
}
