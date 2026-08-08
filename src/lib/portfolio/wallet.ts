// src/lib/portfolio/wallet.ts
//
// **LIVE라고 적힌 화면에 MOCK 총자산이 섞여 있었다.**
//
// 지갑을 만들 때 가장 먼저 정해야 하는 것이 이것이다. 실제 돈과 테스트넷
// 가상자금과 모의 잔고는 **더할 수 없는 것**인데, 그냥 더하면 화면에는
// 그럴듯한 총자산이 뜬다. 그리고 그 숫자는 아무 뜻이 없다.
//
//   실제      569 USDT
//   테스트넷  50,000 USDT   ← 가짜 돈
//   모의      10,000,000원  ← 더 가짜 돈
//   ─────────────────────
//   "총자산"  ???
//
// 그래서 이 파일의 첫 규칙은 **환경을 절대 합치지 않는다**이다.
// 합치려는 시도 자체가 오류다.
//
// 두 번째 규칙: 자산이 늘었다고 번 것이 아니다
// ────────────────────────────────────────────
// 입금하면 총자산이 는다. 그걸 수익으로 세면 "오늘 +100만원"이 뜨는데
// 실제로는 100만원을 넣었을 뿐이다. 매매로 번 것과 넣은 것은 다른 사실이고,
// 섞이면 자기 실력을 영영 모른다.
//
// 세 번째 규칙: 못 읽은 것을 0으로 적지 않는다
// ────────────────────────────────────────────
// 거래소 조회가 실패했을 때 잔고를 0으로 그리면, 사용자는 자기 돈이
// 사라졌다고 본다. 0은 '없다'이고, 실패는 '모른다'다.

// ── 환경 ──────────────────────────────────────────────────

export type WalletEnv = 'LIVE' | 'TESTNET' | 'MOCK';

export const ENV_LABEL: Record<WalletEnv, string> = {
  LIVE: '실전', TESTNET: '테스트넷', MOCK: '모의',
};

export const ENV_NOTE: Record<WalletEnv, string> = {
  LIVE: '실제 자금입니다',
  TESTNET: '거래소 테스트넷의 가상 자금입니다 — 실제 가치가 없습니다',
  MOCK: '앱 안에서만 존재하는 모의 자금입니다 — 거래소와 무관합니다',
};

/**
 * **모르는 값을 실전으로 읽지 않는다.**
 *
 * 실전으로 읽으면 가짜 돈이 실제 자산으로 합산되고, 그게 이 화면에서
 * 가장 비싼 실수다. 이 저장소의 다른 곳과 같은 규칙 — 기본은 테스트넷이다.
 */
export function envOf(v: any): WalletEnv {
  const s = String(v ?? '').trim().toUpperCase();
  if (s.startsWith('LIVE') || s === 'REAL') return 'LIVE';
  if (s === 'MOCK' || s === 'PAPER' || s.startsWith('PAPER')) return 'MOCK';
  return 'TESTNET';
}

// ── 탭 ────────────────────────────────────────────────────

export type WalletTabId = 'overview' | 'futures' | 'spot' | 'strategy' | 'longterm';

export const WALLET_TABS: Array<{ id: WalletTabId; label: string; desc: string }> = [
  { id: 'overview', label: '개요',     desc: '총자산 · 오늘 손익 · 자산 배분' },
  { id: 'futures',  label: '선물',     desc: '지갑 잔고 · 증거금 · 미실현손익' },
  { id: 'spot',     label: '현물',     desc: '코인별 보유 수량과 평가액' },
  { id: 'strategy', label: '전략계좌', desc: '전략별 배정 자금과 성과' },
  { id: 'longterm', label: '장기투자', desc: '주식·ETF 보유' },
];

export function tabOf(v: any): WalletTabId {
  const s = String(v ?? '').trim();
  return WALLET_TABS.some(t => t.id === s) ? (s as WalletTabId) : 'overview';
}

// ── 못 읽은 값 ────────────────────────────────────────────

export type Readiness =
  /** 값을 읽었다 */
  | 'OK'
  /** 읽는 중 */
  | 'LOADING'
  /** 조회가 실패했다 — **0이 아니다** */
  | 'FAILED'
  /** 연결이 끊겼다 */
  | 'DISCONNECTED'
  /** 이 계좌에는 해당 없음 */
  | 'NOT_APPLICABLE';

export interface Amount {
  value: number | null;
  readiness: Readiness;
  /** 화면에 그대로 쓸 문자열 */
  text: string;
}

export const READINESS_TEXT: Record<Readiness, string> = {
  OK: '', LOADING: '조회 중…', FAILED: '확인 불가',
  DISCONNECTED: '연결 끊김', NOT_APPLICABLE: '해당 없음',
};

/**
 * 금액 하나를 화면용으로.
 *
 * **못 읽었으면 0이 아니라 '확인 불가'다.** 0을 그리면 사용자는 자기 돈이
 * 사라졌다고 본다. 0은 '없다'이고 실패는 '모른다'이며, 둘은 전혀 다르다.
 */
export function amountOf(raw: any, readiness: Readiness = 'OK'): Amount {
  if (readiness !== 'OK') {
    return { value: null, readiness, text: READINESS_TEXT[readiness] };
  }
  if (raw == null || raw === '' || typeof raw === 'boolean') {
    return { value: null, readiness: 'FAILED', text: READINESS_TEXT.FAILED };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { value: null, readiness: 'FAILED', text: READINESS_TEXT.FAILED };
  }
  return { value: n, readiness: 'OK', text: n.toLocaleString('ko-KR', { maximumFractionDigits: 8 }) };
}

// ── 총자산 ────────────────────────────────────────────────

export interface Bucket {
  id: string;
  label: string;
  env: WalletEnv;
  /**
   * 어느 탭에 속하는가.
   *
   * **id 문자열을 잘라서 알아내지 않는다.** `id.endsWith('-futures')`
   * 같은 것은 id 짓는 방식이 바뀌는 순간 조용히 틀린다 — 아무 칸도
   * 안 걸리는데 화면은 "선물 없음"이라고 그럴듯하게 그린다.
   */
  kind?: WalletTabId;
  /** 이 칸의 평가액 */
  amount: Amount;
}

/**
 * 이 탭에서 보여 줄 칸만 고른다.
 *
 * 개요는 전부 보여 준다. 나머지는 자기 것만.
 *
 * **어느 탭인지 모르는 칸(`kind` 없음)은 개요에만 넣는다.** 아무 탭에나
 * 끼워 넣으면 선물 탭에 현물이 섞이고, 빼 버리면 총자산에는 잡히는데
 * 어느 탭에도 안 보이는 돈이 생긴다 — 뒤쪽이 더 나쁘다.
 */
export function bucketsForTab(tab: WalletTabId, buckets: Bucket[] | null | undefined): Bucket[] {
  const list = Array.isArray(buckets) ? buckets : [];
  if (tab === 'overview') return list;
  return list.filter(b => b?.kind === tab);
}

export interface TotalEquity {
  env: WalletEnv;
  /** 합계. **하나라도 못 읽었으면 null이다** */
  total: number | null;
  /** 합계를 낼 수 있었는가 */
  complete: boolean;
  /** 못 읽은 칸 이름들 */
  missing: string[];
  /** 이 환경에 속한 칸들 */
  buckets: Bucket[];
  /** 사람이 읽는 한 줄 */
  note: string;
}

/**
 * 한 환경의 총자산.
 *
 * **다른 환경을 섞지 않는다.** 인자로 환경을 받아 그것에 속한 칸만 더한다 —
 * 넘어온 목록에 다른 환경이 있으면 조용히 빼고, 그 사실을 note에 적는다.
 *
 * 그리고 **하나라도 못 읽었으면 합계를 내지 않는다.** 세 칸 중 둘만 더해
 * '총자산'이라고 적으면, 못 읽은 칸이 0인 것처럼 보인다.
 */
export function totalEquityOf(
  env: WalletEnv, buckets: Bucket[] | null | undefined,
): TotalEquity {
  const all = Array.isArray(buckets) ? buckets : [];
  const mine = all.filter(b => b?.env === env);
  const others = all.length - mine.length;

  const missing = mine
    .filter(b => b?.amount?.readiness !== 'OK' && b?.amount?.readiness !== 'NOT_APPLICABLE')
    .map(b => String(b?.label ?? b?.id ?? '이름 없는 칸'));

  const usable = mine.filter(b => b?.amount?.readiness === 'OK' && b.amount.value != null);
  const complete = missing.length === 0 && mine.length > 0;
  const total = complete ? usable.reduce((s, b) => s + (b.amount.value as number), 0) : null;

  const bits: string[] = [];
  if (mine.length === 0) bits.push(`${ENV_LABEL[env]} 계좌가 없습니다`);
  if (missing.length > 0) {
    bits.push(`${missing.join(' · ')}를 확인하지 못해 총자산을 내지 않습니다`);
  }
  // **섞였다는 사실을 조용히 넘기지 않는다.**
  if (others > 0) bits.push(`다른 환경의 계좌 ${others}개는 합산에서 제외했습니다`);

  return {
    env, total, complete, missing, buckets: mine,
    note: bits.join(' · '),
  };
}

/**
 * 환경을 합치려는 시도를 막는다.
 *
 * 실제 돈과 가상 자금은 더할 수 없다. 이 함수는 **언제나 null을 준다** —
 * 호출하는 쪽이 "왜 안 되지"를 코드에서 바로 보게 하려고 남겨 둔다.
 */
export function totalAcrossEnvs(): { total: null; reason: string } {
  return {
    total: null,
    reason: '실전·테스트넷·모의 자산은 더할 수 없습니다. '
      + '테스트넷과 모의는 실제 가치가 없어, 합치면 그 숫자가 아무 뜻도 갖지 못합니다',
  };
}

// ── 자산이 는 것과 번 것은 다르다 ─────────────────────────

export interface FlowParts {
  /** 매매로 낸 실현손익 */
  realizedPnl?: any;
  /** 아직 안 닫은 포지션의 평가손익 */
  unrealizedPnl?: any;
  deposit?: any;
  withdrawal?: any;
  /** 계좌 간 이동 — 총자산을 바꾸지 않는다 */
  transfer?: any;
  fees?: any;
  funding?: any;
  dividend?: any;
  interest?: any;
}

export interface EquityChange {
  /** 자산이 얼마나 변했는가 */
  equityDelta: number | null;
  /** 그중 **매매로 번 것** */
  tradingPnl: number | null;
  /** 그중 **넣고 뺀 것** */
  netExternalFlow: number | null;
  /** 비용 */
  costs: number | null;
  /** 배당·이자 */
  income: number | null;
  /** 합이 맞는가 */
  reconciled: boolean;
  /** 설명되지 않은 몫 */
  unexplained: number | null;
  missing: string[];
  /** 사람이 읽는 한 줄 */
  note: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 이 금액 미만의 차이는 반올림으로 본다 */
export const RECONCILE_EPS = 0.01;

/**
 * 자산 변화를 쪼갠다.
 *
 * **입금은 수익이 아니다.** 100만원을 넣으면 총자산이 100만원 늘지만
 * 번 것은 0원이다. 이걸 안 나누면 화면에 "오늘 +100만원"이 뜨고,
 * 사용자는 자기 매매 실력을 영영 모른다.
 *
 * 이체(transfer)는 계좌 사이 이동이라 **총자산을 바꾸지 않는다.**
 * 여기에 넣으면 같은 돈을 두 번 세게 된다.
 */
export function equityChangeOf(
  equityDelta: any, parts: FlowParts | null | undefined,
): EquityChange {
  const p = parts ?? {};
  const delta = num(equityDelta);

  const realized = num(p.realizedPnl);
  const unrealized = num(p.unrealizedPnl);
  const deposit = num(p.deposit);
  const withdrawal = num(p.withdrawal);
  const fees = num(p.fees);
  const funding = num(p.funding);
  const dividend = num(p.dividend) ?? 0;
  const interest = num(p.interest) ?? 0;

  const missing: string[] = [];
  if (realized == null) missing.push('실현손익');
  if (unrealized == null) missing.push('미실현손익');
  if (deposit == null) missing.push('입금');
  if (withdrawal == null) missing.push('출금');
  if (fees == null) missing.push('수수료');
  if (funding == null) missing.push('펀딩비');

  if (missing.length > 0 || delta == null) {
    return {
      equityDelta: delta, tradingPnl: null, netExternalFlow: null,
      costs: null, income: null, reconciled: false, unexplained: null,
      missing: delta == null ? ['자산 변화', ...missing] : missing,
      note: `${(delta == null ? ['자산 변화', ...missing] : missing).join(' · ')}를 확인하지 못해 `
        + '자산 변화를 쪼개지 않습니다 — 모르는 값을 0으로 더하면 수익이 실제보다 좋게 나옵니다',
    };
  }

  const tradingPnl = realized! + unrealized!;
  const netExternalFlow = deposit! - withdrawal!;
  const costs = fees! + funding!;
  const income = dividend + interest;

  // 자산 변화 = 매매손익 − 비용 + 배당·이자 + 순입출금
  const explained = tradingPnl - costs + income + netExternalFlow;
  const unexplained = delta - explained;
  const reconciled = Math.abs(unexplained) < RECONCILE_EPS;

  return {
    equityDelta: delta, tradingPnl, netExternalFlow, costs, income,
    reconciled, unexplained, missing: [],
    note: reconciled ? ''
      : `쪼갠 항목의 합이 자산 변화와 ${Math.abs(unexplained).toFixed(2)} 다릅니다`
        + ' — 안 세고 있는 항목이 있습니다',
  };
}

/**
 * "오늘 +100만원"이라고 적어도 되는가.
 *
 * **입출금이 있었으면 자산 변화를 손익으로 부르지 않는다.**
 */
export function todayPnlLabel(c: EquityChange | null | undefined): {
  headline: string; caution: string;
} {
  const v = c ?? ({} as EquityChange);
  if (v.tradingPnl == null) {
    return { headline: '확인 불가', caution: v.note || '오늘 손익을 계산하지 못했습니다' };
  }
  const flow = v.netExternalFlow ?? 0;
  const sign = v.tradingPnl >= 0 ? '+' : '';
  const headline = `${sign}${v.tradingPnl.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`;

  if (Math.abs(flow) < RECONCILE_EPS) return { headline, caution: '' };
  return {
    headline,
    caution: `오늘 입출금 ${flow >= 0 ? '+' : ''}${flow.toLocaleString('ko-KR')}이 있었습니다`
      + ' — 자산 증가분과 매매 손익은 다릅니다',
  };
}
