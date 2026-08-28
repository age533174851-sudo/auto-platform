// src/lib/portfolio/legacyPaper.ts
//
// **예전 로컬 모의 기록을 서버 장부에 자동으로 합치지 않는다.**
//
// 브라우저 안에 원화 기준 모의 장부가 있었다(`tg_paper_balance` 등).
// 서버 PAPER는 USDT 기준이고, 체결 방식(슬리피지·수수료)과 TP/SL 규칙이
// 다르다. 자동으로 옮기면 **성적표가 오염된다** — 두 규칙에서 나온 손익이
// 한 줄에 섞이면 그 수익률은 어느 전략의 것도 아니다.
//
// 그래서 여기서는 **있는지만 본다.** 옮기는 함수는 만들지 않는다.

/** 예전 브라우저 장부가 쓰던 키들 */
export const LEGACY_PAPER_KEYS = [
  'tg_paper_balance',
  'tg_exec_logs',
  'tg_mock_session_v1',
] as const;

export interface LegacyPaperVerdict {
  /** 남아 있는 것이 있는가 */
  present: boolean;
  /** 실제로 발견된 키 */
  keys: string[];
  /** 저장소를 못 읽었는가. **못 읽은 것을 '없음'으로 적지 않는다** */
  unreadable: boolean;
}

/**
 * 이 브라우저에 예전 로컬 모의 기록이 남아 있는가.
 *
 * **읽기만 한다.** 이 값은 화면의 안내에만 쓰이고 어떤 숫자에도
 * 들어가지 않는다 — 그것이 "로컬이 서버를 덮을 수 없다"의 뜻이다.
 */
export function legacyLocalPaper(storage: {
  getItem(k: string): string | null;
} | null | undefined): LegacyPaperVerdict {
  if (!storage || typeof storage.getItem !== 'function') {
    return { present: false, keys: [], unreadable: true };
  }
  const keys: string[] = [];
  try {
    for (const k of LEGACY_PAPER_KEYS) {
      const v = storage.getItem(k);
      if (v != null && String(v).trim() !== '') keys.push(k);
    }
  } catch {
    return { present: false, keys: [], unreadable: true };
  }
  return { present: keys.length > 0, keys, unreadable: false };
}
