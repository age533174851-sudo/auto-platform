// src/lib/strategies/runStrategy.ts
//
// **전략 하나를 평가하는 단 하나의 입구.**
//
// 왜 필요한가
// ───────────
// 지금은 `/api/autotrade/daily-ladder`가 모든 예약을 처리한다. 전략이
// 둘만 돼도 부르는 쪽(크론·워커·화면)이 각자 "이건 이 주소, 저건 저 주소"를
// 알아야 하고, 그 표가 세 곳에 생긴다. 전략을 하나 추가할 때마다 세 곳을
// 고쳐야 하며 — 이 저장소의 경험상 — 반드시 한 곳이 빠진다.
//
// 그래서 입구를 하나로 둔다. 부르는 쪽은 `strategyId`만 안다.
//
// 무엇을 하지 않는가
// ──────────────────
// **여기서 주문을 만들지 않는다.** 기존 실행기(daily-ladder·scalp)가 이미
// 크기·배율·안전 관문·주문 경로를 갖고 있다. 그것을 대체하면 실행 경로가
// 둘이 되고, 그때 한쪽만 고쳐진다.
//
// 평가는 주문이 아니다
// ────────────────────
// 주기가 왔다고 주문이 나가는 것이 아니다. 조건이 안 맞으면 `NO_SIGNAL`이
// 정상 결과다. 이것을 실패로 적으면 화면이 온통 빨강이 되고, 진짜 고장이
// 그 안에 묻힌다.

import { resolveStrategy, type StrategySpec } from './registry';

export type EvaluationOutcome =
  /** 진입했다 */
  | 'ENTERED'
  /** 정상 평가 · 진입 조건 없음. **실패가 아니다** */
  | 'NO_SIGNAL'
  /** 안전 관문이 막았다 */
  | 'BLOCKED'
  /** 실행 자체가 실패했다 */
  | 'FAILED';

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  strategyId: string;
  strategyVersion: string;
  /** 사람이 읽는 한 줄 */
  summary: string;
  /** 실행기가 돌려준 것 그대로 */
  raw: any;
}

export interface RunContext {
  symbol: string;
  connectionId: string;
  mode: string;
  env: 'TESTNET' | 'LIVE';
  intervalMin?: number | null;
  leverageCap?: number | null;
  riskPct?: number | null;
  marginPct?: number | null;
  /** 주문을 내지 않고 판정만 한다 */
  checkOnly?: boolean;
  /** 같은 평가가 두 번 돌지 않게 하는 열쇠 */
  idempotencyKey?: string | null;
}

/**
 * 실행기 응답 → 평가 결과.
 *
 * **순수 함수다.** 여기가 틀리면 관망이 실패로 보이거나 그 반대가 되는데,
 * 둘 다 화면을 못 믿게 만든다. 네트워크 없이 값으로 확인할 수 있어야 한다.
 *
 * 판정 순서가 곧 의미다:
 *   1. 실행 자체가 안 됐으면 FAILED — 그 뒤 값은 볼 필요가 없다
 *   2. 주문이 나갔으면 ENTERED
 *   3. 관문이 막았으면 BLOCKED
 *   4. 나머지는 NO_SIGNAL — **정상이다**
 */
export function outcomeOf(input: {
  httpOk: boolean;
  status?: number | null;
  body: any;
}): { outcome: EvaluationOutcome; summary: string } {
  const b = input.body ?? {};

  if (!input.httpOk) {
    // 관문이 막은 것과 실행기가 죽은 것은 다르다. 서버가 이유를 줬으면 그것을 쓴다.
    const blocked = b?.ok === false && (b?.checklist || b?.error === 'blocked' || b?.blockers);
    const why = String(b?.message || b?.error || `HTTP ${input.status ?? '?'}`);
    return blocked
      ? { outcome: 'BLOCKED', summary: why }
      : { outcome: 'FAILED', summary: `실행기가 응답하지 못했습니다 — ${why}` };
  }

  if (b?.executed === true || b?.entered === true || b?.order || b?.orderId) {
    return { outcome: 'ENTERED', summary: String(b?.message || '진입했습니다') };
  }

  // 점검 목록이 막았는가. `allowed === false`만 본다 — undefined는 '안 돌았다'다.
  const allowed = b?.checklist?.allowed;
  if (allowed === false) {
    const blockers = Array.isArray(b?.checklist?.blockers) ? b.checklist.blockers : [];
    return {
      outcome: 'BLOCKED',
      summary: blockers.length > 0
        ? `주문이 막혔습니다 — ${blockers.slice(0, 2).join(' · ')}`
        : String(b?.error || '주문이 막혔습니다'),
    };
  }
  if (b?.ok === false) {
    return { outcome: 'FAILED', summary: String(b?.message || b?.error || '실행에 실패했습니다') };
  }

  // **여기가 정상이다.** 평가했고 조건이 아니었다.
  return { outcome: 'NO_SIGNAL', summary: '정상 평가 완료 · 진입 조건 없음' };
}

export interface RunStrategyDeps {
  /** 실행기를 실제로 부르는 것. 테스트에서는 값으로 바꾼다 */
  call: (route: string, ctx: RunContext, spec: StrategySpec)
    => Promise<{ httpOk: boolean; status?: number | null; body: any }>;
}

/**
 * 전략 하나를 평가한다.
 *
 * **모르는 전략·연구 전용·버전 불일치는 여기서 막는다.** 실행기까지 가지
 * 않는다 — 거기까지 가면 "왜 안 돌지"의 답이 실행기 로그에 묻힌다.
 */
export async function runStrategy(
  strategyId: any,
  strategyVersion: any,
  ctx: RunContext,
  deps: RunStrategyDeps,
): Promise<EvaluationResult> {
  const r = resolveStrategy({
    id: strategyId, version: strategyVersion, env: ctx.env, intervalMin: ctx.intervalMin,
  });
  if (!r.ok || !r.spec) {
    return {
      outcome: 'BLOCKED',
      strategyId: String(strategyId ?? ''),
      strategyVersion: String(strategyVersion ?? ''),
      summary: r.message,
      raw: { code: r.code },
    };
  }
  const spec = r.spec;
  if (!spec.route) {
    return {
      outcome: 'BLOCKED', strategyId: spec.id, strategyVersion: spec.version,
      summary: `'${spec.name}'에 실행 경로가 없습니다`, raw: { code: 'NO_ROUTE' },
    };
  }

  let res: { httpOk: boolean; status?: number | null; body: any };
  try {
    res = await deps.call(spec.route, ctx, spec);
  } catch (e: any) {
    return {
      outcome: 'FAILED', strategyId: spec.id, strategyVersion: spec.version,
      summary: `실행기를 부르지 못했습니다 — ${e?.message || e}`,
      raw: { error: String(e?.message || e) },
    };
  }

  const o = outcomeOf(res);
  return {
    outcome: o.outcome, strategyId: spec.id, strategyVersion: spec.version,
    summary: o.summary, raw: res.body,
  };
}

/**
 * 이 평가의 멱등 키.
 *
 * 예약을 켜면 첫 평가를 바로 넣는데, 사용자가 스위치를 두 번 누르거나
 * 화면이 재시도하면 **같은 평가가 두 번 돈다.** 평가가 두 번 도는 것은
 * 주문이 두 번 나가는 것과 같다 — 조건이 맞았으면 둘 다 들어간다.
 *
 * 시각을 넣지 않는다. 넣으면 1초 차이로 다른 키가 되어 아무것도 못 막는다.
 */
export function evaluationKey(input: {
  userId: string; strategyId: string; symbol: string; connectionId: string;
  /** 'first' = 켠 직후 첫 평가 · 그 외에는 주기 버킷 */
  slot: string;
}): string {
  return [input.userId, input.strategyId, input.symbol, input.connectionId, input.slot]
    .map(v => String(v ?? '').trim()).join(':');
}
