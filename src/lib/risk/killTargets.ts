// src/lib/risk/killTargets.ts
//
// **줄일 대상을 만드는 자리. 라우트 안에 있으면 테스트가 못 본다.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// 라우트가 거래소 포지션을 읽어 놓고 수량을 이렇게 꺼냈다:
//
//     qty: Math.abs(Number(p.qty ?? p.positionAmt ?? 0))
//
// 그런데 `futuresListPositions()`가 돌려주는 `ExecPosition`의 수량 칸은
// **`amount`**다. `qty`도 `positionAmt`도 없다. 그래서 **포지션이 둘
// 있어도 전부 0으로 떨어져 걸러지고**, `live = []` → 대상 0건 →
// `VERIFIED_EMPTY` → "줄일 포지션 없음(거래소 확인)" → 완료.
//
// **읽기는 성공했는데 아무것도 안 줄이고 성공이라고 답한다.**
// REDUCE_RISK에서 이건 "절반으로 줄였다"는 말이 통째로 거짓이 되는 것이다.
//
// 순수 판정 테스트(`discoveryVerdict({ targetCount: 2 })`)는 이걸 못 잡는다.
// 숫자를 손으로 넣기 때문이다. **거래소가 실제로 주는 모양**으로
// 시작해서 대상까지 만들어 봐야 잡힌다 — 그래서 이 파일이 있다.
import type { LevelSpec } from './emergencyLevel';
import { closeTargets } from './emergencyLevel';
import { discoveryVerdict, type DiscoveryVerdict } from './killSwitchTruth';

/** `futuresListPositions()`가 주는 모양 중 여기서 쓰는 것만 */
export interface PositionLike {
  symbol: string;
  /** **기초자산 수량(절대값).** ExecPosition의 칸 이름이 이것이다 */
  amount: number | null;
  side?: 'LONG' | 'SHORT';
}

export interface LivePosition { symbol: string; qty: number }

/**
 * 거래소 포지션 → 대상 후보.
 *
 * **`amount`만 읽는다.** 다른 이름으로 넘어오면 그건 다른 모양이고,
 * 조용히 0으로 만들지 않고 그냥 안 잡힌다 — 그리고 그 사실은 개수로
 * 드러난다(`positionsRead`는 true인데 후보가 0이면 이상한 것이다).
 */
export function liveFromPositions(positions: PositionLike[] | null | undefined): LivePosition[] {
  if (!Array.isArray(positions)) return [];
  const out: LivePosition[] = [];
  for (const p of positions) {
    const symbol = String(p?.symbol || '').toUpperCase();
    if (!symbol) continue;
    const n = Number(p?.amount);
    if (!Number.isFinite(n)) continue;
    const qty = Math.abs(n);
    if (qty <= 0) continue;
    out.push({ symbol, qty });
  }
  return out;
}

export interface TargetPlan {
  live: LivePosition[];
  targets: Array<{ symbol: string; qty: number | null; reason: string }>;
  discovery: DiscoveryVerdict;
  note: string;
}

/**
 * 대상을 만든다. **거래소 포지션에서 시작한다.**
 *
 * 장부(`live_orders`)는 "어느 것이 봇의 것인가"를 가릴 때만 쓴다 —
 * 무엇이 열려 있는지는 거래소가 답할 일이다. 예전에는 후보 자체를
 * 장부에서 만들어서, 장부에 줄이 없으면 거래소에 포지션이 있어도
 * 아무것도 줄이지 않았다.
 */
export function targetPlan(i: {
  spec: LevelSpec | null | undefined;
  positions: PositionLike[] | null;
  /** 거래소 포지션 목록을 읽었는가 */
  positionsRead: boolean;
  /** live_orders를 읽었는가 */
  ledgerRead: boolean;
  /** 봇이 연 심볼 */
  autoSymbols: Set<string>;
}): TargetPlan {
  const live = liveFromPositions(i.positions);
  const plan = closeTargets(i.spec as any, live as any, i.autoSymbols);
  const targets = (plan.targets || []) as TargetPlan['targets'];
  return {
    live,
    targets,
    note: plan.note || '',
    discovery: discoveryVerdict({
      spec: i.spec ? { closePct: i.spec.closePct, automatedOnly: i.spec.automatedOnly } : null,
      positionsRead: i.positionsRead,
      ledgerRead: i.ledgerRead,
      targetCount: targets.length,
    }),
  };
}

export interface ClosedRecord {
  symbol: string; ok: boolean; message: string;
  before: number | null; after: number | null; closePct: number;
}

/**
 * 대상마다 실제로 닫고 **다시 읽어 확인한다.**
 *
 * 접수는 체결이 아니다. `r.success`만 모으면 "주문을 넣었다"까지이고,
 * 실제로 줄었는지는 포지션을 다시 읽어야 안다.
 *
 * 라우트에 있던 루프를 그대로 옮겼다 — **닫기가 몇 번 불렸는지**를
 * 테스트가 셀 수 있어야 하기 때문이다.
 */
export async function runTargetedCloses(i: {
  targets: Array<{ symbol: string }>;
  live: LivePosition[];
  closePct: number;
  close: (symbol: string, pct: number) => Promise<{ success: boolean; message: string }>;
  readBack: (symbol: string) => Promise<number | null>;
}): Promise<ClosedRecord[]> {
  const out: ClosedRecord[] = [];
  for (const t of i.targets) {
    const before = i.live.find(l => l.symbol === t.symbol)?.qty ?? null;
    const r = await i.close(t.symbol, i.closePct);
    // 못 읽으면 null이다 — 0으로 적으면 "닫혔다"가 사실이 된다.
    let after: number | null = null;
    if (r.success) {
      try {
        const a = await i.readBack(t.symbol);
        after = a == null || !Number.isFinite(Number(a)) ? null : Math.abs(Number(a));
      } catch { after = null; }
    }
    out.push({
      symbol: t.symbol, ok: !!r.success, message: r.message,
      before, after, closePct: i.closePct,
    });
  }
  return out;
}
