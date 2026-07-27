'use client';
// TradeReplayModal — 특정 거래를 클릭하면 "왜 이 결과가 났는가"를 AI가 설명.
import React from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { X, Check, AlertTriangle, Lightbulb, TrendingDown, TrendingUp, Clock } from 'lucide-react';
import { replayTrade, type ReplayTrade } from '@/lib/autotrade/replay';
import { loadAudit } from '@/lib/autotrade/auditLog';
import { ordersToClosedTrades } from '@/lib/autotrade/retrospect';

export default function TradeReplayModal({
  trade, orders, currency = 'KRW', onClose,
}: {
  trade: ReplayTrade | null;
  orders: any[];
  currency?: string;
  onClose: () => void;
}) {
  if (!trade) return null;
  const allTrades = ordersToClosedTrades(orders);
  const r = replayTrade(trade, allTrades, loadAudit());
  const accent = r.isLoss ? T.red : T.grn;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.66)', zIndex: 10090, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto', background: T.bg, borderRadius: '22px 22px 0 0', border: `1px solid ${T.border2}`, borderBottom: 'none' }}>
        {/* 헤더 */}
        <div style={{ position: 'sticky', top: 0, background: T.bg, padding: '18px 18px 12px', borderBottom: `1px solid ${T.border}`, zIndex: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {r.isLoss ? <TrendingDown size={19} color={accent} /> : <TrendingUp size={19} color={accent} />}
              <span style={{ color: T.txt, fontWeight: 800, fontSize: 16 }}>{r.entryTime} {r.isLoss ? '손실' : '수익'} 분석</span>
            </div>
            <button onClick={onClose} aria-label="닫기" style={{ minHeight: 40, minWidth: 40, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={20} color={T.muted} /></button>
          </div>
        </div>

        <div style={{ padding: '16px 18px 28px' }}>
          {/* 결과 요약 */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, background: accent + '14', border: `1px solid ${accent}40`, borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>결과</div>
              <div style={{ color: accent, fontSize: 20, fontWeight: 900 }}>{r.resultPct >= 0 ? '+' : ''}{r.resultPct.toFixed(1)}%</div>
              <div style={{ color: accent, fontSize: 11, fontWeight: 700 }}>{r.resultAmount >= 0 ? '+' : ''}{cvt(r.resultAmount, currency)}</div>
            </div>
            <div style={{ flex: 1, background: T.card, borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>전략 · 종목</div>
              <div style={{ color: T.txt, fontSize: 14, fontWeight: 800 }}>{r.strategy}</div>
              <div style={{ color: T.muted, fontSize: 11 }}>{r.symbol}{r.holdMinutes != null ? ` · ${r.holdMinutes}분 보유` : ''}</div>
            </div>
          </div>

          {/* 서술형 분석 */}
          <div style={{ background: T.card, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
            <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>AI 분석</div>
            {r.narrative.map((line, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <span style={{ color: accent, fontWeight: 800, fontSize: 12, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ color: T.sub, fontSize: 12.5, lineHeight: 1.55 }}>{line}</span>
              </div>
            ))}
          </div>

          {/* 진입 조건 */}
          {r.conditions.length > 0 && (
            <div style={{ background: T.card, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>진입 시점 조건</div>
              {r.conditions.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                  {c.flag === 'warn' ? <AlertTriangle size={14} color={T.ylw} /> : <Check size={14} color={T.grn} />}
                  <span style={{ color: T.txt, fontSize: 12, flex: 1 }}>{c.label}</span>
                  <span style={{ color: c.flag === 'warn' ? T.ylw : T.muted, fontSize: 11, fontWeight: 600 }}>{c.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* 과거 동일조건 통계 */}
          {r.historicalWinRate != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: T.alt, borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
              <Clock size={16} color={T.muted} />
              <span style={{ color: T.sub, fontSize: 12, flex: 1 }}>동일 종목 최근 {r.historicalSample}회 승률</span>
              <span style={{ color: r.historicalWinRate >= 50 ? T.grn : T.red, fontSize: 15, fontWeight: 800 }}>{r.historicalWinRate.toFixed(0)}%</span>
            </div>
          )}

          {/* AI 제안 */}
          {r.aiSuggestion && (
            <div style={{ background: `linear-gradient(135deg,#8B5CF618,#6D28D918)`, border: `1px solid #8B5CF640`, borderRadius: 14, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <Lightbulb size={15} color="#A78BFA" />
                <span style={{ color: '#A78BFA', fontSize: 12, fontWeight: 800 }}>AI 제안{r.estImprovePct ? ` · 예상 개선 ${r.estImprovePct}%` : ''}</span>
              </div>
              <div style={{ color: T.txt, fontSize: 12.5, lineHeight: 1.6 }}>{r.aiSuggestion}</div>
            </div>
          )}

          <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 14 }}>
            모의매매 기록·AI 판단 로그를 기반으로 재구성한 분석입니다. 과거 성과가 미래를 보장하지 않습니다.
          </div>
        </div>
      </div>
    </div>
  );
}
