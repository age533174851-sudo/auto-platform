// ─────────────────────────────────────────────────────────────
// TRAIGO Design Tokens — 간격 / 타이포 / 모서리
// 카드 간격 통일, 모바일 한눈에 들어오는 위계 만들기
// ─────────────────────────────────────────────────────────────

import { T } from '@/lib/constants';

// 간격 (Toss스럽게 약간 넉넉하게)
export const SP = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

// 모서리
export const R = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

// 타이포 위계 (모바일 기준)
export const F = {
  // 제목 (페이지 헤더)
  title:    { fontSize: 18, fontWeight: 800, letterSpacing: -0.3, color: T.txt   } as const,
  // 부제목 / 섹션 헤더
  section:  { fontSize: 14, fontWeight: 800, color: T.txt   } as const,
  // 카드 라벨 / 부가 설명
  caption:  { fontSize: 11, fontWeight: 600, color: T.sub   } as const,
  // 본문
  body:     { fontSize: 13, fontWeight: 500, color: T.txt   } as const,
  muted:    { fontSize: 11, fontWeight: 500, color: T.muted } as const,
  // 큰 숫자 (총자산 등)
  numXL:    { fontSize: 26, fontWeight: 900, letterSpacing: -0.5, color: T.txt } as const,
  numL:     { fontSize: 20, fontWeight: 800, letterSpacing: -0.3, color: T.txt } as const,
  numM:     { fontSize: 16, fontWeight: 800, color: T.txt } as const,
  numS:     { fontSize: 13, fontWeight: 700, color: T.txt } as const,
  // 버튼
  btn:      { fontSize: 13, fontWeight: 700, letterSpacing: -0.1 } as const,
  btnSm:    { fontSize: 11, fontWeight: 700 } as const,
} as const;

// 카드 — Toss 느낌의 깔끔한 컨테이너
export function cardStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: R.lg,
    padding: SP.lg,
    ...extra,
  };
}

// 버튼 — 44px 최소 터치영역
export function buttonStyle(
  variant: 'primary' | 'ghost' | 'danger' | 'warn' | 'success' = 'ghost',
  size: 'sm' | 'md' | 'lg' = 'md',
): React.CSSProperties {
  const sizePad = size === 'sm' ? '8px 12px' : size === 'lg' ? '14px 18px' : '12px 16px';
  const sizeMin = size === 'sm' ? 36 : 44;
  const base: React.CSSProperties = {
    border: 'none',
    borderRadius: R.md,
    cursor: 'pointer',
    padding: sizePad,
    minHeight: sizeMin,
    touchAction: 'manipulation',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP.xs + 2,
    ...F.btn,
  };
  if (variant === 'primary') return { ...base, background: T.acc, color: '#fff' };
  if (variant === 'danger')  return { ...base, background: T.red, color: '#fff' };
  if (variant === 'warn')    return { ...base, background: T.ylw, color: '#000' };
  if (variant === 'success') return { ...base, background: T.grn, color: '#fff' };
  return { ...base, background: 'transparent', color: T.txt, border: `1px solid ${T.border}` };
}

// 페이지 컨테이너 (overflow-x 안전 + 하단 네비 여백)
export const PAGE_STYLE: React.CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  overflowX: 'hidden',
  paddingBottom: 90, // 하단 네비 가림 방지
};
