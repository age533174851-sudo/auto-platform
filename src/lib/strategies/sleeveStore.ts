// src/lib/strategies/sleeveStore.ts
//
// **전략 계좌 장부를 읽고 쓴다.**
//
// `sleeveLedger.ts`는 순수 판정이다 — 이 계좌가 이 심볼을 얼마나
// 소유하는가, 이만큼 닫아도 되는가, 낙폭이 한도를 넘었는가. 그런데
// 그 상태를 **어디에도 담아 두지 않아서 판정할 대상이 없었다.**
// 엔진은 있는데 배선이 없는, 이 저장소에서 가장 자주 나는 고장이다.
//
// 이 파일이 그 사이를 잇는다. 두 가지만 한다:
//  1. 표의 행 ↔ SleeveState 로 옮긴다 (순수 함수 — 테스트가 붙는다)
//  2. 그 옮기기를 감싼 읽기·쓰기 (표가 없으면 조용히 비켜선다)
//
// 표가 없으면 어떻게 되는가
// ─────────────────────────
// **아무것도 막지 않는다.** 마이그레이션 041을 안 돌린 상태에서
// 소유권을 강제하면, 모든 주문이 "어느 전략 계좌 것인지 모른다"로
// 막힌다 — 그리고 그걸 푸는 유일한 방법이 SQL 실행이다.
//
// 권한 표(039)에서 정확히 그 실수를 한 번 했다. 아직 아무도 설정하지
// 않은 정책을 강제하는 것은 안전이 아니라 고장이다.

import type { SleeveState, SleeveSpec, SleeveStage } from './sleeveLedger';
import { STAGE_ORDER, freshSleeve, canClose } from './sleeveLedger';

export interface SleeveRow {
  id?: any;
  user_id?: any;
  sleeve_id?: any;
  label?: any;
  connection_id?: any;
  allocated?: any;
  risk_per_trade_pct?: any;
  max_drawdown_pct?: any;
  max_leverage?: any;
  stage?: any;
  reserved_margin?: any;
  realized_pnl?: any;
  unrealized_pnl?: any;
  fees?: any;
  peak_equity?: any;
  max_drawdown_seen_pct?: any;
  positions?: any;
  halted?: any;
  halt_reason?: any;
}

/** 표에서 읽은 한 계좌. 장부(state)와 설정(spec)을 같이 들고 있다 */
export interface SleeveRecord {
  /** 표의 기본키. 주문에 새기는 값이다 */
  rowId: string | null;
  spec: SleeveSpec;
  state: SleeveState;
  connectionId: string | null;
  halted: boolean;
  haltReason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const n0 = (v: any): number => num(v) ?? 0;
const str = (v: any): string => (v == null ? '' : String(v));

/** 알 수 없는 단계는 **가장 앞으로** 본다 — 오타가 실전이 되면 안 된다 */
export function stageOf(v: any): SleeveStage {
  const s = str(v).trim().toUpperCase();
  return (STAGE_ORDER as string[]).includes(s) ? (s as SleeveStage) : 'SPECIFICATION';
}

/**
 * 소유 수량 맵을 읽는다.
 *
 * **숫자가 아닌 값은 버린다.** jsonb는 무엇이든 담을 수 있고, 문자열
 * 하나가 섞이면 그 뒤의 모든 산술이 NaN이 된다 — 그리고 NaN은 비교에서
 * 언제나 false라, 소유권 검사가 조용히 통과한다.
 *
 * 0은 지운다. 0을 들고 있으면 "이 심볼을 소유한다(수량 0)"와 "안
 * 갖고 있다"가 같은 모양이 된다.
 */
export function positionsOf(v: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const k of Object.keys(v)) {
    const q = num((v as any)[k]);
    if (q == null || q === 0) continue;
    const sym = str(k).trim().toUpperCase();
    if (!sym) continue;
    out[sym] = q;
  }
  return out;
}

/**
 * 표의 행 → 계좌 기록.
 *
 * **peak_equity가 0이면 배정액으로 올린다.** 0으로 두면 낙폭이 언제나
 * 0%로 계산되고(최고점이 0이니까), 낙폭 정지가 영영 안 걸린다.
 */
export function recordOf(row: SleeveRow | null | undefined): SleeveRecord | null {
  if (!row) return null;
  const sleeveId = str(row.sleeve_id).trim();
  if (!sleeveId) return null;

  const allocated = Math.max(0, n0(row.allocated));
  const spec: SleeveSpec = {
    id: sleeveId,
    label: str(row.label) || sleeveId,
    allocated,
    riskPerTradePct: num(row.risk_per_trade_pct),
    maxDrawdownPct: num(row.max_drawdown_pct),
    maxLeverage: num(row.max_leverage),
    stage: stageOf(row.stage),
  };

  const base = freshSleeve(spec);
  const state: SleeveState = {
    ...base,
    reservedMargin: Math.max(0, n0(row.reserved_margin)),
    realizedPnl: n0(row.realized_pnl),
    unrealizedPnl: n0(row.unrealized_pnl),
    fees: Math.max(0, n0(row.fees)),
    peakEquity: Math.max(n0(row.peak_equity), allocated),
    maxDrawdownPct: Math.max(0, n0(row.max_drawdown_seen_pct)),
    positions: positionsOf(row.positions),
  };

  return {
    rowId: row.id == null || row.id === '' ? null : String(row.id),
    spec, state,
    connectionId: row.connection_id == null || row.connection_id === ''
      ? null : String(row.connection_id),
    halted: row.halted === true,
    haltReason: str(row.halt_reason),
  };
}

/** 계좌 기록 → 표에 쓸 값. 읽기와 같은 칸 이름을 쓴다 */
export function rowOf(r: SleeveRecord): SleeveRow {
  return {
    sleeve_id: r.spec.id,
    label: r.spec.label,
    connection_id: r.connectionId,
    allocated: r.spec.allocated,
    risk_per_trade_pct: r.spec.riskPerTradePct ?? null,
    max_drawdown_pct: r.spec.maxDrawdownPct ?? null,
    max_leverage: r.spec.maxLeverage ?? null,
    stage: stageOf(r.spec.stage),
    reserved_margin: r.state.reservedMargin,
    realized_pnl: r.state.realizedPnl,
    unrealized_pnl: r.state.unrealizedPnl,
    fees: r.state.fees,
    peak_equity: r.state.peakEquity,
    max_drawdown_seen_pct: r.state.maxDrawdownPct,
    positions: r.state.positions,
    halted: r.halted,
    halt_reason: r.haltReason,
  };
}

export interface SleeveLoad {
  /** 표가 설치되어 있는가. false면 **아무것도 막지 않는다** */
  installed: boolean;
  /** 실제로 읽었는가 */
  known: boolean;
  records: SleeveRecord[];
  reason: string;
}

/**
 * 표가 없어서 실패한 것인가.
 *
 * 코드를 먼저 본다. 문구만 보고 가리면 다른 오류가 '설치 안 됨'으로
 * 읽혀 소유권 검사가 통째로 열린다.
 */
function isMissingTable(err: any): boolean {
  const code = String(err?.code ?? '');
  if (code) return code === '42P01' || code === 'PGRST205';
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table');
}

export async function loadSleeves(sb: any, userId: string | null | undefined): Promise<SleeveLoad> {
  if (!sb || !userId) {
    return { installed: true, known: false, records: [],
      reason: '사용자를 확인하지 못했습니다' };
  }
  try {
    const { data, error } = await (sb as any).from('strategy_accounts')
      .select('*').eq('user_id', userId);
    if (error) {
      if (isMissingTable(error)) {
        return { installed: false, known: false, records: [],
          reason: '전략 계좌 표가 아직 설치되지 않았습니다 — '
                + '마이그레이션 041_strategy_accounts.sql을 실행하기 전까지는 소유권을 강제하지 않습니다' };
      }
      // **못 읽은 것을 '계좌 없음'으로 치지 않는다.** 빈 배열로 돌려주면
      // 모든 포지션이 주인 없는 것이 되고, 소유권 검사가 통째로 통과한다.
      return { installed: true, known: false, records: [],
        reason: `전략 계좌를 읽지 못했습니다 (${error.message})` };
    }
    const records = (Array.isArray(data) ? data : [])
      .map(recordOf).filter(Boolean) as SleeveRecord[];
    return { installed: true, known: true, records, reason: '' };
  } catch (e: any) {
    if (isMissingTable(e)) {
      return { installed: false, known: false, records: [],
        reason: '전략 계좌 표가 아직 설치되지 않았습니다' };
    }
    return { installed: true, known: false, records: [],
      reason: `전략 계좌 조회 실패 (${e?.message || e})` };
  }
}

export interface SaveResult { ok: boolean; error: string; rowId: string | null }

/** 한 계좌를 저장한다(없으면 만든다). 소유자는 인자로 받은 값이 정한다 */
export async function saveSleeve(
  sb: any, userId: string, r: SleeveRecord,
): Promise<SaveResult> {
  if (!sb || !userId) return { ok: false, error: '사용자를 확인하지 못했습니다', rowId: null };
  try {
    const payload = { ...rowOf(r), user_id: userId, updated_at: new Date().toISOString() };
    const { data, error } = await (sb as any).from('strategy_accounts')
      .upsert(payload, { onConflict: 'user_id,sleeve_id' })
      .select('id').maybeSingle();
    if (error) {
      return { ok: false, error: isMissingTable(error)
        ? '전략 계좌 표가 아직 설치되지 않았습니다 (041)'
        : String(error.message || error), rowId: null };
    }
    return { ok: true, error: '', rowId: data?.id == null ? null : String(data.id) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), rowId: null };
  }
}

// ── 소유권 ────────────────────────────────────────────────

export interface OwnerVerdict {
  /** 이 청산을 허용하는가 */
  allowed: boolean;
  /** 소유권 규칙이 실제로 걸렸는가. false면 표가 없거나 계좌를 안 지정한 것 */
  enforced: boolean;
  reason: string;
  /** 이 계좌가 이 심볼에서 소유한 수량 */
  ownedQty: number | null;
}

/**
 * 이 전략 계좌가 이만큼 닫아도 되는가.
 *
 * **막는 자리가 정확해야 한다.** 넓게 막으면 손으로 누르는 청산까지
 * 막히고, 그러면 사용자가 자기 포지션을 못 닫는다 —
 * 못 여는 것은 불편이고 못 닫는 것은 사고다.
 *
 * 그래서 막는 것은 **전략 계좌를 지목한 청산뿐**이다:
 *  · 계좌를 안 지목했으면(수동 주문) 통과한다
 *  · 표가 없으면 통과한다
 *  · 읽지 못했으면 **막는다** — 그건 진짜 모름이고, 모르는 위에서
 *    남의 포지션을 닫으면 되돌릴 수 없다
 */
export function checkOwnership(
  load: SleeveLoad, sleeveId: string | null | undefined,
  symbol: string, qty: number,
): OwnerVerdict {
  const id = str(sleeveId).trim();
  if (!id) {
    return { allowed: true, enforced: false, ownedQty: null,
      reason: '전략 계좌를 지정하지 않은 주문입니다 — 소유권을 따지지 않습니다' };
  }
  if (!load.installed) {
    return { allowed: true, enforced: false, ownedQty: null,
      reason: load.reason };
  }
  if (!load.known) {
    return { allowed: false, enforced: true, ownedQty: null,
      reason: `${load.reason} — 어느 전략의 포지션인지 모르는 채로 닫지 않습니다` };
  }
  const rec = load.records.find(r => r.spec.id === id);
  if (!rec) {
    return { allowed: false, enforced: true, ownedQty: null,
      reason: `전략 계좌 ${id}를 찾지 못했습니다` };
  }
  const c = canClose(rec.state, symbol, qty);
  return {
    allowed: c.allowed, enforced: true,
    ownedQty: c.owned ?? null,
    reason: c.reason,
  };
}
