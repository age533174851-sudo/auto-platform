#!/usr/bin/env node
// scripts/autotrade-tick-verdict.mjs
//
// **200이 "돌았다"는 뜻이 아니다.**
//
// 무엇이 있었나
// ─────────────
// `autotrade-tick`은 15분마다 `/api/autotrade/daily-ladder`를 부르고
// **HTTP 코드만** 본다:
//
//     if [ "$code" != "200" ]; then exit 1; fi
//
// 그런데 그 라우트는 예약 표를 **못 읽어도 200을 돌려준다**:
//
//     return NextResponse.json({ ok: !readError, error: readError, ... })
//
// 즉 DB가 죽어 그날 자동매매가 한 번도 돌지 않아도 워크플로는 초록이다.
// 이 저장소가 반복해서 당한 모양 그대로다 — **없는 검사는 초록처럼
// 보이고**, 여기서는 **실패한 검사마저 초록처럼 보인다.**
//
// 무엇을 **실패로 보지 않는가** — 이게 중요하다
// ─────────────────────────────────────────────
// 대부분의 호출은 "아직 간격 안 됨"이나 "켜 놓은 예약 없음"으로 끝나고
// **그건 정상이다.** 그걸 빨갛게 만들면 매 15분마다 X가 떠서 아무도
// 안 보게 되고, 그러면 진짜 고장도 같이 묻힌다.
//
// 그래서 판정은 셋뿐이다:
//   · 본문을 **읽을 수 없으면** 실패 (못 읽은 것을 통과로 적지 않는다)
//   · 본문이 **스스로 실패라고 말하면**(`ok:false`) 실패
//   · 그 밖에는 성공 — 진입을 했든 안 했든
//
// 쓰는 법: node scripts/autotrade-tick-verdict.mjs <httpCode> <bodyFile>
//   종료 코드 0 = 정상(관망 포함) · 1 = 실패

/** 판정 코드 */
export const TICK_CODES = [
  'OK',                  // 정상 — 진입했거나 관망했다
  'HTTP_NOT_200',        // 전송 실패·서버 오류
  'BODY_UNREADABLE',     // 본문이 비었거나 JSON이 아니다
  'BODY_NOT_OBJECT',     // JSON이지만 객체가 아니다 (배열·문자열·null)
  'OK_FIELD_MISSING',    // 계약에 있어야 할 `ok`가 없다
  'APP_FAILED',          // 200인데 `ok:false` — DB 오류 등
  'RESULTS_UNREADABLE',  // 예약은 있는데 결과 목록을 읽을 수 없다
  'SCHEDULE_FAILED',     // 예약별 결과에 `ok:false`가 있다
];

/**
 * 이 호출을 성공으로 적어도 되는가.
 *
 * @param {number|string} httpCode
 * @param {string|null|undefined} rawBody 응답 본문 그대로
 */
export function tickVerdict(httpCode, rawBody) {
  const code = Number(httpCode);
  const no = (verdict, reason) => ({ ok: false, code: verdict, reason, body: null });

  if (!Number.isFinite(code) || code !== 200) {
    return no('HTTP_NOT_200',
      `자동매매 호출이 HTTP ${httpCode}로 끝났습니다 — 예약을 확인하지 못했습니다`);
  }

  const text = rawBody == null ? '' : String(rawBody).trim();
  if (!text) {
    return no('BODY_UNREADABLE',
      '응답 본문이 비어 있습니다 — 200이지만 무엇을 했는지 알 수 없습니다');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // 200인데 JSON이 아니면 대개 플랫폼 오류 페이지다. 읽지 못한 것을
    // "정상 관망"으로 적으면 그 장애가 영영 안 보인다.
    return no('BODY_UNREADABLE',
      `응답이 JSON이 아닙니다 (${String(e?.message || e).slice(0, 80)}) — `
      + `앞부분: ${text.slice(0, 120)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return no('BODY_NOT_OBJECT',
      `응답이 객체가 아닙니다 (${Array.isArray(parsed) ? '배열' : typeof parsed}) — 계약이 다릅니다`);
  }
  if (!('ok' in parsed)) {
    // `ok`가 없으면 성공인지 실패인지 **말한 적이 없는 것**이다.
    return no('OK_FIELD_MISSING',
      '응답에 `ok` 칸이 없습니다 — 성공 여부를 말하지 않는 응답을 성공으로 적지 않습니다');
  }
  if (parsed.ok !== true) {
    const why = String(parsed.error ?? parsed.note ?? '사유가 적혀 있지 않습니다');
    return no('APP_FAILED',
      `서버가 실패라고 답했습니다 (HTTP 200 · ok:${JSON.stringify(parsed.ok)}) — ${why.slice(0, 200)}`);
  }

  // ── 최상위 `ok:true`는 **예약 목록을 읽었다**는 뜻일 뿐이다 ──
  //
  // 개별 예약의 성패는 `results[].ok`에 따로 적힌다. 라우트에서
  // 그 값이 false가 되는 경우는 둘뿐이고, **둘 다 관망이 아니다**:
  //
  //   · `due.code === 'NO_CONNECTION'`  예약은 켜져 있는데 거래소 연결이 없다
  //   · `record.outcome === 'FAILED'`   평가가 실제로 실패했다
  //
  // 전자는 저절로 낫지 않는 설정 고장이고, 후자는 그냥 실패다. 최상위가
  // 초록이라는 이유로 넘기면 이 PR이 닫으려는 구멍이 한 겹 남는다.
  //
  // **관망은 그대로 성공이다** — `WAITING`·`TOO_SOON`·꺼짐·평가했지만
  // 진입하지 않음은 라우트가 `ok:true`로 적는다.
  const scheduled = Number(parsed.scheduled);
  const hasSchedules = Number.isFinite(scheduled) && scheduled > 0;

  if (!Array.isArray(parsed.results)) {
    // 예약이 없으면 목록이 없어도 된다. 있는데 못 읽는 것은 다른 얘기다.
    if (hasSchedules) {
      return no('RESULTS_UNREADABLE',
        `예약 ${scheduled}건인데 results를 읽을 수 없습니다 `
        + `(${parsed.results === undefined ? '없음' : typeof parsed.results}) — `
        + '무엇을 했는지 모르는 응답을 성공으로 적지 않습니다');
    }
    return {
      ok: true, code: 'OK', body: parsed,
      reason: `정상 — 예약 0건${parsed.note ? ` · ${String(parsed.note).slice(0, 160)}` : ''}`,
    };
  }

  const results = parsed.results;
  const executed = results.filter((r) => r && r.executed === true).length;
  const failures = results.filter((r) => r && r.ok === false);
  if (failures.length > 0) {
    const why = failures.slice(0, 5).map((r) => {
      const tag = r.symbol ? `${r.symbol} ` : '';
      return `${tag}${r.code ?? r.outcome ?? '사유 없음'}`;
    }).join(' · ');
    return no('SCHEDULE_FAILED',
      `예약 ${results.length}건 중 ${failures.length}건이 실패했습니다 — ${why}`
      + (failures.length > 5 ? ` 외 ${failures.length - 5}건` : ''));
  }

  return {
    ok: true, code: 'OK', body: parsed,
    reason: `정상 — 예약 ${Number.isFinite(scheduled) ? scheduled : results.length}건 · `
      + `진입 ${executed}건 · 예약별 실패 0건`
      + (parsed.note ? ` · ${String(parsed.note).slice(0, 160)}` : ''),
  };
}

// ── CLI ──
// import로 불릴 때는 돌지 않는다 (검사기가 같은 파일을 쓴다).
const invokedDirectly = process.argv[1]
  && process.argv[1].endsWith('autotrade-tick-verdict.mjs');
if (invokedDirectly) {
  const [, , httpCode, bodyPath] = process.argv;
  const { readFileSync, existsSync } = await import('node:fs');
  const body = bodyPath && existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '';
  const v = tickVerdict(httpCode, body);
  if (v.ok) {
    console.log(`✅ ${v.reason}`);
    process.exit(0);
  }
  console.error(`❌ [${v.code}] ${v.reason}`);
  console.log(`::error::자동매매 tick 실패 [${v.code}] ${v.reason}`);
  process.exit(1);
}
