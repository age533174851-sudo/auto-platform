// src/lib/engine/entryExitSafety.test.ts
//
// **열 수는 있는데 닫을 수는 없는 상태를 만들지 않는다.**
//
// 이 파일은 정책 하나만 시험한다 — "정본 종료 판정이 안전하다고 했는가".
// `HEDGE`인지 `UNKNOWN`인지의 판정은 여기 없다. 그건
// `futuresExec.closeModeVerdict`의 일이고 그쪽 시험이 본다. 두 곳에서
// 같은 것을 시험하면 한쪽만 고쳐지고, 그때 두 답이 갈린다.
import { test, eq } from '../../test/harness';
import { entryExitSafetyVerdict } from './entryExitSafety';

/** 정본(`closeModeGate`)이 실제로 돌려주는 모양 그대로 */
const ONE_WAY = {
  ok: true, code: 'ONE_WAY', strandsOpenPosition: false,
  message: '포지션 모드 단방향 확인',
};
const HEDGE = {
  ok: false, code: 'HEDGE_UNVERIFIED', strandsOpenPosition: true,
  message: '양방향(헤지) 계좌의 청산 규격을 아직 확정하지 못해 보내지 않았습니다',
};
const UNKNOWN = {
  ok: false, code: 'UNKNOWN', strandsOpenPosition: true,
  message: '계좌의 포지션 모드(단방향/양방향)를 읽지 못해 청산 주문을 보내지 않았습니다',
};
const NO_DIRECTION = {
  ok: false, code: 'NO_DIRECTION', strandsOpenPosition: true,
  message: '닫을 포지션의 방향을 읽지 못해 청산 주문을 보내지 않았습니다',
};

export function runEntryExitSafetyTests() {
  console.log('\n🚪 진입 전 종료 안전 (CAN_AUTO_ENTER requires CAN_AUTO_EXIT_SAFELY)');

  // ① 단방향 — 들어가도 된다
  test('단방향이고 갇히지 않으면 진입 허용', () => {
    const v = entryExitSafetyVerdict(ONE_WAY);
    eq(v.allowed, true, '★ 안전한 계좌인데 막혔습니다');
    eq(v.code, 'AUTO_EXIT_SAFE');
    eq(v.reason, '', '통과에는 사유를 적지 않는다');
  });

  // ② 헤지 — 청산 규격을 확인 못 했다
  test('★ HEDGE_UNVERIFIED면 진입하지 않는다', () => {
    const v = entryExitSafetyVerdict(HEDGE);
    eq(v.allowed, false, '★ 자동으로 닫지 못하는 계좌에 들어갔습니다');
    eq(v.code, 'AUTO_EXIT_UNSAFE');
  });

  // ③ 모드를 못 읽었다 — 확인하지 못한 것은 통과가 아니다
  test('★ UNKNOWN이면 진입하지 않는다', () => {
    const v = entryExitSafetyVerdict(UNKNOWN);
    eq(v.allowed, false, '★ 확인 못 한 것을 통과로 읽었습니다');
    eq(v.code, 'AUTO_EXIT_UNSAFE');
  });

  // ④ 방향을 모른다 — 짐작하면 반대 진입이 된다
  test('★ NO_DIRECTION이면 진입하지 않는다', () => {
    const v = entryExitSafetyVerdict(NO_DIRECTION);
    eq(v.allowed, false, '★ 닫을 방향을 모르는데 새로 열었습니다');
    eq(v.code, 'AUTO_EXIT_UNSAFE');
  });

  // ⑤ ★ 미래 회귀 방어 — `ok`만 보면 새는 조합
  //
  //   오늘 정본에서는 `ok=true`와 `strandsOpenPosition=true`가 함께
  //   나오지 않는다. 그래서 `ok`만 봐도 오늘은 같은 답이 나온다 —
  //   바로 그래서 `strandsOpenPosition`을 빼는 회귀가 **조용하다.**
  //   종료 규격이 늘어 이 조합이 생기는 날, 갇히는 포지션이 열린다.
  test('★ 통과라고 했어도 열린 포지션이 갇히면 진입하지 않는다', () => {
    const v = entryExitSafetyVerdict({
      ok: true, code: 'ONE_WAY', strandsOpenPosition: true, message: '앞뒤가 다른 판정',
    });
    eq(v.allowed, false, '★ ok만 보고 통과시켰습니다 — 갇히는 포지션이 열립니다');
    eq(v.code, 'AUTO_EXIT_UNSAFE');
    // 어긋났다는 사실 자체를 사유에 적는다. "그냥 막혔다"로 적으면
    // 운영자가 계좌 설정을 고치려 하고, 실제 원인은 규격 변경이다.
    eq(/어긋/.test(v.reason), true, '두 말이 어긋났다는 사실을 적어야 합니다');
  });

  // ⑥ 사유와 코드가 응답까지 살아 간다
  test('★ code · message를 그대로 보존한다', () => {
    const v = entryExitSafetyVerdict(HEDGE);
    eq(v.evidence.code, 'HEDGE_UNVERIFIED', '★ 정본의 코드가 뭉개졌습니다');
    eq(v.evidence.strandsOpenPosition, true);
    eq(v.evidence.message, HEDGE.message, '★ 정본의 사유가 사라졌습니다');
    eq(v.reason.includes(HEDGE.message), true, '사유가 응답 문구에 실려야 합니다');
  });

  // ── 증거 자체가 없는 판 ──
  //
  // 조회가 통째로 실패하거나 호출부가 값을 안 넘기면 `undefined`가 온다.
  // 그것을 "문제 없음"으로 읽으면 이 관문이 있으나 마나다.
  test('★ 증거가 없으면 통과가 아니다', () => {
    for (const bad of [null, undefined, {} as any]) {
      const v = entryExitSafetyVerdict(bad);
      eq(v.allowed, false, `★ 증거 없는 판(${JSON.stringify(bad)})이 통과했습니다`);
      eq(v.code, 'AUTO_EXIT_UNSAFE');
      eq(v.evidence.strandsOpenPosition, true, '모르면 갇힌다고 적는다');
    }
  });

  // ★ 이 파일이 모드를 다시 해석하지 않는다는 것을 동작으로 확인한다.
  //
  //   정본이 언젠가 헤지를 통과시키게 되면 이 정책도 **고치지 않고**
  //   같이 통과해야 한다. 여기에 `code === 'HEDGE'` 같은 분기가 생기면
  //   그날 두 판정이 갈린다.
  test('★ 정본이 통과시키면 코드 이름과 무관하게 통과한다', () => {
    const v = entryExitSafetyVerdict({
      ok: true, code: 'HEDGE_VERIFIED', strandsOpenPosition: false,
      message: '양방향 청산 규격 확정됨',
    });
    eq(v.allowed, true, '★ 이 파일이 모드를 따로 해석하고 있습니다');
  });

  test('★ 정본이 막으면 코드 이름이 ONE_WAY라도 막는다', () => {
    const v = entryExitSafetyVerdict({
      ok: false, code: 'ONE_WAY', strandsOpenPosition: true, message: '조회 실패',
    });
    eq(v.allowed, false, '★ 코드 이름만 보고 통과시켰습니다');
  });
}
