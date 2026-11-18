// src/lib/ui/dueDiagView.ts
//
// **예약 줄에 "왜 지금 안 도는가"를 적는다.**
//
// 무엇이 문제였나
// ───────────────
// 화면은 `runtimeStateOf`의 상태(`WATCHING` = 감시 중)를 보여주는데,
// 실행기의 틱은 `dueCheck`의 `WAITING`에서 돌아선다. 2026-11-02~05
// `autotrade-tick` 12회차가 전부 `code:"WAITING"`이었고 그 사실은
// 워크플로 로그에만 있었다 — 화면만 보는 사람에게는 정상으로 보인다.
//
// 서버가 `dueDiag`(=`dueDiagnostics`)로 내려보내기 시작했으니, 그걸
// 사람이 읽는 문자열로 바꾼다.
//
// 왜 JSX 가 아니라 함수인가
// ─────────────────────────
// 표시 규칙도 판단이다. JSX 안에 삼항으로 흩어 두면 시험할 수 없고,
// 시험할 수 없으면 "못 읽은 값을 0으로 적는" 고장이 조용히 들어온다.
// 이 저장소에서 가장 비싸게 난 고장이 그것이다.
//
// 두 가지를 못 박는다
// ───────────────────
//   · **설정값과 실제 적용값을 따로 적는다.** `interval_min`이 비어 있거나
//     0이면 `DEFAULT_INTERVAL_MIN`(1440 = 하루)이 쓰인다. 그 사실이 안
//     보이면 "60분으로 해 뒀는데 왜 안 도나"가 영원히 안 풀린다
//   · **값이 없으면 '확인 불가'다.** `fmtKst`는 null에 '—'를 주는데,
//     '—'는 "없음"으로도 "0"으로도 읽힌다. 모르는 것은 모른다고 적는다
//
// 시각은 KST로 적는다 — 포맷은 `nextRun.fmtKst` 하나를 쓴다. 여기서 다시
// 쓰면 같은 시각이 화면 두 곳에서 다르게 보인다.

import { fmtKst } from '../autotrade/nextRun';

/** 못 읽은 값에 쓰는 한 문구. 추측하지 않는다 */
export const UNKNOWN_TEXT = '확인 불가';

/**
 * `autotrade_schedules.interval_min`의 **DB 기본값**(035 마이그레이션).
 *
 * `nextRun.DEFAULT_INTERVAL_MIN`과 같은 수이지만 **다른 사실**이다 —
 * 저쪽은 "값을 못 읽었을 때 코드가 쓰는 값", 이쪽은 "표가 비어 있을 때
 * DB가 채워 넣는 값"이다. 둘이 갈라질 수 있으므로 여기서 따로 적고,
 * 시험이 둘이 같은지 본다.
 */
export const DB_DEFAULT_INTERVAL_MIN = 1440;

export interface DueDiagView {
  /** "설정 60분" · "설정 없음 → 기본값 1440분 적용" */
  intervalText: string;
  /** 기본값이 끼어들었는가. 화면이 경고색을 쓸 근거 */
  intervalDefaulted: boolean;
  /**
   * 적용 간격이 **기본값과 같은가**(1440 = 하루 1회).
   *
   * `intervalDefaulted`와 다른 것을 말한다. 그쪽은 "표에 값이 없거나
   * 쓸 수 없어서 기본값이 끼어들었다"인데, `interval_min`은
   * `NOT NULL DEFAULT 1440`이고 `CHECK (interval_min >= 1)`이라
   * **운영에서는 null도 0도 될 수 없다.** 즉 그 경고는 실제 줄에서
   * 한 번도 뜨지 않는다 — 아무도 설정하지 않은 예약이 "설정 1440분"으로,
   * 일부러 하루 1회를 고른 것과 똑같이 보인다.
   *
   * 값만으로 "사용자가 골랐는가"는 알 수 없다. 그래서 **추측하지 않고**
   * 아는 것만 적는다: 지금 적용되는 간격이 DB 기본값과 같다는 사실.
   * 60분으로 해 뒀다고 믿는 사람이 이 줄을 보면 바로 알아챈다.
   */
  intervalIsDbDefault: boolean;
  /** 마지막 평가 (KST) 또는 '확인 불가' */
  lastText: string;
  /** 다음 평가 예정 (KST) 또는 '확인 불가' */
  nextText: string;
  /** 판정 이유 — **서버 문구 그대로**. 화면이 다시 쓰지 않는다 */
  reasonText: string;
  /** 판정 코드. 색·배지에만 쓴다 */
  code: string;
}

/**
 * 숫자로 읽는다. **null·undefined·빈 문자열은 null이다.**
 *
 * `Number(null)`은 0이다. 그걸 그대로 쓰면 "안 적혀 있음"이 "0분으로
 * 적혀 있음"이 되고, 마지막 평가 시각 null은 **1970-01-01 09:00 KST**로
 * 표시된다. 둘 다 모르는 것을 아는 것으로 바꾼다 — 이 파일이 막으려는
 * 바로 그 고장이다(제 첫 구현이 실제로 이렇게 틀렸고 테스트가 잡았다).
 */
const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** KST 표기. **못 읽으면 '확인 불가'** — '—'로 적지 않는다 */
function kstOrUnknown(ms: any): string {
  const n = num(ms);
  if (n == null) return UNKNOWN_TEXT;
  const s = fmtKst(n);
  // fmtKst가 포맷에 실패하면 '—'를 준다. 그건 '모름'이지 '없음'이 아니다
  if (!s || s === '—') return UNKNOWN_TEXT;
  return `${s} KST`;
}

export function dueDiagView(diag: any): DueDiagView {
  // 진단 자체가 없으면 네 칸 모두 모른다. **경고도 아니다** — 경고는
  // '기본값이 끼어들었다'를 아는 경우에만 쓴다
  if (diag == null || typeof diag !== 'object') {
    return {
      intervalText: UNKNOWN_TEXT, intervalDefaulted: false,
      // 모르는 것을 '기본값과 같다'로 적지 않는다
      intervalIsDbDefault: false,
      lastText: UNKNOWN_TEXT, nextText: UNKNOWN_TEXT,
      reasonText: UNKNOWN_TEXT, code: '',
    };
  }

  const used = num(diag.intervalMin);
  const raw = num(diag.intervalMinRaw);
  const defaulted = diag.intervalMinDefaulted === true;

  let intervalText: string;
  if (used == null) {
    intervalText = UNKNOWN_TEXT;
  } else if (!defaulted) {
    // **기본값과 같으면 그 사실을 적는다.** `interval_min`은 NOT NULL
    // DEFAULT 1440이라 아무도 설정하지 않은 줄도 여기로 온다 — 그냥
    // "설정 1440분"이라고만 적으면 고른 것과 구분되지 않는다.
    intervalText = used === DB_DEFAULT_INTERVAL_MIN
      ? `설정 ${used}분(하루 1회) — DB 기본값과 같습니다`
      : `설정 ${used}분`;
  } else if (raw == null) {
    // 표에 아무것도 안 적혀 있다
    intervalText = `설정 없음 → 기본값 ${used}분 적용`;
  } else {
    // 적혀 있지만 쓸 수 없는 값이다(0 이하). **적힌 값도 보여준다** —
    // 안 보여주면 사용자는 자기가 뭘 넣었는지 모른 채 고치게 된다
    intervalText = `설정 ${raw}분(쓸 수 없음) → 기본값 ${used}분 적용`;
  }

  const reasonRaw = typeof diag?.due?.reason === 'string' ? diag.due.reason.trim() : '';

  return {
    intervalText,
    intervalDefaulted: used == null ? false : defaulted,
    intervalIsDbDefault: used === DB_DEFAULT_INTERVAL_MIN,
    lastText: kstOrUnknown(diag.lastEvaluationAtMs),
    nextText: kstOrUnknown(diag.nextEvaluationAtMs),
    // 코드만으로 문장을 지어내지 않는다 — 비어 있으면 모르는 것이다
    reasonText: reasonRaw || UNKNOWN_TEXT,
    code: typeof diag?.due?.code === 'string' ? diag.due.code : '',
  };
}
