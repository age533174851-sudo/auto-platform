'use client';
import React, { useState, useEffect, useCallback } from 'react';
import AiDcaPanel from '@/components/AiDcaPanel';
import { confirmDialog } from '@/lib/confirm/dialog';
import { notifyError } from '@/lib/notify/center';
import {
  CalendarClock, Plus, Pencil, Trash2, Play, ChartBar,
  TrendingDown, Flame, Coins as CoinsIc, CircleCheck, X as XIcon,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { formatKRW } from '@/lib/format';
import {
  loadDCARules, saveDCARules, createBlankRule,
  computeNextRun, previewExecution, projectAccumulation,
  FREQUENCY_LABEL,
} from '@/lib/accounts/dca';
import type { DCARule, DCAFrequency, PriceContext } from '@/lib/accounts/dca';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';

const inp: React.CSSProperties = {
  width: '100%', padding: '12px 14px', minHeight: 48,
  background: T.alt, border: `1px solid ${T.border}`, borderRadius: R.md,
  color: T.txt, fontSize: 14, boxSizing: 'border-box',
};

const POPULAR = [
  { symbol: 'QQQ',  name: 'Invesco QQQ' },
  { symbol: 'VOO',  name: 'Vanguard S&P 500' },
  { symbol: 'SCHD', name: 'Schwab Dividend' },
  { symbol: 'NVDA', name: 'NVIDIA' },
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'BTC',  name: 'Bitcoin' },
  { symbol: 'ETH',  name: 'Ethereum' },
  { symbol: '005930', name: '삼성전자' },
  { symbol: '360750', name: 'TIGER S&P500' },
];

const MOCK_PRICES: Record<string, PriceContext> = {
  QQQ:    { currentPrice: 562_000, pct7d: -2.1, pct30d: 4.8 },
  VOO:    { currentPrice: 690_000, pct7d: -1.3, pct30d: 3.2 },
  SCHD:   { currentPrice: 38_500,  pct7d: 0.8,  pct30d: 1.5 },
  NVDA:   { currentPrice: 201_000, pct7d: -6.4, pct30d: -2.1 },
  MSFT:   { currentPrice: 548_000, pct7d: 1.2,  pct30d: 5.6 },
  BTC:    { currentPrice: 97_200_000, pct7d: 3.8, pct30d: 12.4 },
  ETH:    { currentPrice: 5_280_000,  pct7d: 5.2, pct30d: 18.9 },
  '005930': { currentPrice: 78_500, pct7d: -1.8, pct30d: -0.5 },
  '360750': { currentPrice: 17_200, pct7d: -1.0, pct30d: 2.5 },
};

function priceFor(symbol: string): PriceContext {
  return MOCK_PRICES[symbol] || { currentPrice: 100_000, pct7d: 0, pct30d: 0 };
}

function DCAInner({ currency = 'KRW' }: { currency?: string }) {
  const [rules, setRules] = useState<DCARule[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DCARule | null>(null);
  const [showProjection, setShowProjection] = useState<string | null>(null);
  const [executedMsg, setExecutedMsg] = useState<string | null>(null);

  useEffect(() => {
    try { setRules(loadDCARules()); } catch (e) { console.error('[dca] load', e); setRules([]); }
  }, []);

  const persist = useCallback((next: DCARule[]) => {
    setRules(next);
    try { saveDCARules(next); } catch (e) { console.warn('[dca] save', e); }
  }, []);

  const toggleEnabled = (id: string) => persist(rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));

  const deleteRule = async (id: string) => {
    if (!(await confirmDialog('이 적립 룰을 삭제할까요?', { danger: true }))) return;
    persist(rules.filter(r => r.id !== id));
  };

  const openCreate = () => { setDraft(createBlankRule()); setEditingId('new'); };
  const openEdit = (r: DCARule) => { setDraft({ ...r }); setEditingId(r.id); };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.symbol.trim()) { notifyError('이름과 종목은 필수입니다.'); return; }
    const cleaned: DCARule = {
      ...draft,
      baseAmount: Math.max(1000, draft.baseAmount),
      nextRunAt: draft.nextRunAt || computeNextRun(draft.frequency),
    };
    if (editingId === 'new') persist([cleaned, ...rules]);
    else                     persist(rules.map(r => r.id === editingId ? cleaned : r));
    setEditingId(null); setDraft(null);
  };

  const executeNow = (rule: DCARule) => {
    const ctx = priceFor(rule.symbol);
    const preview = previewExecution(rule, ctx);
    if (!preview.willExecute) return;
    const newRules = rules.map(r => r.id !== rule.id ? r : {
      ...r,
      totalInvested: r.totalInvested + preview.amount,
      totalShares:   r.totalShares + preview.shares,
      lastRunAt:     Date.now(),
      nextRunAt:     computeNextRun(r.frequency),
      runCount:      r.runCount + 1,
    });
    persist(newRules);
    setExecutedMsg(`${rule.symbol} ${formatKRW(preview.amount)} 매수 완료 — ${preview.triggerReason}`);
    setTimeout(() => setExecutedMsg(null), 4500);
  };

  return (
    <div style={PAGE_STYLE}>
      <AiDcaPanel currency={currency} />
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP.md, gap: SP.sm, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm }}>
          <IconBox tone="blue" size="md"><CalendarClock size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
          <div>
            <div style={F.title}>자동 적립</div>
            <div style={F.caption}>매일·매주·매월 자동 매수 · 하락시 추가 · 과열시 축소</div>
          </div>
        </div>
        <button onClick={openCreate} style={{ ...buttonStyle('primary', 'md'), gap: 6 }}>
          <Plus size={16} strokeWidth={IC_STROKE} /> 새 룰
        </button>
      </div>

      {executedMsg && (
        <div style={{ background: T.acg, border: `1px solid ${T.acl}`, borderRadius: R.md, padding: SP.md, display: 'flex', alignItems: 'flex-start', gap: SP.sm, marginBottom: SP.md }}>
          <CircleCheck size={18} strokeWidth={IC_STROKE} color={T.acl} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ color: T.acl, fontSize: 12 }}>{executedMsg}</div>
        </div>
      )}

      {(Array.isArray(rules) ? rules : []).length === 0 ? (
        <div style={cardStyle({ textAlign: 'center', padding: '40px 20px' })}>
          <div style={{ ...F.muted, fontSize: 13 }}>아직 적립 룰이 없습니다.</div>
          <div style={{ ...F.muted, marginTop: 4 }}>"+ 새 룰"을 눌러 시작하세요.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.md }}>
          {(Array.isArray(rules) ? rules : []).map(r => {
            const ctx = priceFor(r.symbol);
            const preview = previewExecution(r, ctx);
            const currentValue = r.totalShares * ctx.currentPrice;
            const pnl = currentValue - r.totalInvested;
            const pnlPct = r.totalInvested > 0 ? (pnl / r.totalInvested) * 100 : 0;
            return (
              <div key={r.id} style={cardStyle({ opacity: r.enabled ? 1 : 0.55 })}>
                <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm }}>
                  <IconBox tone="blue" size="md"><CoinsIc size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={F.section}>{r.name}</span>
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: R.pill, background: T.acg, color: T.acl, fontWeight: 700 }}>{r.symbol}</span>
                    </div>
                    <div style={{ ...F.muted, marginTop: 2 }}>
                      {FREQUENCY_LABEL[r.frequency]} · 회당 {formatKRW(r.baseAmount)} · {r.runCount}회 실행
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>
                    <input type="checkbox" checked={r.enabled} onChange={() => toggleEnabled(r.id)} style={{ width: 22, height: 22 }} />
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: SP.md }}>
                  <Stat label="누적 투자" value={formatKRW(r.totalInvested)} />
                  <Stat label="평가금액" value={formatKRW(currentValue)} />
                  <Stat label="손익" value={
                    <span style={{ color: pnl >= 0 ? T.grn : T.red }}>{pnl >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%</span>
                  } />
                </div>

                {/* 다음 실행 미리보기 */}
                <div style={{ marginTop: SP.sm + 2, padding: SP.sm + 2, background: T.alt, borderRadius: R.md, fontSize: 12, color: T.sub, lineHeight: 1.5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={F.muted}>다음 실행</span>
                    <span style={{ color: T.txt, fontWeight: 700 }}>
                      {r.nextRunAt ? new Date(r.nextRunAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short' }) : '—'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={F.muted}>예정 금액</span>
                    <span style={{ color: T.acl, fontWeight: 800, fontSize: 13 }}>{formatKRW(preview.amount)}</span>
                  </div>
                  <div style={{ ...F.muted, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {preview.triggerReason.includes('하락') && <TrendingDown size={11} strokeWidth={IC_STROKE} color={T.grn} />}
                    {preview.triggerReason.includes('과열') && <Flame size={11} strokeWidth={IC_STROKE} color={T.ylw} />}
                    {preview.triggerReason}
                  </div>
                </div>

                {/* 액션 */}
                <div style={{ display: 'flex', gap: 6, marginTop: SP.sm + 2 }}>
                  <button onClick={() => executeNow(r)} disabled={!r.enabled}
                    style={{ ...buttonStyle('primary'), flex: 1, gap: 6, opacity: r.enabled ? 1 : 0.4 }}>
                    <Play size={14} strokeWidth={IC_STROKE} /> 지금 실행
                  </button>
                  <button onClick={() => setShowProjection(showProjection === r.id ? null : r.id)}
                    style={{ ...buttonStyle('ghost'), flex: 1, gap: 6 }}>
                    <ChartBar size={14} strokeWidth={IC_STROKE} /> {showProjection === r.id ? '접기' : '시뮬'}
                  </button>
                  <button onClick={() => openEdit(r)}
                    style={{ ...buttonStyle('ghost'), padding: '10px 12px' }}>
                    <Pencil size={14} strokeWidth={IC_STROKE} />
                  </button>
                  <button onClick={() => deleteRule(r.id)}
                    style={{ ...buttonStyle('ghost'), padding: '10px 12px', color: T.red, border: `1px solid ${T.red}55` }}>
                    <Trash2 size={14} strokeWidth={IC_STROKE} />
                  </button>
                </div>

                {showProjection === r.id && (
                  <div style={{ marginTop: SP.sm + 2, padding: SP.sm + 2, background: T.alt, borderRadius: R.md }}>
                    <div style={{ ...F.section, marginBottom: 6, fontSize: 12 }}>10년 적립 시뮬 (연 10% 가정)</div>
                    {projectAccumulation(r, 120, 10).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length/6)) === 0 || i === arr.length - 1).map(p => (
                      <div key={p.month} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${T.border}`, fontSize: 11 }}>
                        <span style={{ color: T.sub }}>{Math.floor(p.month/12)}년차</span>
                        <span style={{ color: T.muted }}>원금 {formatKRW(p.invested)}</span>
                        <span style={{ color: T.grn, fontWeight: 700 }}>{formatKRW(p.value)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 편집 모달 */}
      {draft && (
        <Modal onClose={() => { setEditingId(null); setDraft(null); }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP.md }}>
            <div style={{ ...F.title, fontSize: 16 }}>{editingId === 'new' ? '새 적립 룰' : '룰 편집'}</div>
            <button onClick={() => { setEditingId(null); setDraft(null); }}
              style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', padding: 8, minHeight: 36, minWidth: 36 }}>
              <XIcon size={18} strokeWidth={IC_STROKE} />
            </button>
          </div>

          <Field label="룰 이름">
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={inp} />
          </Field>

          <Field label="종목 (인기 종목에서 선택 또는 직접 입력)">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 4, marginBottom: 6 }}>
              {POPULAR.map(p => {
                const active = draft.symbol === p.symbol;
                return (
                  <button key={p.symbol} onClick={() => setDraft({ ...draft, symbol: p.symbol, symbolName: p.name })}
                    style={{ ...buttonStyle('ghost', 'sm'), padding: '10px 4px', fontSize: 11,
                      background: active ? T.acg : T.alt,
                      border: `1px solid ${active ? T.acl : T.border}`,
                      color: active ? T.acl : T.txt }}>
                    {p.symbol}
                  </button>
                );
              })}
            </div>
            <input value={draft.symbol} onChange={e => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })} style={inp} placeholder="심볼" />
          </Field>

          <Field label="빈도">
            <div style={{ display: 'flex', gap: 4 }}>
              {(['daily','weekly','monthly'] as DCAFrequency[]).map(f => {
                const active = draft.frequency === f;
                return (
                  <button key={f} onClick={() => setDraft({ ...draft, frequency: f, nextRunAt: computeNextRun(f) })}
                    style={{ ...buttonStyle('ghost', 'md'), flex: 1,
                      background: active ? T.acg : T.alt,
                      border: `1px solid ${active ? T.acl : T.border}`,
                      color: active ? T.acl : T.txt }}>
                    {FREQUENCY_LABEL[f]}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={`1회 매수금액: ${formatKRW(draft.baseAmount)}`}>
            <input type="number" value={draft.baseAmount} onChange={e => setDraft({ ...draft, baseAmount: Number(e.target.value)||0 })} style={inp} />
          </Field>

          <div style={{ padding: SP.sm + 2, background: T.alt, borderRadius: R.md, marginBottom: SP.md }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: SP.sm, cursor: 'pointer', minHeight: 36 }}>
              <input type="checkbox" checked={draft.dipBoost.enabled}
                onChange={e => setDraft({ ...draft, dipBoost: { ...draft.dipBoost, enabled: e.target.checked } })}
                style={{ width: 18, height: 18 }} />
              <TrendingDown size={16} strokeWidth={IC_STROKE} color={T.grn} />
              <span style={{ ...F.body, fontWeight: 700 }}>하락시 추가매수</span>
            </label>
            {draft.dipBoost.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <div>
                  <div style={F.muted}>하락폭 (%)</div>
                  <input type="number" value={draft.dipBoost.threshold}
                    onChange={e => setDraft({ ...draft, dipBoost: { ...draft.dipBoost, threshold: Number(e.target.value) } })} style={inp} />
                </div>
                <div>
                  <div style={F.muted}>매수 배수</div>
                  <input type="number" step={0.1} value={draft.dipBoost.multiplier}
                    onChange={e => setDraft({ ...draft, dipBoost: { ...draft.dipBoost, multiplier: Number(e.target.value)||1 } })} style={inp} />
                </div>
              </div>
            )}
          </div>

          <div style={{ padding: SP.sm + 2, background: T.alt, borderRadius: R.md, marginBottom: SP.md }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: SP.sm, cursor: 'pointer', minHeight: 36 }}>
              <input type="checkbox" checked={draft.overheatCut.enabled}
                onChange={e => setDraft({ ...draft, overheatCut: { ...draft.overheatCut, enabled: e.target.checked } })}
                style={{ width: 18, height: 18 }} />
              <Flame size={16} strokeWidth={IC_STROKE} color={T.ylw} />
              <span style={{ ...F.body, fontWeight: 700 }}>과열시 축소</span>
            </label>
            {draft.overheatCut.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <div>
                  <div style={F.muted}>상승폭 (%)</div>
                  <input type="number" value={draft.overheatCut.threshold}
                    onChange={e => setDraft({ ...draft, overheatCut: { ...draft.overheatCut, threshold: Number(e.target.value) } })} style={inp} />
                </div>
                <div>
                  <div style={F.muted}>축소 배수</div>
                  <input type="number" step={0.1} value={draft.overheatCut.multiplier}
                    onChange={e => setDraft({ ...draft, overheatCut: { ...draft.overheatCut, multiplier: Number(e.target.value)||1 } })} style={inp} />
                </div>
              </div>
            )}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: SP.sm, cursor: 'pointer', marginBottom: SP.md, minHeight: 36 }}>
            <input type="checkbox" checked={draft.reinvestDividend}
              onChange={e => setDraft({ ...draft, reinvestDividend: e.target.checked })}
              style={{ width: 18, height: 18 }} />
            <span style={F.body}>배당 자동 재투자</span>
          </label>

          <div style={{ display: 'flex', gap: SP.sm }}>
            <button onClick={() => { setEditingId(null); setDraft(null); }} style={{ ...buttonStyle('ghost'), flex: 1 }}>취소</button>
            <button onClick={saveDraft} style={{ ...buttonStyle('primary'), flex: 1 }}>저장</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: SP.md }}>
      <div style={{ ...F.caption, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 12px', background: T.alt, borderRadius: R.md }}>
      <div style={F.muted}>{label}</div>
      <div style={{ ...F.numS, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: SP.lg, zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.card, border: `1px solid ${T.border2}`, borderRadius: R.xl, padding: SP.lg + 2, maxWidth: 440, width: '100%', maxHeight: '92vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

export default function DCAPage(props: { currency?: string }) {
  return <ErrorBoundary><DCAInner {...props} /></ErrorBoundary>;
}
