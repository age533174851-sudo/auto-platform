'use client';
// src/components/auto/AutoSheet.tsx
//
// **아래에서 올라오는 판 하나.**
//
// 왜 필요한가
// ───────────
// 자동매매 화면 하나에 자동매매 홈 · 전략 설정 · 시스템 진단이 전부
// 섞여 있었다. 그래서 "지금 내 돈이 어떻게 되고 있나"를 보려면
// Worker 상태와 마이그레이션 번호를 지나가야 했다.
//
// **지우는 것이 아니라 옮긴다.** 진단 정보는 돈에 문제가 생겼을 때
// 가장 먼저 필요한 것이고, 없애면 그때 사람이 Fly 로그를 열게 된다 —
// 이 저장소가 없애려고 애쓴 바로 그 상황이다.
//
// 그래서 기본 화면에서 접고, 한 번 눌러 열 수 있게 한다.
import React from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';

export default function AutoSheet(props: {
  open: boolean;
  title: string;
  /** 제목 옆 한 줄. 열지 않아도 보이는 요약 */
  summary?: string | null;
  /** 요약 색. 문제가 있을 때만 준다 */
  tone?: string | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!props.open) return null;
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto',
          background: T.card, borderTopLeftRadius: 18, borderTopRightRadius: 18,
          border: `1px solid ${T.border}`, borderBottom: 'none',
          padding: '14px 14px 28px',
          // 안쪽에서 무엇이 넘치든 판이 화면을 밀어내지 않게 한다.
          minWidth: 0, overflowWrap: 'anywhere',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          position: 'sticky', top: 0, background: T.card, paddingBottom: 10, zIndex: 1,
        }}>
          <span style={{ color: T.txt, fontWeight: 900, fontSize: 14 }}>{props.title}</span>
          {props.summary && (
            <span style={{ color: props.tone || T.muted, fontSize: 11, fontWeight: 700 }}>
              {props.summary}
            </span>
          )}
          <button
            onClick={props.onClose}
            aria-label="닫기"
            style={{
              marginLeft: 'auto', minWidth: 44, minHeight: 44,
              background: 'transparent', border: `1px solid ${T.border}`,
              borderRadius: 10, color: T.muted, fontSize: 13, fontWeight: 800, cursor: 'pointer',
            }}
          >✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** 판을 여는 줄. 접혀 있을 때 화면에 남는 것은 이 한 줄뿐이다 */
export function AutoSheetRow(props: {
  title: string;
  summary: string;
  tone?: string | null;
  onOpen: () => void;
}) {
  const tone = props.tone || T.muted;
  return (
    <button
      onClick={props.onOpen}
      style={{
        width: '100%', minHeight: 52, textAlign: 'left', cursor: 'pointer',
        background: props.tone ? A(tone, '10') : 'transparent',
        border: `1px solid ${props.tone ? A(tone, '35') : T.border}`,
        borderRadius: 12, padding: '10px 12px', marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 8,
      }}
    >
      <span style={{ color: T.txt, fontWeight: 800, fontSize: 12.5 }}>{props.title}</span>
      <span style={{ color: tone, fontSize: 11, fontWeight: 700, marginLeft: 'auto', textAlign: 'right' }}>
        {props.summary}
      </span>
      <span style={{ color: T.muted, fontSize: 12 }}>›</span>
    </button>
  );
}
