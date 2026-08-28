// src/lib/portfolio/paperAccount.ts
//
// **모의투자 계좌가 지금 얼마인가.**
//
// 조사에서 나온 것
// ────────────────
// 표는 이미 있다 — `paper_accounts`(010) · `paper_positions`(010) ·
// `account_equity_snapshots`(048, `env='MOCK'` 지원). 새로 만들 것이 없다.
//
// 없던 것은 셋이다:
//   · 시작하기 흐름 (초기자금을 고르는 자리)
//   · 오늘 손익 (일 경계 기준점)
//   · 지갑 MOCK 탭과의 배선 — **화면은 있는데 이 API를 읽지 않았다**
//
// 통화는 USDT다
// ─────────────
// `paper_positions`의 체결가·수수료가 전부 USDT이고, 모의로 돌릴 전략도
// 전부 USDT 선물이다. 장부 통화가 갈리면 손익이 두 벌이 된다.
//
// 원화는 **표시 계층에서만** 환산한다. 그리고 이 저장소에는 이미 그
// 사고 기록이 있다(`walletMoney.ts`): 공용 `cvt()`가 입력을 KRW로
// 가정해서 1,000배 확대됐다. **환율이 없으면 원화로 바꾸지 않는다.**

export interface PaperPositionLike {
  symbol?: string | null;
  side?: string | null;
  quantity?: number | string | null;
  fill_price?: number | string | null;
  entry_price?: number | string | null;
  margin?: number | string | null;
  /** 부르는 쪽이 현재가로 계산해 넣는다. **못 구했으면 null** */
  unrealizedPnl?: number | null;
}

export interface PaperAccountRow {
  /** 사용자가 명시적으로 시작한 시각(071). **없으면 시작을 증명하지 못한다** */
  started_at?: string | null;
  balance?: number | string | null;
  initial_balance?: number | string | null;
  total_pnl?: number | string | null;
  total_fees?: number | string | null;
  trade_count?: number | string | null;
  win_count?: number | string | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export type PaperState =
  /** 아직 시작하지 않았다 — 줄이 없거나, 줄은 있어도 시작한 적이 없다 */
  | 'NOT_STARTED'
  /** 돌고 있다 */
  | 'ACTIVE'
  /** 계좌는 읽었는데 값이 이상하다 */
  | 'UNREADABLE';

export interface PaperEquity {
  state: PaperState;
  /** 세 상태를 가르는 정밀 코드. `state`보다 이쪽이 판정의 원본이다 */
  code: PaperAccountCode;
  /** 현금 (실현된 잔고) */
  cash: number | null;
  /** 포지션에 묶인 증거금 */
  usedMargin: number | null;
  /** 미실현손익. **한 포지션이라도 못 구했으면 null이다** */
  unrealizedPnl: number | null;
  /** 총자산 = 현금 + 미실현손익. 미실현을 모르면 null */
  totalEquity: number | null;
  /** 확인된 부분만의 합계 — 총자산이 null일 때 보여 줄 값 */
  knownCash: number | null;
  initialBalance: number | null;
  realizedPnl: number | null;
  totalFees: number | null;
  tradeCount: number | null;
  winCount: number | null;
  /** 시작 대비 수익률(%). 종잣돈이 없으면 null */
  returnPct: number | null;
  note: string;
}

export type PaperAccountCode =
  /** 조회가 실패했다. **'계좌 없음'이 아니다** */
  | 'UNREADABLE'
  /** 조회에 성공했고, 계좌 줄이 없다 */
  | 'NO_ACCOUNT'
  /** 줄은 있는데 사용자가 시작한 적이 없다 — 읽기 경로가 만든 빈 껍데기 */
  | 'GHOST'
  /** 계좌가 있다. **잔고 0도 READY다** — 0은 진짜 0이다 */
  | 'READY';

/**
 * **계좌 없음 · 확인 못 함 · 잔고 0을 절대 섞지 않는다.**
 *
 * 화면에서 실제로 섞였다. 모의 계좌가 없는데 지갑이 `0.00000000 USDT`를
 * 총자산으로 적고, 바로 아래 줄에 "계좌가 없습니다"를 같이 적었다.
 * 두 문장은 동시에 참일 수 없다.
 *
 *   UNREADABLE  조회 실패        → "모의 계좌를 확인하지 못했습니다"
 *   NO_ACCOUNT  줄 없음          → "모의투자 계좌가 없습니다"
 *   GHOST       줄은 있으나 미시작 → 위와 같게 다루되 진단에는 남긴다
 *   READY       줄 있음          → 잔고가 0이면 **"0 USDT"라고 적는다**
 *
 * `hasStartedAtColumn`이 false면 **GHOST를 판정할 수 없다.** 그때는
 * 있는 줄을 부정하지 않고 READY로 둔다 — 마이그레이션이 아직 안 돌았다는
 * 이유로 사용자의 계좌를 "없다"고 말하면 안 된다.
 */
export function paperAccountStateOf(i: {
  ok: boolean;
  row: PaperAccountRow | null | undefined;
  /** 이 DB에 `started_at` 칸이 있는가(071). 모르면 true로 두지 않는다 */
  hasStartedAtColumn?: boolean;
}): { code: PaperAccountCode; startedCode: StartedCode | null; reason: string } {
  if (!i || i.ok === false) {
    return { code: 'UNREADABLE', startedCode: null,
      reason: '모의 계좌 조회가 실패했습니다 — 계좌가 없다는 뜻이 아닙니다' };
  }
  if (!i.row) {
    return { code: 'NO_ACCOUNT', startedCode: null,
      reason: '모의 계좌 줄이 없습니다 — 아직 시작하지 않았습니다' };
  }
  // **줄은 있는데 잔고를 못 읽었다.**
  //
  // 이때 GHOST로 내려보내면 화면이 "시작하지 않았습니다 + 시작하기"를
  // 그리고, 누르는 순간 읽지 못했을 뿐 살아 있던 장부가 초기화된다.
  // 확인하지 못한 것은 통과가 아니다 — 미시작 판정보다 먼저다.
  if (num(i.row.balance) == null) {
    return { code: 'UNREADABLE', startedCode: null,
      reason: '계좌 줄은 있으나 잔고를 읽지 못했습니다 — 0으로도 "없음"으로도 적지 않습니다' };
  }
  if (i.hasStartedAtColumn === false) {
    // **071이 아직 안 돌았다.** 시작 여부를 증명할 칸이 없다 —
    // 그렇다고 있는 계좌를 없다고 적지 않는다.
    return { code: 'READY', startedCode: null,
      reason: 'started_at 칸이 아직 없어 시작 여부를 가리지 못했습니다 — 있는 계좌를 그대로 씁니다' };
  }
  const st = paperStartedOf(i.row);
  if (!st.started) {
    return { code: 'GHOST', startedCode: st.code,
      reason: '읽기 경로가 자동으로 만든 빈 계좌입니다 — 사용자가 고른 종잣돈이 아닙니다' };
  }
  return { code: 'READY', startedCode: st.code, reason: '' };
}

export type StartedCode =
  /** 사용자가 시작 버튼을 눌렀다 — `started_at`이 있다 */
  | 'DECLARED'
  /** 시작 기록은 없지만 **쓴 흔적**이 있다 (매매·수수료·손익·잔고 변화) */
  | 'USED'
  /** 흔적이 없다 — 읽기 경로가 자동으로 만든 빈 껍데기일 수 있다 */
  | 'NONE';

/**
 * 이 계좌는 **사용자가 시작한 것인가.**
 *
 * `getPaperAccount()`는 줄이 없으면 읽기만 해도 10,000 USDT짜리 계좌를
 * 만든다. 그리고 그 함수를 **워커의 자산 기록기**가 15분마다 전 사용자에
 * 대해 불렀다. 그래서 모의투자를 시작한 적 없는 사람에게도 계좌 줄이
 * 있고, 지갑 MOCK 탭을 배선하면 **고른 적 없는 종잣돈이 총자산으로 뜬다.**
 *
 * 읽기 경로의 생성은 코드에서 걷어냈다(`paperRead.ts`). 이 판정은 그
 * 이전에 이미 만들어진 줄을 가른다.
 *
 * **흔적이 없으면 시작으로 치지 않는다.** 반대로 틀리면 사용자가 고르지
 * 않은 숫자를 총자산이라고 적게 된다.
 */
export function paperStartedOf(row: PaperAccountRow | null | undefined): {
  started: boolean; code: StartedCode;
} {
  if (!row) return { started: false, code: 'NONE' };
  const at = row.started_at;
  if (at != null && String(at).trim() !== '' && Number.isFinite(Date.parse(String(at)))) {
    return { started: true, code: 'DECLARED' };
  }
  const trades = num(row.trade_count) ?? 0;
  const fees = num(row.total_fees) ?? 0;
  const pnl = num(row.total_pnl) ?? 0;
  const bal = num(row.balance);
  const init = num(row.initial_balance);
  const moved = bal != null && init != null && bal !== init;
  if (trades !== 0 || fees !== 0 || pnl !== 0 || moved) return { started: true, code: 'USED' };
  return { started: false, code: 'NONE' };
}

/**
 * 계좌 + 포지션 → 지금 얼마인가.
 *
 * **미실현을 못 구한 포지션이 하나라도 있으면 총자산은 null이다.**
 * 부분합계를 총자산이라고 적으면 사용자는 그 숫자를 믿는다 —
 * 지갑에서 이미 같은 실수를 했고, 그때 고친 규칙을 여기서도 지킨다.
 */
export function paperEquityOf(i: {
  account: PaperAccountRow | null | undefined;
  positions: PaperPositionLike[] | null | undefined;
  /** 조회 자체가 성공했는가. **기본은 true** — 옛 호출부와 같게 동작한다 */
  ok?: boolean;
  /** 이 DB에 `started_at` 칸이 있는가(071) */
  hasStartedAtColumn?: boolean;
}): PaperEquity {
  const a = i?.account;
  const st = paperAccountStateOf({
    ok: i?.ok !== false, row: a, hasStartedAtColumn: i?.hasStartedAtColumn,
  });

  const empty = {
    cash: null, usedMargin: null, unrealizedPnl: null, totalEquity: null,
    knownCash: null, initialBalance: null, realizedPnl: null, totalFees: null,
    tradeCount: null, winCount: null, returnPct: null,
  };
  // **계좌 없음과 확인 못 함은 다른 문장이다.**
  if (st.code === 'UNREADABLE') {
    // 줄은 있는데 잔고만 못 읽은 경우는 아는 것을 남긴다.
    if (a) {
      return {
        state: 'UNREADABLE', code: st.code,
        cash: null, usedMargin: null, unrealizedPnl: null, totalEquity: null,
        knownCash: null, initialBalance: num(a.initial_balance),
        realizedPnl: num(a.total_pnl), totalFees: num(a.total_fees),
        tradeCount: num(a.trade_count), winCount: num(a.win_count), returnPct: null,
        note: '모의 계좌의 잔고를 읽지 못했습니다 — 0으로 적지 않습니다',
      };
    }
    return { state: 'UNREADABLE', code: st.code, ...empty,
      note: '모의 계좌를 확인하지 못했습니다 — 계좌가 없다는 뜻이 아닙니다' };
  }
  if (st.code === 'NO_ACCOUNT' || st.code === 'GHOST') {
    return { state: 'NOT_STARTED', code: st.code, ...empty,
      note: '아직 모의투자를 시작하지 않았습니다' };
  }

  // 여기까지 왔으면 READY다 — 줄이 있고 잔고를 읽었다.
  // (잔고를 못 읽은 줄은 위에서 UNREADABLE로 끝났다.
  //  '시작 안 함'으로 적으면 시작하기가 뜨고, 누르는 순간 읽지 못했을
  //  뿐 살아 있던 장부가 초기화된다 — 그래서 순서가 중요하다.)
  const cash = num(a!.balance) as number;
  const initial = num(a!.initial_balance);

  const list = Array.isArray(i?.positions) ? i.positions : [];
  let usedMargin = 0;
  let unreal = 0;
  let unknownCount = 0;
  for (const p of list) {
    const m = num(p?.margin);
    if (m != null) usedMargin += m;
    const u = p?.unrealizedPnl;
    if (u == null || !Number.isFinite(Number(u))) unknownCount += 1;
    else unreal += Number(u);
  }

  // **못 구한 것이 있으면 총자산을 적지 않는다.**
  const unrealizedPnl = unknownCount > 0 ? null : unreal;
  const totalEquity = unrealizedPnl == null ? null : cash + unrealizedPnl;

  return {
    state: 'ACTIVE', code: 'READY',
    cash, usedMargin,
    unrealizedPnl, totalEquity, knownCash: cash,
    initialBalance: initial,
    realizedPnl: num(a!.total_pnl),
    totalFees: num(a!.total_fees),
    tradeCount: num(a!.trade_count),
    winCount: num(a!.win_count),
    returnPct: initial != null && initial > 0 && totalEquity != null
      ? ((totalEquity - initial) / initial) * 100 : null,
    note: unknownCount > 0
      ? `포지션 ${unknownCount}건의 현재가를 못 읽어 총자산을 계산하지 않았습니다`
      : '',
  };
}

/**
 * 오늘 손익.
 *
 * **기준점이 없으면 계산하지 않는다.** 시작 잔고로 대신 재면 그건
 * '오늘'이 아니라 '누적'이고, 화면은 그걸 오늘 것으로 읽는다.
 */
export function paperTodayPnl(i: {
  /** 지금 총자산. 못 구했으면 null */
  totalEquity: number | null;
  /** 오늘 첫 스냅샷의 총자산. 없으면 null */
  dayStartEquity: number | null;
}): { pnl: number | null; pct: number | null; note: string } {
  const now = i?.totalEquity;
  const start = i?.dayStartEquity;
  if (now == null) return { pnl: null, pct: null, note: '총자산을 몰라 오늘 손익을 계산하지 않았습니다' };
  if (start == null) {
    return { pnl: null, pct: null,
      note: '오늘의 기준점이 없습니다 — 첫 기록이 남은 뒤부터 오늘 손익을 셉니다' };
  }
  const pnl = now - start;
  return { pnl, pct: start > 0 ? (pnl / start) * 100 : null, note: '' };
}

/** 시작 금액 선택지. **USDT 장부다** — 원화는 표시 계층에서 환산한다 */
export const PAPER_SEED_CHOICES = [10_000, 50_000, 100_000] as const;

export type SeedCode = 'OK' | 'TOO_SMALL' | 'TOO_LARGE' | 'INVALID';

/**
 * 시작 금액이 쓸 수 있는 값인가.
 *
 * 상한을 두는 이유는 화면 때문이 아니다 — 종잣돈이 비현실적으로 크면
 * 수익률이 전부 0에 붙어 **전략을 비교할 수 없다.**
 */
export function validateSeed(v: any): { code: SeedCode; value: number | null; reason: string } {
  const n = num(v);
  if (n == null || n <= 0) {
    return { code: 'INVALID', value: null, reason: '시작 금액을 숫자로 입력하세요' };
  }
  if (n < 100) {
    return { code: 'TOO_SMALL', value: null,
      reason: '최소 100 USDT부터 시작할 수 있습니다 — 그보다 작으면 최소 주문 수량에 걸려 아무 것도 체결되지 않습니다' };
  }
  if (n > 10_000_000) {
    return { code: 'TOO_LARGE', value: null,
      reason: '최대 10,000,000 USDT까지 넣을 수 있습니다' };
  }
  return { code: 'OK', value: n, reason: '' };
}

// ── 지갑 화면에 붙일 모양 ────────────────────────────
//
// **지갑 MOCK 탭은 만들어 놓고 배선이 없었다.** 지갑은
// `/api/wallets/overview` 하나를 읽는데, 거기 `envs`는
// `['LIVE','TESTNET']`로 고정이었다 — MOCK은 만들어진 적이 없다.
//
// 그래서 화면에는 탭이 있고 눌러도 아무 숫자가 없었다. 이 저장소의
// 단골 고장("만들어 놓고 배선을 안 함")이 그대로 남아 있던 자리다.
//
// 모양은 `EnvWallet`을 그대로 따른다. 화면이 MOCK만 다르게 그리게
// 하면 규칙이 두 벌이 되고, 그때 한쪽만 고쳐진다.

/** `amountOf`가 만드는 모양. 값을 못 구했으면 `null` + 그 이유 */
type AmountLike = { value: number | null; readiness: string };

export interface PaperEnvWallet {
  env: 'MOCK';
  connections: number;
  read: number;
  futures: AmountLike;
  futuresEquity: AmountLike;
  spot: AmountLike;
  total: AmountLike;
  availableMargin: AmountLike;
  positionMargin: AmountLike;
  unrealizedPnl: AmountLike;
  unpricedAssets: string[];
  note: string;
}

/**
 * 모의 계좌 → 지갑 환경 한 칸.
 *
 * **모의는 현물이 없다.** 현물 칸은 0이 아니라 `NOT_APPLICABLE`이다 —
 * 0으로 적으면 "현물을 다 팔았다"로 읽힌다.
 *
 * 시작하지 않았으면 `connections: 0`이다. 지갑은 이미 그 경우를
 * "이 환경에 연결된 계좌가 없습니다"로 그린다.
 */
export function paperEnvWalletOf(
  eq: PaperEquity,
  amount: (raw: any, readiness?: any) => AmountLike,
): PaperEnvWallet {
  const started = eq.state === 'ACTIVE';
  const na = amount(null, 'NOT_APPLICABLE');
  if (!started) {
    return {
      env: 'MOCK', connections: 0, read: 0,
      futures: na, futuresEquity: na, spot: na, total: na,
      availableMargin: na, positionMargin: na, unrealizedPnl: na,
      unpricedAssets: [],
      note: eq.state === 'NOT_STARTED'
        ? '아직 모의투자를 시작하지 않았습니다'
        : (eq.note || '모의 계좌를 읽지 못했습니다'),
    };
  }

  const ok = (v: number | null) => amount(v, v == null ? 'FAILED' : 'OK');
  return {
    env: 'MOCK',
    connections: 1, read: 1,
    // 모의 장부에서 '지갑잔고'에 해당하는 것은 현금이다.
    futures: ok(eq.cash),
    futuresEquity: ok(eq.totalEquity),
    // **현물은 0이 아니라 해당 없음이다.**
    spot: na,
    total: ok(eq.totalEquity),
    availableMargin: ok(eq.cash == null || eq.usedMargin == null
      ? null : Math.max(0, eq.cash - eq.usedMargin)),
    positionMargin: ok(eq.usedMargin),
    unrealizedPnl: ok(eq.unrealizedPnl),
    // 총자산이 null인 이유를 화면이 말할 수 있게 한다.
    unpricedAssets: eq.totalEquity == null && eq.note ? ['현재가 미확인'] : [],
    note: eq.note,
  };
}
