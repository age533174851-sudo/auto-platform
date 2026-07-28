'use client';
// src/components/ThemeToggle.tsx
//
// 테마 선택. 세 갈래 — 밝음 / 어두움 / 시간에 맞춰.
//
// '시간에 맞춰'를 기본으로 두는 이유: 대부분은 테마를 고르러 설정에
// 들어오지 않는다. 밤에 열면 어둡고 낮에 열면 밝은 것이 아무것도
// 안 했을 때 가장 덜 놀랍다.
//
// 지금 무엇이 적용됐는지 함께 보여준다. '시간에 맞춰'만 표시하면
// 사용자는 자기가 고른 것이 지금 어느 쪽인지 알 수 없다.
import React from 'react';
import { Sun, Moon, Clock } from 'lucide-react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { useTheme } from '@/lib/theme/useTheme';
import { MODE_LABEL, LIGHT_FROM_HOUR, DARK_FROM_HOUR, type ThemeMode } from '@/lib/theme/themeMode';

const OPTS: { id: ThemeMode; Icon: typeof Sun }[] = [
  { id: 'light', Icon: Sun },
  { id: 'dark',  Icon: Moon },
  { id: 'auto',  Icon: Clock },
];

export default function ThemeToggle({ compact }: { compact?: boolean }) {
  const { mode, resolved, setMode } = useTheme();

  return (
    <div>
      <div style={{ display: 'flex', gap: 6 }}>
        {OPTS.map(({ id, Icon }) => {
          const on = mode === id;
          return (
            <button key={id} type="button" onClick={() => setMode(id)}
              aria-pressed={on}
              style={{
                flex: 1, minHeight: compact ? 38 : 46,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 3,
                background: on ? A(T.acl, '20') : T.alt,
                color: on ? T.acl : T.sub,
                border: `1px solid ${on ? T.acl : T.border}`,
                borderRadius: 10, cursor: 'pointer',
                fontSize: 11, fontWeight: 700,
              }}>
              <Icon size={compact ? 13 : 15} strokeWidth={on ? 2.4 : 2}/>
              <span>{MODE_LABEL[id]}</span>
            </button>
          );
        })}
      </div>
      {!compact && (
        <div style={{ color: T.muted, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
          {mode === 'auto'
            ? `${LIGHT_FROM_HOUR}시부터 밝게, ${DARK_FROM_HOUR}시부터 어둡게 — 지금은 ${resolved === 'dark' ? '어두움' : '밝음'}입니다.`
            : '고른 테마를 계속 씁니다.'}
        </div>
      )}
    </div>
  );
}
