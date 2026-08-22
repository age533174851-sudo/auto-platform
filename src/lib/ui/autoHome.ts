// src/lib/ui/autoHome.ts
//
// **자동매매 홈이 보여줄 수 있는 값과 없는 값을 가른다.**
//
// 왜 이 파일이 먼저인가
// ─────────────────────
// 자동매매 화면을 "돈부터 보여주는" 구조로 바꾸면 맨 위에 큰 숫자가
// 넷 온다 — 운용 자산 · 오늘 손익 · 오늘 거래 수 · 승률.
//
// 그런데 **그 넷이 전부 있는 게 아니다.** 예약 API는 예약만 알고,
// 지갑 API는 자산과 장부만 안다. 없는 것을 0으로 그리면 화면이
// "오늘 안 벌었다"고 말하는데 실제로는 **아직 모르는 것**이다.
//
// 이 저장소가 반복해서 당한 사고가 정확히 그것이다 — `UNKNOWN`을 0으로
// 적는 것. 큰 글씨로 적으면 더 나쁘다. 사람은 큰 숫자를 안 의심한다.
//
// 그래서 화면을 그리기 전에 여기서 **무엇을 아는가**를 먼저 정한다.
// 모르는 칸은 `known: false`로 나가고, 화면은 그 자리에 숫자가 아니라
// 이유를 그린다.

import type { RunEnv } from './autoOverview';

/** 아는 값 하나. **`value`가 있어도 `known`이 false면 쓰지 않는다** */
export interface Known<T> {
  known: boolean;
  value: T | null;
  /** 모를 때 화면에 그대로 적을 한 줄. 알 때는 null */
  note: string | null;
}

const unknown = <T>(note: string): Known<T> => ({ known: false, value: null, note });
const known = <T>(value: T): Known<T> => ({ known: true, value, note: null });

/** 한 전략 카드가 쓰는 값 */
export interface StrategyCardView {
  scheduleId: string;
  symbol: string;
  strategyId: string;
  /** 서버가 준 이름. **없으면 id를 그대로 쓴다 — 이름을 지어내지 않는다** */
  strategyName: string;
  running: boolean;
  /** 마지막 판단 한 줄. 서버가 적은 것을 그대로 쓴다 */
  lastResult: string | null;
  lastRunAtMs: number | null;
  /** 이 예약이 실전인가 */
  live: boolean;
  connectionId: string | null;
}

export interface AutoHomeView {
  env: RunEnv;
  /** 이 환경의 총자산 */
  equity: Known<number>;
  /** 오늘 매매로 번 것 */
  todayPnl: Known<number>;
  /** 실행 중 전략 수 */
  running: Known<number>;
  /** 오늘 거래 횟수 */
  todayTrades: Known<number>;
  /** 승률 */
  winRate: Known<number>;
  cards: StrategyCardView[];
  /** 예약을 아예 못 읽었는가. 빈 목록과 다르다 */
  schedulesReadOk: boolean;
}

/**
 * 화면이 쓸 값을 한 번에 만든다.
 *
 * `wallet`은 `/api/wallets/overview` 응답, `schedule`은
 * `/api/autotrade/schedule` GET 응답이다. **둘 다 없어도 된다** —
 * 없으면 그 칸이 `known: false`가 될 뿐이고, 화면은 이유를 그린다.
 */
export function autoHomeView(i: {
  env: RunEnv;
  schedule: any | null | undefined;
  wallet: any | null | undefined;
}): AutoHomeView {
  const env = i.env;
  const sched = i.schedule ?? null;
  const rows: any[] = Array.isArray(sched?.schedules) ? sched.schedules : [];
  const schedulesReadOk = !!sched && sched.ok !== false && Array.isArray(sched.schedules);

  return {
    env,
    equity: equityOf(i.wallet, env),
    todayPnl: todayPnlOf(i.wallet, env),
    running: schedulesReadOk
      ? known(rows.filter(r => !!r?.enabled).length)
      : unknown('예약을 읽지 못했습니다'),
    // ── 아직 이 화면에 값이 오지 않는 것들 ──
    //
    // **0으로 그리지 않는다.** 예약 API도 지갑 API도 "오늘 몇 번
    // 거래했는가"와 "이겼는가"를 주지 않는다. 0을 그리면 화면이
    // "오늘 한 번도 안 했다"고 말하는데, 실제로는 세는 곳이 없는 것이다.
    todayTrades: unknown('오늘 거래 수를 세는 경로가 아직 없습니다'),
    winRate: unknown('승률을 집계하는 경로가 아직 없습니다'),
    cards: rows.map(cardOf),
    schedulesReadOk,
  };
}

/**
 * 이 환경의 총자산.
 *
 * **환경을 섞지 않는다.** MOCK·TESTNET·LIVE의 장부와 자산은 절대
 * 합산하지 않는다는 것이 이 저장소의 규칙이다.
 */
function equityOf(wallet: any, env: RunEnv): Known<number> {
  if (!wallet) return unknown('지갑 정보를 아직 읽지 않았습니다');
  if (wallet.ok === false) return unknown('지갑을 읽지 못했습니다');
  const envs: any[] = Array.isArray(wallet.envs) ? wallet.envs : [];
  const row = envs.find(e => String(e?.env) === String(env)) ?? null;
  if (!row) return unknown(`이 환경(${env})의 자산 정보가 없습니다`);

  // `total`은 지갑 계층이 이미 판정한 값이다. **못 읽었으면 value가 null**이고
  // 그 이유가 `text`에 있다 — 여기서 다시 판정하지 않는다.
  // **`Number(null)`은 0이다.** 그래서 `Number(t.value)`를 먼저 하면
  // 모르는 값이 0으로 바뀌고 `Number.isFinite(0)`이 참이라 그대로
  // 통과한다 — 이 파일이 막으려는 바로 그 사고를, 이 파일이 낸다.
  // **null 검사를 숫자 변환보다 먼저 한다.**
  const t = row.total ?? null;
  if (t == null || t.value == null) {
    return unknown(String(t?.text || '총자산을 확인하지 못했습니다'));
  }
  const v = Number(t.value);
  if (!Number.isFinite(v)) return unknown(String(t.text || '총자산을 숫자로 읽지 못했습니다'));
  return known(v);
}

/**
 * 오늘 매매로 번 것.
 *
 * 지갑 계층의 `tradingPnl`을 그대로 쓴다. **자산 변화와 매매손익은
 * 다르다** — 입출금·수수료·펀딩이 섞이면 매매로 번 것이 아니다.
 * 그 판정은 `ledgerEvent.tradingPnlOf`가 이미 하고 있고, 완전하지
 * 않으면 `value`가 null이며 이유가 붙어 있다.
 */
function todayPnlOf(wallet: any, env: RunEnv): Known<number> {
  if (!wallet) return unknown('지갑 정보를 아직 읽지 않았습니다');
  const led = wallet.ledger ?? null;
  if (!led) return unknown('장부를 읽지 못했습니다');
  if (led.error) return unknown('장부를 읽지 못했습니다');
  const row = led[String(env)] ?? null;
  if (!row) return unknown(`이 환경(${env})의 장부가 없습니다`);

  // 여기도 같다 — **null 검사가 숫자 변환보다 먼저다.**
  const tp = row.tradingPnl ?? null;
  if (tp == null || tp.value == null) {
    // **무엇을 몰라서인지 지갑 계층이 이미 적어 뒀다.** 여기서 문장을
    // 지어내지 않는다.
    return unknown(String(tp?.reason || row.reason || '오늘 매매손익을 확정하지 못했습니다'));
  }
  const v = Number(tp.value);
  if (!Number.isFinite(v)) {
    return unknown(String(tp.reason || '오늘 매매손익을 숫자로 읽지 못했습니다'));
  }
  return known(v);
}

/** 예약 한 줄 → 카드 하나. **이름을 지어내지 않는다** */
function cardOf(r: any): StrategyCardView {
  const id = String(r?.strategy_id ?? r?.strategyId ?? '').trim();
  return {
    scheduleId: String(r?.id ?? ''),
    symbol: String(r?.symbol ?? ''),
    strategyId: id,
    // 서버가 이름을 줬으면 그것, 아니면 id 그대로. **마케팅 이름을
    // 만들지 않는다** — 실제 등록된 전략이 아닌 이름을 보여주면
    // 사용자는 존재하지 않는 상품을 켰다고 믿는다.
    strategyName: String(r?.strategyName ?? r?.strategy_name ?? '').trim() || id || '(전략 미상)',
    running: !!r?.enabled,
    lastResult: String(r?.last_result ?? '').trim() || null,
    lastRunAtMs: msOf(r?.last_run_at),
    // 저장소 전체 규칙과 같은 방향: 실전이라고 확실할 때만 실전이다.
    live: String(r?.mode ?? '').toUpperCase().startsWith('LIVE'),
    connectionId: String(r?.connection_id ?? '').trim() || null,
  };
}

function msOf(v: any): number | null {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * 큰 숫자 한 칸을 어떻게 그릴 것인가.
 *
 * **모르는 칸에 `0`도 `—`도 그냥 두지 않는다.** 왜 모르는지가 그 자리에
 * 있어야 사용자가 다음에 무엇을 할지 안다.
 */
export interface StatCell {
  label: string;
  /** 화면에 그대로 쓸 값. 모르면 null */
  text: string | null;
  /** 모를 때 그 자리에 쓸 한 줄 */
  emptyText: string | null;
  known: boolean;
  tone: 'plain' | 'good' | 'bad';
}

export function statCell(
  label: string, k: Known<number>,
  fmt: (v: number) => string,
  opts?: { signed?: boolean },
): StatCell {
  if (!k.known || k.value == null) {
    return { label, text: null, emptyText: k.note || '아직 없음', known: false, tone: 'plain' };
  }
  const v = k.value;
  const tone: StatCell['tone'] = opts?.signed ? (v > 0 ? 'good' : v < 0 ? 'bad' : 'plain') : 'plain';
  return { label, text: fmt(v), emptyText: null, known: true, tone };
}
