// src/lib/engine/overrideGate.ts
//
// 주문 라우트 셋(USDⓈ-M · COIN-M · 현물)이 **같은 방식으로** 사용자의
// "네"를 처리하게 하는 한 곳.
//
// 세 라우트에 각각 적으면 언젠가 한 곳만 고친다. 이 저장소에서 오늘
// 현물·COIN-M이 오늘 손실 한도를 통째로 빠뜨리고 있던 것이 정확히
// 그 결과였다. 무시 처리는 **주문을 나가게 하는 경로**라 더더욱 한 곳이어야
// 한다.
import { applyOverrides, waiveEventsFrom, type BlockerLike } from './checkOverride';

export interface OverrideGateResult {
  /** 그래도 막히는가 */
  blocked: boolean;
  /** 막힐 때 응답에 넣을 조각 */
  remaining: BlockerLike[];
  /** 지목했지만 넘길 수 없어서 거부된 항목 */
  refused: BlockerLike[];
  /** 실제로 넘어간 항목 */
  waived: BlockerLike[];
  /** 안전 기록을 남기다 실패했으면 그 이유 */
  logError: string | null;
}

/**
 * 체크리스트 결과 + 사용자가 "네"를 누른 목록 → 나가도 되는가.
 *
 * 기록은 **항상 남긴다.**
 *  · 막혔으면 막힌 항목을 (status: 그대로)
 *  · 넘겼으면 넘긴 항목을 (status: 'waived')
 *
 * 넘긴 것을 안 남기면 안전 기록에서 "한 번도 발동 안 함"과 "매번 넘김"이
 * 똑같아 보인다. 뒤쪽이 훨씬 위험한 상태인데 더 안전해 보이면 안 된다.
 *
 * 기록 실패가 판정을 바꾸지는 않는다 — 못 적었다는 사실만 돌려준다.
 */
export async function gateWithOverrides(
  sb: any,
  userId: string,
  checklist: { allowed: boolean; blockers: BlockerLike[]; results: BlockerLike[] },
  requested: string[] | null | undefined,
  ctx: { market: string; symbol: string },
): Promise<OverrideGateResult> {
  const { waived, remaining, refused } = applyOverrides(checklist?.blockers, requested);
  const blocked = remaining.length > 0;

  let logError: string | null = null;
  try {
    const { recordSafetyBlocks } = await import('@/lib/safety/safetyLog');
    if (blocked) {
      // 막혔을 때는 지금까지처럼 막은 항목 전부를 남긴다.
      const lg = await recordSafetyBlocks(sb, userId, checklist?.results as any, ctx);
      logError = lg.error;
    } else if (waived.length > 0) {
      // 통과시켰다. 이건 발동한 뒤 사용자가 넘긴 것이라 반드시 남는다.
      const rows = waiveEventsFrom(waived, ctx);
      const { error } = await (sb as any).from('safety_events')
        .insert(rows.map(r => ({ ...r, user_id: userId })));
      if (error) throw new Error(error.message);
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    logError = /safety_events/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg)
      ? 'safety_events 표가 없습니다 — 마이그레이션 026을 적용하세요'
      : msg;
  }

  return { blocked, remaining, refused, waived, logError };
}

/** 요청 본문에서 무시 목록을 꺼낸다. 배열이 아니면 빈 목록이다. */
export function readOverrides(body: any): string[] {
  const v = body?.overrideChecks;
  if (!Array.isArray(v)) return [];
  return v.map((x: any) => String(x || '')).filter(Boolean);
}
