'use client';
// TradeRetrospect — 실제 매매 기록 AI 복기. 조건별 손실 패턴 경고 + 강점.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { Brain, AlertTriangle, CheckCircle2, TrendingUp } from 'lucide-react';
import { analyzeTrades, ordersToClosedTrades } from '@/lib/autotrade/retrospect';

const PAPER_KEY = 'tg_paper_account_v1';

export default function TradeRetrospect({ currency = 'KRW' }: { currency?: string }) {
  const [orders, setOrders] = useState<any[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PAPER_KEY);
      if (raw) { const acc = JSON.parse(raw); setOrders(Array.isArray(acc?.orders) ? acc.orders : []); }
    } catch {}
  }, []);

  const result = useMemo(() => analyzeTrades(ordersToClosedTrades(orders)), [orders]);

  const sevColor = (s: string) => s === 'high' ? T.red : s === 'medium' ? T.ylw : T.muted;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brain size={18} color="#A78BFA" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 매매 복기</div>
          <div style={{ color: T.muted, fontSize: 11 }}>내 매매 패턴을 분석해 약점을 짚어드려요</div>
        </div>
      </div>

      {/* 요약 지표 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>분석 매매</div>
          <div style={{ color: T.txt, fontSize: 16, fontWeight: 800 }}>{result.totalTrades}건</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>승률</div>
          <div style={{ color: result.winRate >= 50 ? T.grn : T.red, fontSize: 16, fontWeight: 800 }}>{result.winRate.toFixed(0)}%</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ color: T.muted, fontSize: 10 }}>평균 손익</div>
          <div style={{ color: result.avgWin + result.avgLoss >= 0 ? T.grn : T.red, fontSize: 13, fontWeight: 800 }}>
            {result.avgWin > 0 ? cvt(result.avgWin, currency) : '—'}
          </div>
        </div>
      </div>

      {/* 조건별 경고 */}
      {result.warnings.length > 0 ? (
        <div style={{ marginBottom: result.strengths.length ? 14 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
            <AlertTriangle size={13} color={T.ylw} /> 발견된 약점 패턴 ({result.warnings.length})
          </div>
          {result.warnings.map((w, i) => (
            <div key={i} style={{ background: sevColor(w.severity) + '10', border: `1px solid ${sevColor(w.severity)}30`, borderRadius: 12, padding: '11px 13px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: sevColor(w.severity), flexShrink: 0 }} />
                <span style={{ color: T.txt, fontSize: 12.5, fontWeight: 800 }}>{w.title}</span>
              </div>
              <div style={{ color: sevColor(w.severity), fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{w.stat}</div>
              <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5 }}>{w.detail}</div>
            </div>
          ))}
        </div>
      ) : result.totalTrades >= 5 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: T.grn + '12', borderRadius: 10, padding: '11px 14px', marginBottom: result.strengths.length ? 14 : 0 }}>
          <CheckCircle2 size={16} color={T.grn} />
          <span style={{ color: T.txt, fontSize: 12 }}>뚜렷한 약점 패턴이 감지되지 않았어요. 좋습니다.</span>
        </div>
      ) : (
        <div style={{ color: T.muted, fontSize: 12, textAlign: 'center', padding: '18px 0' }}>
          매매가 5건 이상 쌓이면 AI가 패턴을 분석해드려요.<br />모의매매로 매매를 시작해보세요.
        </div>
      )}

      {/* 강점 */}
      {result.strengths.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
            <TrendingUp size={13} color={T.grn} /> 강점
          </div>
          {result.strengths.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '5px 0' }}>
              <CheckCircle2 size={14} color={T.grn} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ color: T.sub, fontSize: 12, lineHeight: 1.5 }}>{s}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 12 }}>
        모의매매 체결 기록을 기반으로 분석합니다. 시간대·연속손실·종목·손익비·과매매 패턴을 점검해요.
      </div>
    </div>
  );
}
