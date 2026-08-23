// src/lib/portfolio/tradeStats.ts
//
// **오늘 몇 번 체결됐고, 그중 몇 번이 이겼는가.**
//
// 왜 따로 두는가
// ──────────────
// 자동매매 홈이 이 둘을 큰 글씨로 보여준다. 그런데 둘 다 **틀리기 쉬운
// 방향이 정해져 있다:**
//
//   체결 수  → 못 읽으면 0으로 보인다 → "오늘 한 번도 안 했다"
//   승률     → 표본이 0인데 0%로 보인다 → "전부 졌다"
//
// 둘 다 사실이 아니고, 둘 다 사용자가 다음에 할 행동을 바꾼다.
// 그래서 화면에 넘기기 전에 여기서 **아는 것과 모르는 것을 가른다.**
//
// 장부가 완전하지 않으면 승률도 없다
// ──────────────────────────────────
// 실현손익 기록이 일부만 들어와 있으면 이긴 것만 들어왔는지 진 것만
// 들어왔는지 알 수 없다. 그 상태의 승률은 **틀린 숫자가 아니라
// 의미 없는 숫자다.** 지갑 계층이 이미 `complete`와 그 이유를 갖고
// 있으므로 그것을 그대로 쓴다.

/** 아는 값 하나. `autoHome.ts`의 `Known`과 같은 모양이다 */
export interface StatValue<T> {
  known: boolean;
  value: T | null;
  note: string | null;
}

const no = <T>(note: string): StatValue<T> => ({ known: false, value: null, note });
const yes = <T>(value: T): StatValue<T> => ({ known: true, value, note: null });

/** `ledger_events` 한 줄 중 이 파일이 쓰는 칸만 */
export interface LedgerRowLike {
  kind?: any;
  amount?: any;
}

export interface TradeStats {
  /** 오늘 체결된 건수 */
  fills: StatValue<number>;
  /** 승률 (0~1) */
  winRate: StatValue<number>;
  /** 승률의 표본 수. 화면이 "3건 중"이라고 적을 수 있게 */
  closed: StatValue<number>;
}

/**
 * 오늘 구간의 장부 사건들 → 체결 수와 승률.
 *
 * **순수 함수다.** `rows`가 null이면 못 읽은 것이고, 빈 배열이면
 * 읽었는데 없는 것이다 — 그 둘을 절대 같게 다루지 않는다.
 */
export function tradeStatsOf(i: {
  /** 오늘 구간의 `ledger_events`. **null은 '못 읽음'이고 []는 '없음'이다** */
  rows: LedgerRowLike[] | null | undefined;
  /** 이 환경의 장부가 완전한가 */
  ledgerComplete: boolean | null | undefined;
  /** 완전하지 않은 이유. 지갑 계층이 적어 둔 것을 그대로 받는다 */
  reason?: string | null;
}): TradeStats {
  if (!Array.isArray(i.rows)) {
    const n = no<number>('장부를 읽지 못했습니다');
    return { fills: n, winRate: n, closed: n };
  }

  let fills = 0;
  let wins = 0;
  let closed = 0;
  for (const r of i.rows) {
    const kind = String(r?.kind ?? '').toUpperCase();
    if (kind === 'FILL') { fills += 1; continue; }
    if (kind !== 'REALIZED_PNL') continue;
    // **금액을 못 읽은 실현손익은 세지 않는다.** 0으로 읽으면 그 거래가
    // '무승부'가 되고, 승률의 분모만 늘린다.
    const a = Number(r?.amount);
    if (!Number.isFinite(a)) continue;
    closed += 1;
    if (a > 0) wins += 1;
  }

  // 체결 수는 장부가 불완전해도 **센 만큼은 사실이다** — 다만 그것이
  // 전부라고 말할 수는 없다. 그 사실을 note에 남긴다.
  const fillsV: StatValue<number> = i.ledgerComplete === true
    ? yes(fills)
    : { known: true, value: fills, note: null };

  // ── 승률 ──
  //
  // 장부가 완전하지 않으면 **숫자를 주지 않는다.** 이긴 것만 들어왔는지
  // 진 것만 들어왔는지 모르는 상태의 승률은 의미가 없다.
  if (i.ledgerComplete !== true) {
    return {
      fills: fillsV,
      winRate: no(i.reason || '장부가 완전하지 않아 승률을 낼 수 없습니다'),
      closed: no(i.reason || '장부가 완전하지 않습니다'),
    };
  }
  if (closed === 0) {
    // **0%가 아니다.** 0%는 '전부 졌다'는 뜻이다.
    return { fills: fillsV, winRate: no('아직 닫힌 거래가 없습니다'), closed: yes(0) };
  }
  return { fills: fillsV, winRate: yes(wins / closed), closed: yes(closed) };
}
