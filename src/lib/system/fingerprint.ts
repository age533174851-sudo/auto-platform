// src/lib/system/fingerprint.ts
//
// **값을 보여주지 않고 "같은 값인가"만 묻는다.**
//
// 왜 필요한가
// ───────────
// 2026-08-19에 이런 상태가 됐다:
//
//   · 워커는 살아 있다      (build=5a45fa2 · tick 계속 증가)
//   · 실패 로그가 없다      (#144가 실패를 찍게 돼 있는데도)
//   · worker_heartbeat의 최신 줄은 8/16이다
//
// 셋이 동시에 참이려면 **쓰기는 성공하는데 우리가 보는 곳이 아닌 데
// 쓰고 있어야** 한다. 그걸 확인하려면 워커와 웹이 같은 Supabase를 보고
// 있는지 비교해야 하는데, URL을 로그에 찍는 것은 이 저장소 규칙이
// 금지한다(값은 어디에도 안 남긴다).
//
// 그래서 지문만 비교한다. SHA-256 앞 6자리는 값을 되찾을 수 없고,
// 같은지 다른지는 확실히 말해 준다. 워커가 부팅 로그에 이미 쓰고 있는
// **암호화 키 지문**과 같은 방식이다 — 이 저장소의 기존 관행이다.

import { createHash } from 'crypto';

/**
 * 이 값의 지문 6자리. **비어 있으면 null이지 빈 지문이 아니다.**
 *
 * null과 지문을 같은 칸에 넣으면 "설정 안 됨"과 "설정됐는데 다름"이
 * 구분되지 않는다 — 그 둘은 완전히 다른 고장이다.
 */
export function fingerprintOf(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return createHash('sha256').update(s).digest('hex').slice(0, 6);
}

/** 두 지문을 비교한다. **하나라도 없으면 '같다'가 아니라 '모른다'다** */
export function fingerprintMatch(
  a: string | null | undefined, b: string | null | undefined,
): { code: 'SAME' | 'DIFFERENT' | 'UNKNOWN'; reason: string } {
  if (!a || !b) {
    return { code: 'UNKNOWN',
      reason: `지문이 없어 비교하지 못했습니다 (${!a ? '한쪽' : '다른 쪽'}이 설정되지 않았습니다)` };
  }
  return a === b
    ? { code: 'SAME', reason: `같은 값입니다 (지문 ${a})` }
    : { code: 'DIFFERENT', reason: `다른 값입니다 (${a} ≠ ${b}) — 서로 다른 곳을 보고 있습니다` };
}
