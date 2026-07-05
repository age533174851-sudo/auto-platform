'use client';
// NotifyHost — 전역 알림 UI. 하단 토스트 스택 + 우상단 알림센터(최근 50개).
// 이모지 대신 lucide-react 아이콘 사용. layout에 1회 마운트.
import React, { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Loader2, Info, AlertTriangle,
  ArrowUpCircle, ArrowDownCircle, Bot, ShieldAlert, Bell, X, Trash2,
} from 'lucide-react';
import {
  subscribeToasts, subscribeCenter, loadNotifications, clearNotifications,
  type NotifyItem, type NotifyKind,
} from '@/lib/notify/center';

// 색상 규칙 통일: 초록=수익/성공, 빨강=손실/실패, 파랑=정보/처리중, 노랑=경고, 보라=봇
const KIND: Record<NotifyKind, { Icon: any; color: string; spin?: boolean }> = {
  success: { Icon: CheckCircle2,   color: '#22C55E' },
  error:   { Icon: XCircle,        color: '#EF4444' },
  pending: { Icon: Loader2,        color: '#3B82F6', spin: true },
  info:    { Icon: Info,           color: '#3B82F6' },
  warning: { Icon: AlertTriangle,  color: '#F59E0B' },
  buy:     { Icon: ArrowUpCircle,  color: '#22C55E' },
  sell:    { Icon: ArrowDownCircle,color: '#EF4444' },
  tp:      { Icon: CheckCircle2,   color: '#22C55E' },
  sl:      { Icon: AlertTriangle,  color: '#EF4444' },
  bot:     { Icon: Bot,            color: '#8B5CF6' },
  kill:    { Icon: ShieldAlert,    color: '#EF4444' },
};

function timeStr(ms: number) {
  const d = new Date(ms);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export default function NotifyHost() {
  const [toasts, setToasts] = useState<NotifyItem[]>([]);
  const [openCenter, setOpenCenter] = useState(false);
  const [items, setItems] = useState<NotifyItem[]>([]);
  const [unread, setUnread] = useState(0);

  // 토스트 구독
  useEffect(() => subscribeToasts((item) => {
    setToasts(prev => {
      // 새 결과 토스트가 오면 이전 pending 토스트 제거
      const base = item.kind === 'pending' ? prev : prev.filter(t => t.kind !== 'pending');
      return [...base, item].slice(-4);   // 최대 4개 스택
    });
    if (item.kind !== 'pending') {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== item.id)), 4000);
    }
  }), []);

  // 알림센터 구독
  useEffect(() => {
    const reload = () => { setItems(loadNotifications()); setUnread(u => (openCenter ? 0 : u + 1)); };
    setItems(loadNotifications());
    return subscribeCenter(reload);
  }, [openCenter]);

  const dismiss = useCallback((id: string) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  return (
    <>
      <style>{`@keyframes tg-spin{to{transform:rotate(360deg)}}@keyframes tg-slide-in{from{transform:translateX(110%)}to{transform:translateX(0)}}@keyframes tg-toast-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* ── 하단 토스트 스택 ── */}
      <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 10000, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(92vw, 380px)', pointerEvents: 'none' }}>
        {toasts.map(t => {
          const k = KIND[t.kind];
          return (
            <div key={t.id} onClick={() => dismiss(t.id)} style={{
              pointerEvents: 'auto', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
              background: 'rgba(17,24,39,0.86)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              border: `1px solid ${k.color}55`, borderLeft: `3px solid ${k.color}`, borderRadius: 12,
              padding: '11px 13px', boxShadow: '0 8px 28px rgba(0,0,0,0.45)', animation: 'tg-toast-in .18s ease-out',
            }}>
              <k.Icon size={18} color={k.color} style={k.spin ? { animation: 'tg-spin 0.9s linear infinite', flexShrink: 0, marginTop: 1 } : { flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#fff', fontSize: 12.5, fontWeight: 700, lineHeight: 1.3 }}>{t.title}</div>
                {t.detail && <div style={{ color: '#cbd5e1', fontSize: 11, marginTop: 2, lineHeight: 1.4, whiteSpace: 'pre-line' }}>{t.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 우상단 알림센터 벨 ── */}
      <button onClick={() => { setOpenCenter(true); setUnread(0); }} style={{
        position: 'fixed', top: 10, right: 10, zIndex: 9998, width: 38, height: 38, borderRadius: 10,
        background: 'rgba(17,24,39,0.7)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}>
        <Bell size={18} color="#e2e8f0" />
        {unread > 0 && <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 99, background: '#EF4444', color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unread > 9 ? '9+' : unread}</span>}
      </button>

      {/* ── 알림센터 패널 (우측 슬라이드) ── */}
      {openCenter && (
        <>
          <div onClick={() => setOpenCenter(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10001 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(86vw, 360px)', zIndex: 10002,
            background: '#0B1220', borderLeft: '1px solid rgba(255,255,255,0.1)', boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column', animation: 'tg-slide-in .22s ease-out',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Bell size={16} color="#e2e8f0" />
                <span style={{ color: '#fff', fontSize: 14, fontWeight: 800 }}>알림</span>
                <span style={{ color: '#64748b', fontSize: 11 }}>최근 {items.length}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => { clearNotifications(); setItems([]); }} title="전체 삭제" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}><Trash2 size={16} color="#64748b" /></button>
                <button onClick={() => setOpenCenter(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}><X size={18} color="#94a3b8" /></button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
              {items.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: 12, textAlign: 'center', padding: 40 }}>알림이 없습니다</div>
              ) : items.map(it => {
                const k = KIND[it.kind] || KIND.info;
                return (
                  <div key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 8px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <k.Icon size={17} color={k.color} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#e2e8f0', fontSize: 12.5, fontWeight: 700 }}>{it.title}</div>
                      {it.detail && <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2, whiteSpace: 'pre-line' }}>{it.detail}</div>}
                      <div style={{ color: '#475569', fontSize: 9, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{timeStr(it.at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
