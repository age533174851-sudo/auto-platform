// src/lib/risk/collectLimits.ts
//
// 손실 잠금 셋(오늘·이번 주·연패)을 **한 번에** 모은다.
//
// 왜 모으는가
// ───────────
// 주문 라우트가 다섯이다(선물·COIN-M·현물·웹훅·일일 사다리). 각자 이 셋을
// 따로 채우게 두면 반드시 한두 곳이 빠진다 — 실제로 그랬다:
//
//   · `/api/binance/spot/order`와 `/api/binance/coinm/order`는 **오늘 손실
//     한도를 아예 안 넣고 있었다.** 그런데 체크리스트에서 그 항목은
//     '모르면 막는' 필수 항목이다. 즉 **현물 매수와 COIN-M 진입이 전부
//     막혀 있었다** — 화면에는 "오늘 손실 한도: 확인 못 함"으로.
//
// 검사를 추가할 때마다 다섯 곳을 고쳐야 하는 구조가 그 버그를 만들었다.
// 여기 하나만 부르면 셋이 다 채워진다.
//
// 실패는 null로 남긴다
// ────────────────────
// 못 읽은 항목은 넣지 않는다 → 체크리스트가 unknown으로 막는다.
// 여기서 'ok'로 채우면 조회 실패가 통과가 된다.

export interface LimitVerdicts {
  dailyLoss: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
  weeklyLoss: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
  lossStreak: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
  /**
   * AI 거부권. **켜져 있고 symbol·side를 받았을 때만** 채운다.
   *
   * 여기 넣는 이유는 위와 같다 — 다섯 라우트가 각자 채우게 두면 반드시
   * 한둘이 빠지고, 그때 그 라우트는 AI 없이 도는데 화면에는 켜져 있다고
   * 뜬다. 켜졌다고 믿는 검사가 실제로는 안 도는 것이 이 파일이 막으려는
   * 바로 그 실패다.
   */
  aiVeto: { status: 'ok' | 'blocked' | 'abstain' | 'unknown'; reason: string } | null;
  /** 채점 원장에서 이 판정에 쓴 행. 주문이 나가면 markApplied로 되짚는다 */
  aiPredictionId: string | null;
  /**
   * 가상 서브계좌 한도.
   *
   * 손실 한도와 같은 규칙으로 **못 읽으면 막는다**. 사용자가 "성장 600만"이라고
   * 정해 둔 것이 조회 실패 한 번으로 무제한이 되면 안 된다. 바구니를 안
   * 만든 사람은 판정이 'ok'로 나오므로 아무 일도 일어나지 않는다.
   */
  subAccount: { status: 'ok' | 'over' | 'unassigned' | 'unknown'; reason: string } | null;
}

const EMPTY: LimitVerdicts = {
  dailyLoss: null, weeklyLoss: null, lossStreak: null,
  aiVeto: null, aiPredictionId: null, subAccount: null,
};

export interface CollectLimitsArgs {
  sb: any;
  userId: string;
  /** 실계좌·테스트넷이면 연결 id */
  connectionId?: string | null;
  /** 모의면 true — 이때 거래소를 부르지 않고 paper_* 테이블을 본다 */
  paper?: boolean;
  testnet?: boolean;
  exchange?: 'binance' | 'gate';
  /** 현재 자산(USDT). 비율 한도를 계산하는 데 쓴다 */
  equityUsd?: number | null;
  nowMs?: number;
  /** AI 거부권을 볼 종목·방향. 둘 다 있어야 판정한다 */
  symbol?: string | null;
  side?: 'LONG' | 'SHORT' | null;
  /** 서브계좌 한도용. 'SPOT' | 'USDM' | 'COINM' */
  market?: string | null;
  /** 이 주문이 새로 묶는 증거금(USDT) */
  addMarginUsd?: number | null;
  /** 지금 열려 있는 것들 (증거금 기준). 못 읽었으면 넘기지 않는다 */
  openUse?: Array<{ symbol: string; market: string; marginUsd: number | null }> | null;
}

/**
 * AI 거부권을 채운다. 켜져 있지 않으면 아무것도 하지 않는다.
 *
 * 여기서 실패해도 나머지 판정은 그대로 둔다 — AI 조회 실패로 손실 한도까지
 * 못 읽으면 그건 AI가 안전장치가 된 것이다.
 */
async function fillAiVeto(out: LimitVerdicts, args: CollectLimitsArgs, now: number): Promise<void> {
  let cfg: any = null;
  try {
    const { readVetoConfig } = await import('@/lib/ai/tradeVeto');
    cfg = readVetoConfig(process.env as any);
  } catch { return; }

  // 꺼져 있으면 체크리스트가 이 항목을 아예 안 보여준다. 판정도 하지 않는다.
  if (!cfg?.enabled) return;

  // **켜져 있으면 어떤 경우에도 판정을 남긴다.**
  //
  // 예전에는 실패하면 null로 두었다. 그런데 호출자는 `!!limits.aiVeto`로
  // 이 검사를 목록에 넣을지 정한다 — null이면 항목이 **통째로 사라진다.**
  // 즉 켜 놓고 조회가 한 번 실패하면, 그 뒤로는 AI 검사가 있었다는 사실
  // 자체가 화면에서 없어진다. 켜졌다고 믿는 검사가 안 도는 것이 이 파일이
  // 막으려는 바로 그 실패다.
  const fallback = (reason: string) => {
    out.aiVeto = { status: cfg.strict ? 'unknown' : 'abstain', reason };
    out.aiPredictionId = null;
  };

  if (!args.symbol || (args.side !== 'LONG' && args.side !== 'SHORT')) {
    fallback('종목·방향을 몰라 AI 판단을 적용하지 않았습니다');
    return;
  }

  try {
    const { collectAiVeto } = await import('@/lib/ai/vetoCheck');
    const r = await collectAiVeto({
      sb: args.sb, userId: args.userId, symbol: args.symbol,
      side: args.side, nowMs: now, cfg,
    });
    out.aiVeto = r.verdict;
    out.aiPredictionId = r.predictionId;
  } catch (e: any) {
    fallback(`AI 합의를 읽지 못했습니다 (${e?.message || e})`);
  }
}

/**
 * 서브계좌 한도를 채운다.
 *
 * 여기서 실패해도 나머지 판정은 그대로 둔다 — 한 조회 실패로 손실 한도까지
 * 못 읽으면 사용자는 무엇을 고쳐야 하는지 알 수 없다.
 */
async function fillSubAccount(out: LimitVerdicts, args: CollectLimitsArgs): Promise<void> {
  if (!args.market || !args.symbol) {
    // 시장·종목을 모르면 어느 바구니인지 정할 수 없다. **통과시키지 않는다.**
    out.subAccount = { status: 'unknown', reason: '시장·종목을 몰라 서브계좌 한도를 확인하지 못했습니다' };
    return;
  }
  try {
    const { collectSubAccount } = await import('@/lib/portfolio/subAccountCheck');
    const r = await collectSubAccount({
      sb: args.sb, userId: args.userId,
      market: String(args.market), symbol: String(args.symbol),
      addMarginUsd: args.addMarginUsd ?? null,
      open: Array.isArray(args.openUse) ? args.openUse : null,
    });
    out.subAccount = { status: r.verdict.status, reason: r.verdict.reason };
  } catch (e: any) {
    out.subAccount = { status: 'unknown', reason: `서브계좌 한도를 확인하지 못했습니다 (${e?.message || e})` };
  }
}

/**
 * 오늘·이번 주·연패 잠금 + (켜져 있으면) AI 거부권 + 서브계좌 한도를 한 번에.
 *
 * 하나가 실패해도 나머지는 채운다. 하나 때문에 전부 unknown이 되면
 * 사용자는 무엇을 고쳐야 하는지 알 수 없다.
 */
export async function collectAllLimits(args: CollectLimitsArgs): Promise<LimitVerdicts> {
  const out: LimitVerdicts = { ...EMPTY };
  const now = args.nowMs ?? Date.now();

  if (args.paper) {
    try {
      const { collectPaperDailyLoss } = await import('./dailyLossCheck');
      const f = await collectPaperDailyLoss({ sb: args.sb, userId: args.userId, nowMs: now });
      out.dailyLoss = { status: f.verdict.status, reason: f.verdict.reason };
    } catch { /* null → unknown → 막힌다 */ }
    try {
      const { collectPaperStreakLimits } = await import('./lossStreakCheck');
      const f = await collectPaperStreakLimits({ sb: args.sb, userId: args.userId, nowMs: now });
      out.weeklyLoss = { status: f.weekly.status, reason: f.weekly.reason };
      out.lossStreak = { status: f.streak.status, reason: f.streak.reason };
    } catch { /* null → unknown → 막힌다 */ }
    await fillAiVeto(out, args, now);
    await fillSubAccount(out, args);
    return out;
  }

  if (!args.connectionId) return out;

  // 키는 한 번만 읽는다. 두 수집기가 각자 읽으면 복호화가 두 번 돈다.
  let apiKey = '';
  let apiSecret = '';
  let exchange = args.exchange;
  let testnet = args.testnet;
  try {
    const { data: c } = await (args.sb.from('exchange_connections') as any)
      .select('api_key, api_secret_enc, encrypted_secret, exchange_id, is_testnet')
      .eq('id', args.connectionId).eq('user_id', args.userId).maybeSingle();
    if (!c) return out;
    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    apiKey = c.api_key || '';
    apiSecret = decryptSecret(c.api_secret_enc ?? c.encrypted_secret ?? '');
    if (exchange == null) {
      exchange = String(c.exchange_id || '').toLowerCase() === 'gate' ? 'gate' : 'binance';
    }
    if (testnet == null) testnet = c.is_testnet !== false;
  } catch { return out; }

  const common = {
    apiKey, apiSecret,
    testnet: testnet === true,
    exchange: exchange ?? 'binance',
    currentEquityUsd: args.equityUsd ?? null,
    nowMs: now,
  };

  try {
    const { collectDailyLoss } = await import('./dailyLossCheck');
    const f = await collectDailyLoss(common);
    out.dailyLoss = { status: f.verdict.status, reason: f.verdict.reason };
  } catch { /* null → unknown → 막힌다 */ }

  try {
    const { collectStreakLimits } = await import('./lossStreakCheck');
    const f = await collectStreakLimits(common);
    out.weeklyLoss = { status: f.weekly.status, reason: f.weekly.reason };
    out.lossStreak = { status: f.streak.status, reason: f.streak.reason };
  } catch { /* null → unknown → 막힌다 */ }

  await fillAiVeto(out, args, now);
  await fillSubAccount(out, args);
  return out;
}
