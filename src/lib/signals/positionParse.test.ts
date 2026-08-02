import { test, eq, assert } from '../../test/harness';
import {
  parsePositionSignal, withScreenCheck, canAutoTrade,
  CONFIDENCE_LABEL, ACTION_LABEL,
} from './positionParse';

export function runPositionParseTests() {
  console.log('[방송 신호 — 추측을 사실처럼 적지 않는다]');

  // ── 진입 ────────────────────────────────────────────────
  test('진입 발언에서 방향·종목·가격·배율을 뽑는다', () => {
    const s = parsePositionSignal('비트 여기서 롱 잡았습니다. 118,400에 10배로 갑니다')!;
    eq(s.action, 'ENTRY');
    eq(s.side, 'LONG');
    eq(s.symbol, 'BTC');
    eq(s.entryPrice, 118400);
    eq(s.leverage, 10);
  });

  test('숏도 읽는다', () => {
    const s = parsePositionSignal('이더 숏 진입했습니다 3200 부근')!;
    eq(s.side, 'SHORT');
    eq(s.symbol, 'ETH');
    eq(s.entryPrice, 3200);
  });

  test('손절·익절도 뽑는다', () => {
    const s = parsePositionSignal('비트 롱 들어갔고 손절 115000 익절 125000 봅니다')!;
    eq(s.stopLoss, 115000);
    eq(s.takeProfit, 125000);
  });

  // ── 가정·계획은 신호가 아니다 ───────────────────────────
  test('계획 발언은 추정으로 내린다', () => {
    // "롱 잡을까요?"와 "롱 잡았습니다"는 완전히 다르다. 이걸 안 거르면
    // 시황 얘기만 해도 알림이 울린다.
    const s = parsePositionSignal('비트 롱 진입 예정입니다')!;
    eq(s.confidence, 'uncertain');
    assert(s.reason.includes('가정'), s.reason);
  });

  test('모의라고 말하면 추정이다', () => {
    eq(parsePositionSignal('모의로 비트 롱 잡았습니다')!.confidence, 'uncertain');
  });

  test('계획만 말하고 매매 동사가 없으면 아예 신호가 아니다', () => {
    // "롱 잡으면 어떨까"는 매매가 아니다. 추정으로도 남기지 않는다.
    eq(parsePositionSignal('여기서 롱 잡으면 어떨까 고민 중입니다'), null);
  });

  test('매매 발언이 아니면 신호를 안 만든다', () => {
    // 억지로 만들면 아무 말에나 알림이 울려 진짜 신호가 묻힌다.
    eq(parsePositionSignal('오늘 시장 분위기가 좋네요'), null);
    eq(parsePositionSignal('비트코인 118000입니다'), null);
    eq(parsePositionSignal(''), null);
    eq(parsePositionSignal(null), null);
  });

  // ── 방향을 모르면 진입 신호를 안 만든다 ─────────────────
  test('방향 없는 진입은 신호가 아니다', () => {
    // 롱인지 숏인지 모르는 진입 신호는 쓸모가 없고, 반대로 읽히면 위험하다.
    eq(parsePositionSignal('여기서 진입했습니다'), null);
  });

  test('롱과 숏이 같이 나오면 방향을 안 정한다', () => {
    // "롱 정리하고 숏" — 한쪽을 고르면 반대로 갈 수 있다.
    const s = parsePositionSignal('롱 정리하고 숏으로 돌립니다');
    if (s) eq(s.side, null);
  });

  // ── 청산 ────────────────────────────────────────────────
  test('전량 정리를 읽는다', () => {
    const s = parsePositionSignal('여기서 다 정리할게요')!;
    eq(s.action, 'EXIT');
  });

  test('일부 정리를 따로 읽는다', () => {
    const s = parsePositionSignal('절반만 익절했습니다')!;
    eq(s.action, 'PARTIAL_EXIT');
  });

  test('청산에는 방향이 없어도 된다', () => {
    // 들어갈 때와 달리 "다 정리"는 그 자체로 뜻이 통한다.
    assert(parsePositionSignal('전량 청산했습니다') != null, '청산 신호가 있어야 한다');
  });

  test('추가 매수를 따로 읽는다', () => {
    eq(parsePositionSignal('비트 롱 추가로 더 잡았습니다')!.action, 'ADD');
  });

  test('손절 이동을 읽는다', () => {
    eq(parsePositionSignal('손절 본전으로 올렸습니다')!.action, 'MODIFY');
  });

  // ── 숫자를 잘못 집지 않는다 ─────────────────────────────
  test('배율을 진입가로 읽지 않는다', () => {
    // 아무 숫자나 집으면 '10배'의 10이 진입가가 된다.
    const s = parsePositionSignal('비트 롱 10배로 잡았습니다')!;
    eq(s.leverage, 10);
    eq(s.entryPrice, null);
  });

  test('콤마가 있어도 읽는다', () => {
    eq(parsePositionSignal('비트 롱 118,400에 잡았습니다')!.entryPrice, 118400);
  });

  test('못 찾은 값은 null이다 — 0으로 채우지 않는다', () => {
    const s = parsePositionSignal('비트 롱 잡았습니다')!;
    eq(s.entryPrice, null);
    eq(s.leverage, null);
    eq(s.stopLoss, null);
    assert(s.reason.includes('진입가'), s.reason);
  });

  test('모르는 종목은 null이다', () => {
    const s = parsePositionSignal('무슨무슨코인 롱 잡았습니다')!;
    eq(s.symbol, null);
    assert(s.reason.includes('종목'), s.reason);
  });

  // ── 신뢰도 ──────────────────────────────────────────────
  test('파서 혼자서는 확정을 못 준다', () => {
    // 문장만으로는 화면에 실제 포지션이 떠 있었는지 알 수 없다.
    // 여기서 confirmed를 줄 수 있게 두면 말만 듣고 '확정'이 찍힌다.
    for (const t of ['비트 롱 잡았습니다 118400에', '전량 청산했습니다', '숏 진입합니다']) {
      const s = parsePositionSignal(t)!;
      assert(s.confidence !== 'confirmed', `${t} → confirmed가 나오면 안 된다`);
    }
  });

  test('화면 확인을 붙여야 확정이 된다', () => {
    const s = parsePositionSignal('비트 롱 잡았습니다 118400에')!;
    eq(withScreenCheck(s, true)!.confidence, 'confirmed');
  });

  test('화면과 안 맞으면 올리는 게 아니라 내린다', () => {
    const s = parsePositionSignal('비트 롱 잡았습니다 118400에')!;
    const r = withScreenCheck(s, false)!;
    eq(r.confidence, 'uncertain');
    assert(r.reason.includes('맞지 않'), r.reason);
  });

  test('화면을 못 봤으면 그대로 둔다', () => {
    // 모르는 것을 false로 넘기면 "확인해 봤는데 아니었다"가 되어 뜻이 다르다.
    const s = parsePositionSignal('비트 롱 잡았습니다 118400에')!;
    eq(withScreenCheck(s, null)!.confidence, s.confidence);
  });

  test('추정을 화면 확인으로 확정 만들지 않는다', () => {
    // 문맥으로 짐작한 것은 화면이 맞아도 '확정'이 아니다 — 화면의
    // 포지션이 이 발언 때문에 생긴 것인지 알 수 없다.
    const s = parsePositionSignal('비트 롱 진입 예정입니다')!;
    eq(s.confidence, 'uncertain');
    eq(withScreenCheck(s, true)!.confidence, 'uncertain');
  });

  test('없는 신호에 화면 확인을 붙여도 안 생긴다', () => {
    eq(withScreenCheck(null, true), null);
  });

  // ── 근거 ────────────────────────────────────────────────
  test('근거 원문을 남긴다', () => {
    // 나중에 "왜 이 알림이 왔지"를 되짚을 수 있어야 한다.
    const s = parsePositionSignal('비트 롱 잡았습니다')!;
    assert(s.evidence.includes('롱 잡았습니다'), s.evidence);
  });

  test('긴 원문은 잘라도 잘렸다고 표시한다', () => {
    const long = '비트 롱 잡았습니다 ' + '가'.repeat(300);
    const s = parsePositionSignal(long)!;
    assert(s.evidence.endsWith('…'), '잘렸으면 표시해야 한다');
  });

  // ── 자동매매 경계 ───────────────────────────────────────
  test('이 신호로는 자동 주문을 못 낸다', () => {
    // 다른 사람의 포지션에 대한 추측이고, 방송은 지연되며, 청산은
    // 말 안 하고 넘어가는 일이 흔하다. 들어가는 신호만 있고 나오는
    // 신호가 없는 자동매매는 그냥 돈을 버리는 장치다.
    eq(canAutoTrade(), false);
  });

  // ── 라벨 ────────────────────────────────────────────────
  test('추정 라벨이 아닐 수 있다고 말한다', () => {
    assert(CONFIDENCE_LABEL.uncertain.note.includes('아닐 수 있'),
      CONFIDENCE_LABEL.uncertain.note);
  });

  test('높은 확률도 확인 못 했다고 말한다', () => {
    assert(CONFIDENCE_LABEL.likely.note.includes('확인하지'), CONFIDENCE_LABEL.likely.note);
  });

  test('모든 동작에 한국어 이름이 있다', () => {
    for (const k of ['ENTRY', 'ADD', 'PARTIAL_EXIT', 'EXIT', 'MODIFY'] as const) {
      assert((ACTION_LABEL[k] || '').length > 0, `${k}에 이름이 없습니다`);
    }
  });
}
