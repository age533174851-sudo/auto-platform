// src/lib/commands/hangul.ts
//
// 한글 초성 매칭.
//
// 왜 필요한가
// ───────────
// 한국어 사용자는 '경제캘린더'를 찾을 때 전체를 치지 않는다. `ㄱㅈㅋ`처럼
// 자음만 두드린다. 영문 앱의 부분일치 검색만 붙이면 이 입력이 **0건**으로
// 나오고, 사용자는 그 기능이 없는 줄 안다.
//
// 왜 파일을 따로 두는가
// ─────────────────────
// 유니코드 계산이 틀리면 조용히 틀린다. 'ㄱ'으로 검색했을 때 결과가 몇 개
// 빠져도 화면은 정상으로 보인다 — 목록이 나오니까. 그래서 테스트가 붙는
// 자리에 두고, 매칭 규칙(match.ts)과도 분리한다.
//
// 호환 자모를 쓰는 이유
// ─────────────────────
// 사용자가 키보드로 자음 하나만 누르면 들어오는 값은 **호환 자모**
// (U+3131 'ㄱ' 등)다. 한글 음절을 분해해서 얻는 초성(U+1100 'ᄀ')과 코드가
// 다르다. 눈으로는 똑같이 보여서, 이걸 섞으면 "왜 검색이 안 되지"가 된다.
//
// 그리고 호환 자모 블록은 자음만 연속으로 있지 않다 — 'ㄳ'(U+3133),
// 'ㄵ'(U+3135) 같은 겹받침이 사이에 끼어 있다. 그래서 코드 산술로 초성
// 번호를 구할 수 없고, 아래처럼 초성 19자를 순서대로 적어 인덱스를 쓴다.

/** 초성 19자 (호환 자모). 순서가 곧 초성 인덱스다 */
export const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

const HANGUL_BASE = 0xac00;   // '가'
const HANGUL_LAST = 0xd7a3;   // '힣'
/** 중성 21 × 종성 28 — 초성 하나가 차지하는 음절 수 */
const PER_CHOSEONG = 21 * 28;

/** 완성형 한글 음절인가 ('가'~'힣') */
export function isSyllable(ch: string): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= HANGUL_BASE && c <= HANGUL_LAST;
}

/**
 * 초성으로 쓸 수 있는 낱자인가.
 *
 * 'ㅏ' 같은 모음은 false다. 모음만 쳤을 때 초성 매칭을 시도하면 아무것도
 * 안 맞는데, 그걸 '초성 검색 실패'로 처리하면 일반 부분일치까지 건너뛴다.
 */
export function isChoseongJamo(ch: string): boolean {
  return !!ch && CHOSEONG.includes(ch);
}

/**
 * 음절 하나의 초성을 호환 자모로 돌려준다. 한글이 아니면 null.
 *
 * '값' → 'ㄱ' (종성이 있어도 초성만 본다)
 */
export function choseongOf(ch: string): string | null {
  if (!isSyllable(ch)) return null;
  const idx = Math.floor((ch.charCodeAt(0) - HANGUL_BASE) / PER_CHOSEONG);
  return CHOSEONG[idx] ?? null;
}

/**
 * 문자열의 초성 열.
 *
 * 한글이 아닌 문자는 **그대로 남긴다.** 'AI 분석' → 'AI ㅂㅅ'.
 * 지우면 'AI'로 시작하는 항목을 초성 경로에서 놓친다.
 */
export function choseongOfText(s: string): string {
  let out = '';
  for (const ch of String(s ?? '')) {
    out += choseongOf(ch) ?? ch;
  }
  return out;
}

/** 질의가 초성 낱자를 하나라도 포함하는가 (초성 경로를 탈지 정할 때 쓴다) */
export function hasChoseongJamo(s: string): boolean {
  for (const ch of String(s ?? '')) {
    if (isChoseongJamo(ch)) return true;
  }
  return false;
}

/**
 * 한 글자 비교.
 *
 * 질의 문자가 초성 낱자면 대상 음절의 초성과 비교하고, 그 외에는 그대로
 * 비교한다(영문은 대소문자 무시). 이 규칙 하나로 순수 초성 질의(`ㄱㅈㅋ`)와
 * 섞인 질의(`경ㅋ`)를 같은 코드로 처리한다.
 *
 * 'ㄱ'이 'ㄲ'에 맞지 않는 것은 의도다. 느슨하게 하면 한 글자 질의의 결과가
 * 두 배로 늘어 순위가 무의미해진다.
 */
export function charMatches(queryCh: string, targetCh: string): boolean {
  if (!queryCh || !targetCh) return false;
  if (isChoseongJamo(queryCh)) {
    // 초성 낱자 질의 — 대상이 음절이면 초성끼리, 대상도 낱자면 그대로
    const cho = choseongOf(targetCh);
    if (cho) return cho === queryCh;
    return targetCh === queryCh;
  }
  return queryCh.toLowerCase() === targetCh.toLowerCase();
}

/**
 * 질의가 대상의 어딘가에 **연속으로** 나타나는 첫 위치. 없으면 -1.
 *
 * 중간에 건너뛰기를 허용하지 않는다. 허용하면 'ㅁㅁ'이 거의 모든 항목에
 * 맞아 결과가 목록 전체가 된다 — 그건 검색이 아니다. 오타 허용(퍼지)은
 * 별개 기능이고, 넣더라도 순위를 크게 깎아서 넣어야 한다.
 *
 * 반환값이 위치인 이유: 앞에서 맞은 것이 더 좋은 결과라 점수 계산에 쓴다.
 */
export function indexOfMatch(query: string, target: string): number {
  const q = [...String(query ?? '')];
  const t = [...String(target ?? '')];
  if (q.length === 0) return -1;
  if (q.length > t.length) return -1;

  for (let start = 0; start <= t.length - q.length; start++) {
    let ok = true;
    for (let i = 0; i < q.length; i++) {
      if (!charMatches(q[i], t[start + i])) { ok = false; break; }
    }
    if (ok) return start;
  }
  return -1;
}

/** 질의로 대상이 시작하는가 */
export function startsWithMatch(query: string, target: string): boolean {
  return indexOfMatch(query, target) === 0;
}
