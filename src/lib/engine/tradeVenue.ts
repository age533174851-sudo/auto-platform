// src/lib/engine/tradeVenue.ts
//
// **이 거래가 어느 계좌에서 열렸는가.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// 청산 감시는 거래마다 계좌를 이렇게 골랐다:
//
//     sb.from('exchange_connections')
//       .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle()
//
// **거래를 보지 않는다.** 그 사용자의 활성 연결 중 아무거나 첫 줄이다.
// 바이낸스 테스트넷과 Gate 테스트넷을 둘 다 연결해 두면, Gate에서 연
// 포지션의 트레일링을 바이낸스 봉으로 계산하고 **청산 주문도 바이낸스로**
// 나간다. 저장소 규칙("symbol만 보고 주문 소유권을 판단하지 않는다")을
// 어기는 정도가 아니라 거래를 아예 안 보는 것이다.
//
// 그런데 `ladder_daily_trades`에는 연결을 적는 칸이 없었다. 그래서
// 칸을 먼저 만들고(068), 그 값으로 고른다.
//
// 옛 줄은 어떻게 하나
// ───────────────────
// 마이그레이션 전에 열린 포지션은 `connection_id`가 비어 있다. 그걸
// 이유로 감시를 멈추면 **지금 열려 있는 포지션이 보호를 잃는다.**
// 그렇다고 아무 계좌나 고르면 위의 사고가 그대로다.
//
// 가르는 기준은 하나다: **틀릴 수 있는가.**
//
//   활성 연결이 하나뿐 → 그 하나가 답이다 (틀릴 여지가 없다)
//   둘 이상          → **모른다.** 고르지 않는다

export interface ConnectionLike {
  id: string;
  exchange: 'binance' | 'gate' | null;
  testnet: boolean;
}

export type VenueCode =
  /** 거래에 적힌 연결을 찾았다 */
  | 'OWNED'
  /** 거래에 안 적혔지만 활성 연결이 하나뿐이라 틀릴 여지가 없다 */
  | 'SOLE'
  /** 안 적혔고 후보가 여럿이다. **고르지 않는다** */
  | 'AMBIGUOUS'
  /** 적힌 연결이 지금 없다(비활성·삭제). 남의 계좌로 보내지 않는다 */
  | 'GONE'
  /** 쓸 수 있는 연결이 없다 */
  | 'NONE';

export interface VenueVerdict {
  code: VenueCode;
  /** 이 거래에 쓸 연결. **고르지 못했으면 null** */
  connection: ConnectionLike | null;
  /** 손대도 되는가 */
  actionable: boolean;
  reason: string;
}

/**
 * 이 거래를 어느 연결로 다룰 것인가.
 *
 * **못 고른 것을 "첫 번째 연결"로 채우지 않는다.** 청산·손절 이동은
 * 실제 돈이 나가는 동작이라, 계좌를 잘못 고르면 남의 포지션을 건드린다.
 */
export function tradeVenueOf(i: {
  /** 거래 줄에 적힌 연결 id. 옛 줄은 null이다 */
  tradeConnectionId: string | null | undefined;
  /** 이 사용자의 **활성** 연결들 */
  connections: ConnectionLike[] | null | undefined;
}): VenueVerdict {
  const list = Array.isArray(i?.connections) ? i.connections.filter(c => c && c.id) : [];
  const wanted = String(i?.tradeConnectionId || '').trim();

  if (list.length === 0) {
    return { code: 'NONE', connection: null, actionable: false,
      reason: '쓸 수 있는 거래소 연결이 없습니다' };
  }

  if (wanted) {
    const hit = list.find(c => String(c.id) === wanted) ?? null;
    if (hit) {
      return { code: 'OWNED', connection: hit, actionable: true,
        reason: '이 거래가 열린 연결을 찾았습니다' };
    }
    // **다른 연결로 대체하지 않는다.** 이 포지션이 있는 계좌가 아니다.
    return { code: 'GONE', connection: null, actionable: false,
      reason: '이 거래가 열린 연결이 지금 활성 목록에 없습니다 — '
        + '다른 계좌로 청산 주문을 보내지 않습니다' };
  }

  if (list.length === 1) {
    return { code: 'SOLE', connection: list[0], actionable: true,
      reason: '거래에 연결이 적혀 있지 않지만 활성 연결이 하나뿐입니다' };
  }

  return { code: 'AMBIGUOUS', connection: null, actionable: false,
    reason: `거래에 연결이 적혀 있지 않고 활성 연결이 ${list.length}개입니다 — `
      + '어느 계좌의 포지션인지 확인할 수 없어 손대지 않습니다' };
}
