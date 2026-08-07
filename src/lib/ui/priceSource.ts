// src/lib/ui/priceSource.ts
//
// **'실제 시세'라는 말이 실제 주문으로 읽힌다.**
//
// MOCK 자동매매의 시세 소스가 `시뮬 시세` / `실제 시세` 둘뿐이고,
// 둘의 차이가 화면 어디에도 없다. 그래서 '실제 시세'를 고르면 실제
// 주문도 나가는 것으로 오해할 수 있다 — 실제로는 가격만 진짜고
// 체결은 여전히 MOCK이다.
//
// 그리고 더 나쁜 것이 하나 있었다
// ──────────────────────────────
// 실시간 시세 조회가 실패하면 **조용히 랜덤워크로 떨어졌다.**
//
//   try { 실제 가격 } catch {}
//   // ↓ 그냥 아래로 흘러서 가상 가격을 만든다
//
// 사용자는 실제 시장 움직임으로 전략을 검증하고 있다고 믿는데, 실제로는
// ±0.2% 난수를 보고 있다. 그 상태로 나온 승률·손익은 아무 뜻이 없고,
// 화면에는 그 사실이 한 글자도 안 뜬다.
//
// **모르는 것을 지어내지 않는다**는 이 저장소의 규칙이 시세에도 그대로
// 적용된다. 못 읽으면 멈추고 그렇다고 말한다.

export type PriceSource =
  /** 실제 거래소와 무관한 가상 가격 */
  | 'SIMULATED'
  /** 진짜 시장 가격 — 다만 체결은 여전히 MOCK */
  | 'LIVE_MARKET';

/**
 * 화면에 쓸 이름.
 *
 * '실제 시세'를 안 쓴다. 그 말은 실제 주문으로 읽힌다.
 */
export const SOURCE_LABEL: Record<PriceSource, string> = {
  SIMULATED: '가상 시세',
  LIVE_MARKET: '실시간 시장 시세',
};

/** 고를 때 옆에 적을 설명 */
export const SOURCE_DESC: Record<PriceSource, string> = {
  SIMULATED:
    '실제 거래소와 무관한 가상 가격입니다. 가격 변동·체결·손익이 모두 '
    + '내부에서 만들어집니다 — 전략 로직만 시험합니다.',
  LIVE_MARKET:
    'Gate·바이낸스의 실제 시장 가격을 씁니다. 다만 주문은 거래소로 나가지 '
    + '않고 내부에서만 가상 체결됩니다.',
};

/** 현재 선택 아래에 늘 붙는 한 줄 */
export const SOURCE_SUMMARY: Record<PriceSource, string> = {
  SIMULATED: '가상 가격으로 전략 로직만 시험 중',
  LIVE_MARKET: '실제 가격 사용 · 주문은 MOCK',
};

/**
 * 배지 문구.
 *
 * **실시간 시세를 골라도 MOCK 표시는 사라지지 않는다.** 가격이 진짜라고
 * 주문까지 진짜인 것이 아니고, 그 착각이 가장 비싸다.
 */
export function sourceBadge(src: PriceSource): string {
  return src === 'LIVE_MARKET' ? '실시간 시세 · MOCK 체결' : '가상 시세 · MOCK 체결';
}

export type FeedStatus =
  /** 값을 받았다 */
  | 'OK'
  /** 실시간을 골랐는데 못 읽었다 — **멈춘다** */
  | 'DISCONNECTED'
  /** 아직 한 번도 못 받았다 */
  | 'PENDING';

export interface FeedVerdict {
  status: FeedStatus;
  /** 이 값으로 매매를 진행해도 되는가 */
  canTrade: boolean;
  reason: string;
}

/**
 * 지금 이 시세로 매매를 이어가도 되는가.
 *
 * **실시간을 골랐는데 못 읽으면 가상으로 바꾸지 않는다.** 자동 전환은
 * 사용자가 고른 것과 다른 것을 돌리는 일이고, 그 사실이 화면에 안 뜨면
 * 결과 전체가 뜻을 잃는다. 멈추고 그렇다고 말하는 쪽이 언제나 낫다.
 *
 * 가상 시세는 애초에 바깥을 안 보므로 끊길 것이 없다.
 */
export function feedStatusOf(
  src: PriceSource, price: number | null | undefined,
): FeedVerdict {
  const ok = price != null && Number.isFinite(Number(price)) && Number(price) > 0;

  if (src === 'SIMULATED') {
    return ok
      ? { status: 'OK', canTrade: true, reason: '' }
      : { status: 'PENDING', canTrade: false, reason: '시작 가격을 아직 만들지 못했습니다' };
  }

  if (ok) return { status: 'OK', canTrade: true, reason: '' };

  return {
    status: 'DISCONNECTED', canTrade: false,
    reason: '실시간 시세를 읽지 못했습니다 — 가상 가격으로 바꾸지 않고 멈춥니다. '
      + '난수로 만든 승률은 아무 뜻이 없습니다.',
  };
}

/** 저장된 값을 읽는다. 모르는 값은 가상으로 — 실제 쪽으로 기울지 않는다 */
export function sourceOf(v: any): PriceSource {
  return String(v ?? '').trim().toUpperCase() === 'LIVE_MARKET' ? 'LIVE_MARKET' : 'SIMULATED';
}
