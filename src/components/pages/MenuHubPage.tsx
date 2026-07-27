'use client';
// MenuHubPage — 토스식 전체 메뉴. 카테고리 + 검색 + lucide 아이콘 + 즐겨찾기(별표).
import React, { useState, useMemo, useEffect } from 'react';
import { T } from '@/lib/constants';
import { Search, X, Star } from 'lucide-react';
import { MENU, MENU_CATS, type MenuItem } from '@/lib/menuItems';
import { getFavorites, toggleFavorite, subscribeFavorites, FAV_MAX } from '@/lib/favorites';

export default function MenuHubPage({ onNav }: { onNav: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState<string[]>([]);

  useEffect(() => { setFavs(getFavorites()); return subscribeFavorites(() => setFavs(getFavorites())); }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return MENU;
    const lq = q.toLowerCase();
    return MENU.filter(m => m.label.toLowerCase().includes(lq) || m.desc.toLowerCase().includes(lq) || (m.kw || '').toLowerCase().includes(lq));
  }, [q]);

  const onStar = (id: string) => {
    const added = toggleFavorite(id);
    if (!added && !getFavorites().includes(id) && getFavorites().length >= FAV_MAX) {
      // 한도 초과로 추가 실패한 경우만 (제거는 정상)
    }
    setFavs(getFavorites());
  };

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ color: T.txt, fontWeight: 900, fontSize: 20, marginBottom: 4 }}>전체 메뉴</div>
      <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>별표(★)를 누르면 홈에 고정돼요 · 최대 {FAV_MAX}개</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 12, padding: '0 14px', marginBottom: 18 }}>
        <Search size={16} color={T.muted} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="기능 검색 (예: 백테스트, 자동, 알림)"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.txt, fontSize: 14, padding: '14px 0' }} />
        {q && <button onClick={() => setQ('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}><X size={16} color={T.muted} /></button>}
      </div>

      {q.trim() ? (
        <div>
          <div style={{ color: T.muted, fontSize: 11, marginBottom: 10 }}>검색 결과 {filtered.length}개</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(m => <Row key={m.id} m={m} onNav={onNav} fav={favs.includes(m.id)} onStar={onStar} />)}
          </div>
          {filtered.length === 0 && <div style={{ color: T.muted, fontSize: 13, textAlign: 'center', padding: '30px 0' }}>"{q}"에 맞는 기능이 없어요</div>}
        </div>
      ) : (
        MENU_CATS.map(cat => {
          const items = MENU.filter(m => m.cat === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 22 }}>
              <div style={{ color: T.muted, fontSize: 12, fontWeight: 800, letterSpacing: 0.5, marginBottom: 10 }}>{cat}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map(m => <Row key={m.id} m={m} onNav={onNav} fav={favs.includes(m.id)} onStar={onStar} />)}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function Row({ m, onNav, fav, onStar }: { m: MenuItem; onNav: (id: string) => void; fav: boolean; onStar: (id: string) => void }) {
  const { Icon } = m;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: T.card, border: `1px solid ${fav ? T.ylw + '50' : T.border}`, borderRadius: 14, padding: '4px 8px 4px 14px' }}>
      <button onClick={() => onNav(m.id)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 13, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', minHeight: 56, padding: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: m.color + '1F', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={20} color={m.color} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: T.txt, fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{m.label}</div>
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.3 }}>{m.desc}</div>
        </div>
      </button>
      <button onClick={() => onStar(m.id)} title={fav ? '홈에서 제거' : '홈에 고정'}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 10, display: 'flex', flexShrink: 0 }}>
        <Star size={20} color={fav ? T.ylw : T.muted} fill={fav ? T.ylw : 'none'} />
      </button>
    </div>
  );
}
