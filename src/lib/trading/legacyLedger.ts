// src/lib/trading/legacyLedger.ts
//
// **브라우저에 남아 있는 옛 모의 장부 둘을 거래에서 떼어 놓는다.**
//
// 무엇이 있었나
// ─────────────
// "모의투자"라고 적힌 화면이 셋인데 장부가 서로 달랐다:
//
//   서버 `paper_accounts`/`paper_positions`   ← 정본. PR2~PR4의 회계·챌린지
//   localStorage `tg_paper_account_v1`        ← 원화 1천만, 네트워크 없음
//   localStorage `tg_paper_balance_v1`        ← 원화, TESTNET·LIVE가 섞임
//
// 사용자는 어느 화면에 들어갔는지에 따라 다른 잔고를 봤고, 어느 쪽이
// 자기 성적표인지 알 방법이 없었다. 챌린지가 생긴 지금은 더 나쁘다 —
// 챌린지는 서버 장부에만 있으므로, 옛 화면에서 아무리 거래해도 챌린지는
// 한 칸도 움직이지 않는다.
//
// 합치지 않는다
// ─────────────
// **두 장부를 더하거나 옮기는 함수가 이 파일에 없다.** 일부러 없다.
//
//   · 통화가 다르다 (원화 대 USDT). 환율을 고르는 순간 그 숫자는 우리가
//     만든 것이고, 사용자는 그걸 자기 성적으로 읽는다
//   · `tg_paper_balance_v1`에는 TESTNET·LIVE 체결이 섞여 들어갔고 줄마다
//     환경이 적혀 있지 않다 — **사후에 가려낼 수 없다**
//     (`autotrade/practiceEnv.ts`의 `LEGACY_LEDGER_STATUS`가 같은 말을 한다)
//   · 옮기면 **없던 돈이 생긴다.** 모의라도 성적표의 분모가 바뀐다
//
// 지우지도 않는다
// ───────────────
// 값은 그대로 둔다. 사용자가 몇 달 동안 적어 온 연습 기록일 수 있고,
// 그걸 우리가 정리해 줄 근거가 없다. **읽기만 하고, 거래에는 쓰지 않는다.**
import { LEGACY_LEDGER_STATUS } from '../autotrade/practiceEnv';
// 더 옛날 흔적(`tg_paper_balance` · `tg_exec_logs` · `tg_mock_session_v1`)은
// `portfolio/legacyPaper.ts`가 따로 본다. 그쪽은 "남아 있는가"만 답하고,
// 이 파일은 **"거래에 쓸 수 있는가"**를 답한다. 목록은 겹치지 않는다.

/** 브라우저에만 있는 옛 장부. **정본이 아니다.** */
export type LegacyLedgerId =
  /** `PaperTradingPage`가 쓰던 원화 장부 (`lib/paper/engine.ts`) */
  | 'LOCAL_KRW_PAPER'
  /** `TradingPage`가 쓰던 원화 연습 장부 (`lib/autotrade/store.ts`) */
  | 'LOCAL_KRW_PRACTICE';

export const LEGACY_LEDGERS: LegacyLedgerId[] = ['LOCAL_KRW_PAPER', 'LOCAL_KRW_PRACTICE'];

export interface LegacyLedgerInfo {
  id: LegacyLedgerId;
  label: string;
  storageKey: string;
  /** 어느 파일이 이 장부를 다뤘는가 */
  module: string;
  /** **거래에 쓸 수 있는가 — 언제나 false다** */
  tradable: false;
  /** 성과·통계의 근거로 쓸 수 있는가 */
  usableForStats: boolean;
  /** 사용자에게 보여 줄 한 줄 */
  why: string;
}

const INFO: Record<LegacyLedgerId, LegacyLedgerInfo> = {
  LOCAL_KRW_PAPER: {
    id: 'LOCAL_KRW_PAPER',
    label: '옛 모의투자 장부 (이 브라우저에만 있음)',
    storageKey: 'tg_paper_account_v1',
    module: 'src/lib/paper/engine.ts',
    tradable: false,
    // 환경이 섞이진 않았지만 통화도 체결 판정 주체도 서버와 다르다.
    usableForStats: false,
    why: '이 브라우저에만 있는 원화 장부입니다. 서버 모의투자·챌린지와 다른 장부라 '
      + '합산하지 않으며, 자동 손절·익절도 돌지 않습니다',
  },
  LOCAL_KRW_PRACTICE: {
    id: 'LOCAL_KRW_PRACTICE',
    label: '옛 연습 장부 (이 브라우저에만 있음 · 환경 혼입)',
    storageKey: 'tg_paper_balance_v1',
    module: 'src/lib/autotrade/store.ts',
    tradable: false,
    usableForStats: LEGACY_LEDGER_STATUS.usableForStats,   // false — 정본이 이미 그렇게 적었다
    why: LEGACY_LEDGER_STATUS.why,
  },
};

export function legacyLedgerInfo(id: LegacyLedgerId): LegacyLedgerInfo | null {
  return INFO[id] ?? null;
}

/**
 * 거래에 쓸 수 있는가 — **언제나 false.**
 *
 * 인자를 받는 함수로 둔 이유: 부르는 쪽이 `if (ledger === ...)`를 직접
 * 적으면 새 장부가 생겼을 때 그 자리가 빠진다. 여기 하나만 보게 한다.
 */
export function isTradableLedger(_id: LegacyLedgerId): boolean {
  return false;
}

/** 옛 장부 화면에 띄울 안내. 무엇을 해야 하는지까지 적는다. */
export function legacyLedgerNotice(id: LegacyLedgerId): string {
  const i = legacyLedgerInfo(id);
  if (!i) return '이 장부는 거래에 쓰지 않습니다';
  return `${i.why} 실제 모의투자와 챌린지는 서버 장부에서 이어집니다.`;
}

/**
 * **옮기는 함수를 여기 만들지 않는다.**
 *
 * 누군가 "한 번만 옮겨 주자"고 할 때 붙일 자리가 없어야 한다. 자리가
 * 있으면 언젠가 붙고, 붙는 순간 없던 돈이 생긴다. 이 상수는 그 결정을
 * 코드에 적어 두는 것이고, 검사기가 이 파일에 이전 함수가 없는지 본다.
 */
export const LEGACY_MIGRATION_POLICY = {
  /** 서버 장부로 옮기지 않는다 */
  migrate: false,
  /** 서버 잔고와 더하지 않는다 */
  merge: false,
  /** 사용자 값을 지우지 않는다 */
  erase: false,
  why: '통화도 체결 판정 주체도 다르고, 한쪽은 TESTNET·LIVE가 섞여 사후에 가려낼 수 '
    + '없다. 옮기면 없던 돈이 생기고, 지우면 사용자의 기록이 사라진다. '
    + '읽기만 하고 거래에는 쓰지 않는다',
} as const;
