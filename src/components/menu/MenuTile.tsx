'use client';
// src/components/menu/MenuTile.tsx
//
// 전체 메뉴의 타일 한 장.
//
// **줄을 grid에 넣은 것이 아니다.** 줄 모양을 그대로 격자에 넣으면
// 아이콘·이름·설명이 가로로 늘어선 채 칸만 좁아져서 셋 다 잘린다.
// 타일은 세로로 쌓는다 — 아이콘, 이름, 설명 순.
//
// 데이터는 목록 모드와 같은 `MenuItem`이다. 메뉴 항목을 두 벌 만들면
// 언젠가 한쪽에만 항목이 추가된다.

import React from 'react';
import { SP, FS, FW, CONTROL } from '@/lib/ui/tokens';
import { Star } from 'lucide-react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import type { MenuItem } from '@/lib/menuItems';

export default function MenuTile({
  m, onOpen, fav, onStar,
}: {
  m: MenuItem;
  onOpen: (m: MenuItem) => void;
  fav: boolean;
  onStar: (id: string) => void;
}) {
  const { Icon } = m;
  return (
    <div
      style={{
        position: 'relative',
        background: T.card,
        border: `1px solid ${fav ? A(T.ylw, '50') : T.border}`,
        borderRadius: 14,
        minWidth: 0,
        display: 'flex',
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(m)}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: SP.sm,
          background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
          /* 별표 버튼과 겹치지 않게 오른쪽 위를 비워 둔다 */
          padding: '14px 42px 14px 14px',
          minHeight: 118,
        }}
      >
        <span style={{
          width: CONTROL.min, height: CONTROL.min, borderRadius: 11, background: m.color + '1F',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon size={20} color={m.color} />
        </span>
        <span style={{ minWidth: 0, maxWidth: '100%', display: 'block' }}>
          <span className="menu-tile-label" style={{
            display: 'block', color: T.txt, fontSize: FS.lead, fontWeight: FW.bold, marginBottom: 3,
          }}>{m.label}</span>
          <span className="menu-tile-desc" style={{
            color: T.muted, fontSize: FS.small, lineHeight: 1.35,
          }}>{m.desc}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onStar(m.id)}
        aria-label={fav ? `${m.label} 홈에서 제거` : `${m.label} 홈에 고정`}
        aria-pressed={fav}
        title={fav ? '홈에서 제거' : '홈에 고정'}
        style={{
          position: 'absolute', top: 6, right: 6,
          background: 'transparent', border: 'none', cursor: 'pointer',
          padding: SP.sm, minHeight: CONTROL.sm, display: 'flex',
        }}
      >
        <Star size={17} color={fav ? T.ylw : T.muted} fill={fav ? T.ylw : 'none'} />
      </button>
    </div>
  );
}
