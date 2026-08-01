// src/lib/portfolio/subAccount.ts
//
// 가상 서브계좌 — **한도를 실제로 막는다.**
//
// 왜 필요한가
// ───────────
// 지금 배분표(portfolio/allocation)는 "성장 600만 · 안정 250만 · 실험 100만"을
// 그려준다. 그런데 **주문이 그 숫자를 보지 않는다.** 화면에도 그렇게 적혀
// 있다: "이 표는 계산만 합니다 — 실제 주문 크기에 아직 물려 있지 않습니다."
//
// 계산만 하고 안 막는 안전장치는 없는 것보다 나쁘다. 있다고 믿으면 사람이
// 직접 안 세기 때문이다. 이 파일은 그 표를 **한도로 만든다.**
//
// 거래소에 진짜 계좌를 여러 개 만들지 않는 이유
// ─────────────────────────────────────────────
// 거래소 계좌를 쪼개면 이체가 필요하고, 이체는 시간이 걸리고 실패한다.
// 실험 계정이 기회를 봤는데 자금이 성장 계정에 묶여 있으면 그 사이에 기회가
// 사라진다. 앱 안에서 **장부로만** 나누면 자금은 한 곳에 있고 한도만 갈린다.
//
// 대신 장부가 거래소보다 느슨해서는 안 된다 — 그래서 이 판정은 주문 경로의
// 체크리스트에 들어간다(SUBACCOUNT_LIMIT).
//
// 무엇을 '사용 중'으로 보는가
// ───────────────────────────
// **증거금**이다. 명목가가 아니다. 5배로 100만 원어치를 열면 명목가는 100만
// 원이지만 실제로 묶인 돈은 20만 원이다. 명목가로 세면 배율을 올릴수록
// 한도가 빨리 차서, 정작 위험한 고배율 거래가 먼저 막히고 안전한 저배율
// 거래는 통과하는 이상한 결과가 된다.
//
// 위험(risk)이 아니라 증거금으로 세는 이유도 같다: 이 한도는 "얼마를 잃을
// 수 있나"가 아니라 **"얼마를 이 바구니에 넣었나"**를 정한다. 잃을 수 있는
// 금액은 손실 한도(dailyLoss·weeklyLoss)가 따로 본다.

/** 바구니 하나 */
export interface SubAccount {
  id: string;
  name: string;
  /** 이 바구니에 배정한 금액(USDT). null이면 **한도 없음이 아니라 미설정**이다 */
  allocatedUsd: number | null;
  /**
   * 이 바구니가 맡는 시장. 비어 있으면 모든 시장.
   * 'SPOT' | 'USDM' | 'COINM'
   */
  markets?: string[];
  /**
   * 이 바구니가 맡는 종목 접두사(예: ['BTC','ETH']). 비어 있으면 모든 종목.
   * 대문자로 비교한다.
   */
  symbolPrefixes?: string[];
}

/** 지금 열려 있는 포지션 하나 (증거금 기준) */
export interface OpenUse {
  symbol: string;
  /** 'SPOT' | 'USDM' | 'COINM' */
  market: string;
  /** 이 포지션에 묶인 증거금(USDT). **모르면 null** — 0으로 치지 않는다 */
  marginUsd: number | null;
}

export type SubAccountStatus =
  /** 한도 안이다 */
  | 'ok'
  /** 한도를 넘는다 — 막는다 */
  | 'over'
  /** 이 주문에 맞는 바구니가 없다 */
  | 'unassigned'
  /** 한도나 사용액을 확인하지 못했다 */
  | 'unknown';

export interface SubAccountVerdict {
  status: SubAccountStatus;
  reason: string;
  /** 어느 바구니로 판정했는가 */
  accountId: string | null;
  accountName: string | null;
  allocatedUsd: number | null;
  /** 지금 쓰고 있는 증거금 합계. 모르면 null */
  usedUsd: number | null;
  /** 이 주문이 더 쓰는 증거금 */
  addUsd: number | null;
  /** 남는 금액. 모르면 null */
  remainingUsd: number | null;
}

function num(v: any): number | null {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 입력 다듬기 ─────────────────────────────────────────────
//
// 저장 전에 여기를 반드시 통과시킨다. 화면과 서버가 각자 검사하면 언젠가
// 서로 다른 것을 허용하고, 그때 통과한 값은 **한도를 무르게 만드는 쪽으로만**
// 어긋난다 (범위를 넓히거나 한도를 지우는 쪽).

/** 서브계좌가 맡을 수 있는 시장 — 주문 라우트가 실제로 넘기는 값과 같아야 한다 */
export const SUB_ACCOUNT_MARKETS = ['SPOT', 'USDM', 'COINM'] as const;

export interface SubAccountInput {
  name?: any;
  allocatedUsd?: any;
  markets?: any;
  symbolPrefixes?: any;
  note?: any;
  sortOrder?: any;
}

export interface NormalizedSubAccount {
  name: string;
  /** null이면 **미설정**이다. 0(한도 0)과 다르다 */
  allocatedUsd: number | null;
  markets: string[];
  symbolPrefixes: string[];
  note: string | null;
  sortOrder: number;
}

/**
 * 저장할 값으로 다듬는다. 못 다듬으면 `error`가 채워지고 `value`는 없다.
 *
 * `strict: false`라 `{ok:true}|{ok:false}` 판별 유니온이 좁혀지지 않는다 —
 * 그래서 한 모양에 선택 필드로 둔다.
 *
 * **모르는 값을 버리지 않고 거절하는 이유**
 * ─────────────────────────────────────────
 * markets에 오타('USDT')가 들어왔을 때 조용히 빼 버리면 목록이 비고, 빈
 * 목록은 이 파일에서 **'모든 시장'**이라는 뜻이다. 즉 오타 하나가 바구니의
 * 범위를 좁히는 게 아니라 **전 시장으로 넓힌다.** 틀린 입력이 한도를 무르게
 * 만드는 쪽으로 작동하면 안 된다.
 */
export function normalizeSubAccountInput(
  raw: SubAccountInput,
): { error?: string; value?: NormalizedSubAccount } {
  const r = raw || {};

  const name = String(r.name ?? '').trim();
  if (!name) return { error: '이름을 입력하세요' };
  if (name.length > 40) return { error: '이름은 40자까지입니다' };

  // 배정 금액: 빈 값은 '미설정'으로 남긴다. 0으로 바꾸지 않는다 —
  // 0은 "이 바구니는 안 쓴다"는 뜻이라 완전히 다른 설정이 된다.
  let allocatedUsd: number | null = null;
  const rawAlloc = r.allocatedUsd;
  if (rawAlloc != null && !(typeof rawAlloc === 'string' && rawAlloc.trim() === '')) {
    const n = Number(rawAlloc);
    if (!Number.isFinite(n)) return { error: '배정 금액이 숫자가 아닙니다' };
    if (n < 0) return { error: '배정 금액은 0 이상이어야 합니다' };
    allocatedUsd = Math.round(n * 100) / 100;
  }

  const list = (v: any): string[] => (Array.isArray(v) ? v : [])
    .map(x => String(x ?? '').trim().toUpperCase())
    .filter(Boolean);

  const markets: string[] = [];
  for (const m of list(r.markets)) {
    if (!(SUB_ACCOUNT_MARKETS as readonly string[]).includes(m)) {
      return { error: `모르는 시장입니다: ${m} (${SUB_ACCOUNT_MARKETS.join(' · ')})` };
    }
    if (!markets.includes(m)) markets.push(m);
  }

  const symbolPrefixes: string[] = [];
  for (const p of list(r.symbolPrefixes)) {
    if (!/^[A-Z0-9]{1,20}$/.test(p)) {
      return { error: `종목 접두사는 영문·숫자 1~20자입니다: ${p}` };
    }
    if (!symbolPrefixes.includes(p)) symbolPrefixes.push(p);
  }

  const note = String(r.note ?? '').trim();
  if (note.length > 200) return { error: '메모는 200자까지입니다' };

  const so = Number(r.sortOrder);
  // 순서는 우선순위다(pickAccount의 동점 처리). 못 읽은 값을 0으로 두면
  // 맨 앞으로 올라와 우선순위가 조용히 바뀐다 — 그래서 거절한다.
  if (r.sortOrder != null && String(r.sortOrder).trim() !== '' && !Number.isFinite(so)) {
    return { error: '순서가 숫자가 아닙니다' };
  }
  const sortOrder = Number.isFinite(so) ? Math.trunc(so) : 0;

  return {
    value: { name, allocatedUsd, markets, symbolPrefixes, note: note || null, sortOrder },
  };
}

/** 이 주문이 어느 바구니에 속하는가. 못 고르면 null */
export function pickAccount(
  accounts: SubAccount[], market: string, symbol: string,
): SubAccount | null {
  const list = Array.isArray(accounts) ? accounts : [];
  const mk = String(market || '').toUpperCase();
  const sym = String(symbol || '').toUpperCase();

  // **구체적인 규칙이 먼저다.** 종목까지 지정한 바구니가 시장만 지정한
  // 바구니보다 우선한다. 안 그러면 "모든 시장" 바구니 하나가 전부를
  // 삼켜서 나머지 규칙이 죽은 설정이 된다.
  const score = (a: SubAccount): number => {
    const hasMk = Array.isArray(a.markets) && a.markets.length > 0;
    const hasSym = Array.isArray(a.symbolPrefixes) && a.symbolPrefixes.length > 0;
    if (hasMk && !a.markets!.some(m => String(m).toUpperCase() === mk)) return -1;
    if (hasSym && !a.symbolPrefixes!.some(p => sym.startsWith(String(p).toUpperCase()))) return -1;
    return (hasSym ? 2 : 0) + (hasMk ? 1 : 0);
  };

  let best: SubAccount | null = null;
  let bestScore = -1;
  for (const a of list) {
    const s = score(a);
    // 동점이면 **먼저 정의한 것**을 쓴다. 순서가 뜻을 갖게 두면 사용자가
    // 목록 순서로 우선순위를 표현할 수 있다.
    if (s > bestScore) { best = a; bestScore = s; }
  }
  return bestScore >= 0 ? best : null;
}

/** 이 바구니가 지금 쓰고 있는 증거금 합계. 하나라도 모르면 null */
export function usedByAccount(
  account: SubAccount, open: OpenUse[],
): { usedUsd: number | null; unknownCount: number } {
  const list = Array.isArray(open) ? open : [];
  let sum = 0;
  let unknown = 0;
  for (const o of list) {
    // 이 바구니가 맡는 포지션인가 — 주문을 고를 때와 **같은 규칙**을 쓴다.
    if (pickAccount([account], o.market, o.symbol)?.id !== account.id) continue;
    const m = num(o.marginUsd);
    if (m == null) { unknown++; continue; }
    sum += m;
  }
  // 하나라도 못 읽었으면 합계를 내지 않는다. 모르는 것을 0으로 더하면
  // **한도가 실제보다 넉넉해 보인다** — 이 파일이 막으려는 바로 그 실패다.
  return { usedUsd: unknown > 0 ? null : Math.round(sum * 100) / 100, unknownCount: unknown };
}

/**
 * 이 주문이 바구니 한도 안인가.
 *
 * 순수 함수 — 네트워크를 타지 않는다.
 */
export function judgeSubAccount(input: {
  accounts: SubAccount[] | null | undefined;
  market: string;
  symbol: string;
  /** 이 주문이 새로 묶는 증거금(USDT) */
  addMarginUsd: number | null | undefined;
  /** 지금 열려 있는 것들 */
  open: OpenUse[] | null | undefined;
}): SubAccountVerdict {
  const empty = {
    accountId: null, accountName: null, allocatedUsd: null,
    usedUsd: null, addUsd: num(input.addMarginUsd), remainingUsd: null,
  };

  const accounts = Array.isArray(input.accounts) ? input.accounts : [];
  // 바구니를 안 만들었으면 이 검사는 의미가 없다. 켜지 않은 검사를
  // '확인 못 함'으로 남기면 확인할 것이 있다고 읽힌다.
  if (accounts.length === 0) {
    return { ...empty, status: 'ok', reason: '가상 서브계좌를 쓰지 않습니다' };
  }

  const acc = pickAccount(accounts, input.market, input.symbol);
  if (!acc) {
    // **어느 바구니에도 안 맞는 주문은 막는다.** 통과시키면 한도 밖에서
    // 도는 자금이 생기고, 그러면 바구니를 나눈 의미가 없다.
    return {
      ...empty, status: 'unassigned',
      reason: `${input.symbol}(${input.market})을 맡는 서브계좌가 없습니다 — 규칙을 추가하거나 '모든 시장' 계정을 하나 두세요`,
    };
  }

  const base = {
    accountId: acc.id, accountName: acc.name,
    allocatedUsd: num(acc.allocatedUsd),
    addUsd: num(input.addMarginUsd),
  };

  if (base.allocatedUsd == null) {
    return {
      ...base, status: 'unknown', usedUsd: null, remainingUsd: null,
      reason: `${acc.name}에 배정 금액이 설정되지 않았습니다`,
    };
  }

  const { usedUsd, unknownCount } = usedByAccount(acc, input.open ?? []);
  if (usedUsd == null) {
    return {
      ...base, status: 'unknown', usedUsd: null, remainingUsd: null,
      reason: `${acc.name}에서 증거금을 못 읽은 포지션이 ${unknownCount}건 있습니다 — 얼마를 쓰고 있는지 알 수 없습니다`,
    };
  }

  const add = base.addUsd;
  if (add == null) {
    return {
      ...base, status: 'unknown', usedUsd, remainingUsd: null,
      reason: `이 주문이 쓸 증거금을 계산하지 못했습니다`,
    };
  }

  // 경계에서 새지 않게 센트 단위로 맞춘다. 6,000,000 × 어떤 비율이
  // 6000000.0000001이 되어 "한도에 딱 맞는" 주문이 통과하면 안 된다.
  const after = Math.round((usedUsd + add) * 100) / 100;
  const cap = Math.round(base.allocatedUsd * 100) / 100;
  const remaining = Math.round((cap - usedUsd) * 100) / 100;

  if (after > cap) {
    return {
      ...base, status: 'over', usedUsd, remainingUsd: remaining,
      reason: `${acc.name} 한도 초과 — 배정 ${cap} · 사용 중 ${usedUsd} · 이 주문 ${add} (남은 자리 ${remaining})`,
    };
  }

  return {
    ...base, status: 'ok', usedUsd, remainingUsd: Math.round((cap - after) * 100) / 100,
    reason: `${acc.name} · 배정 ${cap} 중 ${after} 사용 (남음 ${Math.round((cap - after) * 100) / 100})`,
  };
}
