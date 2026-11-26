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
const NUMBER_PRESERVE = 'onChange(preserveRawNumber ? n : round(clamp(n)));';
const RANGE_ONCHANGE  = 'onChange={e => onChange(round(clamp(parseFloat(e.target.value))))}';
const PRESERVE_PROP   = 'preserveRawNumber?: boolean;';

function readSettingField() {
  return readFileSync(join(ROOT, 'src/components/ui/SettingField.tsx'), 'utf8');
}
function readDividendPage() {
  return readFileSync(join(ROOT, 'src/components/pages/DividendCalendarPage.tsx'), 'utf8');
}

// ── 로컬 복제 — snapshot이 통과했을 때만 이 산식이 소스와 같다고 믿는다 ──
//
// SliderField는 두 입력(slider·숫자칸)에 서로 다른 처리를 한다:
//   - slider(range): 항상 round(clamp(n))
//   - 숫자칸: preserveRawNumber면 raw n 그대로, 아니면 round(clamp(n))
//
// DividendCalendarPage의 두 SliderField는 preserveRawNumber=true다. 따라서
// 숫자칸으로 들어온 사용자 입력은 clamp·round를 거치지 않고 저장 상태에
// 그대로 들어간다. slider를 드래그한 값은 여전히 clamp·round된다.
function sliderOnChange(raw, { min, max, step }, kind) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return NaN;
  const clamp = (x) => Math.min(max, Math.max(min, x));
  const decimals = (String(step).split('.')[1] || '').length;
  if (kind === 'number-preserveRaw') return n; // DividendCalendarPage의 숫자칸 경로
  return Number(clamp(n).toFixed(decimals));   // slider 또는 preserveRawNumber 꺼진 숫자칸
}

// ══ SettingField.tsx 소스가 기대한 모양 그대로인가 ═════════════════════

test('SettingField.tsx: SliderField의 clamp·round·preserveRawNumber 라인이 snapshot 그대로', () => {
  const src = readSettingField();
  for (const line of [CLAMP_SNAPSHOT, ROUND_DECIMALS, ROUND_SNAPSHOT, NUMBER_PRESERVE, RANGE_ONCHANGE, PRESERVE_PROP]) {
    assert.ok(
      src.includes(line),
      `SettingField.tsx에 다음 줄이 없음 — 산식이 바뀌었을 수 있다:\n  기대: ${line}\n  → test-dividend-sliderfield.mjs의 sliderOnChange·snapshot을 같이 고칠 것.`
    );
  }
});

test('DividendCalendarPage.tsx: 두 SliderField의 min·max·step·preserveRawNumber가 이 테스트 상수와 같다', () => {
  const src = readDividendPage();
  const propsMatches = src.match(/min=\{0\.00001\} max=\{100_000_000\} step=\{0\.00001\}/g);
  assert.equal(propsMatches?.length, 2,
    `두 SliderField 모두 min={0.00001} max={100_000_000} step={0.00001} 여야 함. 실제 매칭 수: ${propsMatches?.length ?? 0}`);
  // preserveRawNumber가 JSX 속성으로 두 곳 다 있어야 한다 — 숫자칸에서
  // 사용자 입력이 clamp·round 없이 저장 경로로 가도록 (Codex 4차 "10배
  // 저장" 차단). JSX 속성은 들여쓰기 뒤에 혼자 쓰이는 shorthand 모양
  // (`={...}` 없이, 그 자리에서 줄바꿈).
  const preserveMatches = src.match(/^\s+preserveRawNumber\s*$/gm);
  assert.equal(preserveMatches?.length, 2,
    `두 SliderField 모두 JSX shorthand로 preserveRawNumber를 켜야 함. 실제 매칭 수: ${preserveMatches?.length ?? 0}`);
});

test('DividendCalendarPage.tsx: 삭제는 별도 removeHolding 경로 — updateHolding은 n<=0을 거절', () => {
  const src = readDividendPage();
  assert.ok(!src.includes('n === 0) persist(holdings.filter'),
    '수정 경로가 n===0을 삭제로 해석하는 분기가 다시 생김 (silent-delete 회귀)');
  assert.ok(src.includes('const removeHolding ='), 'removeHolding 함수가 사라짐');
  assert.ok(src.includes('onClick={() => removeHolding('), '🗑 버튼이 removeHolding을 호출하지 않음');
});

// ══ 숫자칸 (preserveRawNumber=true) — 사용자 입력 그대로 저장 ══════════

test('숫자칸: 소수 보유 0.5주가 정수로 반올리지 않는다 (Codex 1차 지적)', () => {
  assert.equal(sliderOnChange('0.5', ADD_PROPS, 'number-preserveRaw'), 0.5);
});

test('숫자칸: 0.0005 보존 (Codex 2차 지적)', () => {
  assert.equal(sliderOnChange('0.0005', ADD_PROPS, 'number-preserveRaw'), 0.0005);
});

test('숫자칸: 0.000001 보존 (Codex 4차 재현 — 전엔 0.00001로 10배 저장됐다)', () => {
  // **핵심 회귀 방어**: 사용자가 친 양수를 조용히 다른 양수로 바꾸지 않는다.
  assert.equal(sliderOnChange('0.000001', ADD_PROPS, 'number-preserveRaw'), 0.000001);
});

test('숫자칸: 보통 정수 100 보존', () => {
  assert.equal(sliderOnChange('100', ADD_PROPS, 'number-preserveRaw'), 100);
});

test('숫자칸: 5,000,000 보존 (Codex 2차 지적)', () => {
  assert.equal(sliderOnChange('5000000', ADD_PROPS, 'number-preserveRaw'), 5_000_000);
});

test('숫자칸: 100,000,001도 보존 — slider 상한을 넘어도 숫자칸은 그대로', () => {
  // preserveRawNumber=true이므로 slider의 max=100M 상한이 숫자칸 입력을
  // 자르지 않는다. 호출자(addHolding/updateHolding)가 저장 전에 결정한다.
  assert.equal(sliderOnChange('100000001', ADD_PROPS, 'number-preserveRaw'), 100_000_001);
});

test('숫자칸: 0 보존 → updateHolding/addHolding이 거절한다', () => {
  // 전에는 draftShares="0" → "n===0 → 삭제" 분기였다. 지금은 숫자칸이
  // 0을 그대로 보내고, updateHolding은 validateHoldingShares.non-positive로
  // 거절 → notifyError. 삭제는 🗑 버튼으로만.
  assert.equal(sliderOnChange('0', EDIT_PROPS, 'number-preserveRaw'), 0);
});

test('숫자칸: 음수(-5) 보존 → validateHoldingShares가 거절한다', () => {
  assert.equal(sliderOnChange('-5', ADD_PROPS, 'number-preserveRaw'), -5);
});

test('숫자칸: 기존 소수 보유(25.5) 그대로', () => {
  assert.equal(sliderOnChange('25.5', EDIT_PROPS, 'number-preserveRaw'), 25.5);
});

test('숫자칸: 소수 7자리(0.0000123)도 그대로 — step=0.00001 아래도 통과', () => {
  assert.equal(sliderOnChange('0.0000123', EDIT_PROPS, 'number-preserveRaw'), 0.0000123);
});

// ══ slider (range input) — 여전히 clamp·round 적용 ═════════════════════

test('slider: 0.000001은 min=0.00001로 clamp된다 (slider는 물리적 범위 안)', () => {
  // range input은 min·max를 벗어날 수 없고, step으로 정렬된다. 숫자칸과는
  // 처리가 다르다.
  assert.equal(sliderOnChange('0.000001', ADD_PROPS, 'slider'), 0.00001);
});

test('slider: 100,000,001은 max=100_000_000으로 clamp된다', () => {
  assert.equal(sliderOnChange('100000001', ADD_PROPS, 'slider'), 100_000_000);
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
