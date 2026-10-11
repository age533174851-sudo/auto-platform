// src/lib/engine/holdingEvidence.ts
//
// "이 장부 줄이 거래소에 수량을 내보냈을 수 있는가"를 판단하는 정본.
//
// ── 왜 필요해졌나 ──
//
//   보유·중복 보유 판정을 하는 네 곳이 각각 `['FILLED','RECONCILED']`를
//   직접 적고 있었다. 그런데 `RECONCILED`는 "끝났다"는 뜻이고, 대조가
//   거래소에 **아직 열려 있는** 주문까지 종료로 적던 동안에는 그 목록이
//   우연히 맞았다. 그 거짓을 고치면(reconcileLedgerStatus) 열린 주문은
//   `ACKED`로 남는데, 네 곳이 `ACKED`를 안 보므로 **부분 체결된 포지션이
//   보유 판정에서 사라진다.** 한쪽을 고치면 반대쪽이 틀어지는 자리다.
//
//   그래서 목록을 한곳에 두고 뜻을 적는다: **보유 가능성**이다. 확정된
//   체결만 세는 것이 아니다 — 확인하지 못한 것을 "없다"로 읽지 않는다.
//
// ── 여기에 넣지 않는 것 ──
//
//   `UNKNOWN`·`SENT`·`INTENT`는 **거래소에 닿았는지도 모르는** 상태다.
//   보유로 세면 영구히 진입이 막힌다. 그쪽은 계좌 용량 관문
//   (`UNRESOLVED_ENTRY_STATUSES`)이 따로 막는다 — 두 질문이 다르다.
//
//   `completedTrades`(모드 승급)처럼 **완주한 거래**를 세는 자리에는 쓰지
//   않는다. 열려 있는 주문은 완주가 아니다.

/**
 * 거래소에 수량이 나갔을 수 있는 장부 상태.
 *
 * · `FILLED`     — 체결 확정
 * · `RECONCILED` — 끝났다. 체결이었는지는 거래 내역에서 확인한다
 * · `ACKED`      — 거래소가 접수했다. 부분 체결 수량이 이 상태로 남는다
 */
export const HOLDING_EVIDENCE_STATUSES = ['FILLED', 'RECONCILED', 'ACKED'] as const;

export type HoldingEvidenceStatus = typeof HOLDING_EVIDENCE_STATUSES[number];
