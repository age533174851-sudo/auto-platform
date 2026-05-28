'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Sparkles, Wand2, Wrench, List, Play, Pause, Copy, Trash2, Plus,
  ChevronLeft, ChevronRight, Send, AlertTriangle, CheckCircle2, Info,
  Settings as SettingsIcon,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from './ErrorBoundary';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';
import {
  type UserStrategy, type StrategyTimeframe, type StrategyMarket,
  type StrategyAction, type StrategyMode, type IndicatorName, type Operator,
  type StrategyCondition,
  INDICATOR_LABEL, OPERATOR_LABEL, TIMEFRAME_LABEL, MARKET_LABEL,
} from '@/lib/strategies/types';
import {
  listStrategies, saveStrategy, deleteStrategy, toggleEnabled,
  duplicateStrategy, newStrategyId,
} from '@/lib/strategies/store';

const QUICK_EXAMPLES = [
  'BTC RSI 30 이하일 때 10만원 매수, 익절 5%, 손절 2%',
  'ETH EMA 골든크로스 발생시 20만원 매수',
  '솔라나 거래량 급증하면 5만원 매수',
  '나스닥 일봉 데드크로스 발생시 매도',
  '테슬라 RSI 70 이상이면 매도',
];

const ASSETS_BY_MARKET: Record<StrategyMarket, string[]> = {
  crypto:  ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','DOT','LINK'],
  stock:   ['AAPL','TSLA','NVDA','MSFT','GOOGL','AMZN','META','005930','000660','035420'],
  etf:     ['SPY','QQQ','VOO','SOXL','TQQQ'],
  forex:   ['USDKRW','EURUSD','JPYUSD'],
  futures: ['BTCUSDT','ETHUSDT'],
};

const TIMEFRAMES: StrategyTimeframe[] = ['5m','15m','30m','1h','4h','1d'];

// ─────────────────────────────────────────────────────────────
// 빈 전략 템플릿
// ─────────────────────────────────────────────────────────────
function blankStrategy(): UserStrategy {
  const now = Date.now();
  return {
    id:         newStrategyId(),
    name:       '새 전략',
    asset:      'BTC',
    market:     'crypto',
    timeframe:  '1h',
    mode:       'paper',
    action:     'buy',
    conditions: [{ indicator: 'RSI', operator: '<=', value: 30 }],
    order:      { type: 'market', amount: 100000, currency: 'KRW' },
    risk:       { takeProfitPct: 5, stopLossPct: 2, maxDailyLossPct: 10 },
    enabled:    false,
    createdAt:  now,
    updatedAt:  now,
    source:     'manual',
  };
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────
function StrategyBuilderInner({ onNav }: { onNav?: (tab: string) => void }) {
  const [tab,   setTab]   = useState<'list'|'manual'|'ai'>('list');
  const [items, setItems] = useState<UserStrategy[]>([]);
  const [editing, setEditing] = useState<UserStrategy | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle'|'syncing'|'synced'|'offline'>('idle');

  // 마운트 시: 로컬 목록 + 클라우드 pull (best-effort)
  useEffect(() => {
    setItems(listStrategies());
    let cancelled = false;
    (async () => {
      try {
        const { pullStrategies } = await import('@/lib/strategies/sync');
        const r = await pullStrategies();
        if (cancelled) return;
        if (r.ok) {
          setItems(listStrategies());
          setSyncStatus('synced');
        } else if (r.error === 'not_logged_in') {
          setSyncStatus('offline');
        }
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(() => { setItems(listStrategies()); }, []);

  // 클라우드 푸시 (best-effort)
  const pushToCloud = useCallback(async () => {
    try {
      const { pushStrategies } = await import('@/lib/strategies/sync');
      setSyncStatus('syncing');
      const r = await pushStrategies();
      setSyncStatus(r.ok ? 'synced' : (r.error === 'not_logged_in' ? 'offline' : 'idle'));
    } catch { /* best-effort */ }
  }, []);

  const onSave = useCallback((s: UserStrategy) => {
    saveStrategy(s);
    refresh();
    setEditing(null);
    setTab('list');
    pushToCloud();
  }, [refresh, pushToCloud]);

  const onDelete = useCallback(async (id: string) => {
    if (typeof window === 'undefined') return;
    if (!window.confirm('이 전략을 삭제하시겠습니까?')) return;
    deleteStrategy(id);
    refresh();
    // 클라우드도 삭제
    try {
      const { deleteStrategyCloud } = await import('@/lib/strategies/sync');
      await deleteStrategyCloud(id);
    } catch { /* best-effort */ }
  }, [refresh]);

  const onToggle = useCallback((id: string, enabled: boolean) => {
    toggleEnabled(id, enabled);
    refresh();
    pushToCloud();
  }, [refresh, pushToCloud]);

  const onDuplicate = useCallback((id: string) => {
    duplicateStrategy(id);
    refresh();
  }, [refresh]);

  return (
    <div style={PAGE_STYLE}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
        <IconBox tone="purple" size="md">
          <Sparkles size={IC_SIZE.md} strokeWidth={IC_STROKE} />
        </IconBox>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={F.title}>AI 전략 빌더</div>
          <div style={F.caption}>자연어 또는 직접 입력으로 자동매매 전략 생성</div>
        </div>
        {/* 동기화 상태 배지 */}
        {syncStatus !== 'idle' && (
          <div style={{
            flexShrink: 0, padding: '4px 8px', borderRadius: 8, fontSize: 9, fontWeight: 700,
            background:
              syncStatus === 'synced'  ? T.grn + '20' :
              syncStatus === 'syncing' ? T.acl + '20' :
                                          T.muted + '20',
            color:
              syncStatus === 'synced'  ? T.grn :
              syncStatus === 'syncing' ? T.acl :
                                          T.muted,
            border: `1px solid ${
              syncStatus === 'synced'  ? T.grn :
              syncStatus === 'syncing' ? T.acl :
                                          T.border
            }40`,
          }}>
            {syncStatus === 'synced'  ? '☁ 동기화됨' :
             syncStatus === 'syncing' ? '동기화 중...' :
                                         '오프라인'}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: SP.md }}>
        {([
          { id: 'list',   label: '내 전략',  icon: List },
          { id: 'ai',     label: 'AI 생성', icon: Wand2 },
          { id: 'manual', label: '직접 생성', icon: Wrench },
        ] as const).map(t => {
          const active = tab === t.id;
          const Ic = t.icon;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); if (t.id !== 'manual' && t.id !== 'ai') setEditing(null); }}
              style={{
                flex: 1, padding: '10px', minHeight: 42,
                background: active ? T.acg : T.alt,
                color:      active ? T.acl : T.muted,
                border:    `1px solid ${active ? T.acl : T.border}`,
                borderRadius: R.md, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                touchAction: 'manipulation',
              }}>
              <Ic size={14} strokeWidth={IC_STROKE} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* 본문 */}
      {tab === 'list' && (
        <StrategyList
          items={items}
          onEdit={(s) => { setEditing(s); setTab('manual'); }}
          onToggle={onToggle}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onNew={() => { setEditing(blankStrategy()); setTab('manual'); }}
          onBacktest={(s) => {
            // 백테스트 페이지로 이동, 전략 ID 전달
            if (typeof window !== 'undefined') {
              try { window.sessionStorage.setItem('tg_backtest_strategy', JSON.stringify(s)); } catch {}
            }
            if (onNav) onNav('backtest');
          }}
        />
      )}

      {tab === 'ai' && (
        <AIPromptPanel
          onParsed={(partial) => {
            // partial → 완성된 UserStrategy로 변환 + 편집 모드로
            const draft: UserStrategy = {
              ...blankStrategy(),
              ...partial,
              id: newStrategyId(),
              enabled: false,    // 강제
              source: 'ai',
            };
            setEditing(draft);
            setTab('manual');
          }}
        />
      )}

      {tab === 'manual' && (
        <ManualBuilder
          initial={editing || blankStrategy()}
          onSave={onSave}
          onCancel={() => { setEditing(null); setTab('list'); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 전략 목록
// ─────────────────────────────────────────────────────────────
function StrategyList({
  items, onEdit, onToggle, onDelete, onDuplicate, onNew, onBacktest,
}: {
  items: UserStrategy[];
  onEdit:      (s: UserStrategy) => void;
  onToggle:    (id: string, enabled: boolean) => void;
  onDelete:    (id: string) => void;
  onDuplicate: (id: string) => void;
  onNew:       () => void;
  onBacktest:  (s: UserStrategy) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={cardStyle({ padding: '40px 20px', textAlign: 'center' })}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: SP.sm }}>
          <Sparkles size={32} strokeWidth={2} color={T.muted}/>
        </div>
        <div style={{ ...F.body, color: T.txt, marginBottom: 4 }}>아직 만든 전략이 없습니다</div>
        <div style={{ ...F.muted, marginBottom: SP.md }}>AI 생성 또는 직접 생성 탭에서 만들어보세요</div>
        <button onClick={onNew}
          style={{
            ...buttonStyle('primary', 'md'),
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <Plus size={14} strokeWidth={IC_STROKE} />
          새 전략 만들기
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm }}>
      <button onClick={onNew}
        style={{
          ...buttonStyle('ghost', 'md'),
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
        <Plus size={14} strokeWidth={IC_STROKE} />
        새 전략 만들기
      </button>
      {items.map(s => (
        <div key={s.id} style={cardStyle({ borderLeft: `3px solid ${s.enabled ? T.grn : T.border}` })}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP.sm, marginBottom: SP.sm }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ ...F.body, fontWeight: 800, color: T.txt }}>{s.name}</span>
                {s.source === 'ai' && (
                  <span style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'2px 6px', background: T.prp+'22', color: T.prp, borderRadius: R.sm, fontSize: 9, fontWeight: 800 }}>
                    <Sparkles size={9} strokeWidth={IC_STROKE}/>AI
                  </span>
                )}
                <span style={{ padding:'2px 6px', background: T.alt, color: T.muted, borderRadius: R.sm, fontSize: 9, fontWeight: 700 }}>
                  {s.mode === 'paper' ? '모의' : '실전'}
                </span>
                <span style={{ padding:'2px 6px', background: s.action === 'buy' ? T.grn+'22' : T.red+'22', color: s.action === 'buy' ? T.grn : T.red, borderRadius: R.sm, fontSize: 9, fontWeight: 800 }}>
                  {s.action === 'buy' ? '매수' : '매도'}
                </span>
              </div>
              <div style={{ ...F.muted, lineHeight: 1.5 }}>
                {s.asset} · {TIMEFRAME_LABEL[s.timeframe]} · {MARKET_LABEL[s.market]}
              </div>
              <div style={{ ...F.muted, marginTop: 3 }}>
                조건 {s.conditions.length}개 · 익절 {s.risk.takeProfitPct}% / 손절 {s.risk.stopLossPct}%
              </div>
            </div>
            {/* On/Off 토글 */}
            <button onClick={() => onToggle(s.id, !s.enabled)}
              aria-label={s.enabled ? '비활성화' : '활성화'}
              style={{
                width: 56, height: 30, borderRadius: 15,
                background: s.enabled ? T.grn : T.border,
                border: 'none', cursor: 'pointer', position: 'relative',
                transition: 'background 200ms', flexShrink: 0,
              }}>
              <div style={{
                position: 'absolute', top: 3,
                left: s.enabled ? 29 : 3,
                width: 24, height: 24, borderRadius: 12,
                background: '#fff', transition: 'left 200ms',
              }}/>
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => onEdit(s)}
              style={{ ...buttonStyle('ghost','sm'), flex: 1, minWidth: 70 }}>
              편집
            </button>
            <button onClick={() => onBacktest(s)}
              style={{
                ...buttonStyle('ghost','sm'), flex: 1, minWidth: 70,
                color: T.acl, borderColor: T.acl+'40',
              }}>
              백테스트
            </button>
            <button onClick={() => onDuplicate(s.id)}
              aria-label="복제"
              style={{ ...buttonStyle('ghost','sm'), minWidth: 36, padding: '6px 10px' }}>
              <Copy size={12} strokeWidth={IC_STROKE}/>
            </button>
            <button onClick={() => onDelete(s.id)}
              aria-label="삭제"
              style={{ ...buttonStyle('ghost','sm'), minWidth: 36, padding: '6px 10px', color: T.red, borderColor: T.red+'40' }}>
              <Trash2 size={12} strokeWidth={IC_STROKE}/>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AI 자연어 패널
// ─────────────────────────────────────────────────────────────
function AIPromptPanel({ onParsed }: { onParsed: (s: Partial<UserStrategy>) => void }) {
  const [prompt, setPrompt]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [result, setResult]   = useState<{ strategy: Partial<UserStrategy>; warnings: string[]; confidence: number; source: string } | null>(null);

  const submit = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await fetch('/api/strategies/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`status_${r.status}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResult(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [prompt, loading]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.md }}>
      <div style={cardStyle()}>
        <div style={{ ...F.section, marginBottom: 6, color: T.txt }}>전략을 자연어로 설명하세요</div>
        <div style={{ ...F.muted, marginBottom: SP.sm }}>
          AI가 조건을 분석해서 전략 JSON을 만들어줍니다. 미리보기 후 직접 수정/저장 가능.
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value.slice(0, 800))}
          placeholder="예: BTC RSI 30 이하로 떨어지고 MACD 골든크로스 나오면 20만원 매수, 익절 5% 손절 2%"
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 12px', background: T.bg,
            border: `1px solid ${T.border}`, borderRadius: R.md,
            color: T.txt, fontSize: 13, lineHeight: 1.6,
            resize: 'vertical', outline: 'none',
            fontFamily: 'inherit',
          }}/>
        <div style={{ ...F.muted, textAlign: 'right', marginTop: 4 }}>{prompt.length} / 800</div>

        {/* 빠른 예시 */}
        <div style={{ marginTop: SP.sm }}>
          <div style={{ ...F.caption, marginBottom: 4 }}>예시 클릭으로 채우기</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {QUICK_EXAMPLES.map(ex => (
              <button key={ex} onClick={() => setPrompt(ex)}
                style={{
                  background: T.alt, color: T.sub,
                  border: `1px solid ${T.border}`,
                  borderRadius: R.pill, padding: '4px 9px',
                  fontSize: 10, fontWeight: 600, cursor: 'pointer',
                  touchAction: 'manipulation',
                }}>
                {ex}
              </button>
            ))}
          </div>
        </div>

        <button onClick={submit} disabled={!prompt.trim() || loading}
          style={{
            marginTop: SP.md, width: '100%', padding: '12px',
            minHeight: 48,
            background: !prompt.trim() || loading
              ? T.border
              : `linear-gradient(135deg, ${T.acc}, ${T.prp})`,
            color: '#fff', border: 'none', borderRadius: R.md,
            fontWeight: 800, fontSize: 13,
            cursor: !prompt.trim() || loading ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <Send size={14} strokeWidth={IC_STROKE}/>
          {loading ? 'AI 분석 중…' : 'AI에게 전략 생성 요청'}
        </button>

        {error && (
          <div style={{ marginTop: SP.sm, padding: '8px 12px', background: T.red+'10', border: `1px solid ${T.red}30`, borderRadius: R.sm, color: T.red, fontSize: 11 }}>
            오류: {error}
          </div>
        )}
      </div>

      {/* 결과 미리보기 */}
      {result && (
        <div style={cardStyle({ background: T.acl + '08', borderColor: T.acl + '40' })}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: SP.sm }}>
            <CheckCircle2 size={16} strokeWidth={IC_STROKE} color={T.acl}/>
            <span style={{ ...F.section, color: T.acl }}>AI 분석 결과</span>
            <span style={{ marginLeft: 'auto', ...F.muted }}>
              신뢰도 {Math.round((result.confidence ?? 0) * 100)}% · {result.source}
            </span>
          </div>

          {result.warnings && result.warnings.length > 0 && (
            <div style={{ marginBottom: SP.sm }}>
              {result.warnings.map((w, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, padding: '6px 10px', background: T.ylw+'10', border: `1px solid ${T.ylw}30`, borderRadius: R.sm, marginBottom: 4 }}>
                  <AlertTriangle size={11} strokeWidth={IC_STROKE} color={T.ylw} style={{ marginTop: 2, flexShrink: 0 }}/>
                  <span style={{ color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>{w}</span>
                </div>
              ))}
            </div>
          )}

          <pre style={{
            background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: R.sm, padding: 10,
            color: T.sub, fontSize: 10, lineHeight: 1.5,
            overflow: 'auto', maxHeight: 260,
            fontFamily: 'ui-monospace, monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {JSON.stringify(result.strategy, null, 2)}
          </pre>

          <div style={{ display: 'flex', gap: 6, marginTop: SP.sm }}>
            <button onClick={() => onParsed(result.strategy)}
              style={{ ...buttonStyle('primary','md'), flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <ChevronRight size={14} strokeWidth={IC_STROKE}/>
              편집기로 가져오기
            </button>
            <button onClick={() => setResult(null)}
              style={{ ...buttonStyle('ghost','md') }}>
              다시 작성
            </button>
          </div>

          <div style={{
            marginTop: SP.sm, padding: '8px 10px',
            background: T.ylw+'08', border: `1px solid ${T.ylw}30`,
            borderRadius: R.sm,
            display: 'flex', alignItems: 'flex-start', gap: 5,
          }}>
            <Info size={11} strokeWidth={IC_STROKE} color={T.ylw} style={{ marginTop: 2, flexShrink: 0 }}/>
            <span style={{ color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>
              AI는 바로 실행하지 않습니다. 편집기에서 확인 후 저장하면 모의투자 모드(비활성)로 등록됩니다.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 직접 빌더 (6단계)
// ─────────────────────────────────────────────────────────────
function ManualBuilder({
  initial, onSave, onCancel,
}: {
  initial: UserStrategy;
  onSave:  (s: UserStrategy) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState<UserStrategy>(initial);
  const [step, setStep] = useState<1|2|3|4|5|6>(1);
  const [exchanges, setExchanges] = useState<Array<{ id: string; label: string; exchange_id: string; is_paper: boolean; auto_trading_enabled: boolean; perm_trading: boolean; has_withdrawal: boolean }>>([]);
  const [exLoading, setExLoading] = useState(false);

  // initial 변경 시 갱신 (AI 결과 가져오기)
  useEffect(() => { setS(initial); setStep(1); }, [initial.id]);

  // 거래소 연결 목록 로드 (live 모드용)
  useEffect(() => {
    let cancelled = false;
    setExLoading(true);
    (async () => {
      try {
        let authHeader = '';
        try {
          const { getSupabaseClient } = await import('@/lib/supabase/client');
          const sbc = getSupabaseClient();
          if (sbc) {
            const { data } = await sbc.auth.getSession();
            if (data?.session?.access_token) authHeader = `Bearer ${data.session.access_token}`;
          }
        } catch {}
        const r = await fetch('/api/exchange?action=list', {
          headers: authHeader ? { Authorization: authHeader } : {},
        });
        const d = await r.json();
        if (!cancelled) setExchanges(Array.isArray(d.connections) ? d.connections : []);
      } catch {
        if (!cancelled) setExchanges([]);
      } finally {
        if (!cancelled) setExLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const update = useCallback((patch: Partial<UserStrategy>) => {
    setS(prev => ({ ...prev, ...patch, updatedAt: Date.now() }));
  }, []);

  const addCondition = useCallback(() => {
    update({ conditions: [...s.conditions, { indicator: 'RSI', operator: '<=', value: 30 }] });
  }, [s.conditions, update]);

  const updateCondition = useCallback((i: number, patch: Partial<StrategyCondition>) => {
    const next = [...s.conditions];
    next[i] = { ...next[i], ...patch };
    update({ conditions: next });
  }, [s.conditions, update]);

  const removeCondition = useCallback((i: number) => {
    if (s.conditions.length <= 1) return;
    update({ conditions: s.conditions.filter((_, idx) => idx !== i) });
  }, [s.conditions, update]);

  const submit = useCallback(() => {
    // 안전: 실전 모드면 거래소 선택 확인 + 명시적 확인
    if (s.mode === 'live') {
      if (!s.connectionId) {
        if (typeof window !== 'undefined') {
          window.alert('실전 매매는 거래소 연결을 선택해야 합니다.\n연결된 거래소가 없으면 먼저 거래소 연결 페이지에서 등록하세요.');
        }
        return;
      }
      const ok = typeof window !== 'undefined' && window.confirm(
        '⚠️ 실전 매매 모드로 저장합니다.\n\n' +
        '• 조건 충족 시 실제 자금으로 자동 주문이 실행됩니다\n' +
        '• 모든 손실은 전적으로 사용자 책임입니다\n' +
        '• 1회 주문 한도와 출금권한 차단 등 안전장치가 적용됩니다\n' +
        '• 저장 후에도 목록에서 활성화해야 작동합니다\n\n' +
        '계속하시겠습니까?'
      );
      if (!ok) return;
    }
    onSave(s);
  }, [s, onSave]);

  // ── 단계별 컴포넌트 ───────────────────────────────────────
  return (
    <div>
      {/* Step indicator */}
      <div style={{ display: 'flex', gap: 4, marginBottom: SP.md }}>
        {[1,2,3,4,5,6].map(i => (
          <div key={i} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i <= step ? T.acl : T.border,
            transition: 'background 200ms',
          }}/>
        ))}
      </div>
      <div style={{ ...F.caption, marginBottom: SP.sm }}>{step} / 6 단계</div>

      {/* Step 1: 종목 + 시장 */}
      {step === 1 && (
        <div style={cardStyle()}>
          <div style={{ ...F.section, marginBottom: SP.sm }}>1단계 — 종목 선택</div>
          <div style={{ ...F.caption, marginBottom: 6 }}>시장</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: SP.sm, flexWrap: 'wrap' }}>
            {(['crypto','stock','etf','futures','forex'] as const).map(m => {
              const active = s.market === m;
              return (
                <button key={m} onClick={() => update({ market: m, asset: ASSETS_BY_MARKET[m][0] })}
                  style={{ ...buttonStyle('ghost','sm'),
                    background: active ? T.acg : T.alt,
                    color:      active ? T.acl : T.muted,
                    border:    `1px solid ${active ? T.acl : T.border}` }}>
                  {MARKET_LABEL[m]}
                </button>
              );
            })}
          </div>
          <div style={{ ...F.caption, marginBottom: 6 }}>자산</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: SP.sm, flexWrap: 'wrap' }}>
            {ASSETS_BY_MARKET[s.market].map(a => {
              const active = s.asset === a;
              return (
                <button key={a} onClick={() => update({ asset: a })}
                  style={{ ...buttonStyle('ghost','sm'),
                    background: active ? T.acg : T.alt,
                    color:      active ? T.acl : T.txt,
                    border:    `1px solid ${active ? T.acl : T.border}`,
                    fontFamily: 'monospace' }}>
                  {a}
                </button>
              );
            })}
          </div>
          <div style={{ ...F.caption, marginBottom: 6 }}>직접 입력</div>
          <input value={s.asset}
            onChange={e => update({ asset: e.target.value.toUpperCase().trim() })}
            placeholder="BTC, AAPL, 005930…"
            style={{ width: '100%', boxSizing: 'border-box',
              padding: '10px 12px', background: T.bg, color: T.txt,
              border: `1px solid ${T.border}`, borderRadius: R.sm,
              fontSize: 13, fontFamily: 'monospace', outline: 'none' }}/>
        </div>
      )}

      {/* Step 2: 시간 + 액션 */}
      {step === 2 && (
        <div style={cardStyle()}>
          <div style={{ ...F.section, marginBottom: SP.sm }}>2단계 — 시간/액션</div>
          <div style={{ ...F.caption, marginBottom: 6 }}>시간 단위</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: SP.md, flexWrap: 'wrap' }}>
            {TIMEFRAMES.map(t => {
              const active = s.timeframe === t;
              return (
                <button key={t} onClick={() => update({ timeframe: t })}
                  style={{ ...buttonStyle('ghost','sm'),
                    background: active ? T.acg : T.alt,
                    color:      active ? T.acl : T.muted,
                    border:    `1px solid ${active ? T.acl : T.border}` }}>
                  {TIMEFRAME_LABEL[t]}
                </button>
              );
            })}
          </div>
          <div style={{ ...F.caption, marginBottom: 6 }}>액션</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['buy','sell'] as const).map(a => {
              const active = s.action === a;
              const color = a === 'buy' ? T.grn : T.red;
              return (
                <button key={a} onClick={() => update({ action: a })}
                  style={{ flex: 1, padding: '12px', minHeight: 46,
                    background: active ? color + '22' : T.alt,
                    color:      active ? color : T.muted,
                    border:    `1px solid ${active ? color : T.border}`,
                    borderRadius: R.md, fontWeight: 800, fontSize: 13,
                    cursor: 'pointer', touchAction: 'manipulation' }}>
                  {a === 'buy' ? '매수' : '매도'}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 3: 조건 */}
      {step === 3 && (
        <div style={cardStyle()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP.sm }}>
            <div style={F.section}>3단계 — 진입 조건 ({s.conditions.length})</div>
            <button onClick={addCondition}
              style={{ ...buttonStyle('ghost','sm'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Plus size={11} strokeWidth={IC_STROKE}/>조건 추가
            </button>
          </div>
          <div style={{ ...F.muted, marginBottom: SP.sm }}>모든 조건이 동시에 충족돼야 신호가 발생합니다 (AND).</div>
          {s.conditions.map((c, i) => (
            <div key={i} style={{ background: T.alt, border: `1px solid ${T.border}`, borderRadius: R.md, padding: SP.sm, marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                <select value={c.indicator}
                  onChange={e => updateCondition(i, { indicator: e.target.value as IndicatorName })}
                  style={{ flex: 1, minWidth: 120, background: T.bg, color: T.txt,
                    border: `1px solid ${T.border}`, borderRadius: R.sm, padding: '6px 8px', fontSize: 11 }}>
                  {(Object.keys(INDICATOR_LABEL) as IndicatorName[]).map(k => (
                    <option key={k} value={k}>{INDICATOR_LABEL[k]}</option>
                  ))}
                </select>
                <select value={c.operator || c.signal || ''}
                  onChange={e => {
                    const v = e.target.value;
                    if (['golden_cross','dead_cross','volume_surge','volatility_spike'].includes(v)) {
                      updateCondition(i, { signal: v, operator: undefined });
                    } else {
                      updateCondition(i, { operator: v as Operator, signal: undefined });
                    }
                  }}
                  style={{ flex: 1, minWidth: 100, background: T.bg, color: T.txt,
                    border: `1px solid ${T.border}`, borderRadius: R.sm, padding: '6px 8px', fontSize: 11 }}>
                  {(Object.keys(OPERATOR_LABEL) as Operator[]).map(k => (
                    <option key={k} value={k}>{OPERATOR_LABEL[k]}</option>
                  ))}
                </select>
                {c.operator && ['<=','<','>=','>','=='].includes(c.operator) && (
                  <input type="number"
                    value={c.value ?? ''}
                    onChange={e => updateCondition(i, { value: parseFloat(e.target.value) })}
                    style={{ width: 80, background: T.bg, color: T.txt,
                      border: `1px solid ${T.border}`, borderRadius: R.sm, padding: '6px 8px', fontSize: 11, fontFamily: 'monospace' }}/>
                )}
                {s.conditions.length > 1 && (
                  <button onClick={() => removeCondition(i)}
                    aria-label="조건 제거"
                    style={{ background: T.red+'15', color: T.red, border: 'none', borderRadius: R.sm, padding: '6px 10px', cursor: 'pointer', minHeight: 32 }}>
                    <Trash2 size={11} strokeWidth={IC_STROKE}/>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Step 4: 주문 */}
      {step === 4 && (
        <div style={cardStyle()}>
          <div style={{ ...F.section, marginBottom: SP.sm }}>4단계 — 주문</div>
          <div style={{ ...F.caption, marginBottom: 6 }}>주문 유형</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: SP.md }}>
            {(['market','limit'] as const).map(t => {
              const active = s.order.type === t;
              return (
                <button key={t} onClick={() => update({ order: { ...s.order, type: t } })}
                  style={{ flex: 1, padding: '10px', minHeight: 42,
                    background: active ? T.acg : T.alt,
                    color:      active ? T.acl : T.muted,
                    border:    `1px solid ${active ? T.acl : T.border}`,
                    borderRadius: R.md, fontWeight: 700, fontSize: 12,
                    cursor: 'pointer', touchAction: 'manipulation' }}>
                  {t === 'market' ? '시장가' : '지정가'}
                </button>
              );
            })}
          </div>
          <div style={{ ...F.caption, marginBottom: 6 }}>주문 금액 ({s.order.currency})</div>
          <input type="number" value={s.order.amount}
            onChange={e => update({ order: { ...s.order, amount: parseFloat(e.target.value) || 0 } })}
            style={{ width: '100%', boxSizing: 'border-box', background: T.bg, color: T.txt,
              border: `1px solid ${T.border}`, borderRadius: R.sm, padding: '10px 12px',
              fontSize: 14, fontFamily: 'monospace', outline: 'none', marginBottom: SP.sm }}/>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[50000, 100000, 200000, 500000, 1000000].map(v => (
              <button key={v}
                onClick={() => update({ order: { ...s.order, amount: v } })}
                style={{ ...buttonStyle('ghost','sm'), background: T.alt, color: T.muted, fontSize: 10 }}>
                ₩{(v/10000).toFixed(0)}만
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 5: 리스크 */}
      {step === 5 && (
        <div style={cardStyle()}>
          <div style={{ ...F.section, marginBottom: SP.sm }}>5단계 — 리스크 관리</div>
          {[
            { key: 'takeProfitPct',   label: '익절 (%)',           color: T.grn, min: 0.5, max: 50, step: 0.5 },
            { key: 'stopLossPct',     label: '손절 (%)',           color: T.red, min: 0.5, max: 50, step: 0.5 },
            { key: 'maxDailyLossPct', label: '일일 최대 손실 (%)', color: T.ylw, min: 1,   max: 100, step: 1   },
          ].map(({ key, label, color, min, max, step }) => (
            <div key={key} style={{ marginBottom: SP.md }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={F.caption}>{label}</span>
                <span style={{ color, fontWeight: 800, fontSize: 14 }}>
                  {(s.risk as any)[key] ?? '—'}%
                </span>
              </div>
              <input type="range" min={min} max={max} step={step}
                value={(s.risk as any)[key] ?? 0}
                onChange={e => update({ risk: { ...s.risk, [key]: parseFloat(e.target.value) } })}
                style={{ width: '100%', accentColor: color }}/>
            </div>
          ))}
        </div>
      )}

      {/* Step 6: 확인 */}
      {step === 6 && (
        <div style={cardStyle()}>
          <div style={{ ...F.section, marginBottom: SP.sm }}>6단계 — 확인 및 저장</div>

          <div style={{ marginBottom: SP.sm }}>
            <div style={{ ...F.caption, marginBottom: 4 }}>전략 이름</div>
            <input value={s.name} onChange={e => update({ name: e.target.value })}
              style={{ width: '100%', boxSizing: 'border-box', background: T.bg, color: T.txt,
                border: `1px solid ${T.border}`, borderRadius: R.sm, padding: '10px 12px',
                fontSize: 13, outline: 'none' }}/>
          </div>

          <div style={{ ...F.caption, marginBottom: 6 }}>실행 모드</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: SP.md }}>
            {(['paper','live'] as const).map(m => {
              const active = s.mode === m;
              const color = m === 'paper' ? T.grn : T.red;
              return (
                <button key={m} onClick={() => update({ mode: m })}
                  style={{ flex: 1, padding: '12px', minHeight: 50,
                    background: active ? color + '22' : T.alt,
                    color:      active ? color : T.muted,
                    border:    `1px solid ${active ? color : T.border}`,
                    borderRadius: R.md, fontWeight: 800, fontSize: 12,
                    cursor: 'pointer', touchAction: 'manipulation',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <span>{m === 'paper' ? '모의투자' : '실전매매'}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, opacity: 0.8 }}>
                    {m === 'paper' ? '안전 (가상 자금)' : '실제 자금'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* live 모드: 거래소 연결 선택 */}
          {s.mode === 'live' && (
            <div style={{ marginBottom: SP.md }}>
              <div style={{ ...F.caption, marginBottom: 6 }}>거래소 연결</div>
              {exLoading ? (
                <div style={{ ...F.body, color: T.muted, padding: SP.sm }}>거래소 목록 불러오는 중…</div>
              ) : exchanges.length === 0 ? (
                <div style={{ background: T.red+'10', border: `1px solid ${T.red}30`, borderRadius: R.md, padding: SP.sm }}>
                  <div style={{ color: T.red, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>연결된 거래소가 없습니다</div>
                  <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5 }}>
                    더보기 → 거래소 연결에서 먼저 API 키를 등록하세요. 실전 매매는 거래소 연결이 필수입니다.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {exchanges.map(ex => {
                    const active = s.connectionId === ex.id;
                    const usable = ex.perm_trading && !ex.is_paper && ex.auto_trading_enabled && !ex.has_withdrawal;
                    return (
                      <button key={ex.id}
                        onClick={() => update({ connectionId: ex.id })}
                        disabled={!usable}
                        style={{
                          textAlign: 'left', padding: '11px 13px', minHeight: 56,
                          background: active ? T.acc+'20' : T.alt,
                          border: `1px solid ${active ? T.acl : T.border}`,
                          borderRadius: R.md, cursor: usable ? 'pointer' : 'not-allowed',
                          opacity: usable ? 1 : 0.55,
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: active ? T.acl : T.txt, fontWeight: 800, fontSize: 12 }}>
                            {ex.label || ex.exchange_id}
                          </div>
                          <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>
                            {ex.exchange_id?.toUpperCase()}
                          </div>
                        </div>
                        <div style={{ flexShrink: 0, textAlign: 'right' }}>
                          {!usable ? (
                            <span style={{ fontSize: 9, fontWeight: 700, color: T.red }}>
                              {ex.is_paper ? '모의 연결' :
                               ex.has_withdrawal ? '출금권한 키 차단' :
                               !ex.perm_trading ? '거래권한 없음' :
                               !ex.auto_trading_enabled ? '자동매매 OFF' : '사용 불가'}
                            </span>
                          ) : active ? (
                            <span style={{ fontSize: 10, fontWeight: 800, color: T.grn }}>✓ 선택됨</span>
                          ) : (
                            <span style={{ fontSize: 9, color: T.muted }}>선택</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: R.md, padding: SP.sm, marginBottom: SP.md }}>
            <div style={{ ...F.caption, marginBottom: 6 }}>전략 요약</div>
            <div style={{ ...F.body, color: T.txt, lineHeight: 1.7 }}>
              <strong>{s.asset}</strong> ({MARKET_LABEL[s.market]}) · {TIMEFRAME_LABEL[s.timeframe]}<br/>
              조건 {s.conditions.length}개 만족 시 <strong style={{ color: s.action === 'buy' ? T.grn : T.red }}>{s.action === 'buy' ? '매수' : '매도'}</strong><br/>
              주문 금액: ₩{s.order.amount.toLocaleString('ko-KR')} ({s.order.type === 'market' ? '시장가' : '지정가'})<br/>
              익절 {s.risk.takeProfitPct}% · 손절 {s.risk.stopLossPct}%
            </div>
          </div>

          {/* 경고 */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: SP.sm, background: T.ylw+'10', border: `1px solid ${T.ylw}30`, borderRadius: R.sm, marginBottom: SP.sm }}>
            <AlertTriangle size={13} strokeWidth={IC_STROKE} color={T.ylw} style={{ marginTop: 2, flexShrink: 0 }}/>
            <span style={{ color: T.ylw, fontSize: 11, lineHeight: 1.5 }}>
              저장 후 비활성 상태로 등록됩니다. 목록에서 토글로 활성화하세요.
              {s.mode === 'live' && ' 실전 모드는 거래소 API 연결이 필요합니다.'}
            </span>
          </div>
        </div>
      )}

      {/* 네비게이션 */}
      <div style={{ display: 'flex', gap: 6, marginTop: SP.md }}>
        <button onClick={onCancel}
          style={{ ...buttonStyle('ghost','md'), padding: '12px 16px' }}>
          취소
        </button>
        {step > 1 && (
          <button onClick={() => setStep((step - 1) as any)}
            style={{ ...buttonStyle('ghost','md'), flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <ChevronLeft size={14} strokeWidth={IC_STROKE}/>이전
          </button>
        )}
        {step < 6 && (
          <button onClick={() => setStep((step + 1) as any)}
            style={{ ...buttonStyle('primary','md'), flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            다음<ChevronRight size={14} strokeWidth={IC_STROKE}/>
          </button>
        )}
        {step === 6 && (
          <button onClick={submit}
            style={{ ...buttonStyle('primary','md'), flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <CheckCircle2 size={14} strokeWidth={IC_STROKE}/>저장
          </button>
        )}
      </div>
    </div>
  );
}

export default function StrategyBuilderPage(props: { onNav?: (tab: string) => void }) {
  return <ErrorBoundary><StrategyBuilderInner {...props}/></ErrorBoundary>;
}
