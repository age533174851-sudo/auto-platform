// src/lib/risk/killAlert.ts
//
// **알림 문구는 사람이 읽고 손을 떼는 자리다.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// 자동 손실한도 발동은 지금 **웹 서버가 직접** `executeKillActions`를
// 실행한다. 그런데 텔레그램은 여전히 이렇게 보냈다:
//
//     Worker가 Cancel All → Close All 실행 예정
//
// 네 가지가 동시에 거짓이다:
//
//   · Worker가 하는 일이 아니다 — 이 요청이 이미 실행했다
//   · "실행 예정"이 아니다 — 끝난 뒤에 보내는 알림이다
//   · 기본 조합은 `BC`라 **포지션을 닫지 않는다.** 그런데 Close All이라 적었다
//   · Gate 연결인데 `exchange: 'Binance'`로 하드코딩돼 있었다
//
// 그리고 잔여 재확인 알림은 `clean === false`면 무조건
// "잔여 포지션/주문이 남아있습니다"라고 적었다. `clean=false`에는
// **조회 실패(UNKNOWN)** 도 들어간다 — 남은 것이 확인된 것과 확인하지
// 못한 것을 다시 섞는 것이고, 이 PR이 다른 자리에서 없앤 바로 그 모양이다.
//
// 급할 때 누른 사람은 이 문구를 읽고 거래소를 안 본다. 그래서 여기서
// 가장 위험한 실패는 "안 됐다"가 아니라 **"됐다고 말하는 것"**이다.
import { intentOf } from './killSwitchTruth';
import type { LeftoverVerdict } from './killSwitchTruth';

export interface AlertPayload {
  level: 'critical' | 'warning' | 'info';
  eventType: string;
  exchange: string;
  mode: 'TESTNET' | 'LIVE';
  title: string;
  message: string;
  fields: Record<string, string | number>;
}

/** 거래소 이름. **모르면 지어내지 않는다** */
export function exchangeLabel(exchange: string | null | undefined): string {
  const e = String(exchange || '').trim().toLowerCase();
  if (!e) return '알 수 없음';
  if (e === 'binance') return 'Binance';
  if (e === 'gate' || e === 'gateio' || e === 'gate.io') return 'Gate.io';
  return String(exchange);
}

/** 이번 조합이 무엇을 하기로 했는가. **한 적 없는 일을 적지 않는다** */
export function intendedActions(actionMode: string | null | undefined): string {
  const it = intentOf(actionMode);
  const parts: string[] = ['신규 주문 차단'];
  if (it.cancel) parts.push('미체결 취소');
  if (it.close) parts.push('포지션 종료');
  return parts.join(' · ');
}

/**
 * 발동 알림.
 *
 * **하기로 한 것과 실행 결과만 말한다.** 거래소가 확인해 준 적 없는
 * "완료"를 적지 않는다 — 확인은 잔여 재확인 알림이 따로 한다.
 */
export function killTriggerAlert(i: {
  actionMode: string | null | undefined;
  exchange: string | null | undefined;
  testnet: boolean;
  reason: string | null | undefined;
  equity: number | null;
  /** 실행 결과. `ran === false`면 실행 자체를 못 한 것이다 */
  exec: { ran?: boolean; message?: string | null; error?: string | null } | null | undefined;
}): AlertPayload {
  const ran = i.exec?.ran === true;
  const intended = intendedActions(i.actionMode);

  // **"실행 예정"이라고 쓰지 않는다.** 이 알림은 실행한 뒤에 나간다.
  const message = ran
    ? '자동 손실 한도를 넘어 킬스위치가 발동했습니다. '
      + '신규 주문은 차단됐으며 거래소 작업 결과를 확인 중입니다.'
    : '자동 손실 한도를 넘어 킬스위치가 발동했습니다. '
      + '신규 주문은 차단됐지만 **거래소 작업을 실행하지 못했습니다** — 거래소에서 직접 확인하세요.';

  const fields: Record<string, string | number> = {
    Reason: String(i.reason || '한도 초과'),
    Action: String(i.actionMode || '(없음)'),
    // 무엇을 하기로 했는지만 적는다. 했다고 적지 않는다.
    Intended: intended,
    Executed: ran ? '실행함 (결과 확인 중)' : '실행하지 못함',
  };
  if (i.equity != null && Number.isFinite(i.equity)) {
    fields.Equity = `${i.equity.toFixed(2)} USDT`;
  } else {
    // 못 읽은 것을 0으로 적지 않는다.
    fields.Equity = '확인 못 함';
  }
  if (!ran && (i.exec?.message || i.exec?.error)) {
    fields.Error = String(i.exec.message || i.exec.error).slice(0, 200);
  }

  return {
    level: 'critical', eventType: 'kill_switch',
    exchange: exchangeLabel(i.exchange),
    mode: i.testnet ? 'TESTNET' : 'LIVE',
    title: 'Kill Switch Active',
    message, fields,
  };
}

/**
 * 잔여 재확인 알림.
 *
 * **"남아 있다"와 "확인하지 못했다"를 가른다.** 예전에는 `clean=false`
 * 하나로 뭉쳐서 조회 실패도 "남아있습니다"라고 단정했다.
 *
 * 깨끗하면 `null` — 보낼 알림이 없다.
 */
export function reconcileAlert(i: {
  leftover: LeftoverVerdict | null | undefined;
  exchange: string | null | undefined;
  testnet: boolean;
  /** 화면에 적을 수치. 못 읽었으면 null */
  positions: number | null;
  orders: number | null;
}): AlertPayload | null {
  const lv = i.leftover ?? null;
  if (lv && lv.code === 'CLEAR') return null;

  const unknown = !lv || lv.code === 'UNKNOWN';
  const base = {
    exchange: exchangeLabel(i.exchange),
    mode: (i.testnet ? 'TESTNET' : 'LIVE') as 'TESTNET' | 'LIVE',
    fields: {
      // **못 읽은 것을 0으로 적지 않는다.**
      Positions: i.positions == null ? '확인 못 함' : i.positions,
      Orders: i.orders == null ? '확인 못 함' : i.orders,
    } as Record<string, string | number>,
  };

  if (unknown) {
    return {
      ...base,
      level: 'warning', eventType: 'reconcile_unknown',
      title: '거래소 잔여 확인 실패',
      message: '킬스위치 후 거래소 잔여 상태를 확인하지 못했습니다 — '
        + '남은 것이 없다는 뜻이 아닙니다. 거래소에서 직접 확인하세요.',
    };
  }

  return {
    ...base,
    level: 'warning', eventType: 'reconcile_fail',
    title: '거래소 직접 확인 필요',
    message: '킬스위치 후 거래소에 잔여 포지션/주문이 확인됐습니다.',
  };
}
