'use client';
// src/components/shell/PanelToggle.tsx
//
// 패널을 접고 펴는 버튼. 좌우 둘이 같은 물건이므로 한 번만 만든다.
//
// `div onClick`으로 만들지 않는 이유
// ──────────────────────────────────
// 그러면 Tab으로 닿지 않고, Enter/Space로 눌리지 않고, 화면 낭독기가
// "버튼"이라고 말해 주지 않는다. 아이콘만 있는 버튼은 특히 그렇다 —
// 보이는 글자가 없으므로 `aria-label`이 유일한 이름이다.
//
// `aria-expanded`를 붙이는 이유: 이 버튼은 "무엇을 연다"가 아니라
// "지금 열려 있는지"를 말해야 한다. 낭독기는 그 값을 읽어 준다.

import React from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { T } from '@/lib/constants';

export default function PanelToggle({
  side, open, onToggle, size = 26,
}: {
  side: 'left' | 'right';
  open: boolean;
  onToggle: () => void;
  size?: number;
}) {
  const Icon = side === 'left'
    ? (open ? PanelLeftClose : PanelLeftOpen)
    : (open ? PanelRightClose : PanelRightOpen);

  const what = side === 'left' ? '메뉴 패널' : '오른쪽 패널';
  const label = `${what} ${open ? '접기' : '펼치기'}`;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={open}
      title={label}
      style={{
        background: 'transparent',
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        width: size, height: size,
        minHeight: size,          /* 전역 44px 규칙을 여기서만 낮춘다 —
                                     이 버튼은 마우스가 있는 PC에서만 보인다 */
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: T.sub, cursor: 'pointer', flexShrink: 0, padding: 0,
      }}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} />
    </button>
  );
}
