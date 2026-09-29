// src/lib/engine/entryExitSafety.ts
//
// **안전하게 나갈 수 없는 계좌에는 들어가지 않는다.**
//
// 무엇을 막는가
// ─────────────
// #281이 종료 경로를 fail-closed로 만들었다 — 계좌가 양방향(헤지)이거나
// 포지션 모드를 못 읽으면 청산 주문을 **보내지 않는다.** 짐작해서 보내면
// 반대 방향 신규 진입이 될 수 있기 때문이다.
//
// 그런데 진입 쪽은 그대로였다. 그래서 이런 상태가 생긴다:
//
//     진입   된다
//     종료   안 된다 (HEDGE_UNVERIFIED / UNKNOWN)
//
// 열 수는 있는데 자동으로 닫을 수는 없는 포지션이다. 손절도 익절도
// 자동으로 나가지 않고, **사람이 거래소에 직접 들어가 닫아야 한다.**
// 100배 자리에서 그 비대칭은 사고다 — 진입 차단은 불편이고, 못 닫는
// 포지션은 사고다.
//
// 그래서 불변식 하나를 더 건다:
//
//     CAN_AUTO_ENTER  requires  CAN_AUTO_EXIT_SAFELY
//
// ★ 여기에 모드 해석이 없다
// ─────────────────────────
// 이 파일은 `HEDGE`인지 `ONE_WAY`인지 **판단하지 않는다.** 그 판단의
// 정본은 `futuresExec.closeModeVerdict`이고 `venuePositionOps.closeModeGate`
// 가 그것을 부른다. 여기서 모드를 다시 해석하면 진입과 종료가 **서로 다른
// 답**을 내는 두 번째 안전 판정이 생기고, 그게 정확히 이 PR이 없애려는
// 고장이다.
//
// 이 함수가 보는 것은 하나뿐이다:
//
//     정본 종료 판정이 "안전하다"고 했는가.
//
// 그래서 나중에 헤지 청산 규격이 확정돼 `closeModeVerdict`가 HEDGE를
// 통과시키게 되면, 이 파일은 **한 줄도 고치지 않아도** 같이 통과한다.

/**
 * 정본 종료 판정이 남긴 증거. `closeModeGate`의 반환값 모양 그대로다.
 *
 * 형태를 좁게 베껴 두는 이유: 이 정책이 종료 판정의 **결론만** 보고
 * 원인(모드·거래소)은 보지 않는다는 것을 타입으로 못 박는다.
 */
export interface AutoExitEvidence {
  /** 청산 주문을 보내도 되는가 */
  ok: boolean;
  /** `ONE_WAY` · `HEDGE_UNVERIFIED` · `UNKNOWN` · `NO_DIRECTION` */
  code: string;
  /** 이미 열린 포지션이 있다면 자동으로 닫지 못한다는 뜻인가 */
  strandsOpenPosition: boolean;
  message: string;
}

export interface EntryExitSafetyVerdict {
  allowed: boolean;
  code: 'AUTO_EXIT_SAFE' | 'AUTO_EXIT_UNSAFE';
  /** 왜 진입하지 않는지. 통과면 빈 글자 */
  reason: string;
  /** 판정의 근거를 그대로 들고 간다 — 응답에서 사유가 사라지지 않게 */
  evidence: { code: string; strandsOpenPosition: boolean; message: string };
}

const NO_EVIDENCE = '자동 청산 가능 여부를 확인하지 못했습니다';

/**
 * 이 계좌에서 새 포지션을 열어도 되는가.
 *
 * 통과 조건은 **둘 다** 만족해야 한다:
 *
 *     evidence.ok === true                  종료 요청을 보낼 수 있다
 *     evidence.strandsOpenPosition === false 열린 포지션이 갇히지 않는다
 *
 * ★ 왜 `ok` 하나로 충분하지 않은가
 * ────────────────────────────────
 * 지금은 두 값이 정확히 반대로 움직인다 — `ok`가 참이면 `strandsOpenPosition`
 * 은 늘 거짓이다. 그래서 `ok`만 봐도 오늘은 같은 답이 나온다.
 *
 * 그런데 그 둘은 **다른 질문**이다. `ok`는 "지금 청산 요청을 보낼 수 있나",
 * `strandsOpenPosition`은 "이미 연 것이 갇히나"다. 종료 규격이 늘어나면
 * (부분 청산·조건부 종료) 한쪽만 참인 조합이 생길 수 있고, 그때 `ok`만 보던
 * 코드는 **갇히는 포지션을 여는 쪽으로** 조용히 기운다.
 *
 * 둘 다 요구하면 그 조합이 생기는 순간 진입이 막힌다. 막히는 쪽이 안전한
 * 실패다 — 못 여는 것은 불편이고, 못 닫는 것은 사고다.
 */
export function entryExitSafetyVerdict(
  evidence: AutoExitEvidence | null | undefined,
): EntryExitSafetyVerdict {
  // **증거가 없는 것을 통과로 읽지 않는다.** 판정을 못 받은 것과 판정이
  // 통과인 것은 다르다 — 확인하지 못한 것은 통과가 아니다.
  const code = typeof evidence?.code === 'string' && evidence.code ? evidence.code : 'UNKNOWN';
  const message = typeof evidence?.message === 'string' && evidence.message
    ? evidence.message : NO_EVIDENCE;

  const canSend = evidence?.ok === true;
  // `false`가 아니면 전부 "갇힌다"로 읽는다. undefined를 "안 갇힌다"로
  // 읽으면 증거가 빠진 판이 통과한다.
  const strands = evidence?.strandsOpenPosition !== false;

  const ev = { code, strandsOpenPosition: strands, message };

  if (canSend && !strands) {
    return { allowed: true, code: 'AUTO_EXIT_SAFE', reason: '', evidence: ev };
  }

  // 두 값이 어긋나는 경우를 **따로 적는다.** "청산은 보낼 수 있는데 열린
  // 포지션은 갇힌다"는 오늘의 정본에서는 나오지 않는 조합이다. 나왔다면
  // 종료 규격이 바뀐 것이고, 그 변화를 못 본 채 진입하지 않는다.
  const why = !canSend
    ? message
    : '종료 판정이 통과라고 했는데 열린 포지션은 자동으로 닫지 못한다고 함께 적었습니다'
      + ` — 두 말이 어긋나면 진입하지 않습니다 (${message})`;

  return {
    allowed: false,
    code: 'AUTO_EXIT_UNSAFE',
    reason: '이 계좌에서는 연 포지션을 자동으로 닫지 못해 신규 진입을 하지 않습니다'
      + ` — ${why}`,
    evidence: ev,
  };
}
