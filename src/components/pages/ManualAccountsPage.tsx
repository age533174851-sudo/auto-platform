'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';
import { notifyInfo } from '@/lib/notify/center';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { Wallet, Plus, Trash2, Edit3, TrendingUp, TrendingDown, Info } from 'lucide-react';
import {
  loadManualAccounts, saveManualAccount, deleteManualAccount,
  valuateAccount, valuateAll, muid,
  ACCOUNT_TYPE_LABEL, ACCOUNT_TYPE_COLOR,
  type ManualAccount, type ManualAccountType, type ManualHolding,
} from '@/lib/accounts/manual';

const TYPES: ManualAccountType[] = ['bank', 'toss', 'stock', 'coin_spot', 'coin_futures', 'etc'];

function emptyAccount(): ManualAccount {
  return {
    id: muid(), name: '', institution: '', type: 'bank',
    cashBalance: 0, currency: 'KRW', holdings: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

export default function ManualAccountsPage() {
  const [accounts, setAccounts] = useState<ManualAccount[]>([]);
  const [editing, setEditing] = useState<ManualAccount | null>(null);

  useEffect(() => { setAccounts(loadManualAccounts()); }, []);

  const refresh = useCallback(() => setAccounts(loadManualAccounts()), []);

  const totals = useMemo(() => valuateAll(accounts), [accounts]);

  const onSave = useCallback((acc: ManualAccount) => {
    if (!acc.name.trim()) { notifyInfo('계좌명을 입력하세요'); return; }
    saveManualAccount(acc);
    refresh();
    setEditing(null);
  }, [refresh]);

  const onDelete = useCallback(async (id: string) => {
    if (!(await confirmDialog('이 계좌를 삭제하시겠습니까?', { danger: true }))) return;
    deleteManualAccount(id);
    refresh();
  }, [refresh]);

  // ── 편집 폼 ──
  if (editing) {
    return <AccountEditor account={editing} onSave={onSave} onCancel={() => setEditing(null)} />;
  }

  const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

  return (
    <div style={{ padding: '16px', maxWidth: 600, margin: '0 auto' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Wallet size={18} strokeWidth={2.2} color={T.acl} />
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>수동 자산 등록</div>
          <div style={{ color: T.muted, fontSize: 10 }}>은행·토스·증권·코인을 직접 입력해 총자산 관리</div>
        </div>
      </div>

      {/* 안내 */}
      <Card style={{ padding: '10px 14px', marginBottom: 12, background: T.ylw + '10', border: `1px solid ${T.ylw}30` }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Info size={13} strokeWidth={2.2} color={T.ylw} style={{ marginTop: 1, flexShrink: 0 }} />
          <span style={{ color: T.ylw, fontSize: 10, lineHeight: 1.5 }}>
            수동 등록 계좌는 <strong>자동 업데이트되지 않습니다.</strong> 잔액·현재가는 직접 입력/수정해야 합니다.
            실시간 연동은 거래소 API 연결을 사용하세요.
          </span>
        </div>
      </Card>

      {/* 총자산 요약 */}
      {accounts.length > 0 && (
        <Card style={{ padding: '16px', marginBottom: 12 }}>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>총 자산 (수동 등록 합계)</div>
          <div style={{ color: T.txt, fontSize: 26, fontWeight: 900, fontFamily: 'monospace' }}>₩{fmt(totals.totalAssets)}</div>
          <div style={{ color: totals.totalPnl >= 0 ? T.grn : T.red, fontSize: 13, fontWeight: 700, marginTop: 2 }}>
            {totals.totalPnl >= 0 ? '+' : ''}₩{fmt(totals.totalPnl)} 평가손익
          </div>
          {/* 타입별 비중 바 */}
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 12, background: T.alt }}>
            {Object.entries(totals.byType).map(([type, val]) => {
              const pct = totals.totalAssets > 0 ? (val / totals.totalAssets) * 100 : 0;
              return <div key={type} style={{ width: `${pct}%`, background: ACCOUNT_TYPE_COLOR[type as ManualAccountType] }} title={`${ACCOUNT_TYPE_LABEL[type as ManualAccountType]} ${pct.toFixed(0)}%`} />;
            })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {Object.entries(totals.byType).map(([type, val]) => (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: T.muted }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: ACCOUNT_TYPE_COLOR[type as ManualAccountType] }} />
                {ACCOUNT_TYPE_LABEL[type as ManualAccountType]} ₩{fmt(val)}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 계좌 목록 */}
      {accounts.map(acc => {
        const v = valuateAccount(acc);
        const color = ACCOUNT_TYPE_COLOR[acc.type];
        return (
          <Card key={acc.id} style={{ padding: '14px', marginBottom: 8, borderLeft: `3px solid ${color}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ color: T.txt, fontWeight: 800, fontSize: 13 }}>{acc.name}</span>
                  <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 8, fontWeight: 800, background: color + '22', color }}>
                    {ACCOUNT_TYPE_LABEL[acc.type]}
                  </span>
                  <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 8, fontWeight: 700, background: T.muted + '22', color: T.muted }}>
                    수동등록
                  </span>
                </div>
                <div style={{ color: T.muted, fontSize: 10 }}>{acc.institution || '-'} · 현금 {fmt(acc.cashBalance)} {acc.currency}</div>
                <div style={{ color: T.txt, fontSize: 15, fontWeight: 800, fontFamily: 'monospace', marginTop: 4 }}>₩{fmt(v.total)}</div>
                {acc.holdings.length > 0 && (
                  <div style={{ color: v.pnl >= 0 ? T.grn : T.red, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
                    {v.pnl >= 0 ? <TrendingUp size={11} strokeWidth={2.4} /> : <TrendingDown size={11} strokeWidth={2.4} />}
                    {v.pnl >= 0 ? '+' : ''}{fmt(v.pnl)} ({v.pnlPct >= 0 ? '+' : ''}{v.pnlPct.toFixed(1)}%)
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                <button onClick={() => setEditing(acc)} aria-label="수정"
                  style={{ background: T.alt, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', minHeight: 30, cursor: 'pointer' }}>
                  <Edit3 size={12} strokeWidth={2.2} />
                </button>
                <button onClick={() => onDelete(acc.id)} aria-label="삭제"
                  style={{ background: T.red + '15', color: T.red, border: `1px solid ${T.red}30`, borderRadius: 6, padding: '6px 8px', minHeight: 30, cursor: 'pointer' }}>
                  <Trash2 size={12} strokeWidth={2.2} />
                </button>
              </div>
            </div>
            {acc.holdings.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
                {acc.holdings.map(h => (
                  <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.sub, padding: '2px 0' }}>
                    <span>{h.symbol} {h.side ? (h.side === 'long' ? '롱' : '숏') : ''} {h.leverage ? `${h.leverage}x` : ''} × {h.qty}</span>
                    <span style={{ fontFamily: 'monospace' }}>{fmt(h.curPrice)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}

      {/* 추가 버튼 */}
      <button onClick={() => setEditing(emptyAccount())}
        style={{ width: '100%', padding: '14px', minHeight: 50, marginTop: 4, background: T.acg, color: T.acl, border: `1px dashed ${T.acl}60`, borderRadius: 12, fontWeight: 800, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <Plus size={16} strokeWidth={2.4} /> 계좌 추가
      </button>

      {accounts.length === 0 && (
        <div style={{ textAlign: 'center', color: T.muted, fontSize: 12, padding: '24px 0' }}>
          아직 등록된 계좌가 없습니다.<br />위 버튼으로 은행·토스·증권·코인 계좌를 추가하세요.
        </div>
      )}
    </div>
  );
}

// ─── 계좌 편집 폼 ─────────────────────────────────────────────
function AccountEditor({ account, onSave, onCancel }: {
  account: ManualAccount; onSave: (a: ManualAccount) => void; onCancel: () => void;
}) {
  const [a, setA] = useState<ManualAccount>(account);
  const upd = (patch: Partial<ManualAccount>) => setA(prev => ({ ...prev, ...patch }));

  const addHolding = () => {
    const h: ManualHolding = { id: muid(), symbol: '', qty: 0, avgPrice: 0, curPrice: 0 };
    if (a.type === 'coin_futures') { h.side = 'long'; h.leverage = 1; }
    upd({ holdings: [...a.holdings, h] });
  };
  const updHolding = (i: number, patch: Partial<ManualHolding>) => {
    const next = [...a.holdings]; next[i] = { ...next[i], ...patch }; upd({ holdings: next });
  };
  const rmHolding = (i: number) => upd({ holdings: a.holdings.filter((_, idx) => idx !== i) });

  const isFutures = a.type === 'coin_futures';
  const inputStyle = { width: '100%', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 11px', color: T.txt, fontSize: 12, outline: 'none', boxSizing: 'border-box' as const };

  return (
    <div style={{ padding: '16px', maxWidth: 600, margin: '0 auto' }}>
      <div style={{ color: T.txt, fontWeight: 900, fontSize: 16, marginBottom: 14 }}>
        {account.name ? '계좌 수정' : '새 계좌 등록'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 계좌 유형 */}
        <div>
          <div style={{ color: T.sub, fontSize: 11, marginBottom: 6 }}>계좌 유형</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
            {TYPES.map(t => {
              const active = a.type === t;
              const c = ACCOUNT_TYPE_COLOR[t];
              return (
                <button key={t} onClick={() => upd({ type: t })}
                  style={{ padding: '10px 6px', minHeight: 40, background: active ? c + '22' : T.alt, color: active ? c : T.muted, border: `1px solid ${active ? c : T.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                  {ACCOUNT_TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ color: T.sub, fontSize: 11, marginBottom: 4 }}>계좌명 *</div>
          <input value={a.name} onChange={e => upd({ name: e.target.value })} placeholder="예: 내 토스증권" style={inputStyle} />
        </div>
        <div>
          <div style={{ color: T.sub, fontSize: 11, marginBottom: 4 }}>기관명</div>
          <input value={a.institution} onChange={e => upd({ institution: e.target.value })} placeholder="예: 토스증권, 국민은행, Gate.io" style={inputStyle} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 2 }}>
            <div style={{ color: T.sub, fontSize: 11, marginBottom: 4 }}>현금/예수금</div>
            <input type="number" value={a.cashBalance || ''} onChange={e => upd({ cashBalance: parseFloat(e.target.value) || 0 })} placeholder="0" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.sub, fontSize: 11, marginBottom: 4 }}>통화</div>
            <select value={a.currency} onChange={e => upd({ currency: e.target.value as any })} style={inputStyle as any}>
              <option value="KRW">KRW</option><option value="USD">USD</option><option value="USDT">USDT</option>
            </select>
          </div>
        </div>

        {/* 보유 종목 */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ color: T.sub, fontSize: 11 }}>보유 {isFutures ? '포지션' : '종목/코인'}</span>
            <button onClick={addHolding} style={{ background: T.acg, color: T.acl, border: 'none', borderRadius: 6, padding: '4px 10px', minHeight: 28, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>+ 추가</button>
          </div>
          {a.holdings.map((h, i) => (
            <div key={h.id} style={{ background: T.alt, borderRadius: 8, padding: 10, marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input value={h.symbol} onChange={e => updHolding(i, { symbol: e.target.value.toUpperCase() })} placeholder="심볼 (BTC)" style={{ ...inputStyle, flex: 1 }} />
                <button onClick={() => rmHolding(i)} style={{ background: T.red + '15', color: T.red, border: 'none', borderRadius: 6, padding: '0 10px', cursor: 'pointer' }}>
                  <Trash2 size={12} strokeWidth={2.2} />
                </button>
              </div>
              {isFutures && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <select value={h.side || 'long'} onChange={e => updHolding(i, { side: e.target.value as any })} style={{ ...inputStyle as any, flex: 1 }}>
                    <option value="long">롱</option><option value="short">숏</option>
                  </select>
                  <input type="number" value={h.leverage || ''} onChange={e => updHolding(i, { leverage: parseFloat(e.target.value) || 1 })} placeholder="레버리지" style={{ ...inputStyle, flex: 1 }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" value={h.qty || ''} onChange={e => updHolding(i, { qty: parseFloat(e.target.value) || 0 })} placeholder="수량" style={{ ...inputStyle, flex: 1 }} />
                <input type="number" value={h.avgPrice || ''} onChange={e => updHolding(i, { avgPrice: parseFloat(e.target.value) || 0 })} placeholder="매수가" style={{ ...inputStyle, flex: 1 }} />
                <input type="number" value={h.curPrice || ''} onChange={e => updHolding(i, { curPrice: parseFloat(e.target.value) || 0 })} placeholder="현재가" style={{ ...inputStyle, flex: 1 }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 버튼 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={onCancel} style={{ flex: 1, padding: '13px', minHeight: 48, background: T.alt, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 12, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>취소</button>
        <button onClick={() => onSave(a)} style={{ flex: 2, padding: '13px', minHeight: 48, background: T.acc, color: '#fff', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>저장</button>
      </div>
    </div>
  );
}
