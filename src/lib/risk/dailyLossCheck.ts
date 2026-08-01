// src/lib/risk/dailyLossCheck.ts
//
// 일일 한도 판정에 넣을 **실제 값**을 모은다.
//
// 판정은 dailyLoss.ts(순수)가 하고, 이 파일은 거래소·DB를 읽어 그 입력을
// 만든다. 나눠 두는 이유는 판정에 테스트를 붙이기 위해서다 — 여기서
// 부호 하나 틀리면 손실이 이익으로 읽히고, 그건 화면에서 안 보인다.
//
// 실패는 0으로 덮지 않는다
// ────────────────────────
// income 조회가 실패하면 `todayNetUsd: null`이다. 0으로 두면 '오늘 아무
// 거래도 없었다'가 되어 한도가 통째로 사라진다. null이면 판정이 unknown이
// 되고, 신규 진입이 막힌다 — 확인하지 못한 것은 통과가 아니다.

import {
  sumTodayIncome, judgeDailyLoss, readDailyLossConfig, utcDayStart,
  type DailyLossVerdict, type DailyLossConfig,
} from './dailyLoss';

export interface DailyLossFacts {
  verdict: DailyLossVerdict;
  cfg: DailyLossConfig;
  /** 오늘 순손익(USDT). 모르면 null */
  todayNetUsd: number | null;
  /** 오늘 시작 자산 추정(USDT). 모르면 null */
  dayStartEquityUsd: number | null;
  /** 센 income 건수 */
  incomeCount: number;
}

/**
 * 실계좌·테스트넷의 오늘 한도 상태.
 *
 * 시작 자산은 **현재 자산 − 오늘 순손익**으로 되돌려 구한다. 스냅샷을 따로
 * 저장하지 않는 이유: 저장하려면 하루 한 번 도는 작업이 필요하고, 그게 안
 * 돌면 스냅샷이 며칠 전 값으로 굳는다. 굳은 값으로 비율을 재면 한도가
 * 조용히 틀어진다. 되돌려 구하는 쪽은 항상 오늘 값이다.
 *
 * 입금/출금이 있으면 이 추정이 어긋난다 — 그래서 금액 한도(USD)를 같이
 * 걸어 두는 편이 안전하다.
 */
export async function collectDailyLoss(args: {
  apiKey: string; apiSecret: string; testnet: boolean;
  /** 'gate'면 Gate의 account_book을 읽는다. 기본은 바이낸스 */
  exchange?: 'binance' | 'gate';
  /** 현재 지갑 자산(USDT). 모르면 null */
  currentEquityUsd: number | null;
  nowMs?: number;
  env?: (k: string) => string | undefined;
}): Promise<DailyLossFacts> {
  const now = args.nowMs ?? Date.now();
  const cfg = readDailyLossConfig(args.env ?? ((k) => process.env[k]));
  const dayStart = utcDayStart(now);

  let todayNetUsd: number | null = null;
  let incomeCount = 0;
  try {
    // 거래소마다 원장 엔드포인트가 다르다. 합산은 같은 순수 함수가 한다 —
    // 한도 판정이 거래소마다 갈리면 한쪽만 고쳐진다.
    let rows: any[] | null;
    if (args.exchange === 'gate') {
      const { getGateAccountBook } = await import('@/lib/exchanges/gateFutures');
      rows = await getGateAccountBook(args.apiKey, args.apiSecret, args.testnet, {
        fromSec: Math.floor(dayStart / 1000), limit: 300,
      });
    } else {
      const { getFuturesIncome } = await import('@/lib/exchanges/binanceFutures');
      rows = await getFuturesIncome(args.apiKey, args.apiSecret, args.testnet, {
        startTime: dayStart, limit: 1000,
      });
    }
    if (rows != null) {
      const sum = sumTodayIncome(rows, dayStart);
      todayNetUsd = sum.net;
      incomeCount = sum.count;
    }
  } catch { /* null로 남는다 → unknown → 막힌다 */ }

  const dayStartEquityUsd =
    args.currentEquityUsd != null && todayNetUsd != null
      ? args.currentEquityUsd - todayNetUsd
      : null;

  return {
    verdict: judgeDailyLoss({ todayNetUsd, dayStartEquityUsd, cfg }),
    cfg, todayNetUsd, dayStartEquityUsd, incomeCount,
  };
}

/**
 * 모의 계좌의 오늘 한도 상태.
 *
 * 모의에도 같은 한도를 건다. 규칙이 실전과 다르면 그 연습은 쓸모가 없다 —
 * 하루 한도를 무시하고 계속 넣어도 되는 화면에서 익힌 습관이 실계좌에서
 * 그대로 나온다.
 */
export async function collectPaperDailyLoss(args: {
  sb: any; userId: string; nowMs?: number;
  env?: (k: string) => string | undefined;
}): Promise<DailyLossFacts> {
  const now = args.nowMs ?? Date.now();
  const cfg = readDailyLossConfig(args.env ?? ((k) => process.env[k]));
  const dayStart = utcDayStart(now);

  let todayNetUsd: number | null = null;
  let incomeCount = 0;
  let dayStartEquityUsd: number | null = null;

  try {
    // 오늘 닫힌 모의 포지션의 실현손익. 진입 수수료는 realized_pnl에
    // 이미 반영돼 있다 (paperExecution.computeClose).
    const { data } = await args.sb.from('paper_positions')
      .select('realized_pnl, closed_at')
      .eq('user_id', args.userId).eq('status', 'closed')
      .gte('closed_at', new Date(dayStart).toISOString());
    if (Array.isArray(data)) {
      todayNetUsd = data.reduce((a: number, r: any) => a + (Number(r.realized_pnl) || 0), 0);
      incomeCount = data.length;
    }
  } catch { /* null → unknown → 막힌다 */ }

  try {
    const { getPaperAccount } = await import('@/lib/engine/paperStore');
    const acct = await getPaperAccount(args.sb, args.userId);
    const bal = Number(acct?.balance);
    if (Number.isFinite(bal) && todayNetUsd != null) dayStartEquityUsd = bal - todayNetUsd;
  } catch { /* null */ }

  return {
    verdict: judgeDailyLoss({ todayNetUsd, dayStartEquityUsd, cfg }),
    cfg, todayNetUsd, dayStartEquityUsd, incomeCount,
  };
}
