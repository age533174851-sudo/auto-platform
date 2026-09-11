// src/lib/engine/entryAuthority.ts
//
// **신규 진입을 낼 권한이 있는가 — 거래소를 건드리기 전에 정한다.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 전용 100배 경로는 크기를 만들기 위해 거래소에 **쓴다** — 배율을 걸고
// 되읽는다. 그런데 그 호출이 운영 모드·연결 확인보다 앞에 놓여 있었다.
//
//   loadConnection
//   → planEntry100x  → futuresApplyLeverage   ← 거래소 WRITE
//   → …
//   → MODE_CONN_MISMATCH                       ← 여기서 막힘
//
// 요청이 TESTNET인데 연결이 실계좌면 주문은 막힌다. 그런데 **그 전에
// 실계좌의 배율이 이미 바뀐 뒤다.** 주문이 안 나갔으니 괜찮다고 볼 수
// 없다 — 사용자 계좌의 설정이 바뀌었고, 그 자리에 다른 포지션이 있었다면
// 청산가가 함께 움직인다.
//
// 킬 스위치도 같다. "지금 멈춰"를 눌러 둔 계좌에 배율 설정이 나가면,
// 멈춘 것이 아니다.
//
// 그래서 지켜야 할 불변식은 하나다:
//
//   **신규 진입이 권한 단계에서 막힐 요청은 거래소 상태를 바꾸지 않는다.**
//
// 왜 순수 함수인가
// ────────────────
// 라우트 안에 `if`로 흩어 두면 순서가 시험되지 않는다. 실제로 그렇게
// 흩어져 있었고, 그래서 순서가 뒤집힌 것을 아무도 못 봤다. 사실을 모으는
// 것(네트워크·DB)은 호출부에 남기고, **무엇이 먼저 막는가**만 여기서
// 정한다. 그러면 그 순서를 시험이 직접 확인할 수 있다.

export type EntryAuthorityCode =
  /** 통과 */
  | 'OK'
  /** 이 연결로는 선물 주문을 낼 수 없다 */
  | 'NO_CONNECTION'
  /** 요청 모드와 연결의 망(실전/테스트넷)이 어긋난다 */
  | 'MODE_CONN_MISMATCH'
  /** 사용자가 이 계좌를 멈춰 뒀다 */
  | 'KILL_SWITCH'
  /** 마이그레이션이 밀려 신규 진입을 막는다 */
  | 'MIGRATION_PENDING'
  /** 이 배포에서 실거래가 닫혀 있다 */
  | 'LIVE_TRADING_CLOSED';

export interface EntryAuthorityFacts {
  /** 선물 주문이 가능한 거래소인가 (binance | gate) */
  exchangeSupported: boolean;
  exchangeName?: string;
  /** 연결이 실계좌인가 */
  connIsLive: boolean;
  /** 이 운영 모드가 실계좌 키를 요구하는가 */
  modeNeedsLiveKey: boolean;
  /** 킬 스위치가 막고 있으면 그 이유. 아니면 '' */
  killSwitchReason?: string;
  /** 마이그레이션이 막고 있으면 그 이유. 아니면 '' */
  migrationReason?: string;
  /** 이 배포에서 실거래가 닫혀 있으면 그 이유. 아니면 '' */
  liveClosedReason?: string;
}

export interface EntryAuthorityVerdict {
  allowed: boolean;
  code: EntryAuthorityCode;
  reason: string;
}

const no = (code: EntryAuthorityCode, reason: string): EntryAuthorityVerdict =>
  ({ allowed: false, code, reason });

/**
 * 이 요청이 신규 진입을 낼 권한을 갖는가.
 *
 * **순서가 계약의 일부다.** 목적지가 어긋난 요청(모드↔연결)을 가장 먼저
 * 본다 — 그것이 틀리면 이후의 모든 거래소 호출이 **엉뚱한 계좌로** 간다.
 * 킬 스위치가 그다음이다: 사용자가 명시적으로 멈춰 둔 계좌는 읽기 외에는
 * 건드리지 않는다.
 */
export function entryAuthorityVerdict(f: EntryAuthorityFacts): EntryAuthorityVerdict {
  if (!f.exchangeSupported) {
    return no('NO_CONNECTION',
      `${f.exchangeName || '이 거래소'} 연결로는 선물 주문을 낼 수 없습니다`);
  }
  // **목적지가 먼저다.** 어긋난 채로 진행하면 실계좌 키로 데모를 두드리거나,
  // 테스트넷인 줄 알고 실계좌 설정을 바꾼다.
  if (f.connIsLive !== f.modeNeedsLiveKey) {
    return no('MODE_CONN_MISMATCH',
      f.connIsLive
        ? '실전 연결인데 요청한 운영 모드는 실계좌 키를 쓰지 않습니다'
        : '테스트넷 연결인데 요청한 운영 모드는 실계좌 키를 요구합니다');
  }
  if (f.killSwitchReason) return no('KILL_SWITCH', f.killSwitchReason);
  if (f.migrationReason) return no('MIGRATION_PENDING', f.migrationReason);
  if (f.liveClosedReason) return no('LIVE_TRADING_CLOSED', f.liveClosedReason);
  return { allowed: true, code: 'OK', reason: '' };
}

/**
 * 권한을 먼저 묻고, **통과했을 때만** 거래소를 건드린다.
 *
 * 이 함수가 하는 일은 하나뿐이다 — `mutate`가 권한 뒤에 오도록 강제한다.
 * 라우트에서 순서로만 지키면 나중에 누가 줄을 옮기고, 그 변경은 diff에서
 * 위험해 보이지 않는다. 여기로 묶으면 순서가 **타입과 시험이 있는 구조**가
 * 된다: 막힌 요청에서 `mutate`가 불렸는지 시험이 직접 셀 수 있다.
 */
export async function guardedEntry<T>(
  facts: EntryAuthorityFacts,
  mutate: () => Promise<T>,
): Promise<{ verdict: EntryAuthorityVerdict; result: T | null }> {
  const verdict = entryAuthorityVerdict(facts);
  if (!verdict.allowed) return { verdict, result: null };
  return { verdict, result: await mutate() };
}
