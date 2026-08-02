// src/lib/ui/displayScale.ts
//
// **화면 크기 조절.**
//
// 왜 필요한가
// ───────────
// 이 앱의 글씨는 9~13px이다(FS.micro가 10px). 정보를 많이 넣으려고 그렇게
// 잡았는데, 폰에서는 **읽기 힘든 크기**다. 나이가 있거나 시력이 약하면
// 아예 못 읽는다.
//
// 그리고 이건 취향 문제가 아니다 — 잘 안 보이는 화면에서 사람은 **숫자를
// 잘못 읽는다.** 63,093을 68,093으로 읽고 주문을 낸다. 거래 화면에서
// 글씨 크기는 안전 문제다.
//
// 왜 폰트 크기가 아니라 zoom인가
// ──────────────────────────────
// 이 앱은 크기를 전부 인라인 px로 적는다(fontSize: FS.micro). 그 값들을
// 배율에 반응하게 만들려면 수백 곳을 고쳐야 하고, 한 곳이라도 빠지면
// 그 자리만 작게 남아 더 읽기 어려워진다.
//
// zoom은 **레이아웃째로** 키운다. 글씨만 키우면 칸은 그대로라 글자가
// 잘리는데, zoom은 칸도 같이 커져서 그런 일이 없다. 브라우저 기본
// 확대와 같은 방식이다.
//
// 브라우저가 zoom을 모르면 아무 일도 안 일어난다 — 기능이 없는 것이지
// 화면이 깨지지는 않는다.

export const SCALE_KEY = 'tg_display_scale_v1';

/** 고를 수 있는 배율. 화면에 그대로 쓴다 */
export const SCALE_STEPS = [
  { value: 1,    label: '보통',   note: '기본' },
  { value: 1.15, label: '크게',   note: '15% 크게' },
  { value: 1.3,  label: '더 크게', note: '30% 크게' },
  { value: 1.5,  label: '아주 크게', note: '50% 크게' },
] as const;

export const MIN_SCALE = 1;
export const MAX_SCALE = 1.5;

/**
 * 저장된 값을 쓸 수 있는 배율로 바꾼다.
 *
 * **모르는 값은 1이다.** 이상한 값이 들어와 화면이 3배로 커지면
 * 아무것도 못 누르고, 그 상태에서 설정으로 돌아갈 방법도 없다.
 */
export function normalizeScale(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n < MIN_SCALE) return MIN_SCALE;
  if (n > MAX_SCALE) return MAX_SCALE;
  // 소수 둘째 자리까지. 1.1500000000000001 같은 값이 저장되지 않게.
  return Number(n.toFixed(2));
}

/** 다음 단계 배율. '+' 버튼용 */
export function nextScale(cur: number): number {
  const c = normalizeScale(cur);
  const up = SCALE_STEPS.map(s => s.value).find(v => v > c + 1e-6);
  return up == null ? c : normalizeScale(up);
}

/** 이전 단계 배율. '−' 버튼용 */
export function prevScale(cur: number): number {
  const c = normalizeScale(cur);
  const down = [...SCALE_STEPS].map(s => s.value).reverse().find(v => v < c - 1e-6);
  return down == null ? c : normalizeScale(down);
}

export function readScale(): number {
  if (typeof window === 'undefined') return 1;
  try {
    return normalizeScale(window.localStorage.getItem(SCALE_KEY));
  } catch {
    // 저장소를 못 읽는 환경(시크릿 모드 등). 기본값으로 돈다.
    return 1;
  }
}

/**
 * 배율을 적용한다.
 *
 * 1이면 속성을 **지운다.** `zoom: 1`을 남겨 두면 일부 브라우저가
 * 그것만으로 새 합성 레이어를 만들어 스크롤이 무거워진다.
 */
export function applyScale(scale: number, doc?: Document): void {
  const d = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!d?.documentElement) return;
  const s = normalizeScale(scale);
  const style = d.documentElement.style as any;
  if (s === 1) style.zoom = '';
  else style.zoom = String(s);
}

export function writeScale(scale: number): number {
  const s = normalizeScale(scale);
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(SCALE_KEY, String(s));
  } catch { /* 못 써도 이번 화면에는 적용된다 */ }
  applyScale(s);
  return s;
}
