// src/lib/exchanges/losslessJson.ts
//
// **주문 번호는 계산 대상이 아니다. 숫자로 읽는 순간 망가진다.**
//
// 2026-08-16에 실제로 난 일
// ─────────────────────────
// Gate TESTNET 스모크가 만든 ETHUSDT 조건부 주문 2건이 포지션 0인 뒤에도
// 남았다. DB에 적힌 번호는 이랬다:
//
//   2089209928026685400
//   2089209928399978500
//
// **끝이 `400` · `500`으로 뭉개져 있다.** 이게 지문이다.
// JavaScript의 `Number`가 정확히 담을 수 있는 최대 정수는
// `Number.MAX_SAFE_INTEGER = 9007199254740991`(약 9.0×10¹⁵)이고,
// 위 번호는 약 2.09×10¹⁸ — **300배 넘게 벗어난다.** 그래서
// `JSON.parse`가 만든 순간 마지막 자릿수가 반올림됐다.
//
// 그 뒤는 전부 일관되게 틀렸다:
//
//   Gate 목록 조회 → int64가 반올림된 Number가 됨
//   → 그 값을 DB에 저장
//   → 소유 판정은 **같은 틀린 값끼리** 비교하니 "내 주문 맞음"
//   → 취소는 틀린 번호로 나감
//   → Gate 400 "No order found with the given ID"
//   → 원래 주문은 그대로 남음
//
// 화면에 `STILL_PRESENT` + `400 ORDER_NOT_FOUND`가 같이 뜬 이유가 이것이다.
// 취소 로직이 틀린 게 아니라 **취소할 번호가 이미 깨져 있었다.**
//
// 그래서 규칙
// ───────────
// **외부 식별자는 처음 받은 순간부터 끝까지 십진 문자열이다.**
// `JSON.parse` 뒤에 `String(obj.id)`로 바꾸는 것은 복구가 아니다 —
// 그때는 이미 자릿수가 사라졌다. 그러니 **파싱 시점에** 잡아야 한다.
//
// 무엇을 문자열로 바꾸나
// ──────────────────────
// **안전 범위를 벗어난 정수만.** 가격·수량·수수료는 그대로 숫자로 둔다 —
// 그것들은 계산 대상이고, 안전 범위를 넘을 일도 없다. 소수점이나 지수가
// 있는 값도 건드리지 않는다.
//
// 왜 정규식으로 안 하나
// ─────────────────────
// JSON 문자열 안에 숫자가 들어 있을 수 있다(`"text":"t-mo1-2089209928"`).
// 통째로 훑는 정규식은 그것까지 바꾼다. 그래서 **문자열 안과 밖을 구분해
// 훑는다.** 이스케이프(`\"`)도 같이 본다.

/** 이 정수는 Number로 담으면 값이 바뀌는가 */
export function isUnsafeIntegerLiteral(token: string): boolean {
  if (!/^-?\d+$/.test(token)) return false;
  const digits = token.replace(/^-/, '');
  // 15자리 이하는 언제나 안전하다(최대 안전 정수는 16자리).
  if (digits.length <= 15) return false;
  // 16자리 이상은 실제로 왕복이 되는지 본다 — 값으로 확인한다.
  return String(Number(token)) !== token;
}

/**
 * **큰 정수를 잃지 않고 JSON을 읽는다.**
 *
 * 안전 범위를 벗어난 정수 리터럴만 십진 문자열로 바꾼 뒤 `JSON.parse`한다.
 * 그 외의 값은 그대로다 — 가격·수량은 계속 숫자다.
 *
 * 파싱에 실패하면 **원래 `JSON.parse`와 같은 예외를 던진다.** 조용히
 * 빈 객체를 돌려주면 "응답이 비었다"와 "못 읽었다"가 섞인다.
 */
export function parseLossless<T = any>(text: string): T {
  return JSON.parse(quoteUnsafeIntegers(text)) as T;
}

/**
 * JSON 본문에서 **문자열 밖에 있는** 큰 정수 리터럴만 따옴표로 감싼다.
 *
 * 문자열 안(`"..."`)은 건드리지 않는다 — 식별자 text에 숫자가 들어 있고,
 * 그걸 바꾸면 소유권 파싱이 깨진다.
 */
export function quoteUnsafeIntegers(text: string): string {
  const s = String(text ?? '');
  let out = '';
  let i = 0;
  let inString = false;

  while (i < s.length) {
    const ch = s[i];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        // 이스케이프는 다음 글자까지 통째로 넘긴다. 안 그러면 `\"`를
        // 문자열 끝으로 착각한다.
        if (i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
        i++; continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') { inString = true; out += ch; i++; continue; }

    // 숫자 토큰의 시작인가. `-`는 값의 시작에서만 부호다.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (s[j] === '-') j++;
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
      const intPart = s.slice(i, j);
      // 소수점·지수가 붙어 있으면 정수가 아니다 — 가격이다. 건드리지 않는다.
      const next = s[j];
      const isPlainInteger = next !== '.' && next !== 'e' && next !== 'E';

      if (isPlainInteger && isUnsafeIntegerLiteral(intPart)) {
        out += `"${intPart}"`;
      } else {
        // 숫자 토큰 전체(소수·지수 포함)를 그대로 옮긴다.
        let k = j;
        while (k < s.length && /[0-9.eE+\-]/.test(s[k])) k++;
        out += s.slice(i, k);
        i = k;
        continue;
      }
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * 외부 식별자를 **문자열로** 꺼낸다.
 *
 * `parseLossless`를 거친 값이면 큰 정수는 이미 문자열이다. 그래도
 * 방어적으로 한 번 더 확인한다 — **안전 범위를 벗어난 `number`가
 * 들어오면 그건 이미 망가진 값이므로 null을 돌려준다.** 망가진 번호로
 * 취소를 보내면 거래소는 "그런 주문 없다"고 답하고, 원래 주문은 남는다.
 */
export function venueIdOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s && s !== 'null' && s !== 'undefined' ? s : null;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // **여기서 String(v)를 돌려주면 안 된다.** 이미 반올림된 값이라
    // 복구가 아니라 위조다.
    if (!Number.isSafeInteger(v)) return null;
    return String(v);
  }
  return null;
}

/** 이 값은 "숫자로 읽혀서 이미 망가진" 식별자인가 */
export function isLostPrecisionId(v: any): boolean {
  return typeof v === 'number' && Number.isFinite(v) && !Number.isSafeInteger(v);
}
