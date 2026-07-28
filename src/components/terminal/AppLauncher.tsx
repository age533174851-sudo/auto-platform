'use client';
// src/components/terminal/AppLauncher.tsx
//
// 터미널에서 앱의 나머지 기능으로 가는 길.
//
// 왜 필요한가
// ───────────
// /terminal을 별도 경로로 만들면서 나머지 50여 개 화면(백테스트·자동매매·
// 뉴스·포트폴리오·세금…)으로 가는 길을 안 냈다. 터미널이 섬이 됐다.
//
// 목록을 여기서 새로 만들지 않는다
// ────────────────────────────────
// lib/menuItems의 MENU를 그대로 쓴다. 목록을 두 벌 두면 앱에 기능이
// 추가돼도 터미널에서는 안 보이고, 그 차이를 아무도 모른다.
import React, { memo, useCallback, useMemo, useState } from 'react';
import { C, FS, tabStyle } from './theme';
import { MENU, MENU_CATS } from '@/lib/menuItems';
import { useTerminal } from './TerminalContext';

export const AppLauncher = memo(function AppLauncher({ onClose }: { onClose?: () => void }) {
  const [q, setQ] = useState('');
  const { navigateApp } = useTerminal();

  // 지금 보고 있는 화면(터미널)은 목록에서 뺀다. 자기 자신으로 가는
  // 링크는 눌러도 아무 일이 없어서 고장난 것처럼 보인다.
  // 매매 탭이 곧 터미널이므로 trading이 자기 자신이다.
  const items = useMemo(
    () => MENU.filter(m => m.href !== '/terminal' && m.id !== 'trading'), []);

  /**
   * 앱 안에서는 탭만 바꾼다.
   *
   * href로 두면 전체 페이지가 다시 로드된다 — 차트 iframe·WebSocket이
   * 끊기고 다시 붙는다. 같은 앱 안에서 화면을 바꾸는 것뿐인데 그럴 이유가
   * 없다. 독립 경로(/terminal)로 열었을 때는 navigateApp이 없으므로
   * preventDefault를 하지 않고 링크가 평소대로 동작한다.
   */
  const go = useCallback((e: React.MouseEvent, id: string) => {
    if (!navigateApp) return;                       // 링크 기본 동작에 맡긴다
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;  // 새 탭으로 열기 존중
    e.preventDefault();
    navigateApp(id);
    onClose?.();
  }, [navigateApp, onClose]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter(m =>
      m.label.toLowerCase().includes(t) ||
      m.desc.toLowerCase().includes(t) ||
      (m.kw || '').toLowerCase().includes(t));
  }, [q, items]);

  const cats = q.trim() ? ['검색 결과'] : MENU_CATS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 12px 8px', flexShrink: 0 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { if (q) setQ(''); else onClose?.(); } }}
          placeholder="기능 검색 (백테스트, 자동매매, 뉴스…)"
          autoFocus
          style={{
            width: '100%', boxSizing: 'border-box',
            background: C.raised, color: C.text,
            border: `1px solid ${C.hair}`, borderRadius: 8,
            padding: '9px 11px', fontSize: FS.body, outline: 'none',
          }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px' }}>
        {filtered.length === 0 && (
          <div style={{ padding: '28px 0', textAlign: 'center', color: C.faint, fontSize: FS.small }}>
            &lsquo;{q}&rsquo;에 맞는 기능이 없습니다
          </div>
        )}

        {cats.map(cat => {
          const items = q.trim() ? filtered : filtered.filter(m => m.cat === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 16 }}>
              <div style={{
                color: C.faint, fontSize: FS.micro, fontWeight: 600,
                letterSpacing: '0.05em', marginBottom: 6,
              }}>{cat}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 6 }}>
                {items.map(m => (
                  // 앱은 tab 상태로 화면을 바꾸므로 ?tab=으로 넘긴다.
                  // 새 탭이 아니라 같은 창에서 연다 — 터미널과 앱을 오가는
                  // 것은 화면 전환이지 새 작업이 아니다.
                  <a key={m.id} href={m.href ?? `/?tab=${encodeURIComponent(m.id)}`}
                    onClick={e => go(e, m.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 9,
                    padding: '9px 10px', borderRadius: 9, textDecoration: 'none',
                    background: C.raised, border: `1px solid ${C.hair}`,
                  }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: m.color + '22', color: m.color,
                    }}>
                      <m.Icon size={14}/>
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{
                        display: 'block', color: C.text, fontSize: FS.small, fontWeight: 600,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{m.label}</span>
                      <span style={{
                        display: 'block', color: C.faint, fontSize: FS.micro,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{m.desc}</span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          );
        })}

        <a href="/" onClick={e => go(e, 'home')} style={{
          display: 'block', textAlign: 'center', padding: '11px 0', marginTop: 4,
          background: C.raised, border: `1px solid ${C.hair2}`, borderRadius: 9,
          color: C.accent, fontSize: FS.small, fontWeight: 700, textDecoration: 'none',
        }}>일반 화면(홈)으로 나가기</a>
      </div>
    </div>
  );
});
