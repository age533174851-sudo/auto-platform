// src/components/terminal/theme.ts
//
// 터미널 전용 디자인 토큰.
//
// 기존 앱 테마(T)를 그대로 쓰지 않는 이유
// ────────────────────────────────────────
// 기존 팔레트는 파란 네이비(#060B14 / #0A1628)에 8~10px 글씨였다.
// 두 가지가 겹쳐서 촌스러워진다:
//   1. 배경이 파랗다 → 초록/빨강 손익 색이 배경과 싸운다. 거래 화면에서
//      색은 손익을 뜻해야지 장식이면 안 된다. 배경은 중립이어야 한다.
//   2. 8px 글씨 → 정보를 많이 넣은 것처럼 보이지만 실제로는 안 읽힌다.
//      밀도는 글자를 줄여서가 아니라 여백과 구분선을 줄여서 얻는다.
//
// 그래서 배경을 거의 무채색 먹색으로 낮추고, 경계선을 실선 대신
// 아주 옅은 흰색 알파로 바꾸고, 최소 글자 크기를 10px로 올렸다.
// 색은 손익·경고·강조 세 가지에만 쓴다.

export const C = {
  // ── 표면 ── 아래로 갈수록 위로 떠 있다
  bg:      '#0A0B0D',   // 가장 아래 (화면 배경)
  panel:   '#101216',   // 패널
  raised:  '#16191E',   // 패널 위 요소 (입력창·칩)
  hover:   '#1C2026',   // 마우스 올림
  active:  '#232830',   // 눌림·선택

  // ── 경계 ── 실선 대신 알파. 선이 보이면 화면이 조각나 보인다
  hair:    'rgba(255,255,255,.07)',
  hair2:   'rgba(255,255,255,.12)',
  hair3:   'rgba(255,255,255,.20)',

  // ── 글자 ──
  text:    '#ECEFF3',
  dim:     '#8A919C',
  faint:   '#5A616B',

  // ── 의미색 ── 여기 셋 말고는 색을 쓰지 않는다
  up:      '#0ECB81',
  upBg:    'rgba(14,203,129,.12)',
  down:    '#F6465D',
  downBg:  'rgba(246,70,93,.12)',
  warn:    '#F0B90B',
  warnBg:  'rgba(240,185,11,.12)',

  // ── 강조 ── 상호작용 가능함을 뜻한다
  accent:  '#5B8DEF',
  accentBg:'rgba(91,141,239,.14)',
} as const;

/** 숫자는 항상 이 조합. 자릿수가 흔들리면 값이 바뀐 것처럼 보인다 */
export const NUM: React.CSSProperties = {
  fontFamily: '"SF Mono", "JetBrains Mono", "Roboto Mono", ui-monospace, monospace',
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum" 1',
  letterSpacing: '-0.01em',
};

/**
 * 글자 크기 단계.
 * 10px 아래로 내려가지 않는다 — 그 아래는 정보가 아니라 장식이다.
 */
export const FS = {
  micro: 10,   // 라벨·단위
  small: 11,   // 표 본문
  body:  12,   // 기본
  lead:  13,   // 버튼·강조
  num:   15,   // 가격
  hero:  20,   // 대표 가격
} as const;

/** 패널 제목줄 */
export const paneHead: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  height: 34, padding: '0 12px', flexShrink: 0,
  borderBottom: `1px solid ${C.hair}`,
  fontSize: FS.micro, fontWeight: 600, color: C.dim,
  letterSpacing: '0.04em', textTransform: 'uppercase',
};

/** 탭 — 밑줄 대신 배경 칩. 밑줄은 표 구분선과 헷갈린다 */
export function tabStyle(on: boolean): React.CSSProperties {
  return {
    background: on ? C.active : 'transparent',
    color: on ? C.text : C.dim,
    border: 'none', borderRadius: 6,
    padding: '5px 11px', fontSize: FS.small,
    fontWeight: on ? 700 : 500,
    cursor: 'pointer', whiteSpace: 'nowrap',
    transition: 'background .12s, color .12s',
  };
}

/** 작은 칩 (상태 배지) */
export function chip(color: string, bg?: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '3px 8px', borderRadius: 5,
    fontSize: FS.micro, fontWeight: 600, color,
    background: bg ?? 'transparent',
    border: `1px solid ${bg ? 'transparent' : C.hair2}`,
    whiteSpace: 'nowrap',
  };
}

/** 입력창 */
export const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: C.raised, color: C.text,
  border: `1px solid ${C.hair}`, borderRadius: 8,
  padding: '10px 12px', fontSize: FS.body,
  outline: 'none', ...NUM,
};

/**
 * 주문·Kill Switch처럼 되돌릴 수 없는 버튼.
 * 최소 44px — 손가락으로 눌러야 하고, 급할 때 눌러야 한다.
 */
export function primaryBtn(bg: string, disabled?: boolean): React.CSSProperties {
  return {
    width: '100%', minHeight: 46,
    background: bg, color: '#fff',
    border: 'none', borderRadius: 10,
    fontSize: FS.lead, fontWeight: 700,
    letterSpacing: '-0.01em',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'filter .12s, opacity .12s',
  };
}

/** 보조 버튼 */
export function ghostBtn(on?: boolean): React.CSSProperties {
  return {
    background: on ? C.active : C.raised,
    color: on ? C.text : C.dim,
    border: `1px solid ${on ? C.hair2 : C.hair}`,
    borderRadius: 7, padding: '6px 10px',
    fontSize: FS.small, fontWeight: 600, cursor: 'pointer',
    transition: 'background .12s, color .12s, border-color .12s',
  };
}

/** 값이 오르내릴 때의 색 */
export function pnlColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return C.dim;
  return v > 0 ? C.up : v < 0 ? C.down : C.dim;
}

/** 숫자 포맷 — 자릿수를 고정해 값이 흔들려 보이지 않게 */
export function fmtPrice(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
