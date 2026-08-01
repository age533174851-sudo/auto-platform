// src/lib/ai/vetoCheck.ts
//
// 저장된 AI 합의를 읽어 거부권 판정을 만든다. **IO만 한다** —
// 판정 자체는 tradeVeto.ts의 순수 함수가 하고 여기서는 테이블만 읽는다.
//
// 왜 그때그때 AI를 부르지 않는가
// ──────────────────────────────
// 주문 직전에 다섯 모델을 부르면 사람이 화면에서 몇 초를 기다린다. 시장가
// 주문에서 그 몇 초는 체결가가 달라지는 시간이다. 그리고 AI가 느리면
// **주문이 느려진다** — AI를 안전장치가 아니라 덧댄 의견으로 두기로 한
// 결정과 어긋난다.
//
// 그래서 합의는 뉴스 파이프라인이 만들 때 저장해 두고(`ai_predictions`),
// 주문 때는 가장 최근 것을 읽기만 한다. 오래된 것은 judgeAiVeto가
// 신선도로 걸러 abstain으로 돌린다 — 여기서 '없음'과 '오래됨'을 구분해
// 판정하지 않는다. 판단은 한 곳에서만 한다.

import { judgeAiVeto, readVetoConfig, type VetoJudgement, type VetoConfig } from './tradeVeto';

export interface CollectVetoArgs {
  sb: any;
  userId: string;
  symbol: string;
  side: 'LONG' | 'SHORT' | null | undefined;
  nowMs?: number;
  /** 안 주면 환경변수에서 읽는다 */
  cfg?: VetoConfig;
  env?: Record<string, any>;
}

export interface CollectVetoResult {
  judgement: VetoJudgement;
  /** 체크리스트에 그대로 넣는 모양 */
  verdict: { status: 'ok' | 'blocked' | 'abstain' | 'unknown'; reason: string };
  /** 판정에 쓴 행의 id. 나중에 채점할 때 이 행을 찾는다 */
  predictionId: string | null;
}

export async function collectAiVeto(args: CollectVetoArgs): Promise<CollectVetoResult> {
  const cfg = args.cfg ?? readVetoConfig(args.env ?? {});
  const now = args.nowMs ?? Date.now();

  let row: any = null;
  try {
    const { data } = await (args.sb.from('ai_predictions') as any)
      .select('id, direction, confidence, level, responded, asked, decided_at')
      .eq('user_id', args.userId)
      .eq('symbol', args.symbol)
      // 합의만 본다. 개별 모델 한 줄로 전략을 덮으면 안 된다 —
      // judgeAiVeto의 최소 응답 수도 같은 것을 막지만, 여기서 한 번 더 좁힌다.
      .eq('source', 'consensus')
      .order('decided_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    row = data ?? null;
  } catch {
    // 조회 실패를 '반대 없음'으로 만들지 않는다. consensus를 null로 넘기면
    // judgeAiVeto가 abstain(또는 strict면 unknown)을 돌려준다.
    row = null;
  }

  const judgement = judgeAiVeto({
    side: args.side,
    nowMs: now,
    consensus: row
      ? {
          level: String(row.level ?? ''),
          direction: row.direction ?? null,
          confidence: row.confidence == null ? null : Number(row.confidence),
          responded: row.responded == null ? null : Number(row.responded),
          asked: row.asked == null ? null : Number(row.asked),
          asOfMs: row.decided_at ? Date.parse(String(row.decided_at)) : null,
        }
      : null,
  }, cfg);

  return {
    judgement,
    verdict: { status: judgement.status, reason: judgement.reason },
    predictionId: row?.id ? String(row.id) : null,
  };
}

/**
 * 이 판단이 실제로 주문에 어떻게 쓰였는지 되돌아가 적는다.
 *
 * 왜 필요한가: 막은 판단만 채점하면 "AI가 막았을 때는 항상 맞더라"는 착시가
 * 생긴다. 막은 것과 통과시킨 것을 **같이** 채점해야 그 확신도가 신호인지
 * 알 수 있다.
 *
 * 실패해도 주문을 막지 않는다 — 기록은 매매의 전제가 아니다.
 */
export async function markApplied(
  sb: any, predictionId: string | null,
  applied: 'VETO' | 'PASS' | 'INFO',
  side: 'LONG' | 'SHORT' | null | undefined,
  entryPrice: number | null | undefined,
): Promise<void> {
  if (!predictionId) return;
  try {
    const patch: Record<string, any> = { applied };
    if (side === 'LONG' || side === 'SHORT') patch.side = side;
    // 0이나 NaN을 기준가로 적으면 정답지가 통째로 망가진다.
    if (typeof entryPrice === 'number' && Number.isFinite(entryPrice) && entryPrice > 0) {
      patch.entry_price = entryPrice;
    }
    await (sb.from('ai_predictions') as any).update(patch).eq('id', predictionId);
  } catch { /* 기록 실패로 주문을 막지 않는다 */ }
}
