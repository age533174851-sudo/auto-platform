// src/lib/ui/todayPnlView.ts
//
// 자동매매 화면 「리스크 가드」 카드의 **오늘 손익 한 줄**.
//
// 왜 따로 있나
// ────────────
// 예전 그 줄은 `getTodayPnL()`(localStorage `tg_today_pnl_v1`)을 읽었다.
// 그 칸에 값을 넣는 함수는 `recordTradePnL` 하나인데 **부르는 곳이 0곳**
// 이다 — `AutoTradeEngine`이 import만 하고 부르지 않는다. 그래서 화면은
// 언제 열어도 「오늘 PnL (0건) +0」과 「한도까지 남음: 한도 전액」을
// 그렸다. 모르는 것을 0으로 적은 것이다.
//
// 그 위에 손실일 때는 `Math.abs(Math.floor(pnl))`로 **부호를 지우고**
// 색으로만 손실을 알렸다(−12.3 → 빨간 「13」).
//
// 이 줄은 이제 서버 모의 장부(`/api/paper/account`의 `today`)를 쓴다.
// 장부 통화(USDT)와 부호·「확인 불가」 문구는 `display.ts`가 정한다.
import { pnlText, UNKNOWN_LABEL, type Tone } from './display';

export interface TodayPnlInput {
  /** `paperViewOf`가 낸 상태 코드 */
  code: string;
  /** 서버가 계산한 오늘 손익(USDT). 기준점이 없으면 null */
  todayPnl: number | null;
  /** `paperViewOf`가 낸 사용자 문장 */
  note?: string | null;
}

export interface TodayPnlRow {
  label: string;
  text: string;
  /** **false면 0이 아니라 모르는 것이다** */
  known: boolean;
  tone: Tone;
  /** 모를 때 왜 모르는지. 알면 빈 문자열 */
  reason: string;
}

export const TODAY_PNL_LABEL = '오늘 손익 · 모의 장부';

export function todayPnlRow(p: TodayPnlInput | null | undefined): TodayPnlRow {
  const unknown = (reason: string): TodayPnlRow => ({
    label: TODAY_PNL_LABEL, text: UNKNOWN_LABEL, known: false, tone: 'muted', reason,
  });
  const code = String(p?.code ?? '');
  if (code === 'LOADING' || code === '') return unknown('모의 장부를 불러오는 중입니다');
  if (code !== 'READY') {
    return unknown(String(p?.note || '모의 장부를 확인하지 못했습니다'));
  }
  const shown = pnlText(p?.todayPnl, 'USDT');
  if (!shown.known) {
    // 서버가 오늘 기준점(자정 이후 첫 자산 스냅숏)을 아직 못 찍었거나 못 읽었다.
    // 시작 잔고로 대신 재면 그건 '오늘'이 아니라 '누적'이다.
    return unknown('오늘 기준 자산이 아직 없습니다 — 0원이라는 뜻이 아닙니다');
  }
  return { label: TODAY_PNL_LABEL, text: shown.text, known: true, tone: shown.tone, reason: '' };
}

/**
 * 일일 손실 한도의 **진행**은 적지 않는다.
 *
 * 한도 값(설정)은 있지만, 그 한도와 비교되는 브라우저 가드의 오늘 손익
 * 칸은 아무도 채우지 않는다(위 머리말). 거기서 뺀 「한도까지 남음」은
 * 언제나 한도 전액이었다. 가드에 손익을 넣는 배선은 거래 갈래의 일이다.
 */
export const DAILY_LIMIT_PROGRESS_TEXT =
  '진행 확인 불가 — 브라우저 가드가 오늘 손익을 아직 받지 못합니다';
