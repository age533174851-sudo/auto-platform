'use client';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';
import {
  GripVertical, ArrowUp, ArrowDown, ChevronsUp, ChevronsDown,
  Trash2, Plus, Folder, FolderPlus, Inbox, X, ExternalLink,
} from 'lucide-react';
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
  { id:'g-coin-short', name:'코인 단타',     icon:'', assetIds:['BTC','ETH','SOL'], createdAt: Date.now() },
  { id:'g-coin-long',  name:'장투 코인',     icon:'', assetIds:['BTC','ETH','LINK'], createdAt: Date.now() },
  { id:'g-us-ai',      name:'미국 AI 주식',   icon:'', assetIds:['NVDA','AMD','PLTR','SMCI'], createdAt: Date.now() },
  { id:'g-semi',       name:'반도체',        icon:'💻', assetIds:['NVDA','AMD','TSM','INTC','MU'], createdAt: Date.now() },
  { id:'g-etf',        name:'ETF',          icon:'', assetIds:['SPY','QQQ','SOXL','TQQQ'], createdAt: Date.now() },
  { id:'g-kr',         name:'국내주식',      icon:'🇰🇷', assetIds:['005930','000660','035420'], createdAt: Date.now() },
];

// ─────────────────────────────────────────────────────────────
// 드래그 가능한 자산 행 — HTML5 native drag (desktop) + Pointer events (mobile)
// 드래그 핸들에서만 드래그 시작. 행 본문 클릭은 onOpen 호출.
// ─────────────────────────────────────────────────────────────
interface DraggableAssetRowProps {
  asset:        Asset;
  index:        number;
  totalCount:   number;
  currency:     string;
  isDragOver:   boolean;
  isDragging:   boolean;
  onMoveUp:     () => void;
  onMoveDown:   () => void;
  onMoveTop:    () => void;
  onMoveBottom: () => void;
  onRemove:     () => void;
  onOpen:       () => void;
  onDragStart:  () => void;
  onDragEnter:  () => void;
  onDragEnd:    () => void;
  onPointerDragStart: (clientY: number) => void;
}

function DraggableAssetRow({
  asset, index, totalCount, currency, isDragOver, isDragging,
  onMoveUp, onMoveDown, onMoveTop, onMoveBottom, onRemove, onOpen,
  onDragStart, onDragEnter, onDragEnd, onPointerDragStart,
}: DraggableAssetRowProps) {
  const isFirst = index === 0;
  const isLast  = index === totalCount - 1;
  const a = asset;

  return (
    <div
      data-asset-id={a.id}
      draggable
      onDragStart={(e) => {
        // dataTransfer가 없으면 일부 브라우저에서 드래그 안 됨
        try { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'move'; } catch {}
        onDragStart();
      }}
      onDragOver={(e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch {} }}
      onDragEnter={(e) => { e.preventDefault(); onDragEnter(); }}
      onDrop={(e) => { e.preventDefault(); onDragEnd(); }}
      onDragEnd={onDragEnd}
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr auto auto',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderBottom: isLast ? 'none' : `1px solid ${T.border}`,
        background: isDragOver ? T.acg : 'transparent',
        opacity: isDragging ? 0.5 : 1,
        transition: 'background 120ms, opacity 120ms',
        touchAction: 'pan-y', // 손가락 세로 스크롤은 페이지에 양보
      }}
    >
      {/* 드래그 핸들 + 정렬 버튼 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
        {/* 핸들 — pointer down으로 모바일 long-press 시작 */}
        <button
          type="button"
          onPointerDown={(e) => {
            // 데스크탑 HTML5 drag와 충돌 방지 — touch에서만 활성화
            if (e.pointerType === 'touch') onPointerDragStart(e.clientY);
          }}
          aria-label="드래그하여 순서 변경"
          style={{
            background: 'transparent',
            border: 'none',
            color: T.muted,
            cursor: 'grab',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'none', // 핸들에선 자체 스크롤 차단해야 드래그 의도 명확
          }}>
          <GripVertical size={14} strokeWidth={2.2}/>
        </button>
        {/* 위 / 아래 작은 버튼 (한 줄 이동) */}
        <div style={{ display: 'flex', gap: 1 }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            disabled={isFirst}
            aria-label="한 칸 위로"
            style={{
              background: 'transparent', border: 'none',
              color: isFirst ? T.border : T.muted,
              cursor: isFirst ? 'default' : 'pointer',
              padding: 0, minWidth: 14, height: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <ArrowUp size={12} strokeWidth={2.4}/>
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            disabled={isLast}
            aria-label="한 칸 아래로"
            style={{
              background: 'transparent', border: 'none',
              color: isLast ? T.border : T.muted,
              cursor: isLast ? 'default' : 'pointer',
              padding: 0, minWidth: 14, height: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <ArrowDown size={12} strokeWidth={2.4}/>
          </button>
        </div>
        {/* 맨 위 / 맨 아래 (작게) */}
        <div style={{ display: 'flex', gap: 1 }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); onMoveTop(); }}
            disabled={isFirst}
            aria-label="맨 위로"
            style={{
              background: 'transparent', border: 'none',
              color: isFirst ? T.border : T.muted,
              cursor: isFirst ? 'default' : 'pointer',
              padding: 0, minWidth: 14, height: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <ChevronsUp size={11} strokeWidth={2.4}/>
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onMoveBottom(); }}
            disabled={isLast}
            aria-label="맨 아래로"
            style={{
              background: 'transparent', border: 'none',
              color: isLast ? T.border : T.muted,
              cursor: isLast ? 'default' : 'pointer',
              padding: 0, minWidth: 14, height: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <ChevronsDown size={11} strokeWidth={2.4}/>
          </button>
        </div>
      </div>

      {/* 자산 정보 (클릭 → 상세) */}
      <div onClick={onOpen}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 0 }}>
        <Logo id={a.id} size={32} clr={a.clr} name={a.nameKr}/>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.nameKr}</div>
          <div style={{ color: T.muted, fontSize: 9 }}>{a.sym || a.id}</div>
        </div>
      </div>

      {/* 가격 */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ color: T.txt, fontSize: 11, fontWeight: 700, fontFamily: 'monospace' }}>
          {cvt(a.p || 0, currency)}
        </div>
        <div style={{ color: (a.c || 0) >= 0 ? T.grn : T.red, fontSize: 10, fontWeight: 700 }}>
          {fmtPct(a.c || 0)}
        </div>
      </div>

      {/* 제거 */}
      <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }}
        aria-label="그룹에서 제거"
        style={{
          padding: 6, background: T.alt, color: T.red,
          border: `1px solid ${T.red}30`, borderRadius: 6,
          cursor: 'pointer', minWidth: 30, minHeight: 30,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <X size={13} strokeWidth={2.4}/>
      </button>
    </div>
  );
}

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
  const [newIcon, setNewIcon]   = useState('');
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

  // ── 드래그앤드롭 상태 ────────────────────────────────────────
  const [draggingId, setDraggingId]   = useState<string | null>(null);
  const [dragOverId, setDragOverId]   = useState<string | null>(null);

  // 모바일 pointer 기반 드래그 (HTML5 drag가 터치에서 잘 안되므로)
  const pointerDragRef = useRef<{ id: string; startY: number } | null>(null);

  const startPointerDrag = useCallback((id: string, startY: number) => {
    pointerDragRef.current = { id, startY };
    setDraggingId(id);

    const onMove = (ev: PointerEvent) => {
      const state = pointerDragRef.current;
      if (!state) return;
      // 손가락 위치의 요소 찾기
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      if (!el) return;
      const row = el.closest('[data-asset-id]') as HTMLElement | null;
      const overId = row?.getAttribute('data-asset-id') ?? null;
      if (overId && overId !== state.id) {
        setDragOverId(overId);
      }
      ev.preventDefault();
    };

    const onUp = () => {
      const state = pointerDragRef.current;
      if (state && dragOverId && dragOverId !== state.id) {
        // closure로 잡힌 dragOverId 대신 ref 패턴이 더 안전하지만,
        // 실제로는 setDragOverId가 마지막 값을 갖고 있어서 충분
      }
      // commit
      const sId = pointerDragRef.current?.id ?? null;
      // 현재 dragOverId 사용
      // (setState는 비동기지만 onMove에서 직접 호출하므로 최신값임)
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      window.removeEventListener('pointercancel', onUp);

      // 약간의 지연 후 commit (state 동기화)
      setTimeout(() => {
        const overId = lastDragOverRef.current;
        if (sId && overId && sId !== overId) {
          reorderAssetRef.current?.(sId, overId);
        }
        setDraggingId(null);
        setDragOverId(null);
        pointerDragRef.current = null;
        lastDragOverRef.current = null;
      }, 0);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup',   onUp);
    window.addEventListener('pointercancel', onUp);
  }, [dragOverId]);

  // 최신 dragOverId / reorderAsset을 closure 없이 참조하기 위한 ref
  const lastDragOverRef = useRef<string | null>(null);
  useEffect(() => { lastDragOverRef.current = dragOverId; }, [dragOverId]);
  const reorderAssetRef = useRef<((from: string, to: string) => void) | null>(null);

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
    setNewName(''); setNewIcon(''); setShowAdd(false);
    showToast(`✅ "${g.name}" 그룹 생성됨`);
  }, [newName, newIcon, groups, saveGroups, showToast]);

  const deleteGroup = useCallback(async (id: string) => {
    if (!(await confirmDialog('이 그룹을 삭제하시겠습니까?', { danger: true }))) return;
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

  const moveAsset = useCallback((assetId: string, dir: -1 | 1 | 'top' | 'bottom') => {
    if (!activeGroup) return;
    const ids = Array.isArray(activeGroup.assetIds) ? [...activeGroup.assetIds] : [];
    const idx = ids.indexOf(assetId);
    if (idx < 0) return;

    let nextIds: string[];
    if (dir === 'top') {
      if (idx === 0) return;
      nextIds = [assetId, ...ids.filter(x => x !== assetId)];
    } else if (dir === 'bottom') {
      if (idx === ids.length - 1) return;
      nextIds = [...ids.filter(x => x !== assetId), assetId];
    } else {
      const j = idx + dir;
      if (j < 0 || j >= ids.length) return;
      nextIds = [...ids];
      [nextIds[idx], nextIds[j]] = [nextIds[j], nextIds[idx]];
    }

    const next = groups.map(g => g.id === activeGroup.id ? { ...g, assetIds: nextIds } : g);
    saveGroups(next);
  }, [activeGroup, groups, saveGroups]);

  // 드래그앤드롭으로 순서 재배치 — fromId를 toId의 위치로
  const reorderAsset = useCallback((fromId: string, toId: string) => {
    if (!activeGroup || fromId === toId) return;
    const ids = Array.isArray(activeGroup.assetIds) ? [...activeGroup.assetIds] : [];
    const fromIdx = ids.indexOf(fromId);
    const toIdx   = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, moved);
    const next = groups.map(g => g.id === activeGroup.id ? { ...g, assetIds: ids } : g);
    saveGroups(next);
  }, [activeGroup, groups, saveGroups]);

  // pointer 드래그가 최신 reorderAsset 호출하도록 ref 동기화
  useEffect(() => {
    reorderAssetRef.current = reorderAsset;
  }, [reorderAsset]);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Folder size={20} strokeWidth={2.2} color={T.acl}/>
          <div>
            <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>관심종목 그룹</div>
            <div style={{ color: T.muted, fontSize: 10 }}>{groups.length}개 그룹 · 카테고리별 종목 관리</div>
          </div>
        </div>
        <button type="button" onClick={() => setShowAdd(true)}
          style={{ padding:'9px 14px', minHeight: 38,
            background:'linear-gradient(135deg,#2563EB,#10B981)', color:'#fff',
            border:'none', borderRadius: 10, fontWeight: 800, fontSize: 12, cursor:'pointer',
            display: 'flex', alignItems: 'center', gap: 5 }}>
          <FolderPlus size={14} strokeWidth={2.4}/>
          새 그룹
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
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap: 8 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: T.txt, fontSize: 14, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span>{activeGroup.icon}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeGroup.name}</span>
                </div>
                <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>
                  {(Array.isArray(activeGroup.assetIds) ? activeGroup.assetIds : []).length}개 종목 · 핸들을 드래그해 순서 변경
                </div>
              </div>
              <div style={{ display:'flex', gap: 6, flexShrink: 0 }}>
                <button type="button" onClick={() => setShowEdit(activeGroup.id)}
                  style={{ padding:'7px 12px', background: T.acg, color: T.acl,
                    border:`1px solid ${T.acl}40`, borderRadius: 8,
                    fontSize: 10, fontWeight: 700, cursor:'pointer', minHeight: 34,
                    display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Plus size={12} strokeWidth={2.4}/>
                  종목 추가
                </button>
                <button type="button" onClick={async () => {
                    if (typeof window === 'undefined') return;
                    const ok = (await confirmDialog(`정말 "${activeGroup.name}" 그룹을 삭제하시겠습니까?\n(이 그룹에 추가된 종목 자체는 다른 곳에 영향 없음)`, { danger: true }));
                    if (ok) deleteGroup(activeGroup.id);
                  }}
                  aria-label="그룹 삭제"
                  style={{ padding: 7, background: T.alt, color: T.red,
                    border:`1px solid ${T.red}30`, borderRadius: 8,
                    cursor:'pointer', minWidth: 34, minHeight: 34,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Trash2 size={14} strokeWidth={2.2}/>
                </button>
              </div>
            </div>
          </Card>

          {activeAssets.length === 0 ? (
            <Card style={{ padding:'40px 20px', textAlign:'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
                <Inbox size={32} strokeWidth={2} color={T.muted}/>
              </div>
              <div style={{ color: T.txt, fontSize: 13, marginBottom: 12 }}>
                이 그룹에 추가된 종목이 없습니다
              </div>
              <button type="button" onClick={() => setShowEdit(activeGroup.id)}
                style={{ background: T.acg, color: T.acl,
                  border:`1px solid ${T.acl}40`, borderRadius: 10,
                  padding:'9px 18px', fontSize: 12, fontWeight: 700,
                  cursor:'pointer', minHeight: 38,
                  display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Plus size={13} strokeWidth={2.4}/>
                종목 추가하기
              </button>
            </Card>
          ) : (
            <Card style={{ overflow:'hidden', padding: 0 }}>
              {activeAssets.map((a, i) => (
                <DraggableAssetRow
                  key={a.id}
                  asset={a}
                  index={i}
                  totalCount={activeAssets.length}
                  currency={currency}
                  isDragOver={dragOverId === a.id && draggingId !== a.id}
                  isDragging={draggingId === a.id}
                  onMoveUp={()     => moveAsset(a.id, -1)}
                  onMoveDown={()   => moveAsset(a.id, 1)}
                  onMoveTop={()    => moveAsset(a.id, 'top')}
                  onMoveBottom={() => moveAsset(a.id, 'bottom')}
                  onRemove={()     => toggleAsset(a.id)}
                  onOpen={()       => onOpenAsset?.(a, 'trading')}
                  onDragStart={()  => { setDraggingId(a.id); setDragOverId(null); }}
                  onDragEnter={()  => { if (draggingId && draggingId !== a.id) setDragOverId(a.id); }}
                  onDragEnd={()    => {
                    if (draggingId && dragOverId && draggingId !== dragOverId) {
                      reorderAsset(draggingId, dragOverId);
                    }
                    setDraggingId(null);
                    setDragOverId(null);
                  }}
                  onPointerDragStart={(_clientY) => startPointerDrag(a.id, _clientY)}
                />
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
              {['','','','','','💻','','🇺🇸','🇰🇷',''].map(e => (
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
