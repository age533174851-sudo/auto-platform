// src/lib/autotrade/runOutcome.ts
//
// **HTTP 200은 "주문이 나갔다"는 뜻이 아니다.**
//
// 무엇이 문제였나
// ───────────────
// 화면은 응답이 오면 `j.ok`만 보고 초록/빨강을 정했다. 그런데 이 엔진의
// 대부분의 응답은 `ok: true, executed: false`다 — 조건이 안 맞아 관망한
// 것이고, 그건 정상이지 성공이 아니다.
//
// 그 둘을 같은 초록으로 적으면 사용자는 포지션이 생긴 줄 안다. 반대로
// 체크리스트에 막힌 것을 그냥 '실패'로 적으면, **무엇이 막았는지**가
// 사라져서 고칠 수가 없다.
//
// 그래서 상태를 아홉으로 나눈다. 판정은 여기 한 곳에서만 한다 — 화면
// 안에 적으면 화면마다 다르게 읽고, 실제로 그래서 "실행 성공"과
// "실거래 잠김"이 같은 순간에 같이 떠 있었다.

export type RunOutcome =
  /** 예약만 저장됨 — 아직 아무것도 안 돌았다 */
  | 'SAVED_ONLY'
  /** 첫 점검 실행 중 */
  | 'RUNNING'
  /** 조건 불충족으로 관망 — 정상이다 */
  | 'WAITING'
  /** 안전 점검에서 차단 */
  | 'BLOCKED_CHECKLIST'
  /** 미확정 주문 때문에 차단 */
  | 'BLOCKED_UNRESOLVED'
  /** 앱과 거래소 상태 불일치로 차단 */
  | 'BLOCKED_STATE_MISMATCH'
  /** 이미 오늘 진입함 */
  | 'ALREADY_TODAY'
  /** 다른 실행이 이미 처리 중 */
  | 'IN_PROGRESS'
  /** 주문 전송됨 (결과는 아직) */
  | 'ORDER_SENT'
  /** 주문 결과 미확정 — 나갔는지 모른다 */
  | 'ORDER_UNKNOWN'
  /** 주문 체결 확인됨 */
  | 'ORDER_FILLED'
  /** 그 밖의 실패 */
  | 'ERROR';

export type OutcomeTone = 'good' | 'info' | 'warn' | 'bad';

export interface OutcomeVerdict {
  outcome: RunOutcome;
  tone: OutcomeTone;
  /** 큰 글씨 한 줄 */
  label: string;
  /** 작은 글씨 설명 */
  detail: string;
  /** 이 결과가 '주문이 나간 상태'인가 */
  ordered: boolean;
  /** 사용자가 지금 할 수 있는 일 */
  action?: string;
}

/**
 * **오류가 아니라 "다른 실행이 먼저 했다"인 코드들.**
 *
 * 켜는 순간 즉시 실행과 서버 실행기가 겹칠 수 있다. 그때 두 번째가
 * 받는 답은 실패가 아니다 — 중복 주문을 막는 장치가 제대로 일한 것이다.
 * 이걸 빨간 실패로 적으면, 사용자는 정상 동작을 고장으로 읽고 다시
 * 누른다.
 */
export const CONCURRENT_CODES = ['ALREADY_RUNNING', 'ALREADY_RESERVED', 'ALREADY_TRADED'];

const str = (v: any) => String(v ?? '').trim();
const upper = (v: any) => str(v).toUpperCase();

/** 응답 어디에 있든 차단 코드를 찾는다 */
export function blockCodeOf(body: any): string {
  const direct = upper(body?.blocked) || upper(body?.rejectCode) || upper(body?.code);
  if (direct) return direct;
  // 크론 응답은 results[] 안에 담긴다.
  const rs = Array.isArray(body?.results) ? body.results : [];
  for (const r of rs) {
    const c = upper(r?.blocked) || upper(r?.code);
    if (c) return c;
  }
  return '';
}

function textOf(body: any): string {
  return str(body?.message) || str(body?.error) || str(body?.reason) || str(body?.note);
}

/**
 * 실행 응답 하나를 상태로 옮긴다.
 *
 * **`status`(HTTP)를 마지막에 본다.** 409로 오는 것 중에는 정상 동작이
 * 있고(중복 방지), 200으로 오는 것 중에는 아무 일도 안 한 것이 있다.
 * 코드가 몸통보다 덜 정확하다.
 */
export function classifyRun(res: { status?: number; body?: any } | null | undefined): OutcomeVerdict {
  const status = Number(res?.status);
  const body = res?.body ?? null;
  const text = textOf(body);
  const code = blockCodeOf(body);

  if (!body) {
    return {
      outcome: 'ERROR', tone: 'bad', ordered: false,
      label: '응답을 받지 못했습니다',
      detail: '실행 결과를 알 수 없습니다 — 예약 자체는 저장되었을 수 있습니다',
      action: '아래 실행 기록을 확인하세요',
    };
  }

  // ── 중복 방지가 일한 것 ──
  if (CONCURRENT_CODES.includes(code)) {
    const already = code === 'ALREADY_TRADED';
    return {
      outcome: already ? 'ALREADY_TODAY' : 'IN_PROGRESS',
      tone: 'info', ordered: false,
      label: already ? '오늘은 이미 진입했습니다' : '다른 실행이 이미 처리 중입니다',
      detail: already
        ? '이 전략은 하루 최대 1회입니다 — 내일 다시 확인합니다'
        : '서버 실행기가 같은 예약을 동시에 잡았습니다. 주문은 한 건만 나갑니다',
    };
  }

  // ── 주문이 나갔는가 ──
  //
  // executed는 "엔진이 주문을 보냈다"는 뜻이다. 그 결과가 무엇인지는
  // status가 따로 말한다. 셋을 하나로 뭉치면 '나갔는지 모르는' 상태가
  // 체결로 읽힌다 — 그게 제일 위험하다.
  if (body?.executed === true) {
    const os = upper(body?.status) || upper(body?.order?.status);
    if (os === 'UNKNOWN') {
      return {
        outcome: 'ORDER_UNKNOWN', tone: 'warn', ordered: true,
        label: '주문 결과 미확정',
        detail: '주문을 보냈지만 거래소 응답을 받지 못했습니다 — 체결됐을 수 있습니다',
        action: '[미확정 주문 확정]을 눌러 거래소와 대조하세요. 그 전에는 다시 진입하지 않습니다',
      };
    }
    if (os === 'FILLED') {
      return {
        outcome: 'ORDER_FILLED', tone: 'good', ordered: true,
        label: '주문 체결 확인됨',
        detail: text || '거래소가 체결을 확인했습니다',
      };
    }
    return {
      outcome: 'ORDER_SENT', tone: 'good', ordered: true,
      label: '주문 전송됨',
      detail: text || `거래소가 접수했습니다${os ? ` (${os})` : ''} — 체결은 별도로 확인됩니다`,
    };
  }

  // ── 차단 ──
  if (code === 'STATE_MISMATCH') {
    const n = Array.isArray(body?.mismatches) ? body.mismatches.length : null;
    return {
      outcome: 'BLOCKED_STATE_MISMATCH', tone: 'bad', ordered: false,
      label: '앱과 거래소 상태가 어긋나 차단되었습니다',
      detail: n != null ? `어긋난 곳 ${n}건 — 아래에 무엇이 다른지 적혀 있습니다` : (text || '상태 불일치'),
      action: '[미확정 주문 확정]으로 대부분 풀립니다. 그래도 남으면 거래소에서 직접 정리하세요',
    };
  }

  if (code === 'CHECKLIST_BLOCKED' || body?.checklist?.allowed === false) {
    const unresolved = Number(body?.checklist?.unresolvedOrderCount);
    const blockers: any[] = Array.isArray(body?.checklist?.blockers) ? body.checklist.blockers : [];
    const byUnresolved = Number.isFinite(unresolved) && unresolved > 0
      || blockers.some(b => upper(b?.id) === 'UNRESOLVED_ORDERS');
    if (byUnresolved) {
      return {
        outcome: 'BLOCKED_UNRESOLVED', tone: 'bad', ordered: false,
        label: '결과를 모르는 주문 때문에 차단되었습니다',
        detail: Number.isFinite(unresolved) && unresolved > 0
          ? `미확정 ${unresolved}건 — 실제로 체결됐다면 또 들어가서 포지션이 두 배가 됩니다`
          : '나갔는지 모르는 주문 위에 또 얹으면 두 배로 들어갑니다',
        action: '[미확정 주문 확정]을 눌러 거래소와 대조하세요',
      };
    }
    return {
      outcome: 'BLOCKED_CHECKLIST', tone: 'bad', ordered: false,
      label: '안전 점검에서 차단되었습니다',
      detail: str(body?.error) || str(body?.checklist?.summary) || '아래 막힌 항목을 보세요',
      action: '막힌 항목을 고친 뒤 [지금 점검하기]로 다시 확인하세요',
    };
  }

  // ── 조건 불충족 ──
  //
  // 대부분의 점검이 여기로 온다. **이건 실패가 아니다.**
  if (body?.ok !== false && body?.executed === false) {
    return {
      outcome: 'WAITING', tone: 'info', ordered: false,
      label: '조건 불충족 — 관망',
      detail: text || '진입 신호가 없습니다. 다음 확인 때 다시 봅니다',
    };
  }

  // 크론 모양(results[]) — 진입한 것이 하나라도 있는가
  if (Array.isArray(body?.results)) {
    const rs = body.results;
    if (rs.some((r: any) => r?.executed === true)) {
      return {
        outcome: 'ORDER_SENT', tone: 'good', ordered: true,
        label: '주문 전송됨',
        detail: text || `${rs.filter((r: any) => r?.executed).length}건 진입했습니다`,
      };
    }
    if (rs.length > 0 && rs.every((r: any) => r?.skipped)) {
      return {
        outcome: 'WAITING', tone: 'info', ordered: false,
        label: '아직 간격이 안 됐습니다',
        detail: str(rs[0]?.detail) || text || '다음 확인 때 다시 봅니다',
      };
    }
  }

  if (body?.ok === false || (Number.isFinite(status) && status >= 400)) {
    return {
      outcome: 'ERROR', tone: 'bad', ordered: false,
      label: '실행에 실패했습니다',
      detail: text || `서버가 ${status || '오류'}를 돌려줬습니다`,
    };
  }

  return {
    outcome: 'SAVED_ONLY', tone: 'info', ordered: false,
    label: '예약만 저장되었습니다',
    detail: text || '아직 점검이 돌지 않았습니다',
  };
}

/**
 * 예약 저장은 됐는데 첫 실행이 막혔을 때의 문구.
 *
 * **예약이 켜졌다는 사실을 숨기지 않는다.** 첫 실행이 막혔다고 "실패"만
 * 적으면 사용자는 자동매매가 안 켜진 줄 알고 다시 누르고, 그러면 같은
 * 자리에서 또 막힌다.
 */
export function savedButBlockedText(v: OutcomeVerdict): string {
  if (v.ordered || v.outcome === 'WAITING' || v.outcome === 'ALREADY_TODAY' || v.outcome === 'IN_PROGRESS') {
    return '';
  }
  if (v.tone !== 'bad') return '';
  return '자동매매는 켜졌지만 첫 실행이 안전 점검에서 차단되었습니다 — 예약은 그대로 살아 있고, 막힌 항목을 고치면 다음 확인 때 진입합니다';
}

// ── 첫 평가를 두 번 돌리지 않는다 ─────────────────────────
//
// **자동매매를 켜면 실평가 경로가 둘이었다.**
//
//   [켜기] → POST /api/autotrade/schedule
//              ├ 예약 저장
//              └ 서버가 evaluateIfDue() 실행        ← 첫 번째
//          → 응답(firstEvaluation 포함)
//          → AutotradeControl.save()
//              └ runFirstCheck() → 전략 API POST     ← 두 번째
//
// 두 번째는 `checkOnly`가 아니다. **진짜 실행 요청**이다.
//
// 지금은 아래쪽 중복 방어가 받아 준다 — `last_run_at` compare-and-set,
// scalp의 봉 단위 키, 원본 v1의 거래일 기준 결정적 clientOrderId.
// 그래서 "주문이 무조건 두 번 나간다"고는 말할 수 없다.
//
// **그렇다고 둘을 유지할 이유는 없다.** 실평가 경로 둘을 아래쪽 방어에
// 기대어 두는 것은, 그 방어 중 하나라도 약해지는 날 주문이 두 번 나간다는
// 뜻이다. 그리고 그 날은 코드를 고치는 사람이 이 구조를 모를 때 온다.
//
// 서버는 이미 첫 평가 결과를 응답에 담아 준다. 화면은 그걸 그리면 된다.

/** `/api/autotrade/schedule` 응답의 `firstEvaluation` */
export interface FirstEvaluation {
  ran?: boolean;
  outcome?: string | null;
  summary?: string | null;
  executed?: boolean | null;
  strategyId?: string | null;
  code?: string | null;
  note?: string | null;
  saveError?: string | null;
}

/**
 * 서버가 돌린 첫 평가를 화면이 쓰는 판정으로.
 *
 * **못 돌린 것과 조건이 안 맞은 것을 섞지 않는다.** 앞은 "아직 모른다"
 * 이고 뒤는 "정상인데 지금은 아니다"다. 둘을 같은 문장으로 적으면
 * 사용자는 켜졌는지 아닌지를 알 수 없다.
 */
export function firstEvaluationVerdict(
  fe: FirstEvaluation | null | undefined,
): OutcomeVerdict {
  if (!fe) {
    return {
      outcome: 'SAVED_ONLY', tone: 'info', ordered: false,
      label: '예약이 저장됐습니다',
      detail: '첫 평가 결과가 응답에 없습니다 — 실행기가 주기적으로 확인합니다',
    };
  }

  if (fe.ran !== true) {
    // 못 돌린 이유가 있으면 그대로 적는다. 지어내지 않는다.
    return {
      outcome: 'SAVED_ONLY', tone: 'info', ordered: false,
      label: '예약이 저장됐습니다 — 아직 평가하지 않았습니다',
      detail: String(fe.note ?? fe.code ?? '첫 평가를 돌리지 않았습니다')
        + ' · 실행기가 주기적으로 확인합니다',
    };
  }

  const outcome = String(fe.outcome ?? '').toUpperCase();
  const summary = String(fe.summary ?? '').trim();
  // 저장에 실패했으면 그 사실을 덧붙인다 — 평가는 돌았는데 기록이
  // 없으면 나중에 "왜 아무 기록이 없지"의 답이 어디에도 없다.
  const saveNote = fe.saveError ? ` (실행 기록을 남기지 못했습니다: ${fe.saveError})` : '';

  if (outcome === 'ENTERED') {
    return {
      // **주문이 나갔다는 것과 체결됐다는 것은 다르다.**
      outcome: 'ORDER_SENT', tone: 'good', ordered: true,
      label: '첫 주문이 나갔습니다',
      detail: (summary || '진입 조건이 맞아 주문을 보냈습니다') + saveNote,
      action: '체결과 보호주문은 아래 실행 기록에서 확인하세요',
    };
  }
  if (outcome === 'NO_SIGNAL') {
    return {
      outcome: 'WAITING', tone: 'info', ordered: false,
      label: '조건이 맞지 않아 관망합니다',
      // **이건 실패가 아니다.** 실패로 읽히면 사용자가 설정을 헤집는다.
      detail: (summary || '지금은 진입 조건이 아닙니다') + ' — 정상입니다' + saveNote,
    };
  }
  if (outcome === 'BLOCKED') {
    return {
      outcome: 'BLOCKED_CHECKLIST', tone: 'warn', ordered: false,
      label: '안전 점검이 막았습니다',
      detail: (summary || '점검 항목 중 하나가 통과하지 못했습니다') + saveNote,
      action: '아래 실행 기록에서 어느 항목인지 확인하세요',
    };
  }
  if (outcome === 'FAILED') {
    return {
      outcome: 'ERROR', tone: 'bad', ordered: false,
      label: '첫 평가가 실패했습니다',
      detail: (summary || '이유를 확인하지 못했습니다') + saveNote,
      action: '예약은 저장됐습니다 — 실행기가 다음 주기에 다시 시도합니다',
    };
  }

  // **모르는 결과를 성공으로 적지 않는다.**
  return {
    outcome: 'ERROR', tone: 'warn', ordered: false,
    label: '첫 평가 결과를 해석하지 못했습니다',
    detail: `알 수 없는 결과(${outcome || '없음'})입니다${summary ? ` — ${summary}` : ''}`
      + saveNote + ' · 정상이라는 뜻이 아닙니다',
    action: '아래 실행 기록을 확인하세요',
  };
}
