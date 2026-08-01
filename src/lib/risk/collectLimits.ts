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
}

const EMPTY: LimitVerdicts = {
  dailyLoss: null, weeklyLoss: null, lossStreak: null,
  aiVeto: null, aiPredictionId: null,
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
}

/**
 * AI 거부권을 채운다. 켜져 있지 않으면 아무것도 하지 않는다.
 *
 * 여기서 실패해도 나머지 판정은 그대로 둔다 — AI 조회 실패로 손실 한도까지
 * 못 읽으면 그건 AI가 안전장치가 된 것이다.
 */
async function fillAiVeto(out: LimitVerdicts, args: CollectLimitsArgs, now: number): Promise<void> {
  if (!args.symbol || (args.side !== 'LONG' && args.side !== 'SHORT')) return;
  try {
    const { readVetoConfig } = await import('@/lib/ai/tradeVeto');
    const cfg = readVetoConfig(process.env as any);
    // 꺼져 있으면 체크리스트가 이 항목을 아예 안 보여준다. 판정도 하지 않는다.
    if (!cfg.enabled) return;
    const { collectAiVeto } = await import('@/lib/ai/vetoCheck');
    const r = await collectAiVeto({
      sb: args.sb, userId: args.userId, symbol: args.symbol,
      side: args.side, nowMs: now, cfg,
    });
    out.aiVeto = r.verdict;
    out.aiPredictionId = r.predictionId;
  } catch {
    // 판정 자체를 못 만들었다. null로 두면 체크리스트가 warn으로 남긴다 —
    // 통과로 적지도, 막지도 않는다.
  }
}

/**
 * 오늘·이번 주·연패 잠금(+켜져 있으면 AI 거부권)을 한 번에.
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
  return out;
}
