'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { formatKRW, safePercent } from '@/lib/format';
import { formatRelativeTime } from '@/lib/format';

// Reads trades from same store HistoryPage uses + PnL calculator history
const HISTORY_KEY = 'tg_history_v2';
const PNL_KEY     = 'tg_pnl_history_v1';

interface TradeEntry {
  id:        string;
  ts:        number;
  symbol:    string;
  side:      'buy' | 'sell' | 'long' | 'short';
  entry:     number;
  exit:      number;
  quantity:  number;
  netPnL:    number;
  roi:       number;
  reason?:   string;     // entry rationale
  emotion?:  string;     // mental state
  mistake?:  string;     // post-mortem
}

interface ReviewMetrics {
  totalTrades:  number;
  winTrades:    number;
  loseTrades:   number;
  winRate:      number;
  avgWin:       number;
  avgLoss:      number;
  profitFactor: number;
  bestTrade?:   TradeEntry;
  worstTrade?:  TradeEntry;
  avgHoldHours: number;
}

interface AIInsight {
  strengths:  string[];
  mistakes:   string[];
  fixes:      string[];
  timingExit: 'good' | 'late' | 'early' | 'mixed';
  timingEntry:'good' | 'late' | 'early' | 'mixed';
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function loadTrades(): TradeEntry[] {
  const out: TradeEntry[] = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      arr.forEach((e: any) => {
        out.push({
          id:       e.id || 'h-' + Math.random().toString(36).slice(2),
          ts:       safeNum(e.ts || e.date) || Date.now(),
          symbol:   e.symbol || e.asset || '?',
          side:     e.side || 'long',
          entry:    safeNum(e.entry || e.buyPrice),
          exit:     safeNum(e.exit  || e.sellPrice),
          quantity: safeNum(e.quantity),
          netPnL:   safeNum(e.netPnL || e.pnl),
          roi:      safeNum(e.roi),
          reason:   e.reason,
          emotion:  e.emotion,
          mistake:  e.mistake,
        });
      });
    }
  } catch {}
  try {
    const raw = localStorage.getItem(PNL_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      arr.forEach((r: any) => {
        out.push({
          id:       'p-' + r.id,
          ts:       safeNum(r.ts),
          symbol:   r.symbol || '?',
          side:     r.side === 'short' ? 'short' : 'long',
          entry:    safeNum(r.buyPrice),
          exit:     safeNum(r.sellPrice),
          quantity: safeNum(r.quantity),
          netPnL:   safeNum(r.netProfit),
          roi:      safeNum(r.roi),
        });
      });
    }
  } catch {}
  return out.sort((a, b) => b.ts - a.ts);
}

function calcMetrics(trades: TradeEntry[]): ReviewMetrics {
  const safe = Array.isArray(trades) ? trades : [];
  const wins  = safe.filter(t => t.netPnL > 0);
  const loses = safe.filter(t => t.netPnL < 0);
  const totalProfit = wins.reduce((s, t)  => s + t.netPnL, 0);
  const totalLoss   = Math.abs(loses.reduce((s, t) => s + t.netPnL, 0));
  const avgWin  = wins.length  > 0 ? totalProfit / wins.length  : 0;
  const avgLoss = loses.length > 0 ? totalLoss   / loses.length : 0;
  const winRate = safe.length  > 0 ? (wins.length / safe.length) * 100 : 0;
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 999 : 0);

  let best: TradeEntry | undefined, worst: TradeEntry | undefined;
  safe.forEach(t => {
    if (!best  || t.netPnL > best.netPnL)  best  = t;
    if (!worst || t.netPnL < worst.netPnL) worst = t;
  });

  return {
    totalTrades:  safe.length,
    winTrades:    wins.length,
    loseTrades:   loses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    bestTrade:    best,
    worstTrade:   worst,
    avgHoldHours: 0,
  };
}

function generateInsight(trades: TradeEntry[], m: ReviewMetrics): AIInsight {
  const safe = Array.isArray(trades) ? trades : [];
  const strengths: string[] = [];
  const mistakes:  string[] = [];
  const fixes:     string[] = [];

  // Win rate analysis
  if (m.winRate >= 60) strengths.push(`승률 ${m.winRate.toFixed(1)}% — 매매 진입 기준이 안정적입니다`);
  else if (m.winRate >= 40) strengths.push(`승률 ${m.winRate.toFixed(1)}% — 평균적인 수준입니다`);
  else mistakes.push(`승률 ${m.winRate.toFixed(1)}% — 진입 시점 점검이 필요합니다`);

  // Profit factor (Average win / Average loss ratio)
  if (m.profitFactor >= 1.5) {
    strengths.push(`손익비 ${m.profitFactor.toFixed(2)} — 손실 대비 이익이 큽니다`);
  } else if (m.profitFactor >= 1.0) {
    mistakes.push(`손익비 ${m.profitFactor.toFixed(2)} — 평균 수익이 평균 손실과 비슷합니다`);
    fixes.push('익절 폭을 늘리거나 손절 폭을 줄여 손익비 1.5 이상을 목표로 하세요');
  } else if (m.totalTrades > 0) {
    mistakes.push(`손익비 ${m.profitFactor.toFixed(2)} — 손실이 이익보다 큽니다`);
    fixes.push('손절 라인을 칼같이 지키는 연습이 필요합니다');
  }

  // Average loss vs average win ratio
  if (m.avgWin > 0 && m.avgLoss > 0) {
    const ratio = m.avgWin / m.avgLoss;
    if (ratio < 0.7) {
      mistakes.push('평균 수익(₩' + Math.round(m.avgWin).toLocaleString() + ')이 평균 손실(₩' + Math.round(m.avgLoss).toLocaleString() + ')보다 작습니다');
      fixes.push('익절을 너무 빨리 하지 말고, 추세가 지속되면 목표가까지 보유하세요');
    }
  }

  // Recent losing streak detection
  const recent = safe.slice(0, 5);
  const recentLosses = recent.filter(t => t.netPnL < 0).length;
  if (recentLosses >= 4) {
    mistakes.push(`최근 5거래 중 ${recentLosses}건 손실 — 시장 컨디션이 안 맞을 수 있습니다`);
    fixes.push('연속 손실 시 일정 기간 매매 중단을 권장합니다 (감정 매매 방지)');
  }

  // Emotion field analysis
  const emotional = safe.filter(t => t.emotion && /불안|초조|fomo|FOMO|분노/.test(t.emotion));
  if (emotional.length > safe.length * 0.3 && safe.length > 0) {
    mistakes.push('감정적 상태에서의 매매 비율이 높습니다');
    fixes.push('진입 전 체크리스트를 만들어 감정 매매를 줄이세요');
  }

  // Worst trade
  if (m.worstTrade && m.worstTrade.netPnL < -100_000) {
    mistakes.push(
      `최대 손실 거래: ${m.worstTrade.symbol} ${m.worstTrade.netPnL.toLocaleString()}원 — 손절이 늦었을 가능성`
    );
    fixes.push('진입 전에 손절가를 미리 정하고 지정가 손절을 활용하세요');
  }

  if (strengths.length === 0) strengths.push('아직 분석할 충분한 매매 기록이 없습니다');
  if (mistakes.length === 0)  mistakes.push('주요 실수 패턴이 감지되지 않습니다 — 좋습니다');
  if (fixes.length === 0)     fixes.push('현재 패턴을 유지하고 거래 일지 작성을 계속하세요');

  // Exit timing inference
  let timingExit: AIInsight['timingExit'] = 'mixed';
  if (m.avgWin > 0 && m.avgLoss > 0) {
    if (m.avgWin / m.avgLoss < 0.8) timingExit = 'early';   // exiting too early
    else if (m.avgWin / m.avgLoss > 1.5) timingExit = 'good';
  }

  // Entry timing inference
  let timingEntry: AIInsight['timingEntry'] = 'mixed';
  if (m.winRate >= 55) timingEntry = 'good';
  else if (m.winRate <= 35) timingEntry = 'late';

  return { strengths, mistakes, fixes, timingExit, timingEntry };
}

export default function JournalReviewPage() {
  const [trades, setTrades]   = useState<TradeEntry[]>([]);
  const [selected, setSelected] = useState<TradeEntry | null>(null);

  useEffect(() => {
    setTrades(loadTrades());
  }, []);

  const metrics = useMemo(() => calcMetrics(trades), [trades]);
  const insight = useMemo(() => generateInsight(trades, metrics), [trades, metrics]);

  const refresh = useCallback(() => {
    setTrades(loadTrades());
  }, []);

  const TIMING_LABEL: Record<string,string> = {
    good:'적절', late:'늦음', early:'이름', mixed:'혼재',
  };
  const TIMING_COLOR: Record<string,string> = {
    good: T.grn, late: T.red, early: T.ylw, mixed: T.muted,
  };

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 14 }}>
        <div>
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>🪞 AI 매매 복기</div>
          <div style={{ color: T.muted, fontSize: 10 }}>매매 기록 기반 학습용 분석</div>
        </div>
        <button type="button" onClick={refresh}
          style={{ padding:'8px 14px', minHeight: 36, background: T.acg,
            border:`1px solid ${T.acl}40`, borderRadius: 10, color: T.acl,
            fontWeight: 700, fontSize: 11, cursor:'pointer' }}>
          다시 분석
        </button>
      </div>

      {/* No data */}
      {trades.length === 0 ? (
        <Card style={{ padding:'40px 20px', textAlign:'center' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>📓</div>
          <div style={{ color: T.txt, fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
            아직 매매 기록이 없습니다
          </div>
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.7 }}>
            매매일지나 수익계산기에서 거래를 저장하면 자동으로 분석합니다.
          </div>
        </Card>
      ) : (
        <>
          {/* Disclaimer */}
          <div style={{ background: T.ylw + '10', border:`1px solid ${T.ylw}30`,
            borderRadius: 10, padding:'8px 12px', marginBottom: 10,
            color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>
            ⚠️ 본 분석은 <strong>학습용</strong>이며 투자 조언이 아닙니다.
            과거 패턴은 미래 수익을 보장하지 않습니다.
          </div>

          {/* Metrics summary */}
          <Card style={{ marginBottom: 10 }}>
            <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>통계 요약</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 8 }}>
              {[
                { label:'총 거래', value: `${metrics.totalTrades}건`, color: T.txt },
                { label:'승률',    value: safePercent(metrics.winRate), color: metrics.winRate >= 50 ? T.grn : T.red },
                { label:'평균 수익', value: formatKRW(metrics.avgWin), color: T.grn },
                { label:'평균 손실', value: formatKRW(metrics.avgLoss), color: T.red },
                { label:'손익비',   value: metrics.profitFactor.toFixed(2),
                  color: metrics.profitFactor >= 1.5 ? T.grn : metrics.profitFactor >= 1 ? T.ylw : T.red },
                { label:'승/패',    value: `${metrics.winTrades}/${metrics.loseTrades}`, color: T.txt },
              ].map(m => (
                <div key={m.label} style={{ background: T.alt, borderRadius: 10, padding:'10px 12px' }}>
                  <div style={{ color: T.muted, fontSize: 9 }}>{m.label}</div>
                  <div style={{ color: m.color, fontSize: 14, fontWeight: 800, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Timing analysis */}
            <div style={{ display:'flex', justifyContent:'space-around', marginTop: 14,
              paddingTop: 12, borderTop:`1px solid ${T.border}` }}>
              <div style={{ textAlign:'center' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>진입 타이밍</div>
                <div style={{ color: TIMING_COLOR[insight.timingEntry], fontSize: 12, fontWeight: 800 }}>
                  {TIMING_LABEL[insight.timingEntry]}
                </div>
              </div>
              <div style={{ width: 1, background: T.border }}/>
              <div style={{ textAlign:'center' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>익절 타이밍</div>
                <div style={{ color: TIMING_COLOR[insight.timingExit], fontSize: 12, fontWeight: 800 }}>
                  {TIMING_LABEL[insight.timingExit]}
                </div>
              </div>
            </div>
          </Card>

          {/* Strengths */}
          <Card style={{ marginBottom: 10, borderLeft:`3px solid ${T.grn}` }}>
            <div style={{ color: T.grn, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>
              ✅ 잘하고 있는 점
            </div>
            {insight.strengths.map((s, i) => (
              <div key={i} style={{ color: T.txt, fontSize: 12, lineHeight: 1.6,
                padding:'5px 0' }}>
                · {s}
              </div>
            ))}
          </Card>

          {/* Mistakes */}
          <Card style={{ marginBottom: 10, borderLeft:`3px solid ${T.red}` }}>
            <div style={{ color: T.red, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>
              ⚠️ 실수 또는 개선 필요
            </div>
            {insight.mistakes.map((s, i) => (
              <div key={i} style={{ color: T.txt, fontSize: 12, lineHeight: 1.6,
                padding:'5px 0' }}>
                · {s}
              </div>
            ))}
          </Card>

          {/* Fixes */}
          <Card style={{ marginBottom: 10, borderLeft:`3px solid ${T.acl}` }}>
            <div style={{ color: T.acl, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>
              다음에 고칠 점
            </div>
            {insight.fixes.map((s, i) => (
              <div key={i} style={{ color: T.txt, fontSize: 12, lineHeight: 1.6,
                padding:'5px 0' }}>
                · {s}
              </div>
            ))}
          </Card>

          {/* Best & worst */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8, marginBottom: 10 }}>
            {metrics.bestTrade && (
              <Card style={{ background: T.grn+'10', border:`1px solid ${T.grn}30` }}>
                <div style={{ color: T.grn, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>최고 수익</div>
                <div style={{ color: T.txt, fontSize: 13, fontWeight: 800 }}>{metrics.bestTrade.symbol}</div>
                <div style={{ color: T.grn, fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                  +{formatKRW(metrics.bestTrade.netPnL)}
                </div>
                <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>
                  {formatRelativeTime(metrics.bestTrade.ts)}
                </div>
              </Card>
            )}
            {metrics.worstTrade && (
              <Card style={{ background: T.red+'10', border:`1px solid ${T.red}30` }}>
                <div style={{ color: T.red, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>최대 손실</div>
                <div style={{ color: T.txt, fontSize: 13, fontWeight: 800 }}>{metrics.worstTrade.symbol}</div>
                <div style={{ color: T.red, fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                  {formatKRW(metrics.worstTrade.netPnL)}
                </div>
                <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>
                  {formatRelativeTime(metrics.worstTrade.ts)}
                </div>
              </Card>
            )}
          </div>

          {/* Recent trades */}
          <Card style={{ overflow:'hidden', padding: 0 }}>
            <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
              color: T.muted, fontSize: 10, fontWeight: 700 }}>
              최근 거래 (최대 10건)
            </div>
            {trades.slice(0, 10).map((t, i) => (
              <div key={t.id} onClick={() => setSelected(t)}
                style={{ display:'flex', justifyContent:'space-between',
                  padding:'10px 14px', cursor:'pointer',
                  borderBottom: i < Math.min(9, trades.length - 1) ? `1px solid ${T.border}` : 'none' }}>
                <div>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>
                    {t.symbol} <span style={{ color: T.muted, fontSize: 10 }}>· {t.side}</span>
                  </div>
                  <div style={{ color: T.muted, fontSize: 9 }}>{formatRelativeTime(t.ts)}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color: t.netPnL >= 0 ? T.grn : T.red,
                    fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                    {t.netPnL >= 0 ? '+' : ''}{formatKRW(t.netPnL)}
                  </div>
                  <div style={{ color: t.roi >= 0 ? T.grn : T.red,
                    fontSize: 10, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                    {safePercent(t.roi)}
                  </div>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      {/* Detail modal */}
      {selected && (
        <>
          <div onClick={() => setSelected(null)}
            style={{ position:'fixed', inset: 0, background:'rgba(0,0,0,.7)', zIndex: 200 }}/>
          <div onClick={(e) => e.stopPropagation()}
            style={{ position:'fixed', zIndex: 201, inset:'auto 0 0 0',
              background: T.bg, borderRadius:'20px 20px 0 0',
              maxHeight:'85dvh', overflowY:'auto',
              padding:`18px 16px calc(env(safe-area-inset-bottom, 20px) + 24px)`,
              maxWidth: 520, margin:'0 auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 12 }}>
              <div style={{ color: T.txt, fontWeight: 800, fontSize: 16 }}>{selected.symbol}</div>
              <button type="button" onClick={() => setSelected(null)}
                style={{ background:'transparent', border:`1px solid ${T.border}`,
                  borderRadius: 8, color: T.muted, padding:'5px 12px', fontSize: 12, cursor:'pointer' }}>
                닫기
              </button>
            </div>
            {[
              ['방향',   selected.side === 'short' ? '숏 (공매도)' : '롱 (매수)'],
              ['진입가', formatKRW(selected.entry)],
              ['청산가', formatKRW(selected.exit)],
              ['수량',   selected.quantity.toString()],
              ['순손익', formatKRW(selected.netPnL)],
              ['수익률', safePercent(selected.roi)],
            ].map(([l, v]) => (
              <div key={l} style={{ display:'flex', justifyContent:'space-between',
                padding:'8px 0', borderBottom:`1px solid ${T.border}` }}>
                <span style={{ color: T.muted, fontSize: 11 }}>{l}</span>
                <span style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>{v}</span>
              </div>
            ))}
            {selected.reason && (
              <div style={{ marginTop: 12, padding:'10px 12px', background: T.alt, borderRadius: 8 }}>
                <div style={{ color: T.muted, fontSize: 9, marginBottom: 4 }}>매매 이유</div>
                <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.6 }}>{selected.reason}</div>
              </div>
            )}
            {selected.mistake && (
              <div style={{ marginTop: 8, padding:'10px 12px', background: T.red+'10',
                border:`1px solid ${T.red}30`, borderRadius: 8 }}>
                <div style={{ color: T.red, fontSize: 9, marginBottom: 4 }}>실수 메모</div>
                <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.6 }}>{selected.mistake}</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
