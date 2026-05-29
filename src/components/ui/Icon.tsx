// ─────────────────────────────────────────────────────────────
// TRAIGO Design System — Icon wrapper + tokens
// 이모지 대신 lucide-react 아이콘을 일관된 크기/색상으로 표시
// ─────────────────────────────────────────────────────────────

import React from 'react';
import { T } from '@/lib/constants';

export type IconTone =
  | 'blue'    // 정보 / AI / 차트
  | 'green'   // 수익 / 상승 / 성공
  | 'red'     // 손실 / 하락 / 위험
  | 'yellow'  // 경고 / 주의 / 단타
  | 'purple'  // 장투 / 안정
  | 'cyan'    // 코인 / 보조
  | 'gray';   // 중립 / 설정

const TONE_BG: Record<IconTone, string> = {
  blue:   T.acl + '22',
  green:  T.grn + '22',
  red:    T.red + '22',
  yellow: T.ylw + '22',
  purple: T.prp + '22',
  cyan:   T.cyn + '22',
  gray:   T.sub + '22',
};

const TONE_FG: Record<IconTone, string> = {
  blue:   T.acl,
  green:  T.grn,
  red:    T.red,
  yellow: T.ylw,
  purple: T.prp,
  cyan:   T.cyn,
  gray:   T.sub,
};

export const TONE_COLOR = TONE_FG;

export type IconSize = 'sm' | 'md' | 'lg';

const BOX_SIZE: Record<IconSize, number> = { sm: 28, md: 36, lg: 44 };
const ICON_PX:  Record<IconSize, number> = { sm: 14, md: 18, lg: 22 };

// ── IconBox: 색 토큰 박스 안에 아이콘 ────────────────────
export function IconBox({
  children, tone = 'blue', size = 'md', style,
}: {
  children: React.ReactNode;
  tone?: IconTone;
  size?: IconSize;
  style?: React.CSSProperties;
}) {
  const w = BOX_SIZE[size];
  return (
    <div style={{
      width: w, height: w,
      borderRadius: w / 3,
      background: TONE_BG[tone],
      color: TONE_FG[tone],
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── 인라인 아이콘 (텍스트 옆에 자주 쓰는 작은 아이콘) ──
export function InlineIcon({
  children, tone = 'blue', size = 'md', style,
}: {
  children: React.ReactNode;
  tone?: IconTone;
  size?: IconSize;
  style?: React.CSSProperties;
}) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      color: TONE_FG[tone],
      ...style,
    }}>
      {children}
    </span>
  );
}

// ── 아이콘 사이즈를 lucide 컴포넌트에 전달할 때 사용 ──
export const IC_SIZE = ICON_PX;

// 권장 strokeWidth (lucide 기본 2 → 2.2가 모바일에서 더 또렷)
export const IC_STROKE = 2.2;
