// src/lib/risk/dailyLoss.ts
//
// 하루에 잃을 수 있는 최대치. **넘으면 신규 진입을 잠근다.**
//
// 왜 다시 만드는가 (risk/guard.ts가 이미 있는데)
// ──────────────────────────────────────────────
// 그쪽은 오늘의 손익을 **localStorage에** 들고 있다. 그래서:
//
//  · 브라우저 저장소를 지우면 한도가 0으로 리셋된다
//  · 다른 기기·다른 브라우저로 열면 오늘 얼마를 잃었는지 모른다
//  · **웹훅·크론·서버 라우트에는 아예 적용되지 않는다** — 지금 실제로
//    주문이 나가는 경로가 전부 그쪽이다
//
// 즉 화면에는 '일일 손실 제한 켜짐'이라고 떠 있지만 주문은 그 제한과
// 무관하게 나가고 있었다. 이 파일은 그 판정을 **거래소가 알려준 실현손익**
// 위에서 다시 세운다.
//
// 모르는 것은 통과가 아니다
// ─────────────────────────
// 오늘의 손익을 못 읽으면 한도를 넘었는지 알 수 없다. 그때는 `unknown`이고,
// 이 프로젝트의 다른 검사와 같이 **막는 쪽**이다. "조회가 실패했으니 일단
// 보내자"는 것은 한도를 안 건 것과 같다.

/** 거래소 income 한 줄 (Binance /fapi/v1/income 모양) */
export interface IncomeItem {
  incomeType?: string | null;
  income?: string | number | null;
  time?: number | null;
  symbol?: string | null;
}

export interface TodayIncome {
  /** 실현손익 합 */
  realizedPnl: number;
  /** 수수료 합 (보통 음수) */
  commission: number;
  /** 펀딩비 합 */
  funding: number;
  /** 그 외 (보험청산·리베이트 등) */
  other: number;
  /** 위를 모두 더한 값. '오늘 얼마 벌었나/잃었나'는 이것이다 */
  net: number;
  /** 센 항목 수 */
  count: number;
}

const EMPTY: TodayIncome = {
  realizedPnl: 0, commission: 0, funding: 0, other: 0, net: 0, count: 0,
};

/**
 * income 목록을 오늘치만 골라 더한다.
 *
 * **수수료와 펀딩을 뺀 실현손익만 보면 안 된다.** 100배로 자주 들어가면
 * 수수료가 손익보다 커지는 구간이 있고, 무기한은 8시간마다 펀딩을 낸다.
 * '오늘 얼마 잃었나'를 물었는데 수수료를 빼놓고 답하면 그건 다른 질문의
 * 답이다.
 */
export function sumTodayIncome(
  items: IncomeItem[] | null | undefined,
  dayStartMs: number,
): TodayIncome {
  if (!Array.isArray(items)) return { ...EMPTY };

  const out: TodayIncome = { ...EMPTY };
  for (const it of items) {
    const t = Number(it?.time);
    // 시각을 모르는 줄은 세지 않는다. 어제 것을 오늘로 넣으면 한도가
    // 엉뚱하게 걸리고, 그 반대면 한도가 헐거워진다.
    if (!Number.isFinite(t) || t < dayStartMs) continue;

    const v = Number(it?.income);
    if (!Number.isFinite(v)) continue;

    const type = String(it?.incomeType || '').toUpperCase();
    if (type === 'REALIZED_PNL') out.realizedPnl += v;
    else if (type === 'COMMISSION') out.commission += v;
    else if (type === 'FUNDING_FEE') out.funding += v;
    else out.other += v;

    out.net += v;
    out.count += 1;
  }
  return out;
}

export interface DailyLossConfig {
  /** 절대 금액 한도(USDT). null이면 안 씀 */
  maxLossUsd: number | null;
  /** 시작 자산 대비 비율 한도(%). null이면 안 씀 */
  maxLossPct: number | null;
  /**
   * 목표 수익에 닿아도 잠글 것인가(%).
   *
   * 왜 이익에서 멈추나: 이 프로젝트가 상대하는 실패는 '잃어서 망하는 것'만이
   * 아니다. 목표를 넘긴 뒤에도 계속 눌러서 되돌려주는 날이 더 흔하다.
   * null이면 안 쓴다.
   */
  profitTargetPct: number | null;
}

export const DEFAULT_DAILY_LOSS: DailyLossConfig = {
  maxLossUsd: null,
  maxLossPct: 5,
  profitTargetPct: null,
};

export interface DailyLossInput {
  /** 오늘의 순손익. **모르면 null** — 0으로 주지 말 것 */
  todayNetUsd: number | null;
  /** 오늘 시작 시점의 자산(USDT). 비율 한도를 쓰려면 필요하다 */
  dayStartEquityUsd: number | null;
  cfg: DailyLossConfig;
}

export type DailyLossStatus = 'ok' | 'locked' | 'unknown';

export interface DailyLossVerdict {
  status: DailyLossStatus;
  /** 신규 진입을 막아야 하는가. unknown도 막는다 */
  blockEntries: boolean;
  reason: string;
  /** 한도까지 남은 금액(USDT). 모르면 null */
  remainingUsd: number | null;
  /** 적용된 한도(USDT). 모르면 null */
  limitUsd: number | null;
  /** 이익 목표로 잠긴 것인가 (손실이 아니라) */
  byProfitTarget: boolean;
}

const verdict = (v: Partial<DailyLossVerdict> & { status: DailyLossStatus; reason: string }): DailyLossVerdict => ({
  blockEntries: v.status !== 'ok',
  remainingUsd: null, limitUsd: null, byProfitTarget: false,
  ...v,
});

/**
 * 오늘 더 들어가도 되는가.
 *
 * 청산(나가는 주문)에는 쓰지 않는다. 한도에 걸렸다고 나갈 수 없게 만들면
 * 그건 손실을 키우는 잠금이다 — 잠금의 목적과 정반대가 된다.
 */
export function judgeDailyLoss(i: DailyLossInput): DailyLossVerdict {
  const { cfg } = i;

  const usesUsd = cfg.maxLossUsd != null && Number.isFinite(cfg.maxLossUsd) && cfg.maxLossUsd > 0;
  const usesPct = cfg.maxLossPct != null && Number.isFinite(cfg.maxLossPct) && cfg.maxLossPct > 0;
  const usesTarget = cfg.profitTargetPct != null && Number.isFinite(cfg.profitTargetPct) && cfg.profitTargetPct > 0;

  if (!usesUsd && !usesPct && !usesTarget) {
    // 한도를 안 걸어 뒀다. 그건 '통과'가 맞다 — 검사가 없는 것이지
    // 확인에 실패한 것이 아니다. 다만 그 사실을 적는다.
    return verdict({ status: 'ok', reason: '일일 한도가 설정되어 있지 않습니다' });
  }

  const net = i.todayNetUsd;
  if (net == null || !Number.isFinite(Number(net))) {
    return verdict({
      status: 'unknown',
      reason: '오늘의 실현손익을 확인하지 못해 일일 한도를 판단할 수 없습니다',
    });
  }

  const equity = i.dayStartEquityUsd;
  const equityKnown = equity != null && Number.isFinite(Number(equity)) && Number(equity) > 0;

  // 비율 한도만 걸어 뒀는데 시작 자산을 모르면 판단이 불가능하다.
  if ((usesPct || usesTarget) && !usesUsd && !equityKnown) {
    return verdict({
      status: 'unknown',
      reason: '오늘 시작 자산을 확인하지 못해 비율 한도를 판단할 수 없습니다',
    });
  }

  // 적용할 손실 한도(USDT). 둘 다 있으면 **더 작은 쪽**이 이긴다 —
  // 한도를 두 개 걸어 둔 사람은 둘 다 지키고 싶은 것이다.
  const candidates: number[] = [];
  if (usesUsd) candidates.push(Number(cfg.maxLossUsd));
  if (usesPct && equityKnown) candidates.push(Number(equity) * (Number(cfg.maxLossPct) / 100));
  const limitUsd = candidates.length ? Math.min(...candidates) : null;

  // ── 이익 목표 ──
  if (usesTarget && equityKnown) {
    const target = Number(equity) * (Number(cfg.profitTargetPct) / 100);
    if (Number(net) >= target) {
      return verdict({
        status: 'locked', byProfitTarget: true, limitUsd,
        remainingUsd: 0,
        reason: `오늘 목표 수익에 도달했습니다 (+${Number(net).toFixed(2)} / 목표 +${target.toFixed(2)} USDT). `
              + '신규 진입을 멈춥니다 — 되돌려주는 날은 대개 목표를 넘긴 뒤에 나옵니다.',
      });
    }
  }

  if (limitUsd == null) {
    return verdict({ status: 'ok', reason: '손실 한도가 설정되어 있지 않습니다' });
  }

  // 손실은 음수로 온다. 한도는 양수로 적어 두므로 부호를 맞춰 비교한다.
  const lossUsd = Number(net) < 0 ? -Number(net) : 0;
  const remaining = limitUsd - lossUsd;

  if (lossUsd >= limitUsd) {
    return verdict({
      status: 'locked', limitUsd, remainingUsd: 0,
      reason: `오늘 손실이 한도에 닿았습니다 (−${lossUsd.toFixed(2)} / 한도 ${limitUsd.toFixed(2)} USDT). `
            + '내일까지 신규 진입을 잠급니다. 청산은 계속 할 수 있습니다.',
    });
  }

  return verdict({
    status: 'ok', limitUsd, remainingUsd: remaining,
    reason: lossUsd > 0
      ? `오늘 −${lossUsd.toFixed(2)} / 한도 ${limitUsd.toFixed(2)} USDT (남은 여유 ${remaining.toFixed(2)})`
      : `오늘 +${Number(net).toFixed(2)} USDT · 한도 ${limitUsd.toFixed(2)}`,
  });
}

/**
 * 환경변수에서 한도를 읽는다.
 *
 * 값이 이상하면(문자·음수) **기본값으로 조용히 떨어지지 않는다.** 그러면
 * 오타 하나로 한도가 사라지는데 화면에는 아무 표시도 없다. 잘못된 값은
 * '설정 없음'이 아니라 그대로 무시하고, 나머지 한도만 쓴다.
 */
export function readDailyLossConfig(env: (k: string) => string | undefined): DailyLossConfig {
  const num = (k: string): number | null => {
    const raw = env(k);
    if (raw == null || String(raw).trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const usd = num('DAILY_MAX_LOSS_USD');
  const pct = num('DAILY_MAX_LOSS_PCT');
  const target = num('DAILY_PROFIT_TARGET_PCT');

  // 둘 다 없으면 기본 비율 한도를 쓴다. 한도가 아예 없는 상태로 자동매매가
  // 도는 것이 이 파일이 막으려는 것이다.
  if (usd == null && pct == null) {
    return { maxLossUsd: null, maxLossPct: DEFAULT_DAILY_LOSS.maxLossPct, profitTargetPct: target };
  }
  return { maxLossUsd: usd, maxLossPct: pct, profitTargetPct: target };
}

/**
 * 그 거래소 하루의 시작(UTC 0시) epoch ms.
 *
 * 왜 UTC인가: 거래소의 income 기록이 UTC 기준이고, 펀딩 정산도 00/08/16시
 * UTC다. 한국 시간 자정으로 자르면 하루 경계가 거래소와 어긋나 같은
 * 펀딩이 두 번 세지거나 빠진다.
 */
export function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
