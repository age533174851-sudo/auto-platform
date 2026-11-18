// src/lib/ui/dueDiagView.test.ts
//
// **화면이 추측하지 않는다는 것을 값으로 못 박는다.**
//
// 이 표시가 틀리는 방식은 둘이다:
//
//   · 못 읽은 값을 '—'나 '0'으로 적어서, 사용자가 "확인했는데 비어 있다"로
//     읽는다. 그러면 모르는 것이 아는 것으로 바뀐다
//   · 표에 적힌 간격과 **실제로 쓰인 간격**을 같은 숫자로 적어서,
//     "60분으로 해 뒀는데 왜 안 도나"가 영원히 안 풀린다
//
// 둘 다 이 저장소에서 실제로 난 고장이다.

import { test, eq, assert } from '../../test/harness';
import { dueDiagView, UNKNOWN_TEXT, DB_DEFAULT_INTERVAL_MIN } from './dueDiagView';
import { DEFAULT_INTERVAL_MIN } from '../autotrade/nextRun';

// 2026-11-05 01:38 UTC = 10:38 KST
const UTC_0138 = Date.UTC(2026, 10, 5, 1, 38, 0);
const MIN = 60_000;

export function runDueDiagViewTests() {
  console.log('[예약 화면 — 왜 안 도는지가 화면에 보인다]');

  test('설정값과 실제 적용값을 따로 적는다', () => {
    const v = dueDiagView({
      intervalMinRaw: 60, intervalMin: 60, intervalMinDefaulted: false,
      lastEvaluationAtMs: UTC_0138 - 10 * MIN, lastEvaluationAt: '',
      nextEvaluationAtMs: UTC_0138 + 50 * MIN, nextEvaluationAt: '',
      due: { due: false, code: 'WAITING', leftMin: 50, reason: '다음 평가까지 50분 남았습니다' },
    });
    eq(v.intervalText, '설정 60분');
    eq(v.intervalDefaulted, false);
  });

  test('**기본값이 끼어들면 그 사실을 적는다** — 설정값과 구분한다', () => {
    const v = dueDiagView({
      intervalMinRaw: null, intervalMin: 1440, intervalMinDefaulted: true,
      lastEvaluationAtMs: UTC_0138 - 10 * MIN, lastEvaluationAt: '',
      nextEvaluationAtMs: UTC_0138 + 1430 * MIN, nextEvaluationAt: '',
      due: { due: false, code: 'WAITING', leftMin: 1430, reason: '다음 평가까지 1430분 남았습니다' },
    });
    eq(v.intervalText, '설정 없음 → 기본값 1440분 적용');
    eq(v.intervalDefaulted, true, '화면이 경고색을 쓸 수 있어야 한다');
  });

  test('0으로 적혀 있으면 그 값도 보여주고 기본값 적용을 알린다', () => {
    const v = dueDiagView({
      intervalMinRaw: 0, intervalMin: 1440, intervalMinDefaulted: true,
      lastEvaluationAtMs: null, lastEvaluationAt: null,
      nextEvaluationAtMs: null, nextEvaluationAt: null,
      due: { due: true, code: 'FIRST', leftMin: null, reason: '아직 한 번도 평가하지 않았습니다' },
    });
    eq(v.intervalText, '설정 0분(쓸 수 없음) → 기본값 1440분 적용');
    eq(v.intervalDefaulted, true);
  });

  test('시각은 KST로 적는다', () => {
    const v = dueDiagView({
      intervalMinRaw: 60, intervalMin: 60, intervalMinDefaulted: false,
      lastEvaluationAtMs: UTC_0138, lastEvaluationAt: '',
      nextEvaluationAtMs: UTC_0138 + 60 * MIN, nextEvaluationAt: '',
      due: { due: false, code: 'WAITING', leftMin: 60, reason: '다음 평가까지 60분 남았습니다' },
    });
    // 01:38 UTC → 10:38 KST. ICU 표기가 환경마다 달라서 '10:38'만 확인한다
    eq(v.lastText.includes('10:38'), true, `KST 가 아니다: ${v.lastText}`);
    eq(v.nextText.includes('11:38'), true, `KST 가 아니다: ${v.nextText}`);
    eq(v.lastText.includes('KST'), true, '어느 시간대인지 적어야 한다');
  });

  test('**값이 없으면 확인 불가다** — 추측하지 않는다', () => {
    const v = dueDiagView({
      intervalMinRaw: null, intervalMin: 1440, intervalMinDefaulted: true,
      lastEvaluationAtMs: null, lastEvaluationAt: null,
      nextEvaluationAtMs: null, nextEvaluationAt: null,
      due: { due: true, code: 'FIRST', leftMin: null, reason: '아직 한 번도 평가하지 않았습니다' },
    });
    eq(v.lastText, '확인 불가');
    eq(v.nextText, '확인 불가');
  });

  test('진단 자체가 없으면 네 칸 모두 확인 불가다', () => {
    const v = dueDiagView(null);
    eq(v.intervalText, '확인 불가');
    eq(v.lastText, '확인 불가');
    eq(v.nextText, '확인 불가');
    eq(v.reasonText, '확인 불가');
    eq(v.intervalDefaulted, false, '모르는 것을 경고로 적지 않는다');
  });

  test('판정 이유는 서버 문구를 그대로 쓴다 — 화면이 다시 쓰지 않는다', () => {
    const reason = '다음 평가까지 59분 남았습니다';
    const v = dueDiagView({
      intervalMinRaw: 60, intervalMin: 60, intervalMinDefaulted: false,
      lastEvaluationAtMs: UTC_0138 - MIN, lastEvaluationAt: '',
      nextEvaluationAtMs: UTC_0138 + 59 * MIN, nextEvaluationAt: '',
      due: { due: false, code: 'WAITING', leftMin: 59, reason },
    });
    eq(v.reasonText, reason);
    eq(v.code, 'WAITING');
  });

  test('이유 문구가 비어 있으면 코드만으로 적지 않고 확인 불가다', () => {
    const v = dueDiagView({
      intervalMinRaw: 60, intervalMin: 60, intervalMinDefaulted: false,
      lastEvaluationAtMs: UTC_0138, lastEvaluationAt: '',
      nextEvaluationAtMs: UTC_0138 + 60 * MIN, nextEvaluationAt: '',
      due: { due: false, code: 'WAITING', leftMin: 60, reason: '  ' },
    });
    eq(v.reasonText, '확인 불가');
  });

  test('**시크릿이 섞여 들어와도 표시에 새지 않는다**', () => {
    const v: any = dueDiagView({
      intervalMinRaw: 60, intervalMin: 60, intervalMinDefaulted: false,
      lastEvaluationAtMs: UTC_0138, lastEvaluationAt: '',
      nextEvaluationAtMs: UTC_0138 + 60 * MIN, nextEvaluationAt: '',
      due: { due: false, code: 'WAITING', leftMin: 60, reason: 'ok' },
      apiKey: 'AK-nope', apiSecret: 'SK-nope',
    } as any);
    const flat = JSON.stringify(v);
    eq(flat.includes('AK-nope'), false, flat);
    eq(flat.includes('SK-nope'), false, flat);
    // **칸 목록을 못 박는다.** 새 칸을 더하려면 여기를 같이 고쳐야 하고,
    // 그때 "이 칸이 자유 문자열을 들고 나가는가"를 한 번 더 보게 된다.
    // `intervalIsDbDefault`는 숫자 비교에서 나온 불린이라 들고 나갈
    // 문자열이 없다.
    eq(Object.keys(v).sort().join(','),
      ['code','intervalDefaulted','intervalIsDbDefault','intervalText',
        'lastText','nextText','reasonText'].sort().join(','));
  });
  // ── 기본값과 같은 간격은 그 사실을 적는다 ──
  //
  // `interval_min`은 035에서 `NOT NULL DEFAULT 1440` + `CHECK (>= 1)`로
  // 만들어진다. 그래서 `intervalMinDefaulted`가 참이 되는 조건(raw가
  // null 또는 0)은 **운영 줄에서 한 번도 일어나지 않는다** — 돌려서
  // 확인했다. 아무도 설정하지 않은 예약이 "설정 1440분"으로 나와
  // 일부러 하루 1회를 고른 것과 구분되지 않았다.
  //
  // 값만으로 "사용자가 골랐는가"는 알 수 없다. 그래서 추측하지 않고
  // 아는 것만 적는다: 지금 적용되는 간격이 DB 기본값과 같다는 사실.

  test('아무도 설정하지 않은 줄(=DB 기본값 1440)은 그 사실이 보인다', () => {
    const v = dueDiagView({
      intervalMinRaw: 1440, intervalMin: 1440, intervalMinDefaulted: false,
      lastEvaluationAtMs: null, nextEvaluationAtMs: null,
      due: { due: false, code: 'WAITING', leftMin: null, reason: '아직 간격이 안 됐습니다' },
    });
    eq(v.intervalIsDbDefault, true);
    assert(v.intervalText.includes('DB 기본값과 같습니다'), v.intervalText);
    // 추측해서 '설정 없음'이라고 적지 않는다 — 고른 것일 수도 있다
    assert(!v.intervalText.includes('설정 없음'), v.intervalText);
  });

  test('사용자가 고른 간격에는 기본값 표시를 붙이지 않는다', () => {
    const v = dueDiagView({
      intervalMinRaw: 60, intervalMin: 60, intervalMinDefaulted: false,
      lastEvaluationAtMs: null, nextEvaluationAtMs: null,
      due: { due: true, code: 'DUE', leftMin: 0, reason: '' },
    });
    eq(v.intervalIsDbDefault, false);
    eq(v.intervalText, '설정 60분');
  });

  test('진단이 없으면 기본값과 같다고 적지 않는다', () => {
    const v = dueDiagView(null);
    eq(v.intervalIsDbDefault, false);
    eq(v.intervalText, UNKNOWN_TEXT);
  });

  test('DB 기본값과 코드 기본값이 같은 수인지 못 박는다', () => {
    // 둘은 **다른 사실**이다 — DB가 채우는 값 · 코드가 못 읽었을 때 쓰는 값.
    // 지금은 같은 수이고, 갈라지면 화면 문구가 틀린 말을 하게 된다.
    eq(DB_DEFAULT_INTERVAL_MIN, DEFAULT_INTERVAL_MIN);
  });
}
