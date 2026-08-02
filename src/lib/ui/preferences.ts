// src/lib/ui/preferences.ts
//
// **화면 기본값.** 매번 같은 값을 다시 고르지 않게 한다.
//
// 규칙 하나
// ─────────
// **여기 있는 항목은 전부 실제로 무언가를 바꿔야 한다.** 눌러도 아무 일도
// 안 하는 스위치를 설정 화면에 두면, 그 화면 전체를 못 믿게 된다 —
// 어느 것이 진짜인지 구분할 방법이 없기 때문이다.
//
// 그래서 거래소 설정 화면에 있는 것을 그대로 베끼지 않았다. 헤지 모드·
// 자산 모드·TWAP·Chase는 이 앱에 그 기능 자체가 없다. 없는 기능의
// 스위치는 만들지 않는다.
//
// 저장 위치
// ─────────
// localStorage다. 기기마다 다르고, 지우면 기본값으로 돌아간다.
// 계좌에 묶이는 값(배율 상한·손실 한도)은 여기 두지 않는다 — 그건 서버가
// 지켜야 하는 것이고, 기기에 저장하면 다른 기기에서 안 지켜진다.

export type TriggerPref = 'MARK' | 'LAST';
export type UnitPref = 'BASE' | 'QUOTE';
export type MarginPref = 'ISOLATED' | 'CROSSED';
export type PositionDensity = 'DETAILED' | 'BRIEF';

/** 포지션 카드에 놓을 수 있는 버튼 */
export const POSITION_BUTTONS = ['LEVERAGE', 'TPSL', 'CLOSE', 'REVERSE'] as const;
export type PositionButton = typeof POSITION_BUTTONS[number];

export const BUTTON_LABEL: Record<PositionButton, string> = {
  LEVERAGE: '배율',
  TPSL: 'TP/SL',
  CLOSE: '청산',
  REVERSE: '뒤집기',
};

/** 주문 유형별 확인창 */
export const CONFIRM_KINDS = ['MARKET', 'LIMIT', 'CLOSE', 'REVERSE'] as const;
export type ConfirmKind = typeof CONFIRM_KINDS[number];

export const CONFIRM_LABEL: Record<ConfirmKind, string> = {
  MARKET: '시장가 주문',
  LIMIT: '지정가 주문',
  CLOSE: '청산',
  REVERSE: '뒤집기',
};

export interface Preferences {
  /** TP/SL 트리거 기준 기본값 */
  trigger: TriggerPref;
  /** 주문 수량 단위 기본값 */
  unit: UnitPref;
  /** 배율 기본값 (1~125) */
  leverage: number;
  /** 마진 모드 기본값 — 모의에만 쓴다. 실계좌는 거래소 설정을 읽는다 */
  paperMargin: MarginPref;
  /** 포지션 카드 표시 밀도 */
  density: PositionDensity;
  /**
   * 포지션 카드 버튼. **순서가 곧 표시 순서다.**
   * 비어 있으면 카드에서 아무것도 못 한다 — 그래서 최소 하나는 남긴다.
   */
  positionButtons: PositionButton[];
  /**
   * 확인창을 띄울 주문 유형.
   *
   * **실전 주문은 이 설정과 무관하게 항상 묻는다.** 진짜 돈이 나가는
   * 것을 설정 하나로 끌 수 있으면 그건 설정이 아니라 안전장치 제거다.
   */
  confirmKinds: ConfirmKind[];
}

export const DEFAULTS: Preferences = {
  // Mark가 기본이다 — 얇은 호가의 한 틱 꼬리에 손절이 털리는 것을 줄인다.
  trigger: 'MARK',
  unit: 'BASE',
  leverage: 5,
  // 격리가 기본이다. 교차는 손실이 계좌 전체로 번진다 — 아무도 고르지
  // 않은 위험이 켜져 있으면 안 된다.
  paperMargin: 'ISOLATED',
  density: 'DETAILED',
  positionButtons: ['LEVERAGE', 'TPSL', 'CLOSE'],
  // 시장가와 청산은 되돌릴 수 없다. 기본으로 묻는다.
  confirmKinds: ['MARKET', 'CLOSE', 'REVERSE'],
};

const KEY = 'tg_prefs_v1';

const oneOf = <T extends string>(v: any, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v) ? v as T : fallback;

/**
 * 저장된 값을 읽되 **모양이 틀리면 기본값으로 되돌린다.**
 *
 * 예전 판이 남아 있거나 손으로 고친 값이 들어오면, 그대로 쓰다가 화면
 * 어딘가에서 조용히 터진다. 항목마다 검사하고, 통과 못 한 항목만
 * 기본값으로 바꾼다 — 하나 틀렸다고 전부 날리지 않는다.
 */
export function normalizePrefs(raw: any): Preferences {
  const r = raw && typeof raw === 'object' ? raw : {};

  const lev = Math.round(Number(r.leverage));
  const buttons = Array.isArray(r.positionButtons)
    ? r.positionButtons.filter((b: any) => (POSITION_BUTTONS as readonly string[]).includes(b))
    : null;
  const kinds = Array.isArray(r.confirmKinds)
    ? r.confirmKinds.filter((k: any) => (CONFIRM_KINDS as readonly string[]).includes(k))
    : null;

  return {
    trigger: oneOf(r.trigger, ['MARK', 'LAST'] as const, DEFAULTS.trigger),
    unit: oneOf(r.unit, ['BASE', 'QUOTE'] as const, DEFAULTS.unit),
    leverage: Number.isFinite(lev) && lev >= 1 && lev <= 125 ? lev : DEFAULTS.leverage,
    paperMargin: oneOf(r.paperMargin, ['ISOLATED', 'CROSSED'] as const, DEFAULTS.paperMargin),
    density: oneOf(r.density, ['DETAILED', 'BRIEF'] as const, DEFAULTS.density),
    // **버튼이 하나도 없으면 기본으로 되돌린다.** 다 끄면 포지션 카드에서
    // 청산조차 못 하는데, 그 상태가 저장되면 앱을 다시 켜도 그대로다.
    positionButtons: buttons && buttons.length > 0
      ? dedupe(buttons) : DEFAULTS.positionButtons,
    // 확인창은 전부 꺼도 된다. 다만 실전은 아래 shouldConfirm이 무시한다.
    confirmKinds: kinds ? dedupe(kinds) : DEFAULTS.confirmKinds,
  };
}

function dedupe<T>(a: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of a) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

export function loadPrefs(): Preferences {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return normalizePrefs(JSON.parse(raw));
  } catch { return { ...DEFAULTS }; }
}

export function savePrefs(p: Preferences): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(normalizePrefs(p))); } catch {}
}

/**
 * 이 주문에 확인창을 띄우는가.
 *
 * **실전이면 설정과 무관하게 항상 묻는다.** 진짜 돈이 나가는 것을 설정
 * 하나로 끌 수 있으면 그건 설정이 아니라 안전장치 제거다. 거래소도
 * 'Trade Confirmations'를 끌 수 있게 해 두지만, 이 앱에는 실전으로
 * 잘못 넘어가는 경로가 이미 여러 번 있었다.
 */
export function shouldConfirm(
  p: Preferences, kind: ConfirmKind, realMoney: boolean,
): boolean {
  if (realMoney) return true;
  return p.confirmKinds.includes(kind);
}

/** 버튼 순서를 한 칸 옮긴다. 범위 밖이면 그대로 둔다 */
export function moveButton(
  list: PositionButton[], from: number, to: number,
): PositionButton[] {
  if (!Array.isArray(list)) return [];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return [...list];
  }
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/**
 * 버튼을 켜고 끈다.
 *
 * **마지막 하나는 끄지 못한다.** 다 끄면 포지션 카드에서 청산조차 할 수
 * 없는데, 화면에는 그냥 버튼이 없는 카드로 보인다.
 */
export function toggleButton(
  list: PositionButton[], b: PositionButton,
): { list: PositionButton[]; reason: string } {
  const cur = Array.isArray(list) ? list : [];
  if (cur.includes(b)) {
    if (cur.length <= 1) {
      return { list: cur, reason: '버튼을 모두 끌 수는 없습니다 — 하나는 남겨야 포지션을 조작할 수 있습니다' };
    }
    return { list: cur.filter(x => x !== b), reason: '' };
  }
  // 거래소도 넷까지만 켠다. 그보다 많으면 좁은 화면에서 글자가 잘린다.
  if (cur.length >= 4) {
    return { list: cur, reason: '버튼은 최대 4개까지 켤 수 있습니다' };
  }
  return { list: [...cur, b], reason: '' };
}
