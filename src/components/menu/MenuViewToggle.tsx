'use client';
// src/components/menu/MenuViewToggle.tsx
//
// 전체 메뉴의 보기 방식 전환 — 타일 / 목록.
//
// 두 버튼을 `role="group"`으로 묶고 `aria-pressed`를 쓴다. 라디오가
// 아니라 **눌린 상태를 가진 버튼 둘**이다. 지금 무엇이 켜져 있는지가
// 색으로만 보이면 색을 구분하지 못하는 사람에게는 안 보인다.

import React from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { T } from '@/lib/constants';
import type { MenuView } from '@/lib/ui/panelPrefs';

const OPTS: { v: MenuView; label: string; Icon: typeof List }[] = [
  { v: 'grid', label: '타일', Icon: LayoutGrid },
  { v: 'list', label: '목록', Icon: List },
];

export default function MenuViewToggle({
  view, onChange,
}: { view: MenuView; onChange: (v: MenuView) => void }) {
  return (
    <div
      role="group"
      aria-label="메뉴 보기 방식"
      style={{
        display: 'flex', gap: 3, background: T.alt,
        border: `1px solid ${T.border}`, borderRadius: 10, padding: 3, flexShrink: 0,
      }}
    >
      {OPTS.map(({ v, label, Icon }) => {
        const on = view === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={on}
            title={`${label}로 보기`}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
              /* 손가락으로 누를 수 있어야 한다 — 이 버튼은 폰에도 보인다 */
              minHeight: 40,
              background: on ? T.acc : 'transparent',
              color: on ? '#fff' : T.muted,
              fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap',
            }}
          >
            <Icon size={14} strokeWidth={2.3} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
