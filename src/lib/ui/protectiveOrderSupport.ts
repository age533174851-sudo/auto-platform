// src/lib/ui/protectiveOrderSupport.ts
//
// **이 거래소·환경이 지금 손절(조건부 주문)을 받는가.**
//
// 왜 이 파일이 생겼나 — 답은 이미 서버에 있었다
// ──────────────────────────────────────────────
// `futuresOrderTypes()`(binanceFutures.ts)는 키도 서명도 필요 없는 공개
// 조회로 심볼별 `orderTypes`를 받아 온다. 그 함수의 주석이 존재 이유를
// 이렇게 적어 뒀다:
//
//   "데모에서 STOP_MARKET이 -4120으로 거절됐다. 그런데 그건 주문을
//    실제로 내 봐야 알 수 있었고, **매번 진입·청산 수수료가 나갔다**
//    (잔고가 4,997 → 4,960으로 줄었다)."
//
// 그런데 그 사실은 `/api/binance/futures/diagnose`에만 있었고, 그 경로는
//   · **거래소 연결** 화면에서만 부를 수 있고
//   · 사용자가 진단 버튼을 **직접 눌러야** 하고
//   · `showBinanceTestnetDiagnosis()`가 `binance && isTestnet === true`로
//     막아서 **실계좌에서는 아예 볼 수 없었다.**
//
// 자동매매는 사람이 버튼을 누르는 동안 도는 것이 아니다. 최상위 규칙이
// 말하는 그대로다 — 자동화할 수 있는 절차를 사람에게 넘기지 않는다.
//
// 왜 이것이 '매수매도가 안 되는 이유'인가
// ────────────────────────────────────────
// 진입 주문(MARKET/LIMIT)은 성공한다. 그 다음 손절을 거는 데 실패하면
// `protectionPolicy`의 기본값 `REQUIRED`가 **방금 연 포지션을 즉시
// 되돌린다**(orderExecutor.ts:85). 포지션 크기가 허용손실 ÷ 손절거리로
// 역산된 값이라, 손절이 없으면 그 크기를 정당화할 근거가 사라지기
// 때문이다. 되돌리는 것 자체는 옳다.
//
// 틀린 것은 **그걸 주문을 내 보고 나서야 안다**는 것이다. 사용자 눈에는
// "자동매매가 매수매도를 안 한다"로 보이고, 실제로는 진입 수수료 +
// 청산 수수료 + 슬리피지만 나간다.
//
// ★ 이 파일은 **아무것도 막지 않는다.**
// ──────────────────────────────────────
// 매매 정책을 바꾸지 않는다. 주문 경로에 관문을 더하지 않는다. 사실을
// 화면에 적을 뿐이다. 거래소가 목록에 적어 두고도 거절하는 경우가 있어서
// (실제로 그랬다) 이 값만 보고 막으면 멀쩡한 진입을 막게 된다.
//
// ★ 모르는 것은 통과가 아니다.
// ─────────────────────────────
// 목록을 못 받은 것은 "지원 안 함"도 아니고 "지원함"도 아니다. 셋을
// 섞으면 안 된다 — 다음에 할 일이 전부 다르다.
//   · SUPPORTED   → 할 일 없음
//   · UNSUPPORTED → 이 환경에서는 자동매매가 진입 직후 되돌린다
//   · UNKNOWN     → 확인하지 못했다. **초록으로 그리지 않는다**

/** 조건부 주문(손절)을 걸 수 있는가에 대한 답. 셋뿐이다. */
export type SupportCode = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';

/** 손절을 거래소에 거는 데 반드시 필요한 주문 유형. */
export const REQUIRED_STOP_TYPE = 'STOP_MARKET';

/**
 * 공개 조회가 돌려준 한 거래소·환경의 원재료.
 *
 * `ok: false`는 **조회 자체가 실패했다**는 뜻이다 — 그 경우 orderTypes가
 * 비어 있어도 "지원 안 함"이 아니다.
 */
export interface VenueProbe {
  /** 'binance' | 'gate' | … (소문자) */
  exchange: string;
  /** 테스트넷인가. **모르면 null** — false로 눕히지 않는다 */
  testnet: boolean | null;
  /** 공개 조회가 성공했는가 */
  ok: boolean;
  /** 거래소가 스스로 말한 주문 유형들 */
  orderTypes?: string[] | null;
  /** 조회가 실패했거나 설명이 필요할 때의 원문 */
  detail?: string | null;
  /** 이 거래소는 이 방식으로 물어볼 수 없다(공개 목록 조회가 없다) */
  unprobeable?: boolean;
  /**
   * 어떤 심볼에 대해 물어봤는가.
   *
   * **거래소 전체가 아니라 심볼마다 다르다.** BTCUSDT만 물어보고
   * "이 거래소는 손절을 받는다"고 적으면, SOLUSDT를 거래하는 예약에
   * 대해서는 거짓으로 안심시키는 답이 된다.
   */
  symbol?: string | null;
}

export interface SupportVerdict {
  code: SupportCode;
  /** 화면 한 줄 */
  label: string;
  /** 왜 그렇게 판정했는가 */
  detail: string;
  /** 사용자가 지금 할 수 있는 일. 없으면 null */
  nextAction: string | null;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 한 거래소·환경에 대한 판정. */
export function supportVerdict(p: VenueProbe | null | undefined): SupportVerdict {
  // 아무것도 못 받았다. 이것도 UNKNOWN이다.
  if (!p || typeof p !== 'object') {
    return {
      code: 'UNKNOWN',
      label: '손절을 걸 수 있는지 확인하지 못했습니다',
      detail: '거래소에 물어본 결과가 없습니다 — 지원하지 않는다는 뜻이 아닙니다',
      nextAction: '새로고침해 보세요',
    };
  }

  const where = probeLabel(p);

  // 이 거래소는 이 방식으로 물어볼 수 없다. 모르는 것이지 안 되는 것이 아니다.
  if (p.unprobeable === true) {
    return {
      code: 'UNKNOWN',
      label: `${where} — 손절 지원 여부를 미리 물어볼 수 없습니다`,
      detail: s(p.detail)
        || '이 거래소에는 주문 유형을 미리 알려주는 공개 조회가 없습니다 — 지원하지 않는다는 뜻이 아닙니다',
      nextAction: null,
    };
  }

  // 조회가 실패했다. **목록이 비었다고 "지원 안 함"으로 적지 않는다.**
  if (p.ok !== true) {
    return {
      code: 'UNKNOWN',
      label: `${where} — 손절 지원 여부를 확인하지 못했습니다`,
      detail: s(p.detail)
        ? `거래소에 물어보지 못했습니다 (${s(p.detail)}) — 지원하지 않는다는 뜻이 아닙니다`
        : '거래소에 물어보지 못했습니다 — 지원하지 않는다는 뜻이 아닙니다',
      nextAction: '잠시 후 다시 확인하세요',
    };
  }

  const types = Array.isArray(p.orderTypes) ? p.orderTypes.map(s).filter(Boolean) : null;

  // ok인데 목록이 배열이 아니다 — 응답 모양이 예상과 다르다. 통과시키지 않는다.
  if (types == null) {
    return {
      code: 'UNKNOWN',
      label: `${where} — 손절 지원 여부를 확인하지 못했습니다`,
      detail: '거래소가 주문 유형 목록을 주지 않았습니다 — 지원하지 않는다는 뜻이 아닙니다',
      nextAction: '잠시 후 다시 확인하세요',
    };
  }

  // ok이고 목록이 비어 있다. 빈 목록은 답이 아니다.
  if (types.length === 0) {
    return {
      code: 'UNKNOWN',
      label: `${where} — 손절 지원 여부를 확인하지 못했습니다`,
      detail: '거래소가 빈 목록을 돌려줬습니다 — 지원하지 않는다는 뜻이 아닙니다',
      nextAction: '잠시 후 다시 확인하세요',
    };
  }

  const has = types.some(t => t.toUpperCase() === REQUIRED_STOP_TYPE);
  if (has) {
    return {
      code: 'SUPPORTED',
      label: `${where} — 손절을 거래소에 걸 수 있습니다`,
      detail: `${REQUIRED_STOP_TYPE}를 받습니다 · 주문 유형 ${types.length}종`,
      nextAction: null,
    };
  }

  return {
    code: 'UNSUPPORTED',
    label: `${where} — 손절을 거래소에 걸 수 없습니다`,
    detail:
      `${REQUIRED_STOP_TYPE}가 목록에 없습니다(${types.join(', ')}). `
      + '이 환경에서 자동매매가 진입하면 손절을 걸지 못해 포지션을 즉시 되돌리고, '
      + '진입·청산 수수료만 나갑니다.',
    nextAction: '이 환경의 자동매매를 켜지 않는 것이 좋습니다',
  };
}

/** 'binance' + testnet → '바이낸스 테스트넷'. 모르면 환경을 붙이지 않는다. */
export function venueLabel(exchange: string | null | undefined, testnet: boolean | null | undefined): string {
  const ex = s(exchange).toLowerCase();
  const name = EXCHANGE_KR[ex] || (ex ? ex.toUpperCase() : '거래소');
  if (testnet === true) return `${name} 테스트넷`;
  if (testnet === false) return `${name} 실계좌`;
  return name;
}

/** '바이낸스 실계좌 · BTCUSDT'. 심볼을 모르면 거래소만 적는다. */
export function probeLabel(p: { exchange?: string | null; testnet?: boolean | null; symbol?: string | null }): string {
  const base = venueLabel(p?.exchange, p?.testnet);
  const sym = s(p?.symbol).trim().toUpperCase();
  return sym ? `${base} · ${sym}` : base;
}

const EXCHANGE_KR: Record<string, string> = {
  binance: '바이낸스', bybit: '바이비트', okx: 'OKX',
  gate: '게이트', upbit: '업비트', bithumb: '빗썸',
};

/**
 * 여러 거래소·환경의 판정을 화면 한 줄로 합친다.
 *
 * 합치는 순서가 곧 심각도다 — **하나라도 못 거는 곳이 있으면 그것이
 * 머리줄**이다. 모르는 것은 통과 위로 올린다(모르는 것을 초록으로
 * 그리지 않는다).
 */
export function summarize(vs: SupportVerdict[]): {
  code: SupportCode | 'NONE';
  headline: string;
  worst: SupportVerdict | null;
} {
  if (!Array.isArray(vs) || vs.length === 0) {
    return { code: 'NONE', headline: '확인할 거래소 연결이 없습니다', worst: null };
  }
  const bad = vs.find(v => v.code === 'UNSUPPORTED');
  if (bad) {
    const n = vs.filter(v => v.code === 'UNSUPPORTED').length;
    return {
      code: 'UNSUPPORTED',
      headline: n > 1
        ? `${n}곳에서 손절을 걸 수 없습니다 — 자동매매가 진입 직후 되돌립니다`
        : bad.label,
      worst: bad,
    };
  }
  const unk = vs.find(v => v.code === 'UNKNOWN');
  if (unk) {
    const n = vs.filter(v => v.code === 'UNKNOWN').length;
    return {
      code: 'UNKNOWN',
      headline: n > 1 ? `${n}곳의 손절 지원 여부를 확인하지 못했습니다` : unk.label,
      worst: unk,
    };
  }
  return {
    code: 'SUPPORTED',
    headline: vs.length > 1
      ? `${vs.length}곳 모두 손절을 거래소에 걸 수 있습니다`
      : vs[0].label,
    worst: null,
  };
}
