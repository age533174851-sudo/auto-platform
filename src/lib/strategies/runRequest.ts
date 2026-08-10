// src/lib/strategies/runRequest.ts
//
// **어느 주소로, 어떤 본문으로 부를 것인가 — 한 곳에서 만든다.**
//
// 왜 필요한가
// ───────────
// 지금 전략을 실제로 부르는 곳이 셋이다:
//
//   화면의 [점검]        AutotradeControl.runCheck
//   화면의 첫 평가       AutotradeControl.runFirstCheck
//   서버 주기 평가       evaluationRunner.evaluateSchedule
//
// 셋이 각자 주소와 본문을 적으면, 전략을 하나 추가할 때마다 세 곳을
// 고쳐야 하고 **반드시 한 곳이 빠진다.** 실제로 그랬다: 서버는
// `strategy_id`를 저장하고 읽는데 화면은 `/api/autotrade/daily-ladder`를
// 직접 불렀다. 그래서 예약에 무엇을 저장하든 화면의 점검과 첫 평가는
// 언제나 계단식이었다 — 그리고 아무 오류도 안 났다.
//
// 여기서 만드는 것
// ────────────────
// 전략 id 하나로 주소와 본문을 만든다. 부르는 쪽은 fetch만 한다.
//
// 점검 깃발이 전략마다 다르다
// ───────────────────────────
// `daily-ladder`·`scalp`은 `checkOnly: true`를 받고, `my-original-v1`은
// `dryRun: true`를 받는다. 이걸 부르는 쪽이 외우면 언젠가 틀리고,
// **틀리면 점검인 줄 알았던 호출이 진짜 주문을 낸다.** 그래서 전략
// 명세에 적어 두고 여기서 읽는다.

import { resolveStrategy, type StrategySpec } from './registry';

export interface RunRequestInput {
  strategyId: any;
  /** 예약에 저장된 버전. 없으면 지금 코드 버전으로 본다 */
  strategyVersion?: any;
  env: 'TESTNET' | 'LIVE';
  symbol: string;
  connectionId: string;
  /** 운영 모드 문자열 (TESTNET · LIVE_LIMITED …) */
  mode: string;
  intervalMin?: any;
  leverageCap?: any;
  riskPct?: any;
  marginPct?: any;
  /** 크론이 부를 때만 실린다. 화면에서는 서버가 세션으로 안다 */
  userId?: any;
  idempotencyKey?: any;
  /** 주문을 내지 않고 판정만 한다 */
  checkOnly?: boolean;
}

export interface RunRequest {
  ok: boolean;
  /** 왜 못 만들었는가. ok면 빈 문자열 */
  code: string;
  message: string;
  route: string | null;
  body: Record<string, any> | null;
  spec: StrategySpec | null;
}

/**
 * 이 전략을 부를 요청 하나.
 *
 * **막는 것을 여기서 막는다.** 모르는 전략·연구 전용·실전 미개방·
 * 지원하지 않는 주기는 주소를 만들지 않는다. 주소가 없으면 부를 수 없다.
 */
export function strategyRunRequest(i: RunRequestInput): RunRequest {
  const r = resolveStrategy({
    id: i.strategyId, version: i.strategyVersion,
    env: i.env, intervalMin: i.intervalMin,
  });
  if (!r.ok || !r.spec) {
    return { ok: false, code: r.code, message: r.message, route: null, body: null, spec: null };
  }
  const spec = r.spec;
  if (!spec.route) {
    return {
      ok: false, code: 'NO_ROUTE', route: null, body: null, spec,
      message: `'${spec.name}'에 실행 경로가 없습니다`,
    };
  }

  const body: Record<string, any> = {
    symbol: i.symbol,
    connectionId: i.connectionId,
    mode: i.mode,
    // **`?? null`로 눕혀 보낸다.** undefined는 JSON에서 사라지고,
    // 받는 쪽이 0으로 읽으면 배율 상한 0이 되어 주문이 통째로 막힌다.
    intervalMin: num(i.intervalMin),
    leverageCap: num(i.leverageCap),
    riskPct: num(i.riskPct),
    marginPct: num(i.marginPct),
  };
  if (i.userId != null && String(i.userId) !== '') body.userId = String(i.userId);
  if (i.idempotencyKey != null) body.idempotencyKey = i.idempotencyKey;
  if (i.checkOnly) body[spec.checkFlag] = true;

  return { ok: true, code: 'OK', message: '', route: spec.route, body, spec };
}

/** null·빈 문자열·boolean은 숫자가 아니다. **0으로 눕히지 않는다** */
function num(v: any): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
