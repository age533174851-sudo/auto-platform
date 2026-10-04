// src/lib/engine/riskObservationEligibility.ts
//
// **이 관측을 "실측"이라고 부를 수 있는가 — 정본은 여기 하나다.**
//
// 이것은 종료 판정이 **아니다**
// ────────────────────────────
// 돌려주는 어떤 값도 "닫아라"를 뜻하지 않는다. 표본 자격만 가른다.
// 시장가 주문과 아무 관련이 없고, 이 파일은 거래소를 바꿀 수단을
// import하지 않는다.
//
// 왜 "HTTP를 실제로 보냈다"로는 부족한가
// ──────────────────────────────────────
// `getSymbolPositionRiskEx`는 **포지션이 없어도 줄을 돌려준다** —
// 신규 진입 전 마진 모드를 알아야 해서 일부러 그렇게 만들었다. 그래서
// 실제 자격증명으로 조회했다는 사실만으로는 "열린 포지션을 관측했다"가
// 되지 않는다. `positionAmt`가 0이면 **없는 포지션의 청산가**를 실측
// 통계에 넣는 것이고, 부호가 반대면 **다른 다리**를 관측한 것이다.
//
// `VERIFIED_TESTNET_OBSERVATION`의 뜻
// ───────────────────────────────────
//   "실제 TESTNET에서 **열려 있는** Exact100X 포지션에서 얻은 런타임 관측"
//
// 이것은 **"모든 위험 데이터가 완벽했다"가 아니다.** 계정 조회가 실패해
// 배율·마진 모드를 못 읽었어도 positionRisk 관측 자체는 실제다 — 그
// 사실은 측정값의 `status`·`liquidationSources`가 말한다. 자격과
// 완전성을 같은 값으로 섞지 않는다.
//
// LIVE는 왜 안 되는가
// ───────────────────
// 이름 그대로다. LIVE 관측이 나중에 필요해지면 **별도의 출처를 별도로
// 설계한다** — 지금 `VERIFIED_LIVE…`를 만들지 않는다. MOCK/TESTNET/LIVE의
// 장부와 자산을 섞지 않는 저장소 규칙이 표본에도 그대로 적용된다.

import { executionIdentityComplete } from '../execution/profile';
import type { ExecutionIdentity } from './managedPosition';

export type RiskObservationEligibility =
  /** 실측으로 적어도 된다 */
  | 'ELIGIBLE'
  /** TESTNET이 아니다. **LIVE를 VERIFIED_TESTNET으로 적지 않는다** */
  | 'NOT_TESTNET'
  /** 이 거래소는 전용 관측 대상이 아니다 */
  | 'VENUE_UNSUPPORTED'
  /** Exact100X 실행 계약이 아니다(또는 반쪽이다) */
  | 'IDENTITY_MISMATCH'
  /** 포지션 응답을 못 읽었거나 수량이 숫자가 아니다 */
  | 'POSITION_UNUSABLE'
  /** 수량이 0이다 — **열린 포지션이 아니다** */
  | 'NO_POSITION'
  /** 부호가 장부의 방향과 다르다 — 다른 다리를 본 것이다 */
  | 'SIDE_MISMATCH';

export interface RiskObservationEligibilityInput {
  /** 이 연결이 테스트넷인가. **못 읽었으면 null이고 통과가 아니다** */
  testnet: boolean | null | undefined;
  exchange: string | null | undefined;
  side: 'LONG' | 'SHORT' | null | undefined;
  executionIdentity: ExecutionIdentity | null | undefined;
  /**
   * 거래소가 답한 **부호 있는** 수량. 0이면 포지션 없음.
   *
   * 절댓값을 받지 않는다 — 부호가 사라지면 방향을 대조할 수 없고,
   * 그러면 헤지 계좌의 반대 다리를 이 포지션으로 적게 된다.
   */
  positionAmt: number | null | undefined;
}

export interface RiskObservationEligibilityVerdict {
  code: RiskObservationEligibility;
  /** 실측 통계에 넣어도 되는가 */
  eligible: boolean;
  /** 왜 아닌가. 통과면 빈 문자열 */
  reason: string;
}

const no = (
  code: RiskObservationEligibility, reason: string,
): RiskObservationEligibilityVerdict => ({ code, eligible: false, reason });

/**
 * **표본 자격만 판단한다.** 종료 판정이 아니다.
 */
export function verifiedTestnetObservationEligibility(
  i: RiskObservationEligibilityInput | null | undefined,
): RiskObservationEligibilityVerdict {
  // ① 망 — `true`만 통과한다. 못 읽은 null은 통과가 아니다.
  if (i?.testnet !== true) {
    return no('NOT_TESTNET',
      `VERIFIED_TESTNET은 테스트넷에서만 성립합니다 (testnet=${String(i?.testnet)})`
      + ' — LIVE 관측이 필요하면 별도 출처를 별도로 설계합니다');
  }
  // ② 거래소 — 전용 경로가 지원하는 곳만
  if (i.exchange !== 'binance') {
    return no('VENUE_UNSUPPORTED',
      `전용 Exact100X 관측은 binance에서만 합니다 (${i.exchange || '알 수 없음'})`);
  }
  // ③ 실행 계약 — 반쪽이면 어느 계약의 노출인지 모른다
  if (!executionIdentityComplete(i.executionIdentity ?? undefined)) {
    return no('IDENTITY_MISMATCH',
      '실행 계약 기록이 없거나 반쪽입니다 — 어느 계약의 노출인지 모릅니다');
  }
  if (i.side !== 'LONG' && i.side !== 'SHORT') {
    return no('POSITION_UNUSABLE', `장부의 방향을 읽지 못했습니다 (${String(i.side)})`);
  }
  // ④ 수량 — **숫자인가**. NaN·Infinity·null은 전부 못 쓴다.
  const amt = typeof i.positionAmt === 'number' ? i.positionAmt : Number(i.positionAmt);
  if (i.positionAmt == null || typeof i.positionAmt === 'boolean'
      || !Number.isFinite(amt)) {
    return no('POSITION_UNUSABLE',
      `포지션 수량을 읽지 못했습니다 (${String(i.positionAmt)})`
      + ' — 못 읽은 것은 0이 아닙니다');
  }
  // ⑤ 열려 있는가. **0은 열린 포지션이 아니다**
  if (amt === 0) {
    return no('NO_POSITION',
      '거래소에 열린 포지션이 없습니다 — 없는 포지션의 청산가를 실측으로 적지 않습니다');
  }
  // ⑥ 방향이 맞는가. **부호가 다르면 다른 다리다**
  const observed: 'LONG' | 'SHORT' = amt > 0 ? 'LONG' : 'SHORT';
  if (observed !== i.side) {
    return no('SIDE_MISMATCH',
      `장부는 ${i.side}인데 거래소 수량은 ${observed}입니다 (${amt})`
      + ' — 이 후보의 포지션을 관측한 것이 아닙니다');
  }
  return { code: 'ELIGIBLE', eligible: true, reason: '' };
}
