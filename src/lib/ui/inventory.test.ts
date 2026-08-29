// src/lib/ui/inventory.test.ts
//
// **Inventory가 자기모순이면 그걸 보고 내리는 판단이 전부 틀린다.**
//
// 여기서 보는 것은 "화면이 예쁜가"가 아니라 목록 자체의 성질이다:
// id가 겹치지 않는가 · 값이 정해진 것 중에 있는가 · 구분이 사라지지
// 않았는가 · **안 본 것을 봤다고 적지 않았는가.**
import { test, eq, assert } from '../../test/harness';
import {
  SCREENS, NAVIGATION, PRIMITIVES, OVERLAYS, FEEDBACK, CONVERGENCE, SEMANTICS,
  ENVIRONMENTS, UI_STATES, MIGRATION_STATUSES, PRIMITIVE_STATUSES, UI_STATE_INVENTORY,
} from './inventory';

export function runInventoryTests() {
  console.log('\n🧪 UI Inventory — 목록이 자기모순이 아닌가');

  // ══ ① id가 겹치지 않는다 ══
  const dupOf = (ids: string[]) => ids.filter((v, i) => ids.indexOf(v) !== i);

  test('화면 id가 겹치지 않는다', () => {
    const d = dupOf(SCREENS.map(s => s.id));
    eq(d.join(','), '', `겹치는 화면 id — ${d.join(',')}`);
  });

  test('primitive id가 겹치지 않는다', () => {
    const d = dupOf(PRIMITIVES.map(p => p.id));
    eq(d.join(','), '', `겹치는 primitive id — ${d.join(',')}`);
  });

  test('오버레이·피드백·수렴·의미 id도 겹치지 않는다', () => {
    for (const [name, ids] of [
      ['overlay', OVERLAYS.map(x => x.id)],
      ['feedback', FEEDBACK.map(x => x.id)],
      ['convergence', CONVERGENCE.map(x => x.id)],
      ['semantic', SEMANTICS.map(x => x.id)],
      ['navigation', NAVIGATION.map(x => x.id)],
    ] as Array<[string, string[]]>) {
      eq(dupOf(ids).join(','), '', `${name} id가 겹친다`);
    }
  });

  // ══ ② 필수 칸이 비어 있지 않다 ══
  test('화면에 목적과 라우트가 반드시 있다', () => {
    for (const s of SCREENS) {
      assert(!!s.label.trim(), `${s.id}: label 없음`);
      assert(!!s.routeOrSurface.trim(), `${s.id}: routeOrSurface 없음`);
      assert(!!s.purpose.trim(), `${s.id}: purpose 없음`);
    }
  });

  test('화면에 환경과 상태가 하나 이상 있다 — 비워 두지 않는다', () => {
    for (const s of SCREENS) {
      assert(s.environments.length > 0, `${s.id}: environments가 비었다`);
      assert(s.states.length > 0, `${s.id}: states가 비었다`);
    }
  });

  // ══ ③ 값이 정해진 것 중에 있다 ══
  test('환경 값이 정해진 넷 중에 있다', () => {
    for (const s of SCREENS) {
      for (const e of s.environments) {
        assert(ENVIRONMENTS.includes(e), `${s.id}: 모르는 환경 ${e}`);
      }
    }
  });

  test('상태 값이 정해진 일곱 중에 있다', () => {
    for (const s of SCREENS) {
      for (const st of s.states) {
        assert(UI_STATES.includes(st), `${s.id}: 모르는 상태 ${st}`);
      }
    }
  });

  test('이관 상태와 primitive 상태 값이 정해진 것 중에 있다', () => {
    for (const s of SCREENS) {
      assert(MIGRATION_STATUSES.includes(s.migration), `${s.id}: 모르는 이관 상태 ${s.migration}`);
    }
    for (const p of PRIMITIVES) {
      assert(PRIMITIVE_STATUSES.includes(p.status), `${p.id}: 모르는 상태 ${p.status}`);
    }
  });

  // ══ ④ 화면이 쓰는 primitive는 목록에 있어야 한다 ══
  test('화면이 목록에 없는 primitive를 쓴다고 적지 않는다', () => {
    const known = new Set(PRIMITIVES.map(p => p.id));
    const missing: string[] = [];
    for (const s of SCREENS) {
      for (const p of s.primitives) if (!known.has(p)) missing.push(`${s.id}→${p}`);
    }
    eq(missing.join(', '), '', `목록에 없는 primitive — ${missing.join(', ')}`);
  });

  // ══ ⑤ 안 본 것을 봤다고 적지 않는다 ══
  test('LISTED_ONLY 화면이 있다는 것을 숨기지 않는다', () => {
    // **전부 SURVEYED로 적혀 있으면 오히려 의심스럽다.**
    // 57개 화면을 전부 들여다본 적이 없다면, 그렇게 적는 것이 거짓이다.
    const listed = SCREENS.filter(s => s.depth === 'LISTED_ONLY');
    const surveyed = SCREENS.filter(s => s.depth === 'SURVEYED');
    assert(surveyed.length > 0, '들여다본 화면이 하나도 없다');
    assert(listed.length > 0,
      '전부 SURVEYED로 적혀 있다 — 실제로 전부 확인했는지 다시 보라');
  });

  test('깊이 값이 둘 중 하나다', () => {
    for (const s of SCREENS) {
      assert(s.depth === 'SURVEYED' || s.depth === 'LISTED_ONLY', `${s.id}: ${s.depth}`);
    }
  });

  // ══ ⑥ 구분이 사라지지 않았다 ══
  test('지켜야 할 의미 구분이 전부 적혀 있다', () => {
    const need = [
      'unknown-vs-error', 'disabled-vs-error',
      'no-account-vs-unreadable', 'ready-zero-vs-no-account',
      'env-separation', 'user-vs-diagnostics',
    ];
    const have = new Set(SEMANTICS.map(s => s.id));
    for (const n of need) assert(have.has(n), `의미 구분이 빠졌다 — ${n}`);
  });

  test('의미 구분에는 이유가 붙어 있다', () => {
    for (const s of SEMANTICS) {
      assert(s.rule.trim().length > 0, `${s.id}: rule 없음`);
      assert(s.why.trim().length > 20, `${s.id}: 왜 그런지가 없다 — 규칙만 있으면 곧 잊힌다`);
    }
  });

  test('UNKNOWN과 ERROR가 둘 다 상태 목록에 있다', () => {
    // 하나가 사라지면 나머지 하나가 둘을 겸하게 된다.
    assert(UI_STATES.includes('UNKNOWN'), 'UNKNOWN이 없다');
    assert(UI_STATES.includes('ERROR'), 'ERROR가 없다');
    assert(UI_STATES.includes('DISABLED'), 'DISABLED가 없다');
  });

  test('PAPER가 LIVE·TESTNET과 따로 있다', () => {
    for (const e of ['LIVE', 'TESTNET', 'PAPER'] as const) {
      assert(ENVIRONMENTS.includes(e), `${e}가 없다`);
    }
  });

  // ══ ⑦ CURRENT / TARGET / DECISION ══
  test('수렴 항목에 지금과 목표가 둘 다 적혀 있다', () => {
    for (const c of CONVERGENCE) {
      assert(c.current.trim().length > 0, `${c.id}: current 없음`);
      assert(c.target.trim().length > 0, `${c.id}: target 없음`);
      assert(c.why.trim().length > 0, `${c.id}: why 없음`);
    }
  });

  test('아직 안 정한 것을 정한 것처럼 적지 않는다', () => {
    // OPEN인데 target이 단정적이면, 다음 사람이 그걸 결정으로 읽는다.
    const open = CONVERGENCE.filter(c => c.decision === 'OPEN');
    assert(open.length > 0, '전부 정해졌다고 적혀 있다 — 정말인지 다시 보라');
    for (const c of open) {
      assert(/미정|아직|или|or |①|\?/.test(c.target),
        `${c.id}: OPEN인데 target이 단정적이다 — "${c.target}"`);
    }
  });

  test('결정 값이 셋 중 하나다', () => {
    for (const c of CONVERGENCE) {
      assert(['DECIDED', 'OPEN', 'DONE'].includes(c.decision), `${c.id}: ${c.decision}`);
    }
  });

  // ══ ⑦-2 장부가 걸린 항목은 CURRENT만으로 부족하다 ══
  //
  // "미이관 legacy 화면" 한 줄로 적어 두면 다음 사람은 그것이 **서버
  // PAPER와 다른 장부라는 사실 자체를** 모른다. 모르면 통합한다.

  test('TradingPage 로컬 원화 연습 장부가 무엇인지까지 기록돼 있다', () => {
    const t = CONVERGENCE.find(c => c.id === 'trading-local-ledger');
    assert(!!t, '로컬 연습 장부가 Inventory에 없다');
    eq(t!.decision, 'OPEN', '아직 안 정한 것을 정한 것처럼 적었다');
    assert(/원화|KRW/.test(t!.current), '통화(원화/KRW)가 빠졌다');
    assert(/localStorage|브라우저|로컬/.test(t!.current), '어디에 저장되는지가 빠졌다');
  });

  test('로컬 원화 장부가 정본이 아니라는 것이 CANONICAL에 적혀 있다', () => {
    const t = CONVERGENCE.find(c => c.id === 'trading-local-ledger')!;
    assert(!!t.canonical?.trim(), 'CANONICAL이 비었다 — 두 장부가 같은 것으로 읽힌다');
    assert(/아니다|정본이 아/.test(t.canonical!),
      '정본이 아니라는 말이 없다. 애매하게 적으면 다음 사람이 정본으로 쓴다');
    assert(/paper_|서버 PAPER/.test(t.canonical!), '무엇이 정본인지가 안 적혀 있다');
  });

  test('로컬 원화 장부를 정본 PAPER와 합산하지 않는다는 것이 ISOLATION에 있다', () => {
    const t = CONVERGENCE.find(c => c.id === 'trading-local-ledger')!;
    assert(!!t.isolation?.trim(), 'ISOLATION이 비었다');
    // 최상위 규칙: MOCK / TESTNET / LIVE의 장부와 자산을 절대 합산하지 않는다
    assert(/합산|더한|합치/.test(t.isolation!), '합산 금지가 안 적혀 있다');
    assert(/대체|바꾸|덮/.test(t.isolation!), '대체 금지가 안 적혀 있다');
  });

  test('터미널 주문 경로도 CURRENT/CANONICAL/ISOLATION으로 적혀 있다', () => {
    const t = CONVERGENCE.find(c => c.id === 'terminal-order-path');
    assert(!!t, '터미널이 Inventory의 결정 목록에 없다');
    eq(t!.decision, 'OPEN');
    for (const k of ['current', 'canonical', 'isolation'] as const) {
      assert(!!String(t![k] ?? '').trim(), `terminal-order-path: ${k}가 비었다`);
    }
    assert(/LIVE|TESTNET/.test(t!.isolation!), '환경을 섞지 않는다는 말이 없다');
  });

  // ══ ⑦-3 상태의 의미와 상태를 그리는 물건은 다른 문제다 ══

  test('일곱 상태를 하나도 빠뜨리지 않고 셌다', () => {
    for (const k of UI_STATES) {
      assert(UI_STATE_INVENTORY.some(u => u.state === k),
        `${k} 상태를 아무도 세지 않았다 — 빠진 상태는 조사되지 않은 상태다`);
    }
    eq(UI_STATE_INVENTORY.length, UI_STATES.length, '상태 재고에 중복이나 군더더기가 있다');
  });

  test('상태마다 지금 무엇이 그리고 있는지가 비어 있지 않다', () => {
    for (const u of UI_STATE_INVENTORY) {
      assert(u.existing.length > 0,
        `${u.state}: 지금 그리는 것이 비었다 — 안 본 것을 '없음'으로 적지 않는다`);
      assert(!!u.targetPrimitive.trim(), `${u.state}: 목표가 비었다`);
      assert(PRIMITIVE_STATUSES.includes(u.status), `${u.state}: 모르는 상태값 ${u.status}`);
    }
  });

  test('공통 물건이 없는 상태는 null로 적는다 — 없는 이름을 지어내지 않는다', () => {
    for (const u of UI_STATE_INVENTORY) {
      if (u.sharedPrimitive === null) {
        assert(u.status !== 'EXISTS', `${u.state}: 공통 물건이 없다면서 EXISTS다`);
        continue;
      }
      assert(PRIMITIVES.some(p => p.id === u.sharedPrimitive),
        `${u.state}: '${u.sharedPrimitive}'은 primitive 목록에 없다. `
        + '없는 이름을 적어 두면 다음 사람은 만드는 대신 찾는다');
    }
  });

  test('LOADING·EMPTY는 공통 물건이 없다는 사실이 그대로 적혀 있다', () => {
    for (const k of ['LOADING', 'EMPTY']) {
      const u = UI_STATE_INVENTORY.find(x => x.state === k)!;
      eq(u.sharedPrimitive, null, `${k}: 공통 물건이 없는데 있다고 적었다`);
      eq(u.status, 'MISSING', `${k}: 없는 것을 없다고 적지 않았다`);
    }
  });

  test('UNKNOWN은 판정이 아니라 그리는 물건만 없다', () => {
    const u = UI_STATE_INVENTORY.find(x => x.state === 'UNKNOWN')!;
    // 판정(unknownSummaryOf)과 문구(UNKNOWN_TEXT)는 이미 한 곳에 있다.
    // 이것을 MISSING으로 적으면 판정까지 없는 것처럼 읽힌다.
    assert(u.status !== 'MISSING',
      'UNKNOWN 판정은 status.ts에 이미 있다 — MISSING으로 적으면 없는 것처럼 읽힌다');
    assert(u.existing.some(e => /unknownSummaryOf|UNKNOWN_TEXT|UNKNOWN_LABEL/.test(e)),
      '이미 있는 판정·문구가 재고에 안 적혀 있다');
  });

  // ══ ⑦-4 primitive는 어디로 가는지가 있어야 지도가 된다 ══

  test('primitive마다 무엇으로 모을 것인가가 적혀 있다', () => {
    for (const p of PRIMITIVES) {
      assert(!!p.target?.trim(),
        `${p.id}: target이 비었다 — 지금 위치만 적으면 Inventory는 파일 목록으로 끝난다`);
    }
  });

  test('아직 없는 상태 컴포넌트들이 목록에 있고, 만들지 않았다', () => {
    for (const id of ['LoadingState', 'EmptyState', 'ErrorState', 'UnknownState']) {
      const p = PRIMITIVES.find(x => x.id === id);
      assert(!!p, `${id}가 목록에 없다`);
      eq(p!.file, null, `${id}: 없다면서 위치가 적혀 있다`);
      assert(['MISSING', 'PROPOSED'].includes(p!.status), `${id}: ${p!.status}`);
    }
  });

  test('#213이 만든 상태 primitive의 위치가 적혀 있다', () => {
    for (const id of ['StatusCard', 'SafeNote', 'EnvBadge', 'Details']) {
      const p = PRIMITIVES.find(x => x.id === id);
      assert(!!p, `${id}가 목록에 없다`);
      eq(p!.status, 'EXISTS', `${id}: 있는 것을 없다고 적었다`);
      eq(p!.file, 'src/components/ui/Status.tsx', `${id}: 위치가 다르다`);
    }
  });

  // ══ ⑧ 네비게이션이 여럿이라는 사실 ══
  test('화면 목록이 여러 곳에 있다는 사실을 기록한다', () => {
    assert(NAVIGATION.length >= 3,
      '네비게이션 정의가 세 곳인데 목록에 다 없다 — 하나만 보면 화면을 놓친다');
    for (const n of NAVIGATION) {
      assert(n.count > 0, `${n.id}: 개수가 0이다`);
      assert(!!n.file.trim(), `${n.id}: 정의 위치가 없다`);
    }
  });

  test('지갑 화면이 목록에 있다 — MENU만 읽으면 빠지는 화면이다', () => {
    const w = SCREENS.find(s => s.id === 'wallet');
    assert(!!w, '지갑이 Inventory에 없다');
    assert(/BTABS|MTABS|MENU에 없/.test(w!.notes), '왜 놓치기 쉬운지가 안 적혀 있다');
  });

  // ══ ⑨ 겹쳐 뜨는 층 — 하위 폴더에 있는 것을 놓치지 않는다 ══
  //
  // 처음엔 `src/components` 한 층만 읽어서 `terminal/BottomSheet.tsx`를
  // 못 봤고, registry에는 판정 모듈(`mobileSheet.ts`)이 컴포넌트인 것처럼
  // 적혀 있었다. **Inventory의 목적이 "못 본 것을 없음으로 적지 않는
  // 것"인데, 정작 스캐너가 못 보는 곳이 있었다.**

  test('BottomSheet의 위치가 판정 모듈이 아니라 실제 컴포넌트다', () => {
    const b = OVERLAYS.find(o => o.id === 'BottomSheet');
    assert(!!b, 'BottomSheet가 목록에 없다');
    assert(/\.tsx$/.test(b!.file ?? ''),
      '그리는 컴포넌트가 아니라 판정 모듈을 적어 두었다 — 둘은 다른 것이다');
  });

  test('오버레이·피드백에 적힌 위치가 전부 파일 경로 형태다', () => {
    for (const x of [...OVERLAYS, ...FEEDBACK]) {
      if (x.status === 'MISSING' || x.status === 'PROPOSED') continue;
      assert(!!x.file && /^src\/.+\.(ts|tsx)$/.test(x.file), `${x.id}: 위치가 이상하다 — ${x.file}`);
    }
  });
}
