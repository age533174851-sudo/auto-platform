// src/lib/ledger/ingestTargets.ts
//
// **무엇을 수집할 것인가.**
//
// 별도의 등록 목록을 두지 않는다. 새 연결을 만들 때 어딘가에 또 적어야
// 하면, 언젠가 그 한 줄을 빼먹고 **그 연결의 수수료만 조용히 빠진다.**
// 수집 대상은 언제나 "지금 활성인 거래소 연결 전부"에서 나온다.
//
// 여기서 가르는 것 셋
// ───────────────────
//   · 실전과 테스트넷 — **절대 섞지 않는다** (저장소 규칙: is_testnet === false만 실전)
//   · 거래소별 경로   — binance 연결은 binance API, gate 연결은 gate API
//   · 지원 여부       — 모르는 거래소를 조용히 건너뛰지 않고 그렇다고 말한다

export interface ConnectionRow {
  id?: any;
  exchange_id?: any;
  is_testnet?: any;
  is_active?: any;
}

export type IngestRoute = 'binance' | 'gate' | 'UNSUPPORTED';

export interface IngestTarget {
  connectionId: string;
  /** **`is_testnet === false`일 때만 실전이다.** 그 밖은 전부 테스트넷 */
  env: 'LIVE' | 'TESTNET';
  exchange: string;
  route: IngestRoute;
  supported: boolean;
  reason: string;
}

/**
 * 활성 연결 → 수집 대상.
 *
 * **꺼진 연결은 뺀다.** 그리고 목록 자체를 못 읽었으면 `null`을 그대로
 * 돌려준다 — 빈 배열로 바꾸면 "연결이 없다"가 되고, 그건 수집할 것이
 * 없다는 뜻이 되어 조용히 통과한다.
 */
export function ingestTargetsOf(rows: ConnectionRow[] | null | undefined): IngestTarget[] | null {
  if (!Array.isArray(rows)) return null;
  const out: IngestTarget[] = [];
  for (const c of rows) {
    const connectionId = String(c?.id ?? '');
    if (!connectionId) continue;
    // 꺼 둔 연결은 수집하지 않는다. **모르면 끈 것으로 보지 않는다** —
    // is_active가 null이면 아직 이 칸을 안 쓰던 옛 줄이다.
    if (c?.is_active === false) continue;

    const env: 'LIVE' | 'TESTNET' = c?.is_testnet === false ? 'LIVE' : 'TESTNET';
    const exchange = String(c?.exchange_id ?? '').toLowerCase();
    const route: IngestRoute = exchange === 'binance' ? 'binance'
      : exchange === 'gate' ? 'gate' : 'UNSUPPORTED';

    out.push({
      connectionId, env, exchange, route,
      supported: route !== 'UNSUPPORTED',
      reason: route !== 'UNSUPPORTED' ? ''
        : `${exchange || '(빈 값)'}는 아직 원장 수집을 지원하지 않습니다 — `
          + '이 연결의 수수료·펀딩은 장부에 없습니다',
    });
  }
  return out;
}
