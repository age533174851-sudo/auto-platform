'use client';
import { A } from '@/lib/theme/colors';
// MenuHubPage — 토스식 전체 메뉴. 카테고리 + 검색 + lucide 아이콘 + 즐겨찾기(별표).
//
// 보기 방식 둘
// ────────────
// 목록(list)은 지금까지 있던 모양이고, 타일(grid)은 시작 메뉴처럼
// 한눈에 훑는 모양이다. **둘은 같은 `MENU` 배열을 본다.** 항목 목록을
// 한 벌 더 만들면 다음에 메뉴 하나가 한쪽에만 추가된다.
//
// 검색·즐겨찾기·이동은 보기 방식과 무관하다. 그래서 `open`/`onStar`는
// 여기 한 번만 있고 두 모양이 같은 함수를 받는다 — 타일에서 누른 것과
// 줄에서 누른 것이 다른 곳으로 가는 일이 생기지 않는다.
import React, { useState, useMemo, useEffect } from 'react';
import { T } from '@/lib/constants';
import { Search, X, Star } from 'lucide-react';
import { MENU, MENU_CATS, type MenuItem } from '@/lib/menuItems';
import { getFavorites, toggleFavorite, subscribeFavorites, FAV_MAX } from '@/lib/favorites';
import { loadMenuView, saveMenuView, type MenuView } from '@/lib/ui/panelPrefs';
import MenuViewToggle from '@/components/menu/MenuViewToggle';
import MenuTile from '@/components/menu/MenuTile';

export default function MenuHubPage({ onNav }: { onNav: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState<string[]>([]);
  // 서버 렌더와 첫 그림이 갈리지 않게 기본값으로 시작하고, 붙은 뒤에 읽는다.
  const [view, setView] = useState<MenuView>('list');

  useEffect(() => { setFavs(getFavorites()); return subscribeFavorites(() => setFavs(getFavorites())); }, []);
  useEffect(() => { setView(loadMenuView()); }, []);

  const changeView = (v: MenuView) => { setView(v); saveMenuView(v); };

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

  // href가 있는 항목은 별도 페이지다. onNav는 이 앱 안의 tab만 바꾸므로
  // 그대로 두면 아무 일도 일어나지 않는다.
  //
  // **이 판단은 여기 한 곳에만 있다.** 줄과 타일이 각자 갖고 있으면
  // 한쪽만 고쳐지는 날 그 모양에서만 메뉴가 죽는다.
  const open = (m: MenuItem) => { if (m.href) window.location.href = m.href; else onNav(m.id); };

  // 두 모양에 같은 항목을 넘긴다.
  const render = (items: MenuItem[]) => (
    view === 'grid'
      ? (
        <div className="menu-grid">
          {items.map(m => (
            <MenuTile key={m.id} m={m} onOpen={open} fav={favs.includes(m.id)} onStar={onStar} />
          ))}
        </div>
      )
      : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(m => (
            <Row key={m.id} m={m} onOpen={open} fav={favs.includes(m.id)} onStar={onStar} />
          ))}
        </div>
      )
  );

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 12, flexWrap: 'wrap', marginBottom: 14,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 20, marginBottom: 4 }}>전체 메뉴</div>
          <div style={{ color: T.muted, fontSize: 12 }}>별표(★)를 누르면 홈에 고정돼요 · 최대 {FAV_MAX}개</div>
        </div>
        <MenuViewToggle view={view} onChange={changeView} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 12, padding: '0 14px', marginBottom: 18, maxWidth: 560 }}>
        <Search size={16} color={T.muted} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="기능 검색 (예: 백테스트, 자동, 알림)"
          aria-label="기능 검색"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.txt, fontSize: 14, padding: '14px 0' }} />
        {q && <button onClick={() => setQ('')} aria-label="검색어 지우기" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}><X size={16} color={T.muted} /></button>}
      </div>

      {q.trim() ? (
        <div>
          <div style={{ color: T.muted, fontSize: 11, marginBottom: 10 }}>검색 결과 {filtered.length}개</div>
          {render(filtered)}
          {filtered.length === 0 && <div style={{ color: T.muted, fontSize: 13, textAlign: 'center', padding: '30px 0' }}>&quot;{q}&quot;에 맞는 기능이 없어요</div>}
        </div>
      ) : (
        MENU_CATS.map(cat => {
          const items = MENU.filter(m => m.cat === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 22 }}>
              <div style={{ color: T.muted, fontSize: 12, fontWeight: 800, letterSpacing: 0.5, marginBottom: 10 }}>{cat}</div>
              {render(items)}
            </div>
          );
        })
      )}
    </div>
  );
}

function Row({ m, onOpen, fav, onStar }: { m: MenuItem; onOpen: (m: MenuItem) => void; fav: boolean; onStar: (id: string) => void }) {
  const { Icon } = m;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: T.card, border: `1px solid ${fav ? A(T.ylw,'50') : T.border}`, borderRadius: 14, padding: '4px 8px 4px 14px', minWidth: 0 }}>
      <button onClick={() => onOpen(m)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 13, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', minHeight: 56, padding: 0, minWidth: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: m.color + '1F', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={20} color={m.color} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="menu-tile-label" style={{ color: T.txt, fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{m.label}</div>
          <div className="menu-row-desc" style={{ color: T.muted, fontSize: 11, lineHeight: 1.3 }}>{m.desc}</div>
        </div>
      </button>
      <button onClick={() => onStar(m.id)}
        aria-label={fav ? `${m.label} 홈에서 제거` : `${m.label} 홈에 고정`}
        aria-pressed={fav}
        title={fav ? '홈에서 제거' : '홈에 고정'}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 10, display: 'flex', flexShrink: 0 }}>
        <Star size={20} color={fav ? T.ylw : T.muted} fill={fav ? T.ylw : 'none'} />
      </button>
    </div>
  );
}
