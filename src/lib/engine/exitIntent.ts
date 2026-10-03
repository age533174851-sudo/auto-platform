// src/lib/engine/exitIntent.ts
//
// **DB 울타리는 거래소를 막지 못한다.**
//
// 무엇이 남아 있었나
// ──────────────────
// 종료 경로는 쓰기 직전에 `fenceStillMine`으로 임차를 다시 확인하고,
// 그 확인과 주문 사이에 네트워크 왕복을 0으로 만들었다. 그래도 이 race는
// 남는다:
//
//   A가 `revalidate() === true`를 받는다
//   → **그 직후** 임차가 만료되고 B가 새 울타리를 얻는다
//   → A는 그 사실을 모르고 주문을 보낸다
//   → B도 정상 권한으로 주문을 보낸다
//   → 같은 포지션에 청산이 **두 번** 나간다
//
// "재검증 뒤에 await가 없다"로는 이것을 막지 못한다. B는 **다른
// 프로세스**라 같은 event loop를 공유하지 않고, 거래소는 우리 DB의
// `fence` 값을 모른다. 울타리를 아무리 촘촘히 확인해도, 확인과 수신
// 사이의 물리적 시간은 0이 될 수 없다.
//
// 그래서 막는 자리를 **거래소로 옮긴다.**
//
// 이 저장소에 이미 있는 정본
// ──────────────────────────
// 진입 경로는 결정적 주문 식별자를 이미 쓴다:
//
//   `orderExecutor`: "clientOrderId가 없으면 중복 주문을 막을 수 없어
//                     중단합니다" (하드 실패)
//   `live_orders.client_order_id`: UNIQUE 제약
//   `findOrderByClientId`: "재시도 전에 반드시 호출한다"
//
// **종료 경로만 그 규칙 밖에 있었다.** 새 장치를 만들 일이 아니라, 이미
// 있는 규칙을 종료에도 적용하는 일이다.
//
// ★ 다만 이 저장소의 옛 주석은 "바이낸스는 같은 ID 재사용을 거부한다"고
//   단정하고 있었다. **공식 문서가 보장하는 범위는 그보다 좁다** —
//   `newClientOrderId`는 **열려 있는 주문들 사이에서** 고유하다고 적혀
//   있다. 체결이 끝난 MARKET 주문까지 포함해 같은 id가 영구히 재사용
//   불가라고는 적혀 있지 않다. 그래서 이 파일은 그렇게 주장하지 않는다.
//
// 무엇을 "같은 의도"로 보는가
// ───────────────────────────
// 두 실행자가 **같은 종료**를 하려 할 때 같은 식별자가 나와야 한다.
// 거래소가 중복을 알아볼 **기회**를 주려면 그것이 전제다. 그런데 너무
// 안정적이면 정당한 다음 시도까지 영원히 막힌다 — 부분 청산 뒤 남은
// 노출을 닫는 것은 **다른** 의도다.
//
// 그래서 묶는 것은:
//
//   계좌 · 거래소 · 종목 · 방향 · 실행 계약 · 종료 사유 · **닫을 수량**
//
// 수량이 들어가는 것이 요점이다. A와 B가 같은 순간 같은 노출(1.0)을
// 보면 같은 식별자 → 주문 하나. 0.4가 수동으로 닫혀 0.6이 남으면 다음
// 회차는 다른 식별자 → 정당한 재시도가 막히지 않는다.
//
// ★ **시각을 넣지 않는다.** 넣으면 두 실행자가 다른 식별자를 만들어
//   거래소가 중복을 알아볼 기회조차 없어진다 — 이 파일의 목적이 사라진다.
//
// 무엇을 보장하고 무엇을 보장하지 못하는가
// ────────────────────────────────────────
//   보장한다
//     · 같은 종료 의도는 **결정적으로 같은 식별자**를 만든다
//     · 다른 의도(수량·종목·방향·계약이 다름)는 다른 식별자다
//     · 중복 응답을 받았을 때 그것을 **실패로 적지 않고** 재조회로
//       결과를 확정한다
//
//   보장하지 **못한다**
//     · 낡은 실행자가 **요청을 보내는 것 자체**는 막지 못한다. 분산
//       환경에서 그것까지 막으려면 거래소가 우리 울타리를 알아야 하는데,
//       알지 못한다
//     · **거래소가 반드시 둘째를 거부한다는 것**은 보장하지 못한다.
//       공식 문서는 `newClientOrderId`가 **열린 주문들 사이에서** 고유
//       하다고만 적는다. 체결된 MARKET 주문까지 포함한 영구 중복 차단은
//       확인된 범위 밖이고, 이 환경에서 실제 응답으로 검증하지도 못했다
//       (`UNVERIFIED_EXTERNAL`)
//
// 그래서 **strict single-writer를 주장하지 않는다.** 안전성은
//   ① 울타리 창 최소화  ② `reduceOnly`  ③ 방향 검증
//   ④ 현재 노출 기준 준비  ⑤ 재조회 대조
// 에 의존하고, 중복 식별자 거부는 **추가 방어층**이다. 그 층이 없다고
// 가정해도 **반대 포지션은 생기지 않는다** — ②③⑤가 그것을 막는다.

import type { ExecutionIdentity } from './managedPosition';

export interface ExitIntentKey {
  connectionId: string;
  exchange: 'binance' | 'gate';
  symbol: string;
  side: 'LONG' | 'SHORT';
  executionIdentity: ExecutionIdentity;
  reason: string;
  /** 닫으려는 수량. **지금 관측한 노출이다** */
  quantity: number;
}

/**
 * 거래소 주문 식별자의 최대 길이.
 *
 * 저장소가 이미 쓰는 값이다 — `scalp/route.ts`·`orderExecutor`가
 * `.slice(0, 36)`으로 자른다. 여기서 새로 정하지 않는다.
 */
export const EXIT_INTENT_ID_MAX = 36;

/**
 * 수량을 식별자에 넣을 때의 표기.
 *
 * `0.1 + 0.2`류의 부동소수 꼬리가 식별자를 갈라 놓으면 두 실행자가 다른
 * id를 만든다. 그러면 거래소가 중복을 못 막는다 — 이 파일의 목적이
 * 사라진다. 거래소 수량 격자보다 훨씬 촘촘한 자리에서 끊는다.
 */
const qtyToken = (q: number): string => {
  if (!Number.isFinite(q)) return 'NaN';
  // 지수 표기(`1e-7`)를 피한다 — 같은 값이 다른 글자가 되지 않게.
  return q.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * 순수 해시. **node `crypto`를 쓰지 않는다.**
 *
 * 계약 검사기가 이 모듈을 **직접 컴파일해서 돌려** 식별자가 결정적인지
 * 확인한다. node 내장 모듈이 들어가면 그 컴파일이 깨져 검사가 눈먼다 —
 * 저장소가 `safety/liquidationPrice.ts`를 떼어낸 것과 같은 이유다.
 *
 * 암호학적 강도는 필요 없다. 필요한 성질은 두 가지뿐이다:
 *   · 같은 입력 → 같은 출력 (두 실행자가 같은 id를 만든다)
 *   · 다른 입력 → 다른 출력 (다른 종료가 서로를 막지 않는다)
 *
 * FNV-1a를 **서로 다른 네 개의 오프셋**으로 돌려 128비트를 만든다.
 * 32비트 하나로는 종목·계좌 조합에서 충돌이 현실적으로 가능하다.
 */
function fnv128(input: string): string {
  const BASES = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const out: string[] = [];
  for (const basis of BASES) {
    let h = basis >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      // 문자 상위 바이트도 섞는다 — 유니코드가 하위 바이트만으로 같아지지 않게.
      h ^= (input.charCodeAt(i) >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(h.toString(36));
  }
  return out.join('');
}

/**
 * **같은 종료 의도 → 같은 식별자.**
 *
 * 두 실행자가 각자 계산해도 같은 값이 나와야 한다. 그래서 시각·난수·
 * 프로세스 id를 넣지 않는다.
 */
export function exitIntentId(k: ExitIntentKey): string {
  const parts = [
    String(k.connectionId ?? ''),
    String(k.exchange ?? ''),
    String(k.symbol ?? '').toUpperCase(),
    String(k.side ?? ''),
    String(k.executionIdentity?.profileId ?? ''),
    String(k.executionIdentity?.presetId ?? ''),
    String(k.executionIdentity?.contractVersion ?? ''),
    String(k.reason ?? ''),
    qtyToken(Number(k.quantity)),
  ].join('|');
  // 접두사로 **어느 경로가 낸 주문인지** 읽을 수 있게 한다. 남은 자리를
  // 해시로 채운다 — 입력이 길어져도 36자를 넘지 않는다.
  return `x5t${fnv128(parts)}`.slice(0, EXIT_INTENT_ID_MAX);
}

/**
 * 이 오류가 **"같은 식별자가 이미 있다"**인가.
 *
 * 그 거부는 실패가 아니다 — 다른 실행자가 **같은 의도**를 이미 보냈다는
 * 뜻이다. 실패로 적으면 "안 나갔다"로 읽혀 같은 자리에 또 보내게 된다.
 * 결과는 재조회가 확정한다.
 *
 * ★ **`-4015`를 여기에 넣었던 것은 틀렸다.**
 *   USDⓈ-M 공식 오류표에서
 *     `-4015` = `INVALID_CL_ORD_ID_LEN`  — 식별자의 길이·형식이 잘못됐다
 *     `-4116` = `DUPLICATED_CLIENT_ORDER_ID` — 식별자가 중복이다
 *   이 둘은 **정반대로 다뤄야 한다.** 형식 오류를 "이미 보냈다"로 읽으면
 *   **보내지도 않은 주문을 보낸 것으로 치고** 재조회 결과에 따라 닫혔다고
 *   적을 수 있다. 그건 우리가 만든 고장이다.
 *
 * ★ 모르는 오류를 중복으로 **확대 해석하지 않는다.** 확실한 모양만 참이고
 *   나머지는 기존 분류(거부/모름)가 그대로 처리한다.
 */
export function isDuplicateIntentError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const s = String(msg);
  // **형식 오류는 중복이 아니다.** 먼저 걸러낸다 — 아래 문구 규칙이
  // "client order id"라는 말에 걸려 잘못 참이 되는 것을 막는다.
  if (/-4015\b/.test(s)) return false;
  // Binance USDⓈ-M: -4116 DUPLICATED_CLIENT_ORDER_ID
  if (/-4116\b/.test(s)) return true;
  if (/DUPLICATED_CLIENT_ORDER_ID/i.test(s)) return true;
  // 코드 없이 오는 명백한 문구만. 보수적으로 둔다.
  if (/duplicate\s+order/i.test(s)) return true;
  if (/ORDER_DUPLICATE/i.test(s)) return true;
  if (/client\s*order\s*id[^.]{0,30}duplicat/i.test(s)) return true;
  return false;
}
