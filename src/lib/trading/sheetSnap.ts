// src/lib/trading/sheetSnap.ts
//
// **주문 시트가 차트를 가리지 않게 하는 두 자리.**
//
// 무엇이 고장이었나
// ─────────────────
// 시트를 열면 차트가 **100% 가려졌다**(360×800 실측: 시트 상단 96px,
// 높이 704px). 차트를 보면서 진입하라고 만든 화면인데, 주문하려는 순간
// 차트가 사라진다.
//
// 왜 두 자리뿐인가
// ────────────────
// 자유롭게 끌어 올리는 시트는 **보이지 않는 기능**이다 — 끌 수 있다는 걸
// 모르는 사람에게는 없는 기능이고, 그 사람에게 시트는 영원히 처음 높이다.
// 두 자리는 버튼 하나로 오갈 수 있고 배울 것이 없다.
//
// 무엇을 어디에 두는가
// ────────────────────
// HALF에는 **결정에 필요한 것**만 둔다: 호가 · 방향 · 수량 · 주문.
// EXPANDED에 **설정**을 둔다: 마진모드 · 배율 · 손절 · 익절 · 예상값.
//
// 주문 버튼은 두 자리 모두에 있다. 어느 높이에서도 주문을 끝낼 수 있어야
// 한다 — 그러지 않으면 "주문하려면 먼저 펴야 하는" 단계가 하나 생긴다.

export type SheetSnap = 'HALF' | 'EXPANDED';

export const SHEET_SNAPS: SheetSnap[] = ['HALF', 'EXPANDED'];

/** 처음 열 때의 자리. **차트가 보이는 쪽이다.** */
export const DEFAULT_SNAP: SheetSnap = 'HALF';

/**
 * 시트 높이(뷰포트 대비 %).
 *
 * HALF는 100 미만이어야 한다 — 그래야 위에 차트가 남는다. 이 값이 100이
 * 되는 순간 이 파일이 존재하는 이유가 없어진다.
 */
export function sheetHeightVh(snap: SheetSnap): number {
  return snap === 'EXPANDED' ? 88 : 52;
}

/**
 * 이 자리에서 호가를 몇 줄 보여줄 것인가 (한쪽 기준).
 *
 * HALF에서 5줄씩 쓰면 호가만 245px이라 방향·수량 버튼이 스크롤 밖으로
 * 밀린다 — 실측에서 그랬다. 자리가 좁으면 **줄 수를 줄이지, 칸을 빼지
 * 않는다.** 시장을 덜 보여 주는 것과 주문 조작을 감추는 것 중에서는
 * 앞쪽이 낫다(호가는 위아래로 이어지지만 버튼은 없으면 못 누른다).
 */
export function bookRowsFor(snap: SheetSnap): number {
  return snap === 'EXPANDED' ? 5 : 3;
}

/** 버튼 하나로 오간다. */
export function toggleSnap(snap: SheetSnap): SheetSnap {
  return snap === 'HALF' ? 'EXPANDED' : 'HALF';
}

export type SheetSection =
  /** 실시간 호가 */
  | 'BOOK'
  /** 롱/숏 */
  | 'SIDE'
  /** 격리·교차 */
  | 'MARGIN_MODE'
  | 'LEVERAGE'
  /** 증거금 배정 슬라이더 */
  | 'SIZING'
  /** 손절 거리 프리셋 */
  | 'STOP_PRESETS'
  /** 익절·손절가 직접 입력 */
  | 'TP_SL'
  /** 예상 증거금·수수료·청산가 */
  | 'ESTIMATE'
  /** 최종 주문 버튼 */
  | 'SUBMIT';

export const SHEET_SECTIONS: SheetSection[] = [
  'BOOK', 'SIDE', 'MARGIN_MODE', 'LEVERAGE', 'SIZING',
  'STOP_PRESETS', 'TP_SL', 'ESTIMATE', 'SUBMIT',
];

/** HALF에서도 보이는 것 — 주문을 끝내는 데 필요한 최소한. */
const IN_HALF: SheetSection[] = ['BOOK', 'SIDE', 'SIZING', 'SUBMIT'];

/**
 * 이 자리에서 이 칸을 그리는가.
 *
 * **모르는 칸은 그리지 않는다.** 목록에 없는 이름이 들어오면 false다 —
 * 새 칸을 만들면서 여기 등록을 잊으면 HALF에 조용히 끼어드는 것보다
 * 안 보이는 편이 낫다(안 보이면 곧 알아챈다).
 */
export function sectionVisible(section: SheetSection | string, snap: SheetSnap): boolean {
  if ((SHEET_SECTIONS as string[]).indexOf(String(section)) < 0) return false;
  if (snap === 'EXPANDED') return true;
  return IN_HALF.indexOf(section as SheetSection) >= 0;
}

/**
 * HALF에서 감춘 칸이 무엇인지 화면이 말할 수 있게.
 *
 * 감춘 것을 말하지 않으면 사용자는 그 기능이 **없다**고 읽는다.
 */
export function hiddenInHalf(): SheetSection[] {
  return SHEET_SECTIONS.filter(s => IN_HALF.indexOf(s) < 0);
}
