// src/lib/trading/gameMoney.ts
//
// **모의 금액을 진짜 돈처럼 보이지 않게 한다 — 표시만 바꾼다.**
//
// 무엇을 하는가
// ─────────────
// 내부 값이 10,000이면 화면에 `10,000 P`로 적는다. **1:1이다.** 환율도
// 배수도 없다.
//
// 왜 1:1인가
// ──────────
// 배수를 하나라도 넣는 순간 이 파일이 **두 번째 화폐 권위**가 된다.
// 그러면 `paper_accounts.balance`·`paper_challenge_cashflows`·실현손익·
// 수수료·펀딩이 전부 "어느 단위로 적힌 값인가"를 다시 물어야 하고,
// 챌린지의 `initial_equity`·`target_equity` 판정도 같이 흔들린다.
//
// PR5가 장부 셋을 겨우 하나로 합쳤다. 표시를 예쁘게 하려고 화폐를 하나 더
// 만들면 그 일이 무의미해진다. 그래서 **여기서 하는 일은 숫자를 글자로
// 바꾸는 것뿐이다.**
//
// 이 파일이 만들지 않는 것
// ────────────────────────
//  · 환율·배수·환산 함수 — **아예 없다.** 자리가 있으면 언젠가 붙는다
//  · 역변환(글자 → 숫자) — 주문 payload는 언제나 내부 숫자로 만든다
//  · LIVE 표시 — 실제 돈에 게임머니 단위를 붙이면 그게 제일 위험하다
//
// 이름은 나중에 바꾼다
// ────────────────────
// 표시명은 상수 하나다. `P`든 `Paper`든 `Credit`이든 여기 한 글자만 바꾸면
// 되고, 회계에는 영향이 0이다 — 그것이 이 경계를 둔 이유다.

/** 모의 금액의 표시명. **바꿔도 회계에 영향이 없다.** */
export const GAME_MONEY_UNIT = 'P';

/** 어느 장부의 숫자인가. **LIVE는 게임머니로 적지 않는다.** */
export type MoneyScope = 'PAPER' | 'CHALLENGE' | 'LIVE' | 'UNKNOWN';

/**
 * 이 장부를 게임머니로 표시하는가.
 *
 * **LIVE는 언제나 false다.** 모르는 값도 false다 — 확인하지 못한 것을
 * 모의로 읽으면 실제 돈에 `P`가 붙는다.
 */
export function usesGameMoney(scope: MoneyScope | string | null | undefined): boolean {
  return scope === 'PAPER' || scope === 'CHALLENGE';
}

/** `Number(null)`은 0이다. 못 읽은 것을 0으로 적지 않으려면 먼저 거른다. */
function num(v: any): number {
  return v == null || v === '' ? NaN : Number(v);
}

export interface MoneyFormatOptions {
  /** 소수 자릿수. 기본은 정수 — 게임머니는 잔돈까지 보여 줄 이유가 없다 */
  decimals?: number;
  /** 부호를 항상 붙인다 (손익 표시용) */
  signed?: boolean;
  /** 단위를 뒤에 붙일 것인가. 표 안처럼 좁은 자리는 끌 수 있다 */
  unit?: boolean;
}

/**
 * 모의 금액 → 화면 글자.
 *
 * **못 읽은 값은 `—`다.** 0으로 적으면 "다 잃었다"로 읽힌다.
 */
export function formatGameMoney(v: any, o?: MoneyFormatOptions): string {
  const n = num(v);
  if (!Number.isFinite(n)) return '—';
  const decimals = Number.isFinite(Number(o?.decimals)) ? Number(o!.decimals) : 0;
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
  const sign = n < 0 ? '-' : o?.signed ? '+' : '';
  const unit = o?.unit === false ? '' : ` ${GAME_MONEY_UNIT}`;
  return `${sign}${body}${unit}`;
}

/**
 * 장부에 맞는 표기.
 *
 * LIVE에는 **게임머니를 붙이지 않는다.** 대신 단위 없이 숫자만 돌려주고,
 * 실제 통화 기호는 실계좌 화면이 자기 규칙으로 붙인다 — 이 파일이 실제
 * 통화를 다루기 시작하면 경계가 무너진다.
 */
export function formatMoneyForScope(
  v: any, scope: MoneyScope | string | null | undefined, o?: MoneyFormatOptions,
): string {
  if (usesGameMoney(scope)) return formatGameMoney(v, o);
  const n = num(v);
  if (!Number.isFinite(n)) return '—';
  const decimals = Number.isFinite(Number(o?.decimals)) ? Number(o!.decimals) : 2;
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
  const sign = n < 0 ? '-' : o?.signed ? '+' : '';
  return `${sign}${body}`;
}

/**
 * 화면 맨 위에 세울 모드 배지.
 *
 * 실제 돈과 게임머니가 **한 잔고처럼 보이지 않게** 하는 것이 목적이다.
 * 색까지 여기서 정하는 이유: 화면마다 고르면 어디선가 LIVE가 파란색이 된다.
 */
export interface ModeBadge {
  label: string;
  /** 실제 돈인가 — 화면이 테두리·경고를 세게 두는 기준 */
  realMoney: boolean;
  tone: 'PAPER' | 'CHALLENGE' | 'LIVE' | 'UNKNOWN';
}

export function modeBadge(scope: MoneyScope | string | null | undefined): ModeBadge {
  if (scope === 'CHALLENGE') return { label: '챌린지', realMoney: false, tone: 'CHALLENGE' };
  if (scope === 'PAPER') return { label: '모의', realMoney: false, tone: 'PAPER' };
  if (scope === 'LIVE') return { label: '실전', realMoney: true, tone: 'LIVE' };
  // **모르는 것을 모의로 적지 않는다.** 모의라고 적으면 실제 돈을 연습으로
  // 여기고 주문한다 — 이쪽 방향의 실수가 훨씬 비싸다.
  return { label: '확인 필요', realMoney: true, tone: 'UNKNOWN' };
}
