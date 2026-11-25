// src/lib/accounts/dividends.test.ts
//
// **왜 이 시험이 있는가 (PR #778 리뷰 지적)**
// ────────────────────────────────────────────
// DividendCalendarPage의 `addHolding`·`updateHolding`은 저장 계약상 **정수가
// 아닌 유한한 양의 수량**을 받는다 (DRIP·분할매수로 0.5주 같은 소수 보유가
// 생긴다). 그 저장 경로 위에 UI `<SliderField>`를 얹을 때, slider의
// `step`·`min`·`max`가 저장 계약보다 좁으면 **기존에 저장 가능하던 값이
// UI를 거치며 바뀐다** — 그게 Codex 독립 검증이 짚은 회귀다.
//
// `SliderField.tsx` 자체는 JSX이고 테스트 러너는 .tsx를 컴파일하지 않으므로
// 여기서는 그 함수를 직접 import하지 않는다. 대신 그 clamp·round 산식을
// 그대로 복제(`sliderOnChange`)해 **이 페이지가 쓰는 props**에서 어떤
// 입력이 어떤 저장값으로 바뀌는지 값으로 못 박는다. 산식이 벗어나면 이
// 시험이 같이 벗어나 알려준다.
//
// 저장 쪽은 pure한 `estimateAnnualDividends`로 round-trip을 본다 —
// 소수 보유가 들어오면 연배당 숫자도 소수가 반영된 값으로 나와야
// addHolding → 화면이 일치한다.

import { test, close, eq, assert } from '../../test/harness';
import {
  estimateAnnualDividends,
  DIVIDEND_UNIVERSE,
  type DividendHolding,
} from './dividends';

// **왜 함수로 감쌌는가**
// run-tests.mjs가 각 테스트 파일을 `runXxxTests()` 모양으로 호출한다.
// 이 PR은 scripts/run-tests.mjs를 건드리지 않는다 (다른 열린 PR이 잡고
// 있다). 그래서 지금은 자동 실행되지 않지만, 그 파일이 풀리는 PR에서
// `import { runDividendsTests } from './src/lib/accounts/dividends.test';`
// 와 `runDividendsTests();` 두 줄을 넣기만 하면 CI에 들어온다. 그 전까지는
// `node --test` 한 번으로 수동 실행할 수 있도록 harness 호출만 유지한다.
export function runDividendsTests() {
  console.log('[배당 보유 수량 — SliderField 저장 회귀 (#778)]');

// ── SliderField.tsx의 onChange 산식 복제 ───────────────────────────────
// (src/components/ui/SettingField.tsx 192~253 의 로직을 값 수준에서 재현)
//
// 숫자칸에서 사용자가 raw를 입력하면 SliderField 안에서 이렇게 저장된다:
//   const clamp = n => Math.min(max, Math.max(min, n));
//   const decimals = (String(step).split('.')[1] || '').length;
//   const round = n => Number(n.toFixed(decimals));
//   onChange(round(clamp(parseFloat(raw))));
//
// **이 함수가 틀리면 아래 시험이 전부 거짓말이 된다.**  그래서 SliderField
// 소스를 바꿀 때마다 이 복제본을 같이 맞춰야 한다 — 한 곳에 두고 둘 다
// 쓰려면 clamp/round를 비-JSX 모듈로 뽑아 import 해야 하는데, 그 리팩터는
// 이 PR 범위 밖이라 **의도적으로 같은 산식을 두 곳에 두는 쪽**을 골랐다
// (CLAUDE.md "경로가 둘인데 한쪽만 고침" 함정을 이 주석이 눈에 띄게
// 적어 상쇄). 다음에 SettingField.tsx를 고치는 PR이 이 파일도 같이
// 고치지 않으면 테스트가 깨진다.
function sliderOnChange(raw: string, min: number, max: number, step: number): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return NaN;
  const clamp = (x: number) => Math.min(max, Math.max(min, x));
  const decimals = (String(step).split('.')[1] || '').length;
  return Number(clamp(n).toFixed(decimals));
}

// DividendCalendarPage.tsx에서 두 SliderField가 쓰는 props. 코드와 틀어지면
// 저장 회귀로 이어지므로 **값으로 못 박는다**.
const ADD_PROPS = { min: 0, max: 1_000_000, step: 0.001 };
const EDIT_PROPS = { min: 0, max: 1_000_000, step: 0.001 };

// ── UI → 저장 변환 ─────────────────────────────────────────────────────

test('SliderField ADD props: 소수 보유 0.5주가 정수로 반올리지 않는다', () => {
  // 회귀: #778 리뷰가 step=1·min=1에서 onChange(1)이 되는 걸 짚었다.
  // 지금은 그대로 들여 보내야 한다.
  close(sliderOnChange('0.5', ADD_PROPS.min, ADD_PROPS.max, ADD_PROPS.step), 0.5);
});

test('SliderField ADD props: 0.001 (step의 자리) 보유도 그대로 들여 보낸다', () => {
  close(sliderOnChange('0.001', ADD_PROPS.min, ADD_PROPS.max, ADD_PROPS.step), 0.001);
});

test('SliderField ADD props: 0.0001 (step 아래)은 가장 가까운 step 배수로 반올림', () => {
  // step=0.001이면 소수 셋째 자리 아래는 반영되지 않는다. 사용자에게
  // "저장된 값"이 명확하도록 반올림 결과를 못 박는다.
  close(sliderOnChange('0.0005', ADD_PROPS.min, ADD_PROPS.max, ADD_PROPS.step), 0.001);
});

test('SliderField ADD props: 보통 정수 입력(100)은 정수 그대로', () => {
  eq(sliderOnChange('100', ADD_PROPS.min, ADD_PROPS.max, ADD_PROPS.step), 100);
});

test('SliderField ADD props: max=1_000_000 넘는 입력은 max로 clamp된다', () => {
  // 100만 넘는 수량은 slider의 유한 max에 걸린다 — PR 본문에 이 상한의
  // 근거를 적어 뒀다. 넘는 사용자가 실제로 있다면 상한을 올리는 쪽으로
  // 다시 보는 것이 맞다.
  eq(sliderOnChange('5000000', ADD_PROPS.min, ADD_PROPS.max, ADD_PROPS.step), 1_000_000);
});

test('SliderField ADD props: 0은 그대로 (addHolding이 거를 안전망이 있어서)', () => {
  // min=0이라 slider에서 0으로 끌어가는 것도 가능. 저장 쪽에서는
  // addHolding이 `n <= 0 → notifyError`로 막는다 — 그 안전망이
  // 있으므로 slider에서 추가로 1로 끌어올리지 않는다.
  eq(sliderOnChange('0', ADD_PROPS.min, ADD_PROPS.max, ADD_PROPS.step), 0);
});

test('SliderField EDIT props: 0으로 두는 것은 updateHolding의 삭제 경로', () => {
  // updateHolding(DividendCalendarPage.tsx line ~86)은 n === 0이면
  // 해당 종목을 persist(filter)로 뺀다. 그래서 EDIT props는 min=0이고,
  // 사용자가 0으로 두고 확인을 누르는 경로를 UI에서 지워서는 안 된다.
  eq(sliderOnChange('0', EDIT_PROPS.min, EDIT_PROPS.max, EDIT_PROPS.step), 0);
});

test('SliderField EDIT props: 기존 소수 보유(25.5)를 편집해도 반올리지 않는다', () => {
  // 사용자가 숫자칸을 그대로 두고 확인만 눌렀다고 가정하면, SliderField는
  // `value={Number(draftShares)||0}`를 해당 raw로 받아 재입력이
  // 일어나지 않지만, 사용자가 숫자칸을 재입력(같은 값을 다시 치는 등)하면
  // 그 raw가 onChange를 탄다. 그때 소수가 반올려서는 안 된다.
  close(sliderOnChange('25.5', EDIT_PROPS.min, EDIT_PROPS.max, EDIT_PROPS.step), 25.5);
});

// ── 저장 → 화면 ────────────────────────────────────────────────────────

test('estimateAnnualDividends: 소수 보유(0.5주)도 연배당에 반영된다', () => {
  const schd = DIVIDEND_UNIVERSE.find(d => d.symbol === 'SCHD');
  assert(!!schd, 'SCHD 메타 데이터가 DIVIDEND_UNIVERSE에 있어야 한다');
  const paymentsPerYear =
    schd!.frequency === 'monthly'     ? 12 :
    schd!.frequency === 'quarterly'   ? 4 :
    schd!.frequency === 'semi-annual' ? 2 : 1;
  const expected = schd!.paymentPerShare * paymentsPerYear * 0.5;

  const holdings: DividendHolding[] = [{ symbol: 'SCHD', shares: 0.5 }];
  const est = estimateAnnualDividends(holdings);
  eq(est.length, 1);
  eq(est[0].symbol, 'SCHD');
  close(est[0].shares, 0.5);
  close(est[0].annualDividend, expected);
});

test('estimateAnnualDividends: 큰 보유(1_000_000주)도 그대로 곱한다', () => {
  // slider가 1_000_000에서 clamp하지만, 저장 계약 자체는 더 큰 수도 받는다.
  // 기존에 저장된 큰 값이 estimate를 거쳐 화면에 어떻게 나오는지 못 박는다.
  const schd = DIVIDEND_UNIVERSE.find(d => d.symbol === 'SCHD');
  assert(!!schd, 'SCHD 메타');
  const paymentsPerYear =
    schd!.frequency === 'monthly'     ? 12 :
    schd!.frequency === 'quarterly'   ? 4 :
    schd!.frequency === 'semi-annual' ? 2 : 1;

  const est = estimateAnnualDividends([{ symbol: 'SCHD', shares: 1_000_000 }]);
  eq(est.length, 1);
  eq(est[0].shares, 1_000_000);
  close(est[0].annualDividend, schd!.paymentPerShare * paymentsPerYear * 1_000_000);
});

test('estimateAnnualDividends: 미지원 심볼은 조용히 걸러진다', () => {
  // addHolding이 DIVIDEND_UNIVERSE에 없는 심볼을 저장 전에 막지만, 저장 쪽
  // round-trip의 내구성을 같이 본다.
  const est = estimateAnnualDividends([
    { symbol: '___NOT_A_SYMBOL___', shares: 10 },
    { symbol: 'SCHD', shares: 1 },
  ]);
  eq(est.length, 1);
  eq(est[0].symbol, 'SCHD');
});

test('estimateAnnualDividends: 빈 배열·이상한 입력에도 빈 배열을 돌려준다', () => {
  eq(estimateAnnualDividends([]).length, 0);
  // 타입 바깥 입력에도 던지지 않는다 (defensive guard 유지 확인)
  eq(estimateAnnualDividends(null as unknown as DividendHolding[]).length, 0);
  eq(estimateAnnualDividends(undefined as unknown as DividendHolding[]).length, 0);
});

} // runDividendsTests
