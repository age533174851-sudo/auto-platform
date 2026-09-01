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
import { MIN_CONTROL_TARGET } from '@/lib/ui/panelPrefs';

export default function PanelToggle({
  side, open, onToggle, size = MIN_CONTROL_TARGET,
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
        borderRadius: 10,
        /* **누르는 자리는 아이콘 크기와 다르다.**
           예전에는 26×26이었고 "마우스가 있는 PC에서만 보인다"고 적어
           두었다. 그런데 사이드바는 768px, 레일은 1024px부터 보인다 —
           834×1194나 1024×768 태블릿은 손으로 누른다. 주석이 주장하는
           것과 실제 노출 조건이 달랐고, 손가락에 26px은 너무 작다.

           그래서 상자는 MIN_CONTROL_TARGET으로 잡고 아이콘만 작게 둔다.
           값은 panelPrefs에 있다 — 접힌 레일 폭도 같은 값을 보므로
           버튼만 커지고 칸은 그대로여서 삐져나오는 일이 없다. */
        width: size, height: size,
        minWidth: size, minHeight: size,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: T.sub, cursor: 'pointer', flexShrink: 0, padding: 0,
      }}
    >
      <Icon size={17} strokeWidth={2.2} />
    </button>
  );
}
