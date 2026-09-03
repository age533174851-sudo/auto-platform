// ─────────────────────────────────────────────────────────────
// TRAIGO Design Tokens — 색이 붙은 스타일
//
// **숫자 스케일은 여기 있지 않다.** `src/lib/ui/tokens.ts`가 정본이고,
// 이 파일은 그것을 다시 내보내면서 색(T)이 필요한 스타일만 만든다.
//
// 왜 나눴나
// ─────────
// 이 파일은 `@/lib/constants`를 별칭으로 부른다. 테스트 하네스는 src만
// 복사해 상대경로로 컴파일하므로 이 파일을 읽지 못한다 — 즉 여기 있는
// 값에는 테스트를 붙일 수 없었다. 정본에 테스트가 없으면 값이 갈라져도
// 아무도 모른다. 실제로 글자 크기 스케일이 두 벌(F.* / 터미널 FS.*)로
// 갈라져 있었다.
//
// 기존 `@/components/ui/tokens` import 경로는 그대로 동작한다 —
// 아래에서 스케일을 다시 내보내기 때문이다.
// ─────────────────────────────────────────────────────────────

import { T } from '@/lib/constants';
import { SP, R, FS, FW, CONTROL, BORDER_W } from '@/lib/ui/tokens';

export { SP, R, FS, FW, CONTROL, BORDER_W };

/**
 * 타이포 위계 — 크기·굵기·색을 묶은 것.
 *
 * 크기와 굵기는 정본 스케일(FS·FW)에서 온다. 예전에는 숫자를 직접
 * 적어서, 스케일을 고쳐도 여기는 그대로였다.
 *
 * `numXL: 26`만 스케일 밖이다. 총자산 한 자리에만 쓰는 크기라 스케일에
 * 단계를 만들 만큼 반복되지 않는다 — 억지로 넣으면 다음 사람이 그 단계를
 * 다른 곳에 쓴다.
 */
export const F = {
  // 제목 (페이지 헤더)
  title:    { fontSize: FS.head,  fontWeight: FW.heavy,  letterSpacing: -0.3, color: T.txt   } as const,
  // 부제목 / 섹션 헤더
  section:  { fontSize: FS.sub,   fontWeight: FW.heavy,  color: T.txt   } as const,
  // 카드 라벨 / 부가 설명
  caption:  { fontSize: FS.small, fontWeight: FW.medium, color: T.sub   } as const,
  // 본문
  body:     { fontSize: FS.lead,  fontWeight: FW.normal, color: T.txt   } as const,
  muted:    { fontSize: FS.small, fontWeight: FW.normal, color: T.muted } as const,
  // 큰 숫자 (총자산 등)
  numXL:    { fontSize: 26,        fontWeight: FW.black, letterSpacing: -0.5, color: T.txt } as const,
  numL:     { fontSize: FS.hero,   fontWeight: FW.heavy, letterSpacing: -0.3, color: T.txt } as const,
  numM:     { fontSize: FS.title,  fontWeight: FW.heavy, color: T.txt } as const,
  numS:     { fontSize: FS.lead,   fontWeight: FW.bold,  color: T.txt } as const,
  // 버튼
  btn:      { fontSize: FS.lead,   fontWeight: FW.bold,  letterSpacing: -0.1 } as const,
  btnSm:    { fontSize: FS.small,  fontWeight: FW.bold } as const,
} as const;

// 카드 — Toss 느낌의 깔끔한 컨테이너
export function cardStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: T.card,
    border: `${BORDER_W}px solid ${T.border}`,
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
  const sizePad = size === 'sm' ? `${SP.sm}px ${SP.md}px` : size === 'lg' ? '14px 18px' : `${SP.md}px ${SP.lg}px`;
  // 높이도 정본에서. 예전에는 36/44를 직접 적어서, CONTROL을 고쳐도
  // 버튼은 그대로였다.
  const sizeMin = size === 'sm' ? CONTROL.sm : CONTROL.md;
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
