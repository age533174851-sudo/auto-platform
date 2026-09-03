'use client';
// NotifyHost — 전역 알림 UI. 하단 토스트 스택 + 우상단 **최근 알림함**(최근 50개).
//
// 헤더에도 벨 버튼이 하나 있는데 **다른 것**이다:
//   여기(수신함) → 이미 일어난 일의 기록. 정본은 lib/notify/center.
//   헤더 벨      → 가격·신호 알림 화면. 사용자가 거는 조건을 설정한다.
// 아이콘이 둘 다 종이라 눈으로 구분이 안 됐다. 그래서 이쪽을 수신함
// 아이콘으로 바꿨다. 기능을 지워서 해결하지 않는다 — 둘 다 필요하다.
// 이모지 대신 lucide-react 아이콘 사용. layout에 1회 마운트.
import React, { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Loader2, Info, AlertTriangle,
  ArrowUpCircle, ArrowDownCircle, Bot, ShieldAlert, Inbox, X, Trash2,
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

      {/* ── 우상단 알림센터 벨 ──
          이 버튼은 화면 위에 떠 있다. 그래서 **자기 자리를 스스로 비워
          두지 못한다.** 예전에는 38×38로 top:10 right:10에 그냥 떠 있었고,
          오른쪽 레일이 사라지는 1024px 미만에서 헤더의 로그인·프로필
          버튼을 1376px² 덮었다(430·390·360·834 전부 실측). 데스크톱에서
          안 겹친 것은 접힌 레일이 우연히 같은 띠를 비워 뒀기 때문이다.

          그 띠를 우연이 아니라 계약으로 만든다 — `--notify-band`.
          벨은 그 안에 들어가고, 레일이 없는 폭에서는 헤더가 같은 띠를
          비운다(globals.css). 음수 마진이나 z-index로 밀어 넣지 않는다.
          크기는 `--tap`(40) — 태블릿에서 손으로 누르는 버튼이다. */}
      <button onClick={() => { setOpenCenter(true); setUnread(0); }}
        aria-label={unread > 0 ? `최근 알림함 열기 — 읽지 않음 ${unread}건` : '최근 알림함 열기'}
        title="최근 알림함 — 방금 일어난 일의 기록"
        style={{
        position: 'fixed', top: 4, right: 4, zIndex: 9998,
        width: 'var(--tap)', height: 'var(--tap)', borderRadius: 10,
        background: 'rgba(17,24,39,0.7)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}>
        <Inbox size={18} color="var(--t-txt)" />
        {unread > 0 && <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 99, background: '#EF4444', color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unread > 9 ? '9+' : unread}</span>}
      </button>

      {/* ── 알림센터 패널 (우측 슬라이드) ── */}
      {openCenter && (
        <>
          <div onClick={() => setOpenCenter(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10001 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(86vw, 360px)', zIndex: 10002,
            background: 'var(--t-card)', borderLeft: '1px solid rgba(255,255,255,0.1)', boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column', animation: 'tg-slide-in .22s ease-out',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Inbox size={16} color="var(--t-txt)" />
                <span style={{ color: '#fff', fontSize: 14, fontWeight: 800 }}>최근 알림함</span>
                <span style={{ color: '#64748b', fontSize: 11 }}>최근 {items.length}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {/* 아이콘만 있는 버튼이라도 누르는 자리는 --tap을 지킨다.
                    아이콘 크기와 누르는 자리는 다른 값이다. */}
                <button onClick={() => { clearNotifications(); setItems([]); }} title="전체 삭제" aria-label="알림 전체 삭제" style={{ background: 'transparent', border: 'none', cursor: 'pointer', minWidth: 'var(--tap)', minHeight: 'var(--tap)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={16} color="#64748b" /></button>
                <button onClick={() => setOpenCenter(false)} aria-label="알림 닫기" style={{ background: 'transparent', border: 'none', cursor: 'pointer', minWidth: 'var(--tap)', minHeight: 'var(--tap)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={18} color="var(--t-sub)" /></button>
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
                      <div style={{ color: 'var(--t-txt)', fontSize: 12.5, fontWeight: 700 }}>{it.title}</div>
                      {it.detail && <div style={{ color: 'var(--t-sub)', fontSize: 11, marginTop: 2, whiteSpace: 'pre-line' }}>{it.detail}</div>}
                      <div style={{ color: 'var(--t-muted)', fontSize: 9, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{timeStr(it.at)}</div>
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
