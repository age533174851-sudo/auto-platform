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
// 워커 빌드에는 `@/` 별칭이 없다 — 상대경로로 간다.
import { bodySaysBlocked, blockerNames } from '../autotrade/runOutcome';

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
  /** 경계 있는 사유 코드. 화이트리스트를 통과한 값만 들어온다 */
  reasonCode?: string;
  /**
   * **왜 09:00 강제 진입도 안 났는가.** 화이트리스트를 통과한 값만.
   *
   * 신호가 없을 때 라우트는 강제 진입을 한 번 더 본다. 그 판정이 없으면
   * "신호가 없었다"와 "창 밖이었다"와 "이미 냈다"가 한 문장으로 뭉친다.
   */
  forcedEntryCode?: string;
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
}): { outcome: EvaluationOutcome; summary: string; reasonCode?: string;
  forcedEntryCode?: string } {
  const b = input.body ?? {};

  // ── 관문이 막은 것과 실행기가 죽은 것은 다른 사실이다 ──
  //
  // 라우트들은 거부를 **`blocked` 칸의 코드**로 말한다 —
  // `scalp/route.ts`의 `MIGRATION_PENDING`·`KILL_SWITCH`·`NO_CONNECTION`,
  // `my-original-v1`의 `EXIT_RULE_NOT_CONFIGURED` 같은 값들이다. 그런데
  // 아래 판정은 `checklist`·`blockers`·`error === 'blocked'` 세 모양만
  // 알아봤다. **보내는 어휘와 읽는 어휘가 갈렸다** — 이 저장소가 제일
  // 자주 겪은 고장 그대로다(경로가 둘인데 한쪽만 고침). 그래서 이렇게 됐다:
  //
  //   · `503` + `blocked:'MIGRATION_PENDING'` → **FAILED**
  //     `last_result`가 "실행기가 응답하지 못했습니다"가 된다. 2026-11-10
  //     운영 기록이 정확히 그 문장이었고, 읽는 사람은 워커·호스팅·결제를
  //     의심하게 된다. 멈춰 있던 것은 워커가 아니라 **마이그레이션 기록**이다.
  //   · `200` + `ok:true` + `blocked:'EXIT_RULE_NOT_CONFIGURED'` → **NO_SIGNAL**
  //     100배 전략이 손절·익절 규칙이 없어 거부한 것이 "정상 평가 완료 ·
  //     진입 조건 없음"으로 적힌다. 화면 색은 **초록**이 된다 — 거짓으로
  //     안심시키는 쪽이고, 거짓으로 겁주는 것과 똑같이 나쁘다.
  //
  // 읽는 자리는 여기 하나다. 라우트마다 본문을 고쳐 맞추면 또 갈린다.
  //
  // 지키는 것 둘:
  //   ① **진짜 나간 주문을 덮지 않는다.** 진입 증거가 있으면 ENTERED가 이긴다.
  //   ② **임의 문자열을 장부에 넣지 않는다.** 코드 값 자체는 요약에 싣지
  //      않고, 라우트가 쓴 사람 문장(`message`·`error`)만 쓴다.
  //
  // **차단 판정은 `bodySaysBlocked` 한 곳에 있다.** 예전에는 이 함수 안에만
  // 두 벌(`!httpOk` 가지 · `checklist.allowed` 가지)이 있었고 화면 쪽
  // `classifyRun`에 또 한 벌이 있었다. 세 벌이 갈라졌고, 2026-11-14에
  // Gate 예약이 갈라진 자리로 떨어졌다 — 그 설명은 술어 쪽에 적어 뒀다.
  const enteredEvidence = b?.executed === true || b?.entered === true || b?.order || b?.orderId;
  if (!enteredEvidence && (bodySaysBlocked(b) || b?.outcome === 'BLOCKED')) {
    const why = String(b?.message || b?.error || '').trim();
    // 사람 문장이 없으면 막은 항목 이름으로 대신한다. `blockers`는 객체
    // 배열이라 그냥 join하면 `[object Object]`가 찍힌다.
    const names = blockerNames(b?.checklist?.blockers ?? b?.blockers);
    return {
      outcome: 'BLOCKED',
      summary: why
        || (names.length > 0 ? `주문이 막혔습니다 — ${names.slice(0, 2).join(' · ')}` : '안전장치가 막았습니다'),
    };
  }

  if (!input.httpOk) {
    // 여기까지 왔으면 **관문이 막았다는 증거가 본문에 없다.** 위에서 이미
    // 걸렀으므로, 남은 비정상 응답은 실행기 쪽 실패다.
    const why = String(b?.message || b?.error || `HTTP ${input.status ?? '?'}`);
    return { outcome: 'FAILED', summary: `실행기가 응답하지 못했습니다 — ${why}` };
  }

  if (enteredEvidence) {
    return { outcome: 'ENTERED', summary: String(b?.message || '진입했습니다') };
  }
  if (b?.ok === false) {
    return { outcome: 'FAILED', summary: String(b?.message || b?.error || '실행에 실패했습니다') };
  }

  // **여기가 정상이다.** 평가했고 조건이 아니었다.
  // Persist only a bounded diagnostic code, never raw exchange payloads.
  // No code (older routes) and unknown codes remain generic NO_SIGNAL.
  const knownNoSignalCodes = [
    'NO_BREAKOUT', 'VOLUME_BELOW_THRESHOLD', 'VOLUME_UNAVAILABLE',
    'BARS_UNAVAILABLE', 'BARS_INSUFFICIENT', 'BAR_DATA_INVALID',
    'PRICE_UNAVAILABLE', 'ATR_UNAVAILABLE', 'STOP_INVALID',
    'COST_EXCEEDS_TARGET', 'UNKNOWN_REASON',
  ];
  const reasonCode = typeof b?.reasonCode === 'string' ? b.reasonCode : '';
  const known = knownNoSignalCodes.includes(reasonCode);
  const diagnostic = known ? ` · 사유코드 ${reasonCode}` : '';
  // ★ **코드를 문자열 안에만 묻어 두지 않는다.**
  //
  //   예전에는 요약 문장에만 들어갔다. 그래서 운영 감사가 예약 줄을
  //   읽어도 `reasonCode` 칸이 비어 있었고(`NOT_RECORDED`),
  //   "NO_SIGNAL인데 왜인지 모른다"가 됐다 — 2026-10-15 감사에서
  //   활성 예약 2개가 정확히 그 상태였다.
  //
  //   화이트리스트에 없는 값은 싣지 않는다. 거래소·전략이 보낸 임의
  //   문자열이 장부에 들어가면 경계가 사라진다.
  // ★ **왜 강제 진입도 안 했는지**도 같이 남긴다.
  //
  //   `scalp` 라우트는 신호가 없으면 09:00 KST 창을 한 번 더 보고, 안 되면
  //   그 이유를 응답에 값으로 싣는다. 그 자리의 주석이 이렇게 적는다:
  //
  //     "없으면 '신호가 없었다'와 '창 밖이었다'와 '이미 냈다'가
  //      구분되지 않는다." — src/app/api/autotrade/scalp/route.ts
  //
  //   그런데 여기서 그 값을 버리고 있었다. 그래서 운영 장부에 남는 줄은
  //   `진입 안 함: … 사유코드 VOLUME_BELOW_THRESHOLD` 뿐이었고, 09:00 창이
  //   열렸는데 안 들어간 것인지 창 밖이라 안 본 것인지 읽을 수 없었다
  //   (2026-11-13 #450 실측). 라우트가 적어 보낸 증거를 읽는 쪽이 버리는
  //   모양 — `CLAUDE.md` 의 "경로가 둘인데 한쪽만 고침"이다.
  //
  //   `reasonCode` 와 같은 규칙을 쓴다: 화이트리스트 밖 값은 싣지 않고,
  //   문장에만 묻지 않고 **칸으로도** 남긴다.
  const knownForcedCodes = [
    'BEFORE_WINDOW', 'AFTER_WINDOW', 'ALREADY_TODAY', 'HISTORY_UNKNOWN',
    'NOT_TESTNET', 'NOT_EXACT100X', 'CLOCK_UNREADABLE', 'SIZING_UNKNOWN',
  ];
  const fe = b?.forcedEntry;
  const forcedCode = typeof fe?.code === 'string' ? fe.code : '';
  const forcedKnown = knownForcedCodes.includes(forcedCode);
  const forcedNote = forcedKnown ? ` · 강제진입 ${forcedCode}` : '';

  return { outcome: 'NO_SIGNAL',
    summary: `정상 평가 완료 · 진입 조건 없음${diagnostic}${forcedNote}`,
    ...(known ? { reasonCode } : {}),
    ...(forcedKnown ? { forcedEntryCode: forcedCode } : {}) };
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
    // 없으면 칸을 만들지 않는다 — 'UNKNOWN'으로 메우지 않는다.
    ...(o.reasonCode ? { reasonCode: o.reasonCode } : {}),
    ...(o.forcedEntryCode ? { forcedEntryCode: o.forcedEntryCode } : {}),
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
