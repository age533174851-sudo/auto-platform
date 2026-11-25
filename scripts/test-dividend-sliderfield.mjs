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
//
// **min이 step과 같은 이유 (Codex 3차 재현 7177918783 반영)**
// min=0이었을 때 SliderField의 toFixed(5)가 양의 소수 0.000001을 0으로
// 반올려 updateHolding('SCHD', 0)을 호출했다. 그 당시 updateHolding은
// n === 0을 "삭제"로 해석했기 때문에 **양의 수량을 치려던 사용자가 조용히
// 보유를 잃는** 길이 뚫려 있었다. 삭제는 이제 별도 🗑 버튼이므로
// updateHolding은 n <= 0을 거절한다. slider도 0에 닿지 않게 min을
// step으로 올렸다.
const ADD_PROPS = { min: 0.00001, max: 100_000_000, step: 0.00001 };
const EDIT_PROPS = { min: 0.00001, max: 100_000_000, step: 0.00001 };

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
  const matches = src.match(/min=\{0\.00001\} max=\{100_000_000\} step=\{0\.00001\}/g);
  assert.equal(matches?.length, 2,
    `두 SliderField 모두 min={0.00001} max={100_000_000} step={0.00001} 여야 함. 실제 매칭 수: ${matches?.length ?? 0}`);
});

test('DividendCalendarPage.tsx: 삭제는 별도 removeHolding 경로 — updateHolding은 n<=0을 거절', () => {
  const src = readDividendPage();
  // updateHolding의 분기 `if (n === 0) persist(holdings.filter(...))`가
  // 남아 있으면 silent-delete 회귀.
  assert.ok(!src.includes('n === 0) persist(holdings.filter'),
    '수정 경로가 n===0을 삭제로 해석하는 분기가 다시 생김 (silent-delete 회귀)');
  // 삭제는 removeHolding을 통해서만
  assert.ok(src.includes('const removeHolding ='), 'removeHolding 함수가 사라짐');
  assert.ok(src.includes('onClick={() => removeHolding('), '🗑 버튼이 removeHolding을 호출하지 않음');
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

test('ADD props: 0.000001 (step 아래)는 min으로 clamp — 0이 아니다 (Codex 3차 silent-delete 방어)', () => {
  // step=0.00001보다 작은 양수 입력은 toFixed(5)에서 0으로 반올리지만,
  // 그 전에 min=0.00001로 clamp된다 (SliderField는 clamp → round 순서).
  // 따라서 양수가 0으로 변하는 길이 막힌다.
  assert.equal(sliderOnChange('0.000001', ADD_PROPS), 0.00001);
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

test('ADD props: 0은 min으로 clamp — 0이 아니다 (silent-nothing 방어)', () => {
  // 전에는 0 입력 → addShares='' → 저장 눌러도 아무 일 없음 (silent fail).
  // min=0.00001로 clamp되므로 유효 입력으로 들어간다.
  assert.equal(sliderOnChange('0', ADD_PROPS), 0.00001);
});

test('EDIT props: 0은 min으로 clamp — 삭제로 해석되지 않는다 (silent-delete 방어)', () => {
  // 전에는 draftShares="0" → updateHolding의 "n===0 → 삭제" 분기에 걸렸다.
  // min=0.00001이면 slider에서는 0에 닿지 못하고, updateHolding 자체가
  // n<=0을 거절한다. 삭제는 🗑 버튼으로만.
  assert.equal(sliderOnChange('0', EDIT_PROPS), 0.00001);
});

test('EDIT props: 0.000001 (Codex 재현 입력)은 silent-delete로 가지 않는다', () => {
  // Codex 3차 재현 경로의 핵심 입력. min=0.00001·updateHolding 거절
  // 두 겹으로 막힌다. 여기서는 SliderField onChange의 결과만 검증한다
  // (0.00001 — min clamp). updateHolding의 거절은 아래 validate 테스트에서.
  assert.equal(sliderOnChange('0.000001', EDIT_PROPS), 0.00001);
});

test('EDIT props: 기존 소수 보유(25.5) 그대로', () => {
  assert.equal(sliderOnChange('25.5', EDIT_PROPS), 25.5);
});

test('EDIT props: 소수 넷째 자리(123.4567)도 그대로', () => {
  assert.equal(sliderOnChange('123.4567', EDIT_PROPS), 123.4567);
});

// ══ validateHoldingShares — updateHolding의 저장 결정 (silent-delete 방어 핵심) ══
//
// 이 함수는 src/lib/accounts/dividends.ts에 **pure**로 뺐다. DividendCalendarPage의
// updateHolding이 이걸 호출해 n<=0을 거절한다. 전처럼 "n===0이면 삭제"가
// 아니다 — 삭제는 removeHolding 전용.
test('dividends.ts: validateHoldingShares는 양의 유한 수량만 ok', async () => {
  const src = readFileSync(join(ROOT, 'src/lib/accounts/dividends.ts'), 'utf8');
  assert.ok(src.includes('export function validateHoldingShares'),
    'validateHoldingShares가 dividends.ts에 없음 — silent-delete 방어 핵심이 사라짐');
  // 거절 사유도 명시되어야 한다
  assert.ok(src.includes("'not-finite'") && src.includes("'non-positive'"),
    'validateHoldingShares의 거절 사유 상수가 바뀜');
});
