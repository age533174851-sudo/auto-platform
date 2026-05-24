'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { ASSETS } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Logo } from './SharedUI';
import { cvt, fmtPct } from '@/lib/utils';

const STORE_KEY = 'tg_watch_groups_v1';

interface WatchGroup {
  id:        string;
  name:      string;
  icon:      string;
  assetIds:  string[];
  createdAt: number;
}

const DEFAULT_GROUPS: WatchGroup[] = [
  { id:'g-coin-short', name:'코인 단타',     icon:'⚡', assetIds:['BTC','ETH','SOL'], createdAt: Date.now() },
  { id:'g-coin-long',  name:'장투 코인',     icon:'💎', assetIds:['BTC','ETH','LINK'], createdAt: Date.now() },
  { id:'g-us-ai',      name:'미국 AI 주식',   icon:'🤖', assetIds:['NVDA','AMD','PLTR','SMCI'], createdAt: Date.now() },
  { id:'g-semi',       name:'반도체',        icon:'💻', assetIds:['NVDA','AMD','TSM','INTC','MU'], createdAt: Date.now() },
  { id:'g-etf',        name:'ETF',          icon:'📊', assetIds:['SPY','QQQ','SOXL','TQQQ'], createdAt: Date.now() },
  { id:'g-kr',         name:'국내주식',      icon:'🇰🇷', assetIds:['005930','000660','035420'], createdAt: Date.now() },
];

export default function WatchGroupsPage({
  prices,
  currency,
  onOpenAsset,
}: {
  prices?: Asset[];
  currency: string;
  onOpenAsset?: (a: any, dest?: string) => void;
}) {
  const [groups, setGroups]     = useState<WatchGroup[]>([]);
  const [active, setActive]     = useState<string>('');
  const [showAdd, setShowAdd]   = useState(false);
  const [showEdit, setShowEdit] = useState<string | null>(null);
  const [newName, setNewName]   = useState('');
  const [newIcon, setNewIcon]   = useState('⭐');
  const [pickerSearch, setPickerSearch] = useState('');
  const [toast, setToast]       = useState('');

  // Load groups
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length > 0) {
        setGroups(arr);
        setActive(arr[0]?.id ?? '');
      } else {
        setGroups(DEFAULT_GROUPS);
        setActive(DEFAULT_GROUPS[0].id);
      }
    } catch {
      setGroups(DEFAULT_GROUPS);
      setActive(DEFAULT_GROUPS[0].id);
    }
  }, []);

  const showToast = useCallback((m: string) => {
    setToast(m); setTimeout(() => setToast(''), 2500);
  }, []);

  const saveGroups = useCallback((next: WatchGroup[]) => {
    setGroups(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
  }, []);

  const sourceAssets = useMemo(() => {
    const src = Array.isArray(prices) && prices.length > 0 ? prices : ASSETS;
    return Array.isArray(src) ? src : [];
  }, [prices]);

  const assetMap = useMemo(() => {
    const m = new Map<string, Asset>();
    sourceAssets.forEach(a => m.set(a.id, a));
    return m;
  }, [sourceAssets]);

  const activeGroup = useMemo(
    () => groups.find(g => g.id === active) ?? null,
    [groups, active]
  );

  const activeAssets = useMemo(() => {
    if (!activeGroup) return [] as Asset[];
    const ids = Array.isArray(activeGroup.assetIds) ? activeGroup.assetIds : [];
    return ids.map(id => assetMap.get(id)).filter(Boolean) as Asset[];
  }, [activeGroup, assetMap]);

  const filteredCandidates = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return sourceAssets.slice(0, 20);
    return sourceAssets.filter(a =>
      (a.nameKr || '').toLowerCase().includes(q) ||
      (a.id     || '').toLowerCase().includes(q) ||
      (a.sym    || '').toLowerCase().includes(q)
    ).slice(0, 20);
  }, [pickerSearch, sourceAssets]);

  /* ── Actions ── */
  const createGroup = useCallback(() => {
    if (!newName.trim()) { showToast('그룹 이름을 입력하세요'); return; }
    const g: WatchGroup = {
      id: 'g-' + Date.now().toString(36),
      name: newName.trim(),
      icon: newIcon,
      assetIds: [],
      createdAt: Date.now(),
    };
    saveGroups([...groups, g]);
    setActive(g.id);
    setNewName(''); setNewIcon('⭐'); setShowAdd(false);
    showToast(`✅ "${g.name}" 그룹 생성됨`);
  }, [newName, newIcon, groups, saveGroups, showToast]);

  const deleteGroup = useCallback((id: string) => {
    if (!confirm('이 그룹을 삭제하시겠습니까?')) return;
    const next = groups.filter(g => g.id !== id);
    saveGroups(next);
    if (active === id) setActive(next[0]?.id ?? '');
    showToast('🗑 그룹 삭제됨');
  }, [groups, active, saveGroups, showToast]);

  const toggleAsset = useCallback((assetId: string) => {
    if (!activeGroup) return;
    const has = (Array.isArray(activeGroup.assetIds)?activeGroup.assetIds:[]).includes(assetId);
    const nextIds = has
      ? activeGroup.assetIds.filter(x => x !== assetId)
      : [...activeGroup.assetIds, assetId];
    const next = groups.map(g => g.id === activeGroup.id ? { ...g, assetIds: nextIds } : g);
    saveGroups(next);
    showToast(has ? '➖ 제거됨' : '➕ 추가됨');
  }, [activeGroup, groups, saveGroups, showToast]);

  const moveAsset = useCallback((assetId: string, dir: -1 | 1) => {
    if (!activeGroup) return;
    const ids = [...activeGroup.assetIds];
    const idx = ids.indexOf(assetId);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    const next = groups.map(g => g.id === activeGroup.id ? { ...g, assetIds: ids } : g);
    saveGroups(next);
  }, [activeGroup, groups, saveGroups]);

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top: 16, left:'50%', transform:'translateX(-50%)',
          background: T.acl, color:'#fff', padding:'10px 18px', borderRadius: 12,
          fontSize: 13, fontWeight: 700, zIndex: 999 }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 14 }}>
        <div>
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>🗂 관심종목 그룹</div>
          <div style={{ color: T.muted, fontSize: 10 }}>{groups.length}개 그룹 · 카테고리별 종목 관리</div>
        </div>
        <button type="button" onClick={() => setShowAdd(true)}
          style={{ padding:'9px 14px', minHeight: 38,
            background:'linear-gradient(135deg,#2563EB,#10B981)', color:'#fff',
            border:'none', borderRadius: 10, fontWeight: 800, fontSize: 12, cursor:'pointer' }}>
          + 새 그룹
        </button>
      </div>

      {/* Group tabs */}
      <div style={{ display:'flex', gap: 6, overflowX:'auto', marginBottom: 12, paddingBottom: 4 }}>
        {groups.map(g => (
          <button key={g.id} type="button" onClick={() => setActive(g.id)}
            style={{ flexShrink: 0, padding:'8px 14px', minHeight: 38,
              background: active === g.id ? T.acg : T.alt,
              border:`1px solid ${active === g.id ? T.acl : T.border}`,
              color: active === g.id ? T.acl : T.muted,
              borderRadius: 20, fontSize: 12, fontWeight: 700, cursor:'pointer',
              display:'flex', alignItems:'center', gap: 5 }}>
            <span>{g.icon}</span>
            <span>{g.name}</span>
            <span style={{ background: T.bg, color: T.muted, fontSize: 9,
              padding:'1px 6px', borderRadius: 10, marginLeft: 2 }}>
              {(Array.isArray(g.assetIds) ? g.assetIds : []).length}
            </span>
          </button>
        ))}
      </div>

      {/* Active group content */}
      {activeGroup ? (
        <>
          <Card style={{ marginBottom: 10, padding:'12px 14px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div>
                <div style={{ color: T.txt, fontSize: 14, fontWeight: 800 }}>
                  {activeGroup.icon} {activeGroup.name}
                </div>
                <div style={{ color: T.muted, fontSize: 10 }}>
                  {(Array.isArray(activeGroup.assetIds) ? activeGroup.assetIds : []).length}개 종목
                </div>
              </div>
              <div style={{ display:'flex', gap: 6 }}>
                <button type="button" onClick={() => setShowEdit(activeGroup.id)}
                  style={{ padding:'7px 12px', background: T.acg, color: T.acl,
                    border:`1px solid ${T.acl}40`, borderRadius: 8,
                    fontSize: 10, fontWeight: 700, cursor:'pointer', minHeight: 34 }}>
                  + 종목 추가
                </button>
                <button type="button" onClick={() => deleteGroup(activeGroup.id)}
                  style={{ padding:'7px 12px', background: T.alt, color: T.red,
                    border:`1px solid ${T.red}30`, borderRadius: 8,
                    fontSize: 10, fontWeight: 700, cursor:'pointer', minHeight: 34 }}>
                  🗑
                </button>
              </div>
            </div>
          </Card>

          {activeAssets.length === 0 ? (
            <Card style={{ padding:'40px 20px', textAlign:'center' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
              <div style={{ color: T.txt, fontSize: 13, marginBottom: 12 }}>
                이 그룹에 추가된 종목이 없습니다
              </div>
              <button type="button" onClick={() => setShowEdit(activeGroup.id)}
                style={{ background: T.acg, color: T.acl,
                  border:`1px solid ${T.acl}40`, borderRadius: 10,
                  padding:'9px 18px', fontSize: 12, fontWeight: 700,
                  cursor:'pointer', minHeight: 38 }}>
                종목 추가하기
              </button>
            </Card>
          ) : (
            <Card style={{ overflow:'hidden', padding: 0 }}>
              {activeAssets.map((a, i) => (
                <div key={a.id} style={{ display:'grid', gridTemplateColumns:'30px 1fr auto auto',
                  alignItems:'center', gap: 8, padding:'10px 14px',
                  borderBottom: i < activeAssets.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                  <div style={{ display:'flex', flexDirection:'column', gap: 2 }}>
                    <button type="button" onClick={() => moveAsset(a.id, -1)}
                      disabled={i === 0}
                      style={{ background:'none', border:'none', color: i === 0 ? T.border : T.muted,
                        fontSize: 10, cursor: i === 0 ? 'default' : 'pointer', padding: 2 }}>▲</button>
                    <button type="button" onClick={() => moveAsset(a.id, 1)}
                      disabled={i === activeAssets.length - 1}
                      style={{ background:'none', border:'none',
                        color: i === activeAssets.length - 1 ? T.border : T.muted,
                        fontSize: 10, cursor: i === activeAssets.length - 1 ? 'default' : 'pointer', padding: 2 }}>▼</button>
                  </div>
                  <div onClick={() => onOpenAsset?.(a, 'trading')}
                    style={{ display:'flex', alignItems:'center', gap: 8, cursor:'pointer', minWidth: 0 }}>
                    <Logo id={a.id} size={32} clr={a.clr} name={a.nameKr}/>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: T.txt, fontWeight: 700, fontSize: 12 }}>{a.nameKr}</div>
                      <div style={{ color: T.muted, fontSize: 9 }}>{a.sym || a.id}</div>
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ color: T.txt, fontSize: 11, fontWeight: 700, fontFamily:'monospace' }}>
                      {cvt(a.p || 0, currency)}
                    </div>
                    <div style={{ color: (a.c || 0) >= 0 ? T.grn : T.red,
                      fontSize: 10, fontWeight: 700 }}>
                      {fmtPct(a.c || 0)}
                    </div>
                  </div>
                  <button type="button" onClick={() => toggleAsset(a.id)}
                    style={{ padding:'5px 8px', background: T.alt, color: T.red,
                      border:`1px solid ${T.red}30`, borderRadius: 6,
                      fontSize: 9, fontWeight: 700, cursor:'pointer', minHeight: 30 }}>
                    제거
                  </button>
                </div>
              ))}
            </Card>
          )}
        </>
      ) : (
        <Card style={{ padding:'40px 20px', textAlign:'center', color: T.muted }}>
          그룹을 만들어 시작하세요
        </Card>
      )}

      {/* New group modal */}
      {showAdd && (
        <>
          <div onClick={() => setShowAdd(false)}
            style={{ position:'fixed', inset: 0, background:'rgba(0,0,0,.7)', zIndex: 200 }}/>
          <div onClick={(e) => e.stopPropagation()}
            style={{ position:'fixed', zIndex: 201, inset:'auto 0 0 0',
              background: T.bg, borderRadius:'20px 20px 0 0',
              padding:`18px 16px calc(env(safe-area-inset-bottom, 20px) + 24px)`,
              maxWidth: 520, margin:'0 auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom: 14 }}>
              <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>+ 새 그룹</div>
              <button type="button" onClick={() => setShowAdd(false)}
                style={{ background:'transparent', border:`1px solid ${T.border}`,
                  borderRadius: 8, color: T.muted, padding:'5px 12px', fontSize: 12, cursor:'pointer' }}>
                닫기
              </button>
            </div>
            <div style={{ display:'flex', gap: 6, marginBottom: 10 }}>
              {['⭐','💎','⚡','🚀','🤖','💻','📊','🇺🇸','🇰🇷','🏦'].map(e => (
                <button key={e} type="button" onClick={() => setNewIcon(e)}
                  style={{ padding:'10px', background: newIcon === e ? T.acg : T.alt,
                    border:`1px solid ${newIcon === e ? T.acl : T.border}`,
                    borderRadius: 10, fontSize: 18, cursor:'pointer', minHeight: 44, minWidth: 44 }}>
                  {e}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="그룹 이름 (예: 코인 단타)"
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 10, padding:'12px 14px',
                color: T.txt, fontSize: 14, outline:'none', marginBottom: 14 }}
            />
            <button type="button" onClick={createGroup}
              style={{ width:'100%', padding:'13px', minHeight: 48,
                background:'linear-gradient(135deg,#2563EB,#10B981)',
                color:'#fff', border:'none', borderRadius: 12,
                fontWeight: 800, fontSize: 14, cursor:'pointer' }}>
              생성
            </button>
          </div>
        </>
      )}

      {/* Asset picker modal */}
      {showEdit && activeGroup && (
        <>
          <div onClick={() => setShowEdit(null)}
            style={{ position:'fixed', inset: 0, background:'rgba(0,0,0,.7)', zIndex: 200 }}/>
          <div onClick={(e) => e.stopPropagation()}
            style={{ position:'fixed', zIndex: 201, inset:'auto 0 0 0',
              background: T.bg, borderRadius:'20px 20px 0 0',
              maxHeight:'88dvh', overflowY:'auto',
              padding:`18px 16px calc(env(safe-area-inset-bottom, 20px) + 24px)`,
              maxWidth: 520, margin:'0 auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom: 12 }}>
              <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>
                "{activeGroup.name}"에 종목 추가
              </div>
              <button type="button" onClick={() => setShowEdit(null)}
                style={{ background:'transparent', border:`1px solid ${T.border}`,
                  borderRadius: 8, color: T.muted, padding:'5px 12px', fontSize: 12, cursor:'pointer' }}>
                완료
              </button>
            </div>
            <input
              value={pickerSearch}
              onChange={e => setPickerSearch(e.target.value)}
              placeholder="종목 검색..."
              style={{ width:'100%', boxSizing:'border-box', background: T.alt,
                border:`1px solid ${T.border}`, borderRadius: 10, padding:'10px 14px',
                color: T.txt, fontSize: 13, outline:'none', marginBottom: 10 }}
            />
            {filteredCandidates.map(a => {
              const isIn = (Array.isArray(activeGroup.assetIds)?activeGroup.assetIds:[]).includes(a.id);
              return (
                <div key={a.id} onClick={() => toggleAsset(a.id)}
                  style={{ display:'flex', alignItems:'center', gap: 10,
                    padding:'9px 10px', cursor:'pointer',
                    background: isIn ? T.grn + '15' : 'transparent',
                    border:`1px solid ${isIn ? T.grn + '40' : T.border}`,
                    borderRadius: 10, marginBottom: 5 }}>
                  <Logo id={a.id} size={28} clr={a.clr} name={a.nameKr}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.nameKr}</div>
                    <div style={{ color: T.muted, fontSize: 9 }}>{a.sym || a.id}</div>
                  </div>
                  <div style={{ color: isIn ? T.grn : T.acl, fontSize: 16, fontWeight: 800 }}>
                    {isIn ? '✓' : '+'}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
