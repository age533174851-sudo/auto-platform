// src/lib/signals/creatorIntake.test.ts
//
// 막으려는 것:
//  1. said_at이 없을 때 detected_at으로 대신 채우는 것
//     — 지연이 0초가 되고, 그 신호는 성적이 가장 좋게 나오는 칸에 앉는다
//  2. 확신도가 없는 신호를 1로 채워 gateSignal을 무력화하는 것
//  3. 검수 안 된 신호를 판정에 넣어, 그 사람이 아니라 우리 파서의 성과를 재는 것
//  4. 못 태운 행을 조용히 버려 화면이 아무 말도 안 하게 되는 것
import { test, assert, eq } from '../../test/harness';
import { intakeSignal, intakeAll, delaySecOf, msOf, kindOf, regimeOf,
         confidenceFromTier, kindFromAction } from './creatorIntake';

const SAID = '2026-01-01T00:00:00.000Z';
const DETECTED = '2026-01-01T00:00:45.000Z';   // 45초 뒤

function row(over: any = {}) {
  return {
    id: 'r1', creator: 'A', symbol: 'BTCUSDT', side: 'LONG',
    action: 'ENTRY', stop_loss: 63500, entry_price: 64000,
    extract_confidence: 0.9, utterance_kind: 'EXPLICIT_ENTRY',
    said_at: SAID, detected_at: DETECTED,
    review_status: 'approved', regime: 'TREND_UP',
    ...over,
  };
}

export function runCreatorIntakeTests() {
  console.log('[신호 반입 — 발언 시각]');

  test('정상 행은 통과한다', () => {
    const r = intakeSignal(row());
    eq(r.ok, true, r.reason);
    eq(r.signal?.direction, 'LONG');
    eq(r.delaySec, 45);
    eq(r.regime, 'TREND_UP');
  });

  test('발언 시각이 없으면 감지 시각으로 대신 채우지 않는다', () => {
    // 이게 이 파일에서 가장 중요한 테스트다. 대신 채우면 지연이 0초가
    // 되고, 그 신호는 FAST 칸에 앉는다 — 성적이 가장 좋게 나오는 칸이다.
    const r = intakeSignal(row({ said_at: null }));
    eq(r.ok, false);
    assert(r.missing.includes('said_at'), r.reason);
    assert(r.reason.includes('볼 수 없었던 가격'), r.reason);
  });

  test('지연은 둘 중 하나라도 없으면 null이다', () => {
    eq(delaySecOf(SAID, DETECTED), 45);
    eq(delaySecOf(null, DETECTED), null, '0으로 떨어뜨리면 FAST 칸이 오염된다');
    eq(delaySecOf(SAID, null), null);
  });

  test('감지가 발언보다 먼저면 0으로 접지 않는다', () => {
    // 그건 둘 중 하나가 잘못 기록된 것이다. 0으로 접으면 정상으로 보인다.
    eq(delaySecOf(DETECTED, SAID), null);
  });

  test('시각을 못 읽으면 지금 시각으로 채우지 않는다', () => {
    eq(msOf('이건 시각이 아니다'), null);
    eq(msOf(null), null);
    eq(msOf(''), null);
    eq(msOf(0), null, '0을 1970년으로 읽으면 안 된다');
  });

  console.log('[신호 반입 — 검수]');

  test('검수 안 된 신호는 태우지 않는다', () => {
    const r = intakeSignal(row({ review_status: 'pending' }));
    eq(r.ok, false);
    assert(r.reason.includes('추출기의 성과'), r.reason);
  });

  test('검수 상태가 없으면 pending으로 본다 — approved가 기본이면 안 된다', () => {
    const r = intakeSignal(row({ review_status: undefined }));
    eq(r.ok, false, '기본이 통과면 아무도 검수하지 않고 전부 들어간다');
  });

  test('거부된 신호는 거부됐다고 말한다', () => {
    const r = intakeSignal(row({ review_status: 'rejected' }));
    eq(r.ok, false);
    assert(r.reason.includes('거부'), r.reason);
  });

  test('검수 건너뛰기는 명시해야 켜진다', () => {
    eq(intakeSignal(row({ review_status: 'pending' })).ok, false);
    eq(intakeSignal(row({ review_status: 'pending' }), { allowUnreviewed: true }).ok, true);
  });

  console.log('[신호 반입 — 값을 지어내지 않는다]');

  test('확신도가 없으면 1로 채우지 않는다', () => {
    // 채우면 gateSignal의 "확신도를 모르는 신호는 태우지 않는다"가
    // 통째로 무력해진다.
    const r = intakeSignal(row({ extract_confidence: null }));
    eq(r.ok, false);
    assert(r.missing.includes('confidence'), r.reason);
  });

  test('등급(confidence)을 확신도 숫자로 쓰지 않는다', () => {
    // 표에는 'confirmed'/'likely'/'uncertain' 등급 컬럼이 따로 있다.
    // 그걸 숫자 확신도로 읽으면 NaN이거나 엉뚱한 값이 된다.
    const r = intakeSignal(row({ extract_confidence: null, confidence: 'confirmed' }));
    eq(r.ok, false, '등급을 확신도로 대신 쓰면 안 된다');
  });

  test('손절을 말하지 않은 신호는 기본적으로 막힌다', () => {
    const r = intakeSignal(row({ stop_loss: null }));
    eq(r.ok, false);
    assert(r.missing.includes('stopLoss'), r.reason);
  });

  test('진입 발언이 아니면 태우지 않는다', () => {
    for (const k of ['OPINION', 'LONG_TERM', 'RECAP', 'QUESTION', 'AD', 'JOKE']) {
      eq(intakeSignal(row({ utterance_kind: k })).ok, false, `${k}가 통과했다`);
    }
  });

  test('모르는 발언 종류는 UNKNOWN이고 UNKNOWN은 안 통과한다', () => {
    eq(kindOf('아무거나'), 'UNKNOWN');
    eq(kindOf(null), 'UNKNOWN');
    eq(intakeSignal(row({ utterance_kind: null })).ok, false);
  });

  test('방향이 없으면 진입 신호가 아니라고 말한다', () => {
    // 청산 발언에는 방향이 없을 수 있다. 그건 잘못이 아니다.
    const r = intakeSignal(row({ side: null }));
    eq(r.ok, false);
    assert(r.reason.includes('진입 신호가 아닙니다'), r.reason);
  });

  test('모르는 국면은 UNKNOWN이다', () => {
    eq(regimeOf('상승장'), 'UNKNOWN');
    eq(regimeOf('RANGE'), 'RANGE');
    eq(intakeSignal(row({ regime: null })).regime, 'UNKNOWN');
  });

  console.log('[신호 반입 — 못 태운 것도 돌려준다]');

  test('못 태운 행을 조용히 버리지 않는다', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', said_at: null }),
      row({ id: 'c', review_status: 'pending' }),
      row({ id: 'd', stop_loss: null }),
    ];
    const out = intakeAll(rows);
    eq(out.accepted.length, 1);
    eq(out.rejected.length, 3, '버리면 왜 빠졌는지 아무도 모른다');
  });

  test('사유를 세어 무엇이 가장 많이 막히는지 알려준다', () => {
    const rows = [
      row({ id: 'a', said_at: null }),
      row({ id: 'b', said_at: null }),
      row({ id: 'c', review_status: 'pending' }),
    ];
    const out = intakeAll(rows);
    eq(out.reasonCounts['said_at'], 2);
    eq(out.reasonCounts['review_status'], 1);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(intakeAll(null).accepted.length, 0);
    eq(intakeAll(undefined).rejected.length, 0);
    eq(intakeSignal(null).ok, false);
  });

  console.log('[신호 반입 — 등급 사다리]');

  test('등급을 숫자로 바꾸는 곳은 한 곳뿐이다', () => {
    eq(confidenceFromTier('confirmed'), 0.95);
    eq(confidenceFromTier('likely'), 0.80);
    eq(confidenceFromTier('uncertain'), 0.40);
  });

  test('uncertain은 기본 문턱 아래라 막힌다', () => {
    const c = confidenceFromTier('uncertain');
    assert(c != null && c < 0.7, '문턱 위로 올리면 불확실한 신호가 장부에 들어간다');
    eq(intakeSignal(row({ extract_confidence: c })).ok, false);
  });

  test('모르는 등급은 숫자를 만들지 않는다', () => {
    eq(confidenceFromTier('아무거나'), null, '0.5쯤으로 채우면 확신도 검사가 무력해진다');
    eq(confidenceFromTier(null), null);
  });

  test('ENTRY만 진입 발언이다', () => {
    eq(kindFromAction('ENTRY'), 'EXPLICIT_ENTRY');
    for (const a of ['ADD', 'PARTIAL_EXIT', 'EXIT', 'MODIFY', '']) {
      eq(kindFromAction(a), 'UNKNOWN', `${a}가 진입으로 읽혔다`);
    }
  });
}
