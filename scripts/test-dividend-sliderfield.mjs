// scripts/test-dividend-sliderfield.mjs
//
// **DividendCalendarPage 수량 숫자칸 → SliderField 저장 회귀 (#778)**
//
// Codex 독립 검증이 짚은 축소 회귀를 값으로 못 박는다:
//   1차 (step=1): 0.5주 → 1주로 반올림됐다
//   2차 (step=0.001): 0.0005·5,000,000은 여전히 clamp/round됐다
//   3차 (이 테스트): step=0.00001·max=100_000_000·min=0 그대로 들여 보냄 확인
//
// **왜 scripts/test-*.mjs로 올렸는가**
// `scripts/run-tests.mjs`가 PR #772에 잡혀 있어 신규 `src/.../*.test.ts`를
// CI에 등록할 수 없다. `.github/workflows/ci.yml`은 `node --test
// scripts/test-*.mjs` 글롭을 이미 돌리므로 이 파일은 run-tests.mjs를
// 건드리지 않고 CI에 들어간다 — Codex 2차 지적이 알려 준 경로다.
//
// **왜 산식을 복사하지 않고 snapshot을 쓰는가**
// SettingField.tsx의 clamp·round는 React 컴포넌트 안의 로컬 함수라
// 그대로 import할 수 없다. 복사하면 소스가 변해도 복사본은 안 변해
// 거짓 통과가 난다 (CLAUDE.md "경로가 둘인데 한쪽만 고침"). 그래서
// **실제 소스 라인을 snapshot으로 묶는다** — 산식이 움직이면 snapshot
// 테스트가 먼저 깨지고, 그때 아래 실행 테스트의 기대값을 같이 손본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

// ── DividendCalendarPage의 두 SliderField가 쓰는 props ─────────────────
// 이 상수가 소스와 어긋나면 테스트가 거짓말을 한다. 아래 '페이지 소스
// snapshot' 테스트가 그 어긋남을 잡는다.
const ADD_PROPS = { min: 0, max: 100_000_000, step: 0.00001 };
const EDIT_PROPS = { min: 0, max: 100_000_000, step: 0.00001 };

// ── SliderField.tsx의 clamp·round 산식 (snapshot) ──────────────────────
// 이 문자열이 실제 소스에 있어야 한다. 없으면 산식이 움직였다는 뜻 —
// 이 파일의 로컬 복제본도 같이 맞춰야 한다. **이 snapshot이 깨지는 건
// 알림이다, 건너뛸 신호가 아니다.**
const CLAMP_SNAPSHOT  = '  const clamp = (n: number) => Math.min(max, Math.max(min, n));';
const ROUND_DECIMALS  = "  const decimals = (String(step).split('.')[1] || '').length;";
const ROUND_SNAPSHOT  = '  const round = (n: number) => Number(n.toFixed(decimals));';
const NUMBER_ONCHANGE = 'if (Number.isFinite(n)) onChange(round(clamp(n)));';
const RANGE_ONCHANGE  = 'onChange={e => onChange(round(clamp(parseFloat(e.target.value))))}';

function readSettingField() {
  return readFileSync(join(ROOT, 'src/components/ui/SettingField.tsx'), 'utf8');
}
function readDividendPage() {
  return readFileSync(join(ROOT, 'src/components/pages/DividendCalendarPage.tsx'), 'utf8');
}

// ── 로컬 복제 — snapshot이 통과했을 때만 이 산식이 소스와 같다고 믿는다 ──
function sliderOnChange(raw, { min, max, step }) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return NaN;
  const clamp = (x) => Math.min(max, Math.max(min, x));
  const decimals = (String(step).split('.')[1] || '').length;
  return Number(clamp(n).toFixed(decimals));
}

// ══ SettingField.tsx 소스가 기대한 모양 그대로인가 ═════════════════════

test('SettingField.tsx: SliderField의 clamp·round 라인이 snapshot 그대로 (아니면 로컬 복제를 같이 바꿔야 함)', () => {
  const src = readSettingField();
  for (const line of [CLAMP_SNAPSHOT, ROUND_DECIMALS, ROUND_SNAPSHOT, NUMBER_ONCHANGE, RANGE_ONCHANGE]) {
    assert.ok(
      src.includes(line),
      `SettingField.tsx에 다음 줄이 없음 — 산식이 바뀌었을 수 있다:\n  기대: ${line}\n  → test-dividend-sliderfield.mjs의 sliderOnChange·snapshot을 같이 고칠 것.`
    );
  }
});

test('DividendCalendarPage.tsx: 두 SliderField의 min·max·step이 이 테스트 상수와 같다', () => {
  const src = readDividendPage();
  // add 쪽
  assert.ok(src.includes('min={0} max={100_000_000} step={0.00001}'),
    'add SliderField의 min={0} max={100_000_000} step={0.00001}가 소스에 없음 — 상수를 수정하거나 소스 회귀');
  // 두 번(add + edit) 나와야 한다
  const matches = src.match(/min=\{0\} max=\{100_000_000\} step=\{0\.00001\}/g);
  assert.equal(matches?.length, 2, `두 SliderField 모두 같은 props여야 함. 실제 매칭 수: ${matches?.length ?? 0}`);
});

// ══ 저장 계약 보존 ═════════════════════════════════════════════════════

test('ADD props: 소수 보유 0.5주가 정수로 반올리지 않는다 (Codex 1차 지적)', () => {
  assert.equal(sliderOnChange('0.5', ADD_PROPS), 0.5);
});

test('ADD props: 0.001 (3자리) 보존', () => {
  assert.equal(sliderOnChange('0.001', ADD_PROPS), 0.001);
});

test('ADD props: 0.0005 (4자리) 보존 (Codex 2차 지적 — step=0.001이었을 때 0.001로 반올림됐다)', () => {
  assert.equal(sliderOnChange('0.0005', ADD_PROPS), 0.0005);
});

test('ADD props: 0.00001 (step 자리) 보존', () => {
  assert.equal(sliderOnChange('0.00001', ADD_PROPS), 0.00001);
});

test('ADD props: 0.000001 (step 아래)는 가장 가까운 step 배수 — 여기선 0', () => {
  // step=0.00001보다 작은 입력은 toFixed(5)에서 0으로 반올린다. 이 경우
  // addHolding의 n <= 0 안전망이 거른다.
  assert.equal(sliderOnChange('0.000001', ADD_PROPS), 0);
});

test('ADD props: 보통 정수 100은 그대로', () => {
  assert.equal(sliderOnChange('100', ADD_PROPS), 100);
});

test('ADD props: 5,000,000 보존 (Codex 2차 지적 — max=1M이었을 때 잘렸다)', () => {
  assert.equal(sliderOnChange('5000000', ADD_PROPS), 5000000);
});

test('ADD props: 100,000,001은 max로 clamp — 1억주는 realistic ceiling 넘음을 알리는 자리', () => {
  // 1억주를 넘는 보유를 편집하면 이 값으로 잘린다 — DividendCalendarPage.tsx
  // 주석에 적힌 trade-off. 더 올리려면 SliderField가 숫자칸까지 clamp하지
  // 않도록 API를 나눠야 한다 (별도 PR).
  assert.equal(sliderOnChange('100000001', ADD_PROPS), 100_000_000);
});

test('ADD props: 0은 그대로 (addHolding이 거를 안전망이 있다)', () => {
  assert.equal(sliderOnChange('0', ADD_PROPS), 0);
});

test('EDIT props: 0으로 두는 것은 updateHolding의 삭제 경로', () => {
  assert.equal(sliderOnChange('0', EDIT_PROPS), 0);
});

test('EDIT props: 기존 소수 보유(25.5) 그대로', () => {
  assert.equal(sliderOnChange('25.5', EDIT_PROPS), 25.5);
});

test('EDIT props: 소수 넷째 자리(123.4567)도 그대로', () => {
  assert.equal(sliderOnChange('123.4567', EDIT_PROPS), 123.4567);
});
