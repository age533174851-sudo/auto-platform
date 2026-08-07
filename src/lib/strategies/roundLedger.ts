// src/lib/strategies/roundLedger.ts
//
// **한 회차와 전체 회차는 다른 숫자다.**
//
// 무엇이 문제였나
// ───────────────
// 화면에 `잔고`와 `누적손익`이 한 줄로 나란히 있었다. 그런데 목표가
// 있는 프로필은 목표에 닿으면 계좌가 시드로 되감긴다. 그래서 그 두
// 숫자는 **지금 돌고 있는 판의 것**이고, 지금까지 열 판을 어떻게 했는지는
// 어디에도 없었다.
//
// 그 상태에서 사용자가 볼 수 있는 것은 이런 것이다:
//
//   잔고 $1,000 · 누적손익 $0
//
// 방금 세 판을 내리 파산시켰어도 화면은 저렇게 적는다. 계좌가 되감겼기
// 때문이다. **되감긴 것은 계좌지 사실이 아니다.**
//
// 회차 모드를 왜 나누나
// ─────────────────────
// "10만불까지 가는 데 몇 판 걸리나"와 "$1,000으로 시작해서 계속 굴리면
// 어디까지 가나"는 완전히 다른 질문이다.
//
//   · 독립 회차(INDEPENDENT_ROUNDS) — 매 판 새로 $1,000을 넣는다.
//     열 판이면 총 $10,000을 넣은 것이다. 성공률이 뜻을 갖는다.
//   · 연속 복리(CONTINUOUS_COMPOUND) — 이전 판이 끝난 잔고에서 이어서
//     시작한다. 넣은 돈은 처음 $1,000뿐이다.
//
// **두 모드의 결과를 한 표에 더하면 안 된다.** 독립 회차에서 열 번 넣은
// $10,000과 연속 복리에서 한 번 넣은 $1,000을 같은 '총 투입'에 더하면,
// 그 합계는 아무 뜻도 없다. 그래서 장부를 모드별로 따로 둔다 — 섞이지
// 않게 하는 가장 확실한 방법은 애초에 같은 통에 안 담는 것이다.

import type { StrategyType } from './profiles';
import type { RiskPresetId } from './profilePreset';
import { presetOf } from './profilePreset';

export type RoundMode = 'INDEPENDENT_ROUNDS' | 'CONTINUOUS_COMPOUND';

export const DEFAULT_ROUND_MODE: RoundMode = 'INDEPENDENT_ROUNDS';

export const MODE_INFO: Record<RoundMode, { label: string; desc: string }> = {
  INDEPENDENT_ROUNDS: {
    label: '독립 회차',
    desc: '매 회차 시드를 새로 넣습니다 — 10회면 시드 10개를 넣은 것입니다',
  },
  CONTINUOUS_COMPOUND: {
    label: '연속 복리',
    desc: '이전 회차가 끝난 잔고에서 이어서 시작합니다 — 넣은 돈은 처음 한 번뿐입니다',
  },
};

export function roundModeOf(raw: any): RoundMode {
  const s = String(raw ?? '').trim().toUpperCase();
  return s === 'CONTINUOUS_COMPOUND' ? 'CONTINUOUS_COMPOUND' : DEFAULT_ROUND_MODE;
}

export interface RoundEntry {
  n: number;
  mode: RoundMode;
  /** 어느 설정에서 나온 결과인가. 섞이면 합계가 뜻을 잃는다 */
  preset: RiskPresetId;
  startEquity: number;
  endEquity: number;
  /**
   * 이 회차에 **새로 넣은 돈.**
   *
   * 독립 회차는 매번 시드만큼, 연속 복리는 첫 회차만 시드만큼이고
   * 그 뒤로는 0이다. 이 값을 안 나누면 '총 투입'이 두 모드에서
   * 전혀 다른 뜻이 된다.
   */
  capitalInjected: number;
  pnl: number;
  trades: number;
  wins: number;
  reached: boolean;
  /** 파산으로 끝났나. 목표 미달과 파산은 다른 결과다 */
  ruined: boolean;
  reason: string;
  /**
   * 종료 사유 코드. **옛 회차에는 없다** — 그때는 endReasonOf가
   * 문장에서 되짚는다. 통째로 UNKNOWN으로 만들면 지금까지의 통계가
   * 전부 사라진다.
   */
  endReason?: RoundEndReason;
  simSeconds: number;
}

/**
 * 회차가 **왜** 끝났는가.
 *
 * 지금은 `reason`이 사람이 읽는 문장 하나뿐이라("손으로 회차 종료",
 * "파산", "모의 90일 도달 — 목표 미달") 통계를 낼 수 없다. 목표를
 * 못 찍고 끝난 것과 손으로 멈춘 것과 낙폭에 걸려 선 것이 전부
 * '실패'로 뭉쳐 있으면, 그 실패율은 아무 뜻이 없다.
 */
export type RoundEndReason =
  /** 목표 잔고에 닿았다 */
  | 'TARGET_HIT'
  /** 파산선 아래로 떨어졌다 */
  | 'RUIN'
  /** 낙폭 한도에 걸려 멈췄다 — 파산과 다르다 */
  | 'MDD_STOP'
  /** 정해진 거래 수를 다 썼다 */
  | 'MAX_TRADES'
  /** 정해진 기간을 다 썼다 */
  | 'MAX_TIME'
  /** 사람이 멈췄다 */
  | 'MANUAL_STOP'
  /** 무엇 때문인지 모른다 */
  | 'UNKNOWN';

export const END_REASON_LABEL: Record<RoundEndReason, string> = {
  TARGET_HIT: '목표 달성',
  RUIN: '파산',
  MDD_STOP: '낙폭 한도 중단',
  MAX_TRADES: '거래 수 소진',
  MAX_TIME: '기간 소진',
  MANUAL_STOP: '수동 종료',
  UNKNOWN: '사유 미상',
};

/**
 * 회차의 종료 사유를 정한다.
 *
 * **저장된 코드가 있으면 그것이 우선이다.** 없으면(이 필드가 생기기
 * 전에 쌓인 회차) 문장에서 되짚는다 — 옛 기록을 통째로 UNKNOWN으로
 * 만들면 지금까지의 통계가 전부 사라진다.
 */
export function endReasonOf(r: Partial<RoundEntry> | null | undefined): RoundEndReason {
  if (!r) return 'UNKNOWN';
  const stored = String((r as any).endReason ?? '').trim().toUpperCase();
  if (stored in END_REASON_LABEL) return stored as RoundEndReason;

  // **파산을 목표보다 먼저 본다.** 파산선에서 목표를 찍을 수는 없고,
  // 둘 다 참으로 기록된 회차가 있으면 나쁜 쪽이 사실이다.
  if (r.ruined === true) return 'RUIN';
  if (r.reached === true) return 'TARGET_HIT';

  const t = String(r.reason ?? '');
  if (t.includes('낙폭') || t.includes('MDD')) return 'MDD_STOP';
  if (t.includes('손으로') || t.includes('수동')) return 'MANUAL_STOP';
  if (t.includes('거래') && t.includes('도달')) return 'MAX_TRADES';
  if (t.includes('일') || t.includes('기간')) return 'MAX_TIME';
  return 'UNKNOWN';
}

export interface LedgerBook {
  profileId: StrategyType;
  mode: RoundMode;
  rounds: RoundEntry[];
}

export interface LedgerSummary {
  mode: RoundMode;
  totalRounds: number;
  /** 총 투입 — 지금까지 새로 넣은 돈의 합 */
  totalCapitalInjected: number;
  /** 총 회수 — 독립 회차는 각 판 끝 잔고의 합, 연속 복리는 마지막 잔고 */
  totalFinalEquity: number;
  /** 전체 순손익 = 총 회수 − 총 투입 */
  totalNetPnl: number;
  successfulRounds: number;
  failedRounds: number;
  ruinedRounds: number;
  /**
   * **돈을 번 회차 수.** 목표 달성과 다르다.
   *
   * 지금까지 '성공률 0%'가 무엇을 뜻하는지 애매했다 — 원금보다
   * 플러스로 끝나도 목표를 못 찍으면 실패로 세어졌기 때문이다.
   * 그 둘은 완전히 다른 사실이라 따로 센다.
   */
  profitableRounds: number;
  /** 목표 달성률 0~1. 회차가 없으면 null — 0%가 아니다 */
  targetHitRate: number | null;
  /** 수익 회차율 0~1. 회차가 없으면 null */
  profitableRate: number | null;
  /** 파산률 0~1. 회차가 없으면 null */
  ruinRate: number | null;
  /**
   * 종료 사유별 회차 수.
   *
   * '실패 12회'로는 아무것도 못 한다 — 낙폭에 걸려 선 것과 손으로
   * 멈춘 것과 목표를 못 찍은 것은 각각 다음에 할 일이 다르다.
   */
  byEndReason: Record<RoundEndReason, number>;
  /** 회차 끝 잔고의 중앙값. 회차가 없으면 null */
  medianRoundEquity: number | null;
  totalTrades: number;
  totalWins: number;
  totalSimSeconds: number;
  /**
   * 이 장부에 두 가지 이상의 설정에서 나온 회차가 섞여 있나.
   *
   * 섞였다고 지우지는 않는다 — 지우는 것은 사용자가 정한다. 다만
   * **합계가 그 사실 위에 서 있다는 것은 화면에 적혀야 한다.**
   */
  mixedPresets: boolean;
  presets: RiskPresetId[];
}

const KEY = (id: StrategyType, mode: RoundMode) => `tg_round_ledger_${id}_${mode}_v1`;

/** profileRisk와 같은 이유로 메모리 대체 저장소를 둔다 — 없으면 테스트가 아무것도 확인 못 한다. */
const mem = new Map<string, string>();
function store(): { get(k: string): string | null; set(k: string, v: string): void } {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      get: k => { try { return window.localStorage.getItem(k); } catch { return mem.get(k) ?? null; } },
      set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { mem.set(k, v); } },
    };
  }
  return { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } };
}

export function __clearRoundLedgerMemory() { mem.clear(); }

function emptyBook(id: StrategyType, mode: RoundMode): LedgerBook {
  return { profileId: id, mode, rounds: [] };
}

export function loadBook(id: StrategyType, mode: RoundMode): LedgerBook {
  const m = roundModeOf(mode);
  try {
    const raw = store().get(KEY(id, m));
    if (!raw) return emptyBook(id, m);
    const b = JSON.parse(raw) as LedgerBook;
    b.profileId = id;
    // **저장된 모드를 믿지 않는다.** 키가 모드를 담고 있으므로 키가
    // 진실이다. 안에 다른 모드가 적혀 있으면 그건 옛 저장분의 흔적이고,
    // 그대로 두면 화면이 다른 모드의 이름표를 단다.
    b.mode = m;
    if (!Array.isArray(b.rounds)) b.rounds = [];
    for (const r of b.rounds) { r.mode = m; r.preset = presetOf(r.preset); }
    return b;
  } catch { return emptyBook(id, m); }
}

function saveBook(b: LedgerBook) {
  try { store().set(KEY(b.profileId, b.mode), JSON.stringify(b)); } catch {}
}

/** 다음 회차 번호 (1부터) */
export function nextRoundNo(id: StrategyType, mode: RoundMode): number {
  return loadBook(id, mode).rounds.length + 1;
}

/**
 * 다음 회차를 **얼마에서 시작하는가.**
 *
 * 연속 복리는 이전 회차가 끝난 잔고다. 여기서 시드를 돌려주면 복리가
 * 아니라 독립 회차가 되고, 그런데도 화면에는 '연속 복리'라고 적힌다 —
 * 이름과 동작이 갈리는 쪽이 조용히 틀리는 쪽이다.
 *
 * 파산으로 끝났으면 이어 갈 잔고가 없다. 그때는 시드를 다시 넣는다.
 *
 * ⚠ 여기서 한 번 틀렸다. 예전 구현은 `endEquity <= 0`만 봤다.
 *
 * 그런데 이 저장소의 **파산은 잔고 0이 아니다** — 시드의 0.5% 아래로
 * 떨어지면 파산이고, 그건 여전히 양수다. 그래서 이런 일이 났다:
 *
 *   1회차  10,000,000 → 파산 판정 → 잔고 49,819
 *   2회차  49,819에서 시작(시드 재투입 안 함) → 249
 *
 * 죽은 잔고를 계속 복리로 굴린 것이다. 그 회차들의 수익률·낙폭·목표
 * 도달률이 전부 그 위에서 계산되므로, **전략을 판단하는 통계가 통째로
 * 오염된다.** 주석은 ruined를 말하는데 코드는 0만 봤다 — 설명과 동작이
 * 갈리면 아무도 안 읽는 쪽(코드)이 이긴다.
 */
export function nextStartEquity(
  id: StrategyType, mode: RoundMode, seed: number,
): { equity: number; injected: number } {
  const m = roundModeOf(mode);
  if (m === 'INDEPENDENT_ROUNDS') return { equity: seed, injected: seed };

  const rounds = loadBook(id, m).rounds;
  if (rounds.length === 0) return { equity: seed, injected: seed };
  const last = rounds[rounds.length - 1];
  const end = Number(last.endEquity);
  // 파산한 계좌에서 이어 갈 수는 없다. 새로 넣는다 — 그리고 그것은
  // '투입'이므로 총 투입에 더해져야 한다.
  //
  // **ruined를 먼저 본다.** 잔고가 양수여도 파산은 파산이다. 0만 보면
  // 시드의 0.5%인 죽은 잔고를 계속 굴리게 된다.
  if (last.ruined === true) return { equity: seed, injected: seed };
  if (!Number.isFinite(end) || end <= 0) return { equity: seed, injected: seed };
  return { equity: end, injected: 0 };
}

export interface AppendInput {
  preset: RiskPresetId;
  startEquity: number;
  endEquity: number;
  capitalInjected: number;
  trades: number;
  wins: number;
  reached: boolean;
  ruined: boolean;
  reason: string;
  /** 종료 사유. 안 주면 reached·ruined·문장에서 되짚는다 */
  endReason?: RoundEndReason;
  simSeconds: number;
}

export function appendRound(id: StrategyType, mode: RoundMode, r: AppendInput): LedgerBook {
  const b = loadBook(id, mode);
  b.rounds.push({
    n: b.rounds.length + 1,
    mode: b.mode,
    preset: presetOf(r.preset),
    startEquity: Number(r.startEquity) || 0,
    endEquity: Number(r.endEquity) || 0,
    capitalInjected: Number(r.capitalInjected) || 0,
    pnl: (Number(r.endEquity) || 0) - (Number(r.startEquity) || 0),
    trades: Math.max(0, Math.floor(Number(r.trades) || 0)),
    wins: Math.max(0, Math.floor(Number(r.wins) || 0)),
    reached: !!r.reached,
    ruined: !!r.ruined,
    reason: String(r.reason ?? ''),
    // 넘어온 코드가 있으면 그것을, 없으면 지금 사실에서 정한다.
    endReason: endReasonOf({ ...r, endReason: (r as any).endReason } as any),
    simSeconds: Math.max(0, Number(r.simSeconds) || 0),
  });
  saveBook(b);
  return b;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  return s.length % 2 ? s[i] : (s[Math.floor(i)] + s[Math.ceil(i)]) / 2;
}

/**
 * 전체 회차 장부를 요약한다.
 *
 * **'총 회수'가 모드마다 다르다.** 독립 회차는 판마다 따로 넣고 따로
 * 뺐으니 끝 잔고를 더하는 것이 맞다. 연속 복리는 같은 돈이 이어져
 * 흐르므로 더하면 같은 돈을 여러 번 세게 된다 — 마지막 잔고 하나가
 * 지금 손에 있는 전부다.
 */
export function summarize(book: LedgerBook): LedgerSummary {
  const rounds = Array.isArray(book?.rounds) ? book.rounds : [];
  const mode = roundModeOf(book?.mode);
  const n = rounds.length;

  const totalCapitalInjected = rounds.reduce((a, r) => a + (Number(r.capitalInjected) || 0), 0);
  const totalFinalEquity = mode === 'CONTINUOUS_COMPOUND'
    ? (n > 0 ? (Number(rounds[n - 1].endEquity) || 0) : 0)
    : rounds.reduce((a, r) => a + (Number(r.endEquity) || 0), 0);

  const successfulRounds = rounds.filter(r => r.reached).length;
  const ruinedRounds = rounds.filter(r => r.ruined).length;
  // **원금과 비교한다.** 시작 잔고보다 많이 끝났으면 번 회차다.
  // 목표를 못 찍었어도 번 것은 번 것이다.
  const profitableRounds = rounds.filter(
    r => (Number(r.endEquity) || 0) > (Number(r.startEquity) || 0)).length;

  const byEndReason = Object.keys(END_REASON_LABEL).reduce((acc, k) => {
    acc[k as RoundEndReason] = 0; return acc;
  }, {} as Record<RoundEndReason, number>);
  for (const r of rounds) byEndReason[endReasonOf(r)]++;
  const presets = Array.from(new Set(rounds.map(r => presetOf(r.preset))));

  return {
    mode,
    totalRounds: n,
    totalCapitalInjected,
    totalFinalEquity,
    totalNetPnl: totalFinalEquity - totalCapitalInjected,
    successfulRounds,
    failedRounds: n - successfulRounds,
    ruinedRounds,
    // **회차가 없으면 0%가 아니라 '아직 없음'이다.** 0%로 적으면
    // 한 판도 안 돌린 전략이 '성공률 0%'로 보인다.
    profitableRounds,
    targetHitRate: n > 0 ? successfulRounds / n : null,
    profitableRate: n > 0 ? profitableRounds / n : null,
    ruinRate: n > 0 ? ruinedRounds / n : null,
    byEndReason,
    medianRoundEquity: median(rounds.map(r => Number(r.endEquity) || 0)),
    totalTrades: rounds.reduce((a, r) => a + (Number(r.trades) || 0), 0),
    totalWins: rounds.reduce((a, r) => a + (Number(r.wins) || 0), 0),
    totalSimSeconds: rounds.reduce((a, r) => a + (Number(r.simSeconds) || 0), 0),
    mixedPresets: presets.length > 1,
    presets,
  };
}

/** 이 모드의 장부만 지운다. 다른 모드는 그대로다 */
export function clearBook(id: StrategyType, mode: RoundMode): LedgerBook {
  const b = emptyBook(id, roundModeOf(mode));
  saveBook(b);
  return b;
}

/** 두 모드의 장부를 모두 지운다 */
export function clearAllBooks(id: StrategyType): void {
  clearBook(id, 'INDEPENDENT_ROUNDS');
  clearBook(id, 'CONTINUOUS_COMPOUND');
}

export const ALL_ROUND_MODES: RoundMode[] = ['INDEPENDENT_ROUNDS', 'CONTINUOUS_COMPOUND'];
