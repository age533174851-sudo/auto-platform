import { test, eq, assert } from '../../test/harness';
import {
  normalizeScale, nextScale, prevScale, applyScale,
  SCALE_STEPS, MIN_SCALE, MAX_SCALE,
} from './displayScale';

export function runDisplayScaleTests() {
  console.log('[화면 크기 — 이상한 값으로 화면이 잠기지 않게]');

  test('정상 값은 그대로', () => {
    eq(normalizeScale(1), 1);
    eq(normalizeScale(1.15), 1.15);
    eq(normalizeScale(1.5), 1.5);
  });

  test('범위를 벗어나면 잘라낸다', () => {
    // 화면이 3배로 커지면 아무것도 못 누르고, 그 상태에서 설정으로
    // 돌아갈 방법도 없다.
    eq(normalizeScale(5), MAX_SCALE);
    eq(normalizeScale(0.1), MIN_SCALE);
    eq(normalizeScale(-2), MIN_SCALE);
  });

  test('모르는 값은 1이다', () => {
    eq(normalizeScale(null), 1);
    eq(normalizeScale(undefined), 1);
    eq(normalizeScale('큼'), 1);
    eq(normalizeScale({}), 1);
    eq(normalizeScale(NaN), 1);
  });

  test('문자열도 읽는다 — localStorage는 문자열만 준다', () => {
    eq(normalizeScale('1.15'), 1.15);
  });

  test('부동소수 찌꺼기를 남기지 않는다', () => {
    // 1.1500000000000001이 저장되면 다음에 읽을 때 단계와 안 맞는다.
    eq(normalizeScale(1.15 + 0.0000000001), 1.15);
  });

  // ── 단계 이동 ───────────────────────────────────────────
  test('다음 단계로 올라간다', () => {
    eq(nextScale(1), 1.15);
    eq(nextScale(1.15), 1.3);
  });

  test('맨 위에서는 안 올라간다', () => {
    eq(nextScale(MAX_SCALE), MAX_SCALE);
    eq(nextScale(99), MAX_SCALE);
  });

  test('이전 단계로 내려간다', () => {
    eq(prevScale(1.3), 1.15);
    eq(prevScale(1.15), 1);
  });

  test('맨 아래에서는 안 내려간다', () => {
    eq(prevScale(1), 1);
    eq(prevScale(0), 1);
  });

  test('단계 사이 값에서도 움직인다', () => {
    // 저장된 값이 단계에 없어도(옛 버전 등) 갇히지 않아야 한다.
    eq(nextScale(1.2), 1.3);
    eq(prevScale(1.2), 1.15);
  });

  // ── 적용 ────────────────────────────────────────────────
  const fakeDoc = () => ({ documentElement: { style: {} as any } }) as any;

  test('1이면 속성을 지운다', () => {
    // zoom:1을 남기면 일부 브라우저가 그것만으로 새 합성 레이어를 만들어
    // 스크롤이 무거워진다.
    const d = fakeDoc();
    d.documentElement.style.zoom = '1.3';
    applyScale(1, d);
    eq(d.documentElement.style.zoom, '');
  });

  test('배율을 문자열로 적는다', () => {
    const d = fakeDoc();
    applyScale(1.3, d);
    eq(d.documentElement.style.zoom, '1.3');
  });

  test('적용할 때도 범위를 지킨다', () => {
    const d = fakeDoc();
    applyScale(99, d);
    eq(d.documentElement.style.zoom, String(MAX_SCALE));
  });

  test('문서가 없어도 터지지 않는다', () => {
    applyScale(1.3, null as any);
    applyScale(1.3, {} as any);
  });

  // ── 목록 자체 ───────────────────────────────────────────
  test('단계가 오름차순이고 중복이 없다', () => {
    const vs = SCALE_STEPS.map(s => s.value);
    for (let i = 1; i < vs.length; i++) {
      assert(vs[i] > vs[i - 1], `${vs[i]}가 ${vs[i - 1]}보다 커야 한다`);
    }
  });

  test('첫 단계가 기본값 1이다', () => {
    // 1이 목록에 없으면 '보통'으로 돌아갈 방법이 없다.
    eq(SCALE_STEPS[0].value, 1);
  });

  test('모든 단계가 허용 범위 안이다', () => {
    for (const s of SCALE_STEPS) {
      eq(normalizeScale(s.value), s.value);
    }
  });

  test('모든 단계에 이름이 있다', () => {
    for (const s of SCALE_STEPS) {
      assert(s.label.length > 0 && s.note.length > 0, `${s.value}에 이름이 없습니다`);
    }
  });
}
