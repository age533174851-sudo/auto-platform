'use client';
//
// 단축키 도움말 (`?`).
//
// 단축키에 도움말이 없으면 그 기능은 만든 사람만 쓴다. 그래서 키맵을 손으로
// 다시 적지 않고 DEFAULT_BINDINGS를 그대로 그린다 — 목록을 두 곳에 적으면
// 언젠가 한 곳만 고치고, 그러면 도움말이 거짓말을 한다.
import React, { useEffect, useMemo, useState } from 'react';
import { activeBindings, prettyChord, type HotkeyProfile } from '@/lib/commands/keymap';

export interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
  profile: HotkeyProfile;
}

export default function ShortcutHelp({ open, onClose, profile }: ShortcutHelpProps) {
  // 맥이면 ⌘로 적는다. 서버 렌더에서는 알 수 없으니 마운트 후에 정한다.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    try { setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)); } catch {}
  }, []);

  const rows = useMemo(() => activeBindings(profile), [profile]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460, maxHeight: '80vh', overflowY: 'auto',
          background: 'var(--t-card)', border: '1px solid var(--t-border)',
          borderRadius: 16, padding: 20, fontFamily: "'Sora',sans-serif",
          boxShadow: '0 20px 60px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 16 }}>⌨️</span>
          <span style={{ color: 'var(--t-txt)', fontWeight: 800, fontSize: 15 }}>단축키</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--t-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map(b => (
            <div key={b.sequence} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 2px', borderBottom: '1px solid var(--t-border)' }}>
              <span style={{ color: 'var(--t-txt)', fontSize: 12.5, flex: 1 }}>{b.label}</span>
              <code style={{
                fontSize: 11, fontWeight: 700, color: 'var(--t-acl, #3B82F6)',
                background: 'var(--t-alt, rgba(255,255,255,.05))',
                border: '1px solid var(--t-border)', borderRadius: 6,
                padding: '3px 8px', whiteSpace: 'nowrap',
              }}>
                {prettyChord(b.sequence, isMac)}
              </code>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14, color: 'var(--t-muted)', fontSize: 10.5, lineHeight: 1.7 }}>
          입력칸에 커서가 있으면 단축키는 동작하지 않습니다 — 수량을 입력하다가
          주문이 나가는 것을 막기 위한 것입니다.
          {!profile.enableTrading && (
            <>
              <br />
              주문·청산 단축키는 아직 없습니다. 붙일 때는 한 번 더 눌러 확인하는
              단계를 거칩니다.
            </>
          )}
        </div>
      </div>
    </div>
  );
}
