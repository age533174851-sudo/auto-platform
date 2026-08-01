// src/lib/ai/recordPrediction.ts
//
// AI 합의를 **원장에 남긴다.** 남기지 않으면 나중에 채점할 것이 없다.
//
// 왜 자산 이름을 종목으로 바꾸는가
// ────────────────────────────────
// 뉴스 분석은 영향 자산을 'BTC'·'ETH'로 말하고, 매매는 'BTCUSDT'로 한다.
// 이 변환을 안 하면 거부권이 매번 "이 종목의 합의가 없습니다"를 돌려주고,
// 기능이 켜져 있는데 아무것도 안 하는 상태가 된다 — 가장 알아채기 어려운
// 고장이다.
//
// 'NASDAQ'처럼 매매 종목이 아닌 것은 **버린다.** 억지로 종목을 만들면
// 존재하지 않는 종목의 합의가 쌓인다.

/** 매매 가능한 종목 이름으로. 아니면 null */
export function toTradingSymbol(asset: string | null | undefined, quote = 'USDT'): string | null {
  if (asset == null) return null;
  const a = String(asset).trim().toUpperCase();
  if (!a) return null;
  // 이미 종목 이름이면 그대로 (BTCUSDT · BTC_USDT)
  if (/^[A-Z0-9]{2,15}_?(USDT|USDC|BUSD|BTC|ETH)$/.test(a)) return a.replace('_', '');
  // 지수·통화·거시 지표는 매매 종목이 아니다
  if (!/^[A-Z0-9]{2,10}$/.test(a)) return null;
  if (['NASDAQ', 'SPX', 'SP500', 'DXY', 'VIX', 'GOLD', 'OIL', 'USD', 'KRW', 'JPY', 'EUR', 'CNY'].includes(a)) {
    return null;
  }
  return `${a}${quote}`;
}

export interface RecordArgs {
  sb: any;
  userId: string;
  /** 'consensus' 또는 개별 공급자 이름 */
  source: string;
  /** 영향 자산 목록 ('BTC') 또는 종목 이름 ('BTCUSDT') */
  assets: string[];
  direction: string | null;
  confidence: number | null;
  level: string | null;
  /** 실제로 답한 수 / 물어본 수. **둘 다 남긴다** */
  responded: number | null;
  asked: number | null;
  reasons?: string[];
  /** 몇 분 뒤에 채점할 것인가 */
  horizonMin?: number;
  nowMs?: number;
}

/**
 * 합의 한 건을 자산별로 한 행씩 남긴다.
 *
 * 실패해도 던지지 않는다 — 기록은 분석의 전제가 아니다. 다만 몇 건을
 * 남겼는지 돌려줘서, 호출자가 "0건 남았다"를 알 수 있게 한다. 조용히
 * 0건이 되면 몇 주 뒤에 "채점할 것이 없다"로만 드러난다.
 */
export async function recordPrediction(args: RecordArgs): Promise<{ inserted: number; error: string | null }> {
  const symbols = Array.from(new Set(
    (Array.isArray(args.assets) ? args.assets : [])
      .map(a => toTradingSymbol(a))
      .filter((s): s is string => !!s),
  ));
  if (symbols.length === 0) return { inserted: 0, error: 'no_tradable_symbol' };

  const at = new Date(args.nowMs ?? Date.now()).toISOString();
  const rows = symbols.map(symbol => ({
    user_id: args.userId,
    symbol,
    source: args.source,
    direction: args.direction ?? null,
    // 확신도를 모르면 NULL이다. 0으로 적으면 '아주 자신 없었다'가 되어
    // 보정 곡선을 왜곡한다.
    confidence: Number.isFinite(args.confidence as number) ? args.confidence : null,
    level: args.level ?? null,
    responded: Number.isFinite(args.responded as number) ? args.responded : null,
    asked: Number.isFinite(args.asked as number) ? args.asked : null,
    reasons: args.reasons && args.reasons.length ? args.reasons : null,
    applied: 'INFO',        // 주문에 쓰이면 markApplied가 덮어쓴다
    decided_at: at,
    horizon_min: args.horizonMin ?? 240,
  }));

  try {
    const { error } = await (args.sb.from('ai_predictions') as any).insert(rows);
    if (error) return { inserted: 0, error: error.message || 'insert_failed' };
    return { inserted: rows.length, error: null };
  } catch (e: any) {
    return { inserted: 0, error: e?.message || 'insert_failed' };
  }
}
