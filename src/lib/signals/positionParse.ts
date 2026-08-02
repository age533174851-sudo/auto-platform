// src/lib/signals/positionParse.ts
//
// **한국어 매매 발언 → 구조화된 신호.**
//
// 무엇을 하는 파일인가
// ────────────────────
// "여기서 롱 잡았습니다. 118400에 10배로." 같은 문장에서 종목·방향·
// 진입가·배율을 뽑아낸다. **어디서 온 문장인지는 모른다** — 손으로
// 붙여넣은 것이든, 공개 게시물이든, 나중에 자막이든 같은 함수를 쓴다.
// 출처를 모르게 만든 이유는 출처가 바뀌어도 이 판정이 안 흔들리게
// 하기 위해서다.
//
// 왜 '추정'을 반드시 표시하는가
// ─────────────────────────────
// 이건 **다른 사람의 포지션에 대한 추측**이다. 그리고 자주 틀린다:
//
//   · 농담이거나 가상 포지션
//   · 이미 진입한 뒤 늦게 공개
//   · 일부 물량만 공개
//   · 다른 계좌 사용
//   · 청산했는데 말 안 함
//
// 추측을 사실처럼 적으면 두 가지가 동시에 나빠진다. 사용자는 없는
// 포지션을 따라 사고, 실명이 붙은 그 사람에게는 **하지도 않은 매매가
// 기록으로 남는다.** 그래서 신뢰도를 없앨 수 없게 타입에 박아 둔다.
//
// 자동매매로 바로 연결하지 않는다
// ───────────────────────────────
// 이 파일은 신호를 만들 뿐 주문을 만들지 않는다. 그 경계는 코드로
// 지킨다 — 여기서 OrderPlan을 만들 수 있게 두면 언젠가 누가 연결한다.

export type SignalSide = 'LONG' | 'SHORT';

export type SignalAction =
  /** 새로 들어감 */
  | 'ENTRY'
  /** 물량 추가 */
  | 'ADD'
  /** 일부만 정리 */
  | 'PARTIAL_EXIT'
  /** 전량 정리 */
  | 'EXIT'
  /** 손절 옮김·목표 변경 등 */
  | 'MODIFY';

/**
 * 얼마나 믿을 수 있는가.
 *
 * **`confirmed`는 이 파일이 혼자 만들 수 없다.** 문장만으로는 화면에
 * 실제 포지션이 떠 있었는지 알 수 없기 때문이다. 화면 확인은 바깥에서
 * 붙인다 — 여기서 confirmed를 줄 수 있게 두면, 말만 듣고 '확정'이
 * 찍히는 길이 생긴다.
 */
export type Confidence =
  /** 포지션 화면과 발언이 모두 확인됨 — 바깥에서만 붙일 수 있다 */
  | 'confirmed'
  /** 명확하게 진입·청산을 말했다 */
  | 'likely'
  /** 문맥으로 추측했다 */
  | 'uncertain';

export interface PositionSignal {
  /** 방향. 못 정하면 null — 추측해서 채우지 않는다 */
  side: SignalSide | null;
  action: SignalAction;
  /** 'BTC' 같은 기초 심볼. 못 찾으면 null */
  symbol: string | null;
  entryPrice: number | null;
  leverage: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: Confidence;
  /** 근거가 된 원문 조각. **없으면 신호를 만들지 않는다** */
  evidence: string;
  /** 왜 이렇게 판정했는지 */
  reason: string;
}

// ── 사전 ─────────────────────────────────────────────────────
//
// 사람 이름은 코드에 없다. 이 파일은 **누가 말했는지 모른다** —
// 채널 목록은 사용자가 관리하고, 이 함수는 문장만 받는다.

const LONG_WORDS = ['롱', '매수', '롱잡', '롱 잡', '숏청산', '반등베팅'];
const SHORT_WORDS = ['숏', '매도', '숏잡', '숏 잡', '롱청산', '하락베팅'];

/** 진입으로 볼 표현 */
const ENTRY_WORDS = ['잡았', '들어갔', '진입', '탔', '탑승', '샀', '매수했', '들어감', '잡음'];
/** 추가 */
const ADD_WORDS = ['추가', '불타기', '물타기', '더 잡', '더잡'];
/** 일부 정리 */
const PARTIAL_WORDS = ['일부', '절반', '반만', '부분', '분할 익절', '분할익절'];
/** 전량 정리 */
const EXIT_WORDS = ['정리', '청산', '전량', '다 팔', '다팔', '익절', '손절', '털었', '나왔', '종료'];
/** 계획·가정 — 실제로 한 것이 아니다 */
const HYPOTHETICAL = ['하면', '한다면', '할까', '갈까', '보고 있', '고민', '예정', '생각 중', '생각중',
                      '였으면', '이라면', '만약', '가정', '연습', '모의'];

/** 알려진 코인 별칭 → 심볼. 여기 없으면 못 찾은 것이다 */
const SYMBOL_ALIASES: Record<string, string> = {
  '비트': 'BTC', '비트코인': 'BTC', 'btc': 'BTC', '비코': 'BTC',
  '이더': 'ETH', '이더리움': 'ETH', 'eth': 'ETH',
  '리플': 'XRP', 'xrp': 'XRP',
  '솔라나': 'SOL', 'sol': 'SOL', '솔': 'SOL',
  '도지': 'DOGE', 'doge': 'DOGE',
  '에이다': 'ADA', 'ada': 'ADA',
  '바낸코인': 'BNB', 'bnb': 'BNB',
};

const has = (t: string, words: string[]) => words.some(w => t.includes(w));

/** 숫자를 읽는다. 콤마와 '만'을 다룬다 */
function num(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/,/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 발언에서 신호를 뽑는다.
 *
 * 순수 함수다 — 네트워크도 AI도 안 탄다. 규칙이 눈에 보여야 왜 그렇게
 * 판정했는지 되짚을 수 있다.
 *
 * **못 뽑으면 null이다.** 억지로 만들면 "아무 말이나 하면 신호가 생기는"
 * 상태가 되고, 그러면 알림이 쏟아져서 진짜 신호가 묻힌다.
 */
export function parsePositionSignal(textRaw: string | null | undefined): PositionSignal | null {
  const text = String(textRaw || '').trim();
  if (!text) return null;
  const t = text.toLowerCase();

  // ── 가정·계획은 신호가 아니다 ──
  //
  // "롱 잡을까요?"와 "롱 잡았습니다"는 완전히 다르다. 이걸 안 거르면
  // 시황 얘기만 해도 알림이 울린다.
  const hypothetical = has(text, HYPOTHETICAL);

  // ── 무엇을 했는가 ──
  let action: SignalAction | null = null;
  // **손절 이동을 청산보다 먼저 본다.** '손절'이 EXIT_WORDS에 있어서
  // "손절 본전으로 올렸습니다"가 전량 청산으로 잡혔다. 손절을 옮긴 것과
  // 손절에 걸려 나간 것은 정반대 뜻이다 — 앞은 이익을 지키는 것이고
  // 뒤는 포지션이 없어진 것이다.
  if (/(손절|스탑).{0,10}(올리|올렸|옮기|옮겼|이동|본전)|본전.{0,6}(으로|로)/.test(text)) action = 'MODIFY';
  else if (has(text, EXIT_WORDS) && has(text, PARTIAL_WORDS)) action = 'PARTIAL_EXIT';
  else if (has(text, EXIT_WORDS)) action = 'EXIT';
  else if (has(text, ADD_WORDS) && has(text, ENTRY_WORDS)) action = 'ADD';
  else if (has(text, ENTRY_WORDS)) action = 'ENTRY';

  if (!action) return null;

  // ── 방향 ──
  //
  // 청산에는 방향이 없어도 된다("다 정리할게요"). 진입인데 방향을
  // 모르면 **신호를 만들지 않는다** — 롱인지 숏인지 모르는 진입 신호는
  // 아무 쓸모가 없고, 반대로 읽히면 위험하다.
  const isLong = has(text, LONG_WORDS);
  const isShort = has(text, SHORT_WORDS);
  let side: SignalSide | null = null;
  if (isLong && !isShort) side = 'LONG';
  else if (isShort && !isLong) side = 'SHORT';
  // 둘 다 나오면 모른다("롱 정리하고 숏") — 한쪽을 고르면 반대로 갈 수 있다.

  if ((action === 'ENTRY' || action === 'ADD') && side == null) return null;

  // ── 종목 ──
  let symbol: string | null = null;
  for (const [alias, sym] of Object.entries(SYMBOL_ALIASES)) {
    if (t.includes(alias.toLowerCase())) { symbol = sym; break; }
  }

  // ── 숫자들 ──
  //
  // 진입가는 "118400에", "118,400 에서" 같은 모양이다. 조사를 붙여
  // 찾는 이유는, 아무 숫자나 집으면 "10배"의 10이나 시각의 21이
  // 진입가가 되기 때문이다.
  const entryPrice = num((text.match(/([0-9][0-9,]{2,})\s*(?:원|불|달러)?\s*(?:에서|에|쯤|근처|부근)/) || [])[1]);
  const leverage = num((text.match(/([0-9]{1,3})\s*(?:배|x|X)/) || [])[1]);
  const stopLoss = num((text.match(/손절\D{0,6}([0-9][0-9,]{2,})/) || [])[1]);
  const takeProfit = num((text.match(/(?:익절|목표)\D{0,6}([0-9][0-9,]{2,})/) || [])[1]);

  // ── 얼마나 믿을 수 있는가 ──
  //
  // **여기서 'confirmed'는 절대 안 나온다.** 문장만으로는 화면에 실제
  // 포지션이 떠 있었는지 알 수 없다. 화면 확인은 바깥에서 붙인다.
  const clear = !hypothetical && (
    // 과거형으로 말했다 = 실제로 했다는 뜻
    /했|았|었|입니다|합니다|할게요|간다|갑니다/.test(text)
  );
  const confidence: Confidence = clear ? 'likely' : 'uncertain';

  const reason = [
    hypothetical ? '가정·계획 표현이 섞여 있어 실제 매매인지 불확실합니다' : null,
    side == null ? '방향을 정하지 못했습니다' : null,
    symbol == null ? '종목을 찾지 못했습니다' : null,
    entryPrice == null && (action === 'ENTRY' || action === 'ADD') ? '진입가를 찾지 못했습니다' : null,
  ].filter(Boolean).join(' · ') || '명확한 매매 발언으로 읽었습니다';

  return {
    side, action, symbol,
    entryPrice, leverage, stopLoss, takeProfit,
    confidence,
    // 근거 없이 신호를 만들지 않는다. 나중에 "왜 이 알림이 왔지"를
    // 되짚을 수 있어야 한다.
    evidence: text.length > 200 ? `${text.slice(0, 200)}…` : text,
    reason,
  };
}

/**
 * 화면 확인을 붙여 신뢰도를 올린다.
 *
 * **이 함수로만 `confirmed`가 된다.** 파서가 스스로 confirmed를 줄 수
 * 없게 나눠 둔 이유는, 말만 듣고 '확정'이 찍히는 길을 아예 없애기
 * 위해서다.
 *
 * @param screenMatches 방송 화면에 뜬 포지션이 이 신호와 맞는가.
 *                      **모르면 null**을 넘긴다 — false로 넘기면
 *                      "확인해 봤는데 아니었다"가 되어 뜻이 달라진다.
 */
export function withScreenCheck(
  sig: PositionSignal | null,
  screenMatches: boolean | null,
): PositionSignal | null {
  if (!sig) return null;
  if (screenMatches === true && sig.confidence === 'likely') {
    return { ...sig, confidence: 'confirmed', reason: `${sig.reason} · 화면의 포지션과도 일치` };
  }
  if (screenMatches === false) {
    // 화면과 안 맞는다. 올리는 게 아니라 **내린다.**
    return { ...sig, confidence: 'uncertain', reason: `${sig.reason} · 화면의 포지션과 맞지 않습니다` };
  }
  return sig;
}

/** 화면에 그대로 쓸 한국어 라벨. 추정을 확정처럼 적지 않기 위한 한 곳 */
export const CONFIDENCE_LABEL: Record<Confidence, { text: string; note: string }> = {
  confirmed:  { text: '확정',   note: '포지션 화면과 발언이 모두 확인됨' },
  likely:     { text: '높은 확률', note: '명확하게 말했지만 화면으로 확인하지는 못함' },
  uncertain:  { text: '추정',   note: '문맥으로 짐작한 것입니다 — 아닐 수 있습니다' },
};

export const ACTION_LABEL: Record<SignalAction, string> = {
  ENTRY: '진입', ADD: '추가', PARTIAL_EXIT: '일부 정리', EXIT: '전량 정리', MODIFY: '포지션 변경',
};

/**
 * 이 신호로 **자동 주문을 내도 되는가**.
 *
 * 언제나 false다. 값을 돌려주는 함수로 둔 이유는, 나중에 누가 자동매매를
 * 붙이려 할 때 **여기 한 곳만 보면 되게** 하기 위해서다.
 *
 * 왜 항상 false인가: 이건 다른 사람의 포지션에 대한 추측이고, 방송은
 * 지연되며, 일부만 공개되고, 농담일 수도 있다. 그리고 청산은 말 안 하고
 * 넘어가는 일이 흔하다 — **들어가는 신호만 있고 나오는 신호가 없는
 * 자동매매**는 그냥 돈을 버리는 장치다.
 */
export function canAutoTrade(): false {
  return false;
}
