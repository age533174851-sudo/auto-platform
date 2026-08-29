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
  ENVIRONMENTS, UI_STATES, MIGRATION_STATUSES, PRIMITIVE_STATUSES,
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

  test('터미널의 로컬 원화 장부가 기록돼 있고 아직 미정이다', () => {
    const t = CONVERGENCE.find(c => c.id === 'trading-local-ledger');
    assert(!!t, '로컬 연습 장부가 Inventory에 없다');
    eq(t!.decision, 'OPEN');
    assert(/원화|KRW/.test(t!.current), '통화가 다르다는 사실이 빠졌다');
    assert(/PAPER/.test(t!.current), 'canonical PAPER가 아니라는 사실이 빠졌다');
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
}
