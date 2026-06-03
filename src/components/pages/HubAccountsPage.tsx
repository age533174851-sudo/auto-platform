'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Landmark, Siren, RefreshCw, BarChart3, Wallet, Repeat,
  TriangleAlert, ShieldAlert, Bot, Activity, Briefcase, Banknote,
  TrendingUp, TrendingDown, Coins, Building2, Power, CircleCheck,
  ChevronUp, ChevronDown, Settings2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { safeNumber, formatKRW } from '@/lib/format';
import {
  loadHubState, saveHubState, resetHubState,
  totalBalance, totalTodayPnl, positionUnrealized, accountUnrealized, previewTransfer,
} from '@/lib/accounts/store';
import type { HubState, HubAccount, AccountKind, SellScope } from '@/lib/accounts/types';
import { ACCOUNT_KIND_META } from '@/lib/accounts/types';
import { executeSell, SELL_SCOPE_LABEL, SELL_SCOPE_DESC } from '@/lib/accounts/sellActions';
import { executeEmergency, deactivateEmergency } from '@/lib/accounts/emergencyExit';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import type { IconTone } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';

// 계좌 종류별 아이콘 + 토 매핑
const KIND_ICON: Record<AccountKind, { Icon: LucideIcon; tone: IconTone }> = {
  shortterm: { Icon: Activity,   tone: 'yellow' },
  longterm:  { Icon: Briefcase,  tone: 'blue'   },
  cash:      { Icon: Banknote,   tone: 'gray'   },
  crypto:    { Icon: Coins,      tone: 'yellow' },
  stock:     { Icon: Building2,  tone: 'green'  },
  autobot:   { Icon: Bot,        tone: 'purple' },
};

// ─── 숫자 표시 컴포넌트들 ───
function Pct({ value, plus = true }: { value: number; plus?: boolean }) {
  const v = safeNumber(value, 0);
  const color = v > 0 ? T.grn : v < 0 ? T.red : T.sub;
  const sign = v > 0 && plus ? '+' : '';
  return <span style={{ color, fontWeight: 700 }}>{sign}{v.toFixed(2)}%</span>;
}

function KRW({ value, plus = false }: { value: number; plus?: boolean }) {
  const v = safeNumber(value, 0);
  const color = plus ? (v > 0 ? T.grn : v < 0 ? T.red : T.txt) : T.txt;
  const sign  = plus && v > 0 ? '+' : '';
  return <span style={{ color, fontWeight: 700 }}>{sign}{formatKRW(v)}</span>;
}

// 도넛
function Donut({ data, total, size = 140 }: { data: { value: number; color: string }[]; total: number; size?: number }) {
  const safe = Array.isArray(data) ? data : [];
  if (safe.length === 0 || total <= 0) {
    return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: T.alt, color: T.muted, fontSize: 11 }}>—</div>;
  }
  const cx = size/2, cy = size/2, r = size/2 - 12, stroke = 18;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.alt} strokeWidth={stroke} />
      {safe.map((d, i) => {
        const len = C * (total > 0 ? d.value/total : 0);
        const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color} strokeWidth={stroke} strokeDasharray={`${len} ${C-len}`} strokeDashoffset={-offset} />;
        offset += len;
        return el;
      })}
    </svg>
  );
}

function RiskBadge({ level }: { level: HubAccount['riskLevel'] }) {
  const map: Record<string, { color: string; label: string }> = {
    low:     { color: T.grn,     label: '낮음' },
    mid:     { color: T.ylw,     label: '보통' },
    high:    { color: '#FB923C', label: '높음' },
    extreme: { color: T.red,     label: '매우 위험' },
  };
  const m = map[level] || map.mid;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, color: m.color, background: m.color + '22', padding: '3px 8px', borderRadius: R.pill }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color }} />
      {m.label}
    </span>
  );
}

// ────────────────────────────────────────────────────────────
function HubAccountsPageInner() {
  const [state, setState] = useState<HubState | null>(null);
  const [tab, setTab] = useState<'dashboard'|'sell'|'transfer'>('dashboard');
  const [sellScope, setSellScope] = useState<SellScope>('shortterm_only');
  const [sellRatio, setSellRatio] = useState<25|50|75|100>(100);
  const [sellConfirmOpen, setSellConfirmOpen] = useState(false);
  const [sellConfirmText, setSellConfirmText] = useState('');
  const [sellResultMsg, setSellResultMsg] = useState<string | null>(null);

  const [emergencyStep, setEmergencyStep] = useState<0|1|2>(0);
  const [emergencyOpts, setEmergencyOpts] = useState({ closeSpot: false, closeLongterm: false });
  const [emergencyResult, setEmergencyResult] = useState<{ msg: string; data: ReturnType<typeof executeEmergency>['result'] } | null>(null);

  useEffect(() => {
    try { setState(loadHubState()); }
    catch (e) { console.error('[hub] load', e); setState(loadHubState()); }
  }, []);

  const persist = useCallback((next: HubState) => {
    setState(next);
    try { saveHubState(next); } catch (e) { console.warn('[hub] save', e); }
  }, []);

  const totals = useMemo(() => {
    if (!state) return { total: 0, today: 0, accounts: [] as HubAccount[] };
    return {
      total:    totalBalance(state),
      today:    totalTodayPnl(state),
      accounts: Array.isArray(state.accounts) ? state.accounts : [],
    };
  }, [state]);

  const donutData = useMemo(() => {
    return totals.accounts
      .filter(a => safeNumber(a.balance) > 0)
      .map(a => ({ value: a.balance, color: a.color }));
  }, [totals.accounts]);

  const shortAcc = useMemo(() => totals.accounts.find(a => a.kind === 'shortterm'), [totals.accounts]);
  const transferPreview = useMemo(() => {
    if (!state || !shortAcc) return { toLong: 0, toCash: 0, keep: 0 };
    return previewTransfer(Math.max(0, safeNumber(shortAcc.todayPnl)), state.transferRule);
  }, [state, shortAcc]);

  const onSellConfirm = () => {
    if (!state) return;
    if (sellConfirmText.trim() !== '정리') {
      setSellResultMsg('"정리"라고 정확히 입력해야 실행됩니다.');
      return;
    }
    const r = executeSell(state, sellScope, sellRatio);
    persist(r.state);
    setSellResultMsg(`매도 완료 — ${r.closedCount}건 청산, ${r.reducedCount}건 부분 매도, 실현손익 ${formatKRW(r.totalRealized)} (현금 회수 ${formatKRW(r.totalCashReturned)})`);
    setSellConfirmOpen(false);
    setSellConfirmText('');
  };

  const onEmergencyConfirm = () => {
    if (!state) return;
    const r = executeEmergency(state, emergencyOpts);
    persist(r.state);
    setEmergencyResult({
      msg: `긴급 탈출 완료 — 봇 ${r.result.stoppedBots}개 정지 · 선물 ${r.result.closedPerpPositions}건 종료 · 현금 회수 ${formatKRW(r.result.cashRecovered)}`,
      data: r.result,
    });
    setEmergencyStep(0);
  };

  const onTransferExecute = () => {
    if (!state || !shortAcc) return;
    const { toLong, toCash } = transferPreview;
    if (toLong + toCash <= 0) return;
    const newAccs: HubAccount[] = state.accounts.map(a => {
      if (a.id === shortAcc.id)  return { ...a, cash: Math.max(0, a.cash - toLong - toCash) };
      if (a.kind === 'longterm') return { ...a, cash: a.cash + toLong, balance: a.balance + toLong };
      if (a.kind === 'cash')     return { ...a, cash: a.cash + toCash, balance: a.balance + toCash };
      return a;
    });
    persist({ ...state, accounts: newAccs });
  };

  const setRulePart = (key: 'toLongterm'|'toCash', value: number) => {
    if (!state) return;
    const v = Math.max(0, Math.min(100, value));
    const other = key === 'toLongterm' ? state.transferRule.toCash : state.transferRule.toLongterm;
    const otherClamped = Math.min(other, 100 - v);
    const newRule = {
      ...state.transferRule,
      [key]: v,
      ...(key === 'toLongterm' ? { toCash: otherClamped } : { toLongterm: otherClamped }),
    };
    persist({ ...state, transferRule: newRule });
  };

  if (!state) {
    return <div style={{ padding: '40px 20px', textAlign: 'center', color: T.muted, fontSize: 13 }}>로딩 중...</div>;
  }

  return (
    <div style={PAGE_STYLE}>
      {/* ─── 헤더 ─── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP.md, gap: SP.sm, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm }}>
          <IconBox tone="blue" size="md"><Landmark size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
          <div>
            <div style={F.title}>통합 운용</div>
            <div style={F.caption}>단타 + 장투 · 긴급 탈출 · 수익 자동 이동</div>
          </div>
        </div>
        <button
          onClick={() => { if (confirm('계좌 데이터를 초기 mock 상태로 되돌립니다. 진행할까요?')) persist(resetHubState()); }}
          style={{ ...buttonStyle('ghost', 'sm'), gap: 6 }}
        >
          <RefreshCw size={14} strokeWidth={IC_STROKE} /> 초기화
        </button>
      </div>

      {/* ─── 긴급 모드 배너 ─── */}
      {state.emergencyMode && (
        <div style={{ background: T.red + '15', border: `1px solid ${T.red}55`, borderRadius: R.md, padding: SP.md, marginBottom: SP.md, display: 'flex', gap: SP.sm, alignItems: 'center' }}>
          <IconBox tone="red" size="md"><Siren size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...F.section, color: T.red }}>긴급 탈출 모드 활성화 중</div>
            <div style={F.muted}>자동매매가 모두 정지되었습니다. 시장 안정 확인 후 해제하세요.</div>
          </div>
          <button onClick={() => persist(deactivateEmergency(state))} style={buttonStyle('ghost', 'sm')}>해제</button>
        </div>
      )}

      {/* ─── 탭 ─── */}
      <div style={{ display: 'flex', gap: SP.xs, marginBottom: SP.md, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {([
          ['dashboard', '대시보드',    BarChart3],
          ['sell',      '한 번에 파기', TriangleAlert],
          ['transfer',  '수익 이동',    Repeat],
        ] as const).map(([id, label, Ic]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ ...buttonStyle(tab === id ? 'primary' : 'ghost', 'md'),
              flexShrink: 0,
              background: tab === id ? T.acg : 'transparent',
              color:      tab === id ? T.acl : T.sub,
              border:     `1px solid ${tab === id ? T.acl : T.border}`,
            }}>
            <Ic size={IC_SIZE.sm} strokeWidth={IC_STROKE} /> {label}
          </button>
        ))}
      </div>

      {/* ─── 대시보드 ─── */}
      {tab === 'dashboard' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.md }}>
          {/* 전체 자산 카드 */}
          <div style={cardStyle()}>
            <div style={{ display: 'flex', gap: SP.lg, alignItems: 'center' }}>
              <Donut data={donutData} total={totals.total} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Wallet size={14} strokeWidth={IC_STROKE} color={T.sub} />
                  <span style={F.caption}>총 자산</span>
                </div>
                <div style={{ ...F.numXL, marginTop: 4 }}>{formatKRW(totals.total)}</div>
                <div style={{ marginTop: 6, ...F.body, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {totals.today >= 0
                    ? <TrendingUp size={14} strokeWidth={IC_STROKE} color={T.grn} />
                    : <TrendingDown size={14} strokeWidth={IC_STROKE} color={T.red} />}
                  <span style={F.caption}>오늘 </span>
                  <KRW value={totals.today} plus />
                </div>
              </div>
            </div>

            {/* 계좌 비중 미니 리스트 */}
            <div style={{ marginTop: SP.md, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {totals.accounts.filter(a => a.balance > 0).map(a => {
                const pct = totals.total > 0 ? (a.balance / totals.total) * 100 : 0;
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, ...F.muted }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: a.color, display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ color: T.sub }}>{a.name}</span>
                    <span style={{ marginLeft: 'auto', color: T.txt, fontWeight: 700 }}>{pct.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 긴급 탈출 카드 */}
          <button
            onClick={() => setEmergencyStep(1)}
            disabled={state.emergencyMode}
            style={{
              ...buttonStyle('danger', 'lg'),
              padding: '20px',
              fontSize: 15,
              fontWeight: 800,
              gap: 8,
              opacity: state.emergencyMode ? 0.5 : 1,
              cursor: state.emergencyMode ? 'not-allowed' : 'pointer',
              boxShadow: state.emergencyMode ? 'none' : `0 0 0 1px ${T.red}55, 0 6px 20px ${T.red}33`,
              width: '100%',
            }}
          >
            <Siren size={20} strokeWidth={IC_STROKE} />
            긴급 탈출
          </button>

          {/* 계좌 카드들 */}
          {totals.accounts.map(acc => <AccountCard key={acc.id} acc={acc} />)}
        </div>
      )}

      {/* ─── 한 번에 파기 ─── */}
      {tab === 'sell' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.md }}>
          <div style={cardStyle()}>
            <div style={F.section}>1. 매도 범위</div>
            <div style={{ ...F.muted, marginTop: 4, marginBottom: SP.md }}>대상이 될 포지션을 고릅니다.</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: SP.sm }}>
              {(Object.keys(SELL_SCOPE_LABEL) as SellScope[]).map(s => {
                const active = sellScope === s;
                return (
                  <button key={s} onClick={() => setSellScope(s)} style={{
                    padding: SP.md, minHeight: 68,
                    background: active ? T.acg : T.alt,
                    border: `1px solid ${active ? T.acl : T.border}`,
                    borderRadius: R.md,
                    color: active ? T.acl : T.txt,
                    cursor: 'pointer',
                    textAlign: 'left',
                    touchAction: 'manipulation',
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{SELL_SCOPE_LABEL[s]}</div>
                    <div style={{ color: T.muted, fontSize: 10, fontWeight: 500, marginTop: 4, lineHeight: 1.3 }}>{SELL_SCOPE_DESC[s]}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={cardStyle()}>
            <div style={F.section}>2. 매도 비율</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP.sm, marginTop: SP.md }}>
              {([25,50,75,100] as const).map(r => {
                const active = sellRatio === r;
                return (
                  <button key={r} onClick={() => setSellRatio(r)} style={{
                    padding: '14px 6px', minHeight: 48,
                    background: active ? T.acg : T.alt,
                    border: `1px solid ${active ? T.acl : T.border}`,
                    borderRadius: R.md,
                    color: active ? T.acl : T.txt,
                    fontSize: 15, fontWeight: 800, cursor: 'pointer',
                    touchAction: 'manipulation',
                  }}>{r}%</button>
                );
              })}
            </div>
          </div>

          <SellPreview state={state} scope={sellScope} ratio={sellRatio} />

          {sellResultMsg && (
            <div style={{ background: T.acg, border: `1px solid ${T.acl}`, borderRadius: R.md, padding: SP.md, display: 'flex', alignItems: 'flex-start', gap: SP.sm }}>
              <CircleCheck size={18} strokeWidth={IC_STROKE} color={T.acl} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ color: T.acl, fontSize: 12 }}>{sellResultMsg}</div>
            </div>
          )}

          <button onClick={() => { setSellResultMsg(null); setSellConfirmOpen(true); setSellConfirmText(''); }}
            style={{ ...buttonStyle('warn', 'lg'), gap: 8, width: '100%' }}>
            <TriangleAlert size={18} strokeWidth={IC_STROKE} />
            매도 실행 (확인 필요)
          </button>
        </div>
      )}

      {/* ─── 수익 이동 ─── */}
      {tab === 'transfer' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.md }}>
          <div style={cardStyle()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm }}>
              <IconBox tone="blue" size="sm"><Repeat size={IC_SIZE.sm} strokeWidth={IC_STROKE} /></IconBox>
              <div style={F.section}>단타 수익 자동 이동 룰</div>
            </div>
            <div style={{ ...F.muted, marginTop: 6, marginBottom: SP.md }}>
              단타로 번 돈이 계속 사라지지 않게 — 일부를 자동으로 장투/현금으로 옮깁니다.
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md, cursor: 'pointer', minHeight: 44 }}>
              <input type="checkbox" checked={state.transferRule.enabled}
                onChange={(e) => persist({ ...state, transferRule: { ...state.transferRule, enabled: e.target.checked } })}
                style={{ width: 20, height: 20 }} />
              <span style={F.body}>자동 이동 활성화</span>
            </label>

            <div style={{ opacity: state.transferRule.enabled ? 1 : 0.5, pointerEvents: state.transferRule.enabled ? 'auto' : 'none' }}>
              <SliderRow label="장투 계좌로" value={state.transferRule.toLongterm} color={T.acl} onChange={v => setRulePart('toLongterm', v)} />
              <SliderRow label="현금 보관"   value={state.transferRule.toCash}     color={T.sub} onChange={v => setRulePart('toCash', v)} />
              <SliderRow label="단타 재투자(자동)" value={Math.max(0, 100 - state.transferRule.toLongterm - state.transferRule.toCash)} color={T.ylw} disabled />
            </div>
          </div>

          <div style={cardStyle()}>
            <div style={F.section}>오늘 분배 미리보기</div>
            <div style={{ ...F.muted, marginTop: 4, marginBottom: SP.md, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              단타 계좌 오늘 손익: <KRW value={shortAcc?.todayPnl || 0} plus />
            </div>

            <PreviewRow color={T.acl} label="장투 계좌로" value={transferPreview.toLong} />
            <PreviewRow color={T.sub} label="현금 보관"   value={transferPreview.toCash} />
            <PreviewRow color={T.ylw} label="단타 재투자" value={transferPreview.keep} />

            <button
              onClick={onTransferExecute}
              disabled={!state.transferRule.enabled || (transferPreview.toLong + transferPreview.toCash) <= 0}
              style={{ ...buttonStyle('primary', 'lg'), width: '100%', marginTop: SP.md, gap: 6,
                opacity: (state.transferRule.enabled && (transferPreview.toLong + transferPreview.toCash) > 0) ? 1 : 0.4 }}
            >
              <Repeat size={16} strokeWidth={IC_STROKE} /> 지금 이동 실행
            </button>
          </div>
        </div>
      )}

      {/* ─── 매도 확인 모달 ─── */}
      {sellConfirmOpen && (
        <Modal onClose={() => setSellConfirmOpen(false)}>
          <ModalHeader Icon={TriangleAlert} title="매도 확인" tone="yellow" />
          <div style={{ ...F.body, marginTop: SP.sm, lineHeight: 1.6 }}>
            <b>{SELL_SCOPE_LABEL[sellScope]}</b>의 포지션을 <b>{sellRatio}%</b> 매도하시겠습니까?
          </div>
          <div style={{ ...F.muted, marginTop: 4 }}>이 작업은 되돌릴 수 없습니다.</div>
          <div style={{ ...F.caption, marginTop: SP.md, color: T.sub }}>확인하려면 <b style={{ color: T.red }}>정리</b>라고 입력</div>
          <input
            type="text" value={sellConfirmText} onChange={e => setSellConfirmText(e.target.value)}
            placeholder='"정리"'
            style={{ width: '100%', padding: 12, background: T.alt, border: `1px solid ${T.border}`, borderRadius: R.md, color: T.txt, fontSize: 14, marginTop: 8, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: SP.sm, marginTop: SP.md }}>
            <button onClick={() => setSellConfirmOpen(false)} style={{ ...buttonStyle('ghost'), flex: 1 }}>취소</button>
            <button onClick={onSellConfirm} disabled={sellConfirmText.trim() !== '정리'} style={{ ...buttonStyle('danger'), flex: 1, opacity: sellConfirmText.trim()==='정리' ? 1 : 0.4 }}>실행</button>
          </div>
        </Modal>
      )}

      {/* ─── 긴급 탈출 1차 ─── */}
      {emergencyStep === 1 && (
        <Modal onClose={() => setEmergencyStep(0)}>
          <ModalHeader Icon={Siren} title="긴급 탈출 — 1차 확인" tone="red" />
          <div style={{ ...F.body, marginTop: SP.md, lineHeight: 1.6 }}>
            다음 작업이 자동 실행됩니다:
            <ul style={{ marginTop: 8, paddingLeft: 18, color: T.sub }}>
              <li>모든 자동매매 봇 정지</li>
              <li>모든 선물 포지션 시장가 종료</li>
              <li>레버리지 포지션 우선 정리</li>
              <li>현물/장투 매도는 아래에서 선택</li>
            </ul>
          </div>

          <div style={{ marginTop: SP.md, padding: SP.sm + 2, background: T.alt, borderRadius: R.md }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: SP.sm, cursor: 'pointer', padding: '6px 0', minHeight: 44 }}>
              <input type="checkbox" checked={emergencyOpts.closeSpot}
                onChange={e => setEmergencyOpts(o => ({ ...o, closeSpot: e.target.checked }))}
                style={{ width: 18, height: 18 }} />
              <span style={F.body}>코인 현물도 함께 매도</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: SP.sm, cursor: 'pointer', padding: '6px 0', minHeight: 44 }}>
              <input type="checkbox" checked={emergencyOpts.closeLongterm}
                onChange={e => setEmergencyOpts(o => ({ ...o, closeLongterm: e.target.checked }))}
                style={{ width: 18, height: 18 }} />
              <span style={F.body}>장투 포지션도 함께 매도 <span style={{ color: T.ylw, fontSize: 10 }}>(신중)</span></span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: SP.sm, marginTop: SP.md }}>
            <button onClick={() => setEmergencyStep(0)} style={{ ...buttonStyle('ghost'), flex: 1 }}>취소</button>
            <button onClick={() => setEmergencyStep(2)} style={{ ...buttonStyle('danger'), flex: 1 }}>다음</button>
          </div>
        </Modal>
      )}

      {/* ─── 긴급 탈출 2차 ─── */}
      {emergencyStep === 2 && (
        <Modal onClose={() => setEmergencyStep(0)}>
          <ModalHeader Icon={ShieldAlert} title="최종 확인" tone="red" />
          <div style={{ ...F.body, marginTop: SP.md, lineHeight: 1.6 }}>
            정말 실행하시겠습니까? 시장가 청산이므로 슬리피지가 발생할 수 있습니다.
          </div>
          <div style={{ marginTop: SP.sm, padding: SP.sm + 2, background: T.red + '15', border: `1px solid ${T.red}55`, borderRadius: R.md, color: T.red, fontSize: 11, fontWeight: 700 }}>
            현물 매도: {emergencyOpts.closeSpot ? 'ON' : 'OFF'} · 장투 매도: {emergencyOpts.closeLongterm ? 'ON' : 'OFF'}
          </div>
          <div style={{ display: 'flex', gap: SP.sm, marginTop: SP.md }}>
            <button onClick={() => setEmergencyStep(1)} style={{ ...buttonStyle('ghost'), flex: 1 }}>뒤로</button>
            <button onClick={onEmergencyConfirm} style={{ ...buttonStyle('danger'), flex: 1, gap: 6 }}>
              <Power size={16} strokeWidth={IC_STROKE} /> 실행
            </button>
          </div>
        </Modal>
      )}

      {/* ─── 긴급 탈출 결과 ─── */}
      {emergencyResult && (
        <Modal onClose={() => setEmergencyResult(null)}>
          <ModalHeader Icon={CircleCheck} title="실행 완료" tone="blue" />
          <div style={{ ...F.body, marginTop: SP.sm }}>{emergencyResult.msg}</div>

          <div style={{ marginTop: SP.md, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP.sm }}>
            <ResultStat label="정지된 봇"     value={`${emergencyResult.data.stoppedBots}개`} />
            <ResultStat label="선물 종료"     value={`${emergencyResult.data.closedPerpPositions}건`} />
            <ResultStat label="레버리지 정리" value={`${emergencyResult.data.closedLeveraged}건`} />
            <ResultStat label="현물 매도"     value={`${emergencyResult.data.closedSpot}건`} />
            <ResultStat label="유지된 포지션" value={`${emergencyResult.data.notClosed}건`} />
            <ResultStat label="실현손익"      value={formatKRW(emergencyResult.data.realizedPnl)} color={emergencyResult.data.realizedPnl >= 0 ? T.grn : T.red} />
          </div>
          <div style={{ marginTop: SP.sm, padding: SP.sm + 2, background: T.grn + '15', borderRadius: R.md, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: T.sub, fontSize: 11 }}>현금 회수</span>
            <span style={{ color: T.grn, fontWeight: 800, fontSize: 16 }}>{formatKRW(emergencyResult.data.cashRecovered)}</span>
          </div>

          <button onClick={() => setEmergencyResult(null)} style={{ ...buttonStyle('primary', 'lg'), width: '100%', marginTop: SP.md }}>확인</button>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 보조 컴포넌트
// ─────────────────────────────────────────────────────────────

function AccountCard({ acc }: { acc: HubAccount }) {
  const [expanded, setExpanded] = useState(false);
  const meta = ACCOUNT_KIND_META[acc.kind];
  const iconMeta = KIND_ICON[acc.kind];
  const Ic = iconMeta.Icon;
  const unrl = accountUnrealized(acc);
  const positions = Array.isArray(acc.positions) ? acc.positions : [];

  return (
    <div style={cardStyle()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm + 2 }}>
        <IconBox tone={iconMeta.tone} size="md"><Ic size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={F.section}>{acc.name}</div>
          <div style={{ ...F.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.desc}</div>
        </div>
        <RiskBadge level={acc.riskLevel} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP.sm, marginTop: SP.md }}>
        <Stat label="평가금액"    value={formatKRW(acc.balance)} />
        <Stat label="오늘 손익"   value={<KRW value={acc.todayPnl} plus />} />
        <Stat label="누적 수익률" value={<Pct value={acc.cumulativeReturn} />} />
        <Stat label="실현손익"    value={<KRW value={acc.realizedPnl} plus />} />
        <Stat label="미실현손익"  value={<KRW value={unrl} plus />} />
        <Stat label="포지션"      value={`${positions.length}개`} />
      </div>

      {acc.botActive && (
        <div style={{ marginTop: SP.sm, padding: '8px 12px', background: T.prp + '15', border: `1px solid ${T.prp}55`, borderRadius: R.md, color: T.prp, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Bot size={14} strokeWidth={IC_STROKE} /> 자동매매 봇 가동 중
        </div>
      )}

      {positions.length > 0 && (
        <button onClick={() => setExpanded(e => !e)}
          style={{ ...buttonStyle('ghost', 'md'), width: '100%', marginTop: SP.sm, gap: 6 }}>
          {expanded
            ? <><ChevronUp size={14} strokeWidth={IC_STROKE} /> 포지션 접기</>
            : <><ChevronDown size={14} strokeWidth={IC_STROKE} /> 포지션 {positions.length}개 보기</>}
        </button>
      )}

      {expanded && positions.length > 0 && (
        <div style={{ marginTop: SP.sm, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {positions.map(p => {
            const pnl = positionUnrealized(p);
            return (
              <div key={p.id} style={{ padding: '10px 12px', background: T.alt, borderRadius: R.md, display: 'flex', alignItems: 'center', gap: SP.sm }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: T.txt, fontWeight: 700, fontSize: 12 }}>{p.symbol}</span>
                    <span style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 800,
                      background: p.side === 'long' ? T.grn + '33' : p.side === 'short' ? T.red + '33' : T.acg,
                      color:      p.side === 'long' ? T.grn         : p.side === 'short' ? T.red         : T.acl,
                    }}>
                      {p.side === 'spot' ? 'SPOT' : p.side.toUpperCase()}{p.leverage && p.leverage > 1 ? ` ${p.leverage}x` : ''}
                    </span>
                    {p.isBot && <Bot size={11} strokeWidth={IC_STROKE} color={T.prp} />}
                  </div>
                  <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>
                    {p.qty} @ {formatKRW(p.avgPrice)} → {formatKRW(p.currentPrice)}
                  </div>
                </div>
                <KRW value={pnl} plus />
              </div>
            );
          })}
        </div>
      )}
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

function ResultStat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ padding: '10px 12px', background: T.alt, borderRadius: R.md }}>
      <div style={F.muted}>{label}</div>
      <div style={{ ...F.numS, color: color || T.txt, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function SliderRow({ label, value, color, onChange, disabled }: { label: string; value: number; color: string; onChange?: (v: number) => void; disabled?: boolean }) {
  return (
    <div style={{ marginBottom: SP.md }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={F.caption}>{label}</span>
        <span style={{ color, fontWeight: 800, fontSize: 14 }}>{value}%</span>
      </div>
      {!disabled && onChange ? (
        <input type="range" min={0} max={100} value={value} onChange={e => onChange(Number(e.target.value))}
          style={{ width: '100%', accentColor: color }} />
      ) : (
        <div style={{ height: 6, background: T.alt, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${value}%`, height: '100%', background: color }} />
        </div>
      )}
    </div>
  );
}

function PreviewRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${T.border}` }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, marginRight: 8 }} />
      <span style={{ color: T.sub, fontSize: 13, flex: 1 }}>{label}</span>
      <span style={{ color: T.txt, fontWeight: 700, fontSize: 14 }}>{formatKRW(value)}</span>
    </div>
  );
}

function SellPreview({ state, scope, ratio }: { state: HubState; scope: SellScope; ratio: number }) {
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const targets: { symbol: string; pnl: number; account: string; color: string }[] = [];
  let totalPnl = 0;
  for (const acc of accounts) {
    const positions = Array.isArray(acc.positions) ? acc.positions : [];
    for (const p of positions) {
      const pnl = positionUnrealized(p);
      let hit = false;
      switch (scope) {
        case 'all':            hit = true; break;
        case 'shortterm_only': hit = acc.kind === 'shortterm'; break;
        case 'longterm_only':  hit = acc.kind === 'longterm'; break;
        case 'crypto_perp':    hit = p.assetClass === 'crypto_perp'; break;
        case 'stock_only':     hit = p.assetClass === 'stock' || p.assetClass === 'etf'; break;
        case 'profit_only':    hit = pnl > 0; break;
        case 'loss_only':      hit = pnl < 0; break;
      }
      if (hit) {
        const partialPnl = pnl * (ratio/100);
        totalPnl += partialPnl;
        targets.push({ symbol: p.symbol, pnl: partialPnl, account: acc.name, color: acc.color });
      }
    }
  }

  return (
    <div style={cardStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SP.sm }}>
        <div style={F.section}>매도 미리보기</div>
        <span style={F.caption}>{targets.length}건</span>
      </div>
      <div style={{ marginBottom: SP.sm, padding: SP.sm + 2, background: T.alt, borderRadius: R.md, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={F.caption}>예상 실현손익</span>
        <KRW value={totalPnl} plus />
      </div>
      {targets.length === 0 ? (
        <div style={{ color: T.muted, fontSize: 12, textAlign: 'center', padding: '20px 0' }}>대상 포지션이 없습니다.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {targets.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: T.alt, borderRadius: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: t.color, flexShrink: 0 }} />
              <span style={{ color: T.txt, fontWeight: 700, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.symbol}</span>
              <span style={{ color: T.muted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80 }}>{t.account}</span>
              <KRW value={t.pnl} plus />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: SP.xl, zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.card, border: `1px solid ${T.border2}`, borderRadius: R.xl, padding: SP.xl, maxWidth: 440, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

function ModalHeader({ Icon, title, tone }: { Icon: LucideIcon; title: string; tone: IconTone }) {
  const color = tone === 'red' ? T.red : tone === 'yellow' ? T.ylw : tone === 'green' ? T.grn : T.acl;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm + 2 }}>
      <IconBox tone={tone} size="md"><Icon size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
      <div style={{ fontWeight: 800, color, fontSize: 16 }}>{title}</div>
    </div>
  );
}

export default function HubAccountsPage() {
  return <ErrorBoundary><HubAccountsPageInner /></ErrorBoundary>;
}
