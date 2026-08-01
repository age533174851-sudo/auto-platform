'use client';
import { A } from '@/lib/theme/colors';
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

  // ESC = 취소. Enter = 확인 — **단 위험한 것은 빼고.**
  // 실전 주문과 안전 점검 무시는 Enter로 넘어가면 안 된다. 창이 뜬 줄
  // 모르고 Enter를 눌러 실제 자금이 나가는 것이 실제로 가능했다.
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter' && !req.danger) close(true);
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
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: A(T.red,'1A'), display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
            <AlertTriangle size={22} color={T.red} />
          </div>
        )}

        {req.title && <div style={{ color: T.txt, fontWeight: 800, fontSize: 16, textAlign: 'center', marginBottom: 8 }}>{req.title}</div>}

        {/* \uBAA9\uB85D\uC774 \uAE38\uBA74 \uAC00\uC6B4\uB370 \uC815\uB82C\uC740 \uC77D\uAE30 \uC5B4\uB835\uB2E4 \u2014 \uD56D\uBAA9\uC774 \uC5EC\uB7FF\uC774\uBA74 \uC67C\uCABD\uC73C\uB85C.
            \uADF8\uB9AC\uACE0 \uBC18\uB4DC\uC2DC \uC2A4\uD06C\uB864\uC774 \uB418\uC5B4\uC57C \uD55C\uB2E4. \uC608\uC804\uC5D0\uB294 maxHeight\uAC00 \uC5C6\uC5B4
            \uD56D\uBAA9\uC774 \uB9CE\uC73C\uBA74 **\uBC84\uD2BC\uC774 \uD654\uBA74 \uBC16\uC73C\uB85C \uBC00\uB824** \uC544\uBB34\uAC83\uB3C4 \uBABB \uB20C\uB800\uB2E4. */}
        <div style={{
          color: req.title ? T.muted : T.txt, fontSize: 13.5, lineHeight: 1.6,
          textAlign: lines.length > 4 ? 'left' : 'center',
          marginBottom: 18, whiteSpace: 'pre-wrap',
          maxHeight: '52vh', overflowY: 'auto',
        }}>
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
