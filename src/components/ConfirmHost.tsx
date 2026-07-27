'use client';
// ConfirmHost — 전역 확인 모달. 앱 루트에 마운트. confirmDialog() 요청을 렌더.
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { _subscribeConfirm } from '@/lib/confirm/dialog';
import { AlertTriangle } from 'lucide-react';

export default function ConfirmHost() {
  const [req, setReq] = useState<any>(null);

  useEffect(() => _subscribeConfirm(setReq), []);

  const close = useCallback((ok: boolean) => {
    setReq((cur: any) => { if (cur) cur.resolve(ok); return null; });
  }, []);

  // ESC = 취소, Enter = 확인
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, close]);

  if (!req) return null;

  const danger = !!req.danger;
  const accent = danger ? T.red : T.acl;
  const lines = String(req.message).split('\n');

  return (
    <div onClick={() => close(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', zIndex: 10080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 340, background: T.bg, border: `1px solid ${T.border2}`, borderRadius: 20, padding: '22px 20px 16px', animation: 'tg-confirm-in .18s ease-out' }}>
        <style>{`@keyframes tg-confirm-in{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}`}</style>

        {danger && (
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: T.red + '1A', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
            <AlertTriangle size={22} color={T.red} />
          </div>
        )}

        {req.title && <div style={{ color: T.txt, fontWeight: 800, fontSize: 16, textAlign: 'center', marginBottom: 8 }}>{req.title}</div>}

        <div style={{ color: req.title ? T.muted : T.txt, fontSize: 13.5, lineHeight: 1.6, textAlign: 'center', marginBottom: 18, whiteSpace: 'pre-wrap' }}>
          {lines.map((ln: string, i: number) => <div key={i}>{ln || '\u00A0'}</div>)}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => close(false)}
            style={{ flex: 1, background: T.card, color: T.sub, border: `1px solid ${T.border}`, borderRadius: 12, padding: '13px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            {req.cancelText || '취소'}
          </button>
          <button onClick={() => close(true)} autoFocus
            style={{ flex: 1, background: accent, color: '#fff', border: 'none', borderRadius: 12, padding: '13px', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
            {req.confirmText || '확인'}
          </button>
        </div>
      </div>
    </div>
  );
}
