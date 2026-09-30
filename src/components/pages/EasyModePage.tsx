'use client';

import React, { useEffect, useState } from 'react';
import {
  Beaker, Bot, Blocks, LineChart, PieChart, Settings,
  ChevronRight, Sparkles, LayoutGrid,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';

const EASY_START_KEY = 'tg_easy_start';

type EasyAction = {
  id: string;
  title: string;
  desc: string;
  color: string;
  Icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
};

const ACTIONS: EasyAction[] = [
  { id: 'paper', title: '모의매매', desc: '가짜 돈으로 먼저 연습', color: '#8B5CF6', Icon: Beaker },
  { id: 'auto', title: '자동매매', desc: '켜기 · 끄기 · 상태 확인', color: '#2563EB', Icon: Bot },
  { id: 'strategies', title: '내 전략', desc: '전략 만들기 · 관리', color: '#7C3AED', Icon: Blocks },
  { id: 'market', title: '시장', desc: '가격과 종목 찾아보기', color: '#0EA5E9', Icon: LineChart },
  { id: 'portfolio', title: '내 자산', desc: '보유 자산과 손익 확인', color: '#10B981', Icon: PieChart },
  { id: 'settings', title: '계정 · 설정', desc: '계정, 보안, 앱 설정', color: '#64748B', Icon: Settings },
];

export default function EasyModePage({ onNav }: { onNav: (id: string) => void }) {
  const [startEasy, setStartEasy] = useState(false);

  useEffect(() => {
    try { setStartEasy(localStorage.getItem(EASY_START_KEY) === 'true'); } catch {}
  }, []);

  const toggleStart = () => {
    setStartEasy(v => {
      const next = !v;
      try { localStorage.setItem(EASY_START_KEY, String(next)); } catch {}
      return next;
    });
  };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', paddingBottom: 24 }}>
      <div style={{
        background: `linear-gradient(135deg,${A(T.acc,'18')},${A(T.prp,'16')})`,
        border: `1px solid ${A(T.acl,'35')}`,
        borderRadius: 22,
        padding: '20px 18px',
        marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 13,
            background: T.acg, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={22} color={T.acl} strokeWidth={2.3} />
          </div>
          <div>
            <div style={{ color: T.txt, fontWeight: 900, fontSize: 20 }}>쉬운 화면</div>
            <div style={{ color: T.muted, fontSize: 11, marginTop: 2 }}>자주 쓰는 기능만 모았습니다</div>
          </div>
        </div>
        <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.6 }}>
          복잡한 메뉴를 찾지 않아도 됩니다. 필요한 일을 누르면 바로 해당 화면으로 이동합니다.
          기존 전체 기능은 그대로 남아 있습니다.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
        {ACTIONS.map(({ id, title, desc, color, Icon }) => (
          <button
            key={id}
            onClick={() => onNav(id)}
            style={{
              minHeight: 126,
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 18,
              padding: '16px 14px',
              cursor: 'pointer',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{
              width: 44, height: 44, borderRadius: 13,
              background: `${color}1F`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon size={23} color={color} strokeWidth={2.2} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: T.txt, fontSize: 15, fontWeight: 850 }}>{title}</div>
                <div style={{ color: T.muted, fontSize: 10.5, marginTop: 3, lineHeight: 1.35 }}>{desc}</div>
              </div>
              <ChevronRight size={17} color={T.muted} />
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={toggleStart}
        aria-pressed={startEasy}
        style={{
          width: '100%',
          minHeight: 54,
          borderRadius: 16,
          border: `1px solid ${startEasy ? A(T.acl,'55') : T.border}`,
          background: startEasy ? T.acg : T.card,
          color: T.txt,
          cursor: 'pointer',
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          textAlign: 'left',
          marginBottom: 10,
        }}
      >
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: startEasy ? A(T.acl,'22') : T.alt,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <LayoutGrid size={18} color={startEasy ? T.acl : T.muted} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 13 }}>다음부터 쉬운 화면으로 시작</div>
          <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>
            {startEasy ? '켜짐 · 앱을 다시 열어도 쉬운 화면부터 시작합니다' : '꺼짐 · 기본 홈으로 시작합니다'}
          </div>
        </div>
        <div style={{
          width: 42, height: 24, borderRadius: 999,
          background: startEasy ? T.acl : T.border2,
          padding: 3, display: 'flex', alignItems: 'center',
          justifyContent: startEasy ? 'flex-end' : 'flex-start',
        }}>
          <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', display: 'block' }} />
        </div>
      </button>

      <button
        onClick={() => onNav('menu_hub')}
        style={{
          width: '100%', minHeight: 48,
          background: 'transparent',
          border: `1px dashed ${T.border2}`,
          borderRadius: 14,
          color: T.muted,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        전체 기능 보기
      </button>
    </div>
  );
}
