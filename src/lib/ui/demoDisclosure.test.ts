// src/lib/ui/demoDisclosure.test.ts
//
// **판정을 이 파일에 둔다.** `check-wiring.mjs`는 `src/lib/**`의 판정
// 모듈이 화면에서 불리지 않으면 막는다 — 그 규칙이 옳다. 이 판정은
// 화면에서 부를 것이 아니라 **소스를 검사하는 규칙**이라서 애초에
// 생산 경로 호출자가 없다. 그래서 별도 모듈로 두지 않고 시험과 같은
// 파일에 둔다(검사기는 `.test.ts`를 대상에서 뺀다). 규칙 자체도
// 아래에서 고정 입력으로 시험한다.
import { test, eq, assert } from '../../test/harness';
import { readFileSync, existsSync } from 'node:fs';

//
// **데모 숫자를 보여 주는 화면은 데모라고 말해야 한다.**
//
// 이 저장소에는 하드코딩·합성 입력으로 도는 패널이 넷 있다. 셋은 스스로
// 데모라고 적는다:
//
//   WalkForwardPanel   "워크포워드 알고리즘 데모" · "이 결과는 실제 시장의
//                       엣지 증거가 아니며…"
//   DailyStrategyPanel "1D 5v5 합성 경로 연구 결과" · "…실제 거래소 과거
//                       데이터가 아니라 코드가 생성한 합성 데이터입니다"
//   StrategyFactoryPanel "데모 — 이 화면의 성과 숫자는 실측이 아닙니다"
//
// `EnginePanel`은 적지 않았다. 머리말은 "실행 엔진 (백엔드)"이고 하드코딩된
// `DEMO_SIGNAL` 하나로 돌면서 초록색 **"검증 통과"**를 띄운다. 어디에도
// 그 신호가 지어낸 것이라는 말이 없다.
//
// CLAUDE.md: **실제 증거 없이 PASS를 적지 않는다.** 그래서 이 판단을 한
// 곳에 두고 시험을 붙인다 — 다음에 데모 패널이 늘어도 라벨 없이는 통과
// 못 한다. 문구는 각 화면이 알아서 쓰되 **데모라는 말은 반드시 있어야**
// 한다.

/** 하드코딩·합성 입력으로 도는 화면과, 그 사실을 알리는지 보는 기준 */
export const DEMO_PANELS = [
  'src/components/EnginePanel.tsx',
  'src/components/StrategyFactoryPanel.tsx',
  'src/components/WalkForwardPanel.tsx',
  'src/components/DailyStrategyPanel.tsx',
] as const;

/**
 * 데모 입력의 흔적. 하나라도 있으면 이 화면은 지어낸 값으로 돈다.
 * 이름만 본다 — 값은 보지 않는다.
 */
export const DEMO_INPUT_MARKERS = ['DEMO_', 'makeDaily', 'generateSyntheticCandles'] as const;

/**
 * 사용자에게 보이는 고지. 화면마다 문구는 달라도 이 중 하나는 있어야 한다.
 * `//` 주석 안의 단어는 사용자가 못 보므로 세지 않는다.
 */
export const DISCLOSURE_MARKERS = ['데모', '합성'] as const;

export interface PanelVerdict {
  path: string;
  hasDemoInput: boolean;
  disclosed: boolean;
  /** 못 읽었으면 통과로 적지 않는다 */
  unreadable: boolean;
}

/** 줄 단위 `//` 주석을 지운다 — 주석의 "데모"는 사용자에게 보이지 않는다. */
export function stripLineComments(src: string): string {
  return src.split('\n').map(l => {
    const i = l.indexOf('//');
    if (i < 0) return l;
    // 문자열 안의 `//`(예: URL)를 주석으로 오인하지 않도록 따옴표 개수를 본다.
    const before = l.slice(0, i);
    const odd = (q: string) => (before.split(q).length - 1) % 2 === 1;
    if (odd("'") || odd('"') || odd('`')) return l;
    return before;
  }).join('\n');
}

export function judgePanel(path: string, src: string | null): PanelVerdict {
  if (src == null) return { path, hasDemoInput: false, disclosed: false, unreadable: true };
  const hasDemoInput = DEMO_INPUT_MARKERS.some(m => src.includes(m));
  const visible = stripLineComments(src);
  const disclosed = DISCLOSURE_MARKERS.some(m => visible.includes(m));
  return { path, hasDemoInput, disclosed, unreadable: false };
}

/**
 * 고지가 없는 데모 화면을 돌려준다. 파일을 못 읽은 것도 함께 돌려준다 —
 * **읽지 못한 것을 "없음"으로 적지 않는다.**
 */
export function findUndisclosedDemoPanels(
  read: (path: string) => string | null,
  paths: readonly string[] = DEMO_PANELS,
): { undisclosed: PanelVerdict[]; unreadable: PanelVerdict[] } {
  const verdicts = paths.map(p => judgePanel(p, read(p)));
  return {
    undisclosed: verdicts.filter(v => !v.unreadable && v.hasDemoInput && !v.disclosed),
    unreadable: verdicts.filter(v => v.unreadable),
  };
}


export function runDemoDisclosureTests() {
  console.log('[데모 화면 — 지어낸 숫자를 보여 주면 데모라고 말한다]');

  // ── 판단 자체를 먼저 시험한다 (실제 파일과 무관하게) ──

  test('데모 입력이 있고 고지도 있으면 통과', () => {
    const v = judgePanel('x.tsx', 'const DEMO_SIGNAL = 1;\nreturn <div>데모 화면입니다</div>;');
    eq(v.hasDemoInput, true); eq(v.disclosed, true);
  });

  test('★ 데모 입력이 있는데 고지가 없으면 잡는다', () => {
    const v = judgePanel('x.tsx', 'const DEMO_SIGNAL = 1;\nreturn <div>실행 엔진</div>;');
    eq(v.hasDemoInput, true); eq(v.disclosed, false);
  });

  test('★ 주석 안의 "데모"는 고지로 세지 않는다 — 사용자가 못 본다', () => {
    const v = judgePanel('x.tsx', '// 데모 다중 전략\nconst DEMO_X = 1;\nreturn <div>실행 엔진</div>;');
    eq(v.disclosed, false);
  });

  test('문자열 안의 // 를 주석으로 오인하지 않는다', () => {
    const kept = stripLineComments('const u = "https://x/데모";');
    assert(kept.includes('데모'), kept);
  });

  test('합성 데이터 생성기도 데모 입력으로 본다', () => {
    eq(judgePanel('x.tsx', 'makeDaily(10)').hasDemoInput, true);
    eq(judgePanel('x.tsx', 'generateSyntheticCandles({})').hasDemoInput, true);
  });

  test('데모 입력이 없는 화면은 고지가 없어도 잡지 않는다', () => {
    const v = judgePanel('x.tsx', 'const rows = await fetchRows();');
    eq(v.hasDemoInput, false);
  });

  test('★ 못 읽은 파일을 "없음"으로 적지 않는다', () => {
    const r = findUndisclosedDemoPanels(() => null, ['a.tsx']);
    eq(r.unreadable.length, 1); eq(r.undisclosed.length, 0);
  });

  // ── 실제 화면에 적용한다 ──

  test('★ 저장소의 데모 화면 전부가 데모라고 말한다', () => {
    // run-tests.mjs는 `src/`를 임시 디렉터리로 복사하고 그 안에서 돈다.
    // 그래서 cwd 기준 상대 경로로 읽힌다. 못 읽으면 통과로 적지 않는다.
    const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
    const { undisclosed, unreadable } = findUndisclosedDemoPanels(read, DEMO_PANELS);
    assert(unreadable.length === 0,
      `읽지 못한 화면이 있습니다 (통과로 적지 않습니다): ${unreadable.map(v => v.path).join(', ')}`);
    assert(undisclosed.length === 0,
      `데모 입력으로 도는데 데모라고 말하지 않는 화면: ${undisclosed.map(v => v.path).join(', ')}`);
  });
}
