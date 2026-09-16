// src/lib/trading/paperTarget.test.ts
//
// **고른 적 없는 장부로 주문이 나가는 길이 없는지 고정한다.**
//
//  ① 계좌 id를 만들지도, 실지도 않는다
//  ② 잘못된 challengeId가 조용히 기본 계좌가 되지 않는다
//  ③ 잔고·조회·주문이 **같은 값**에서 요청을 만든다
//  ④ 챌린지는 RUNNING에서만 주문을 받는다 (모르는 상태는 거부)
import { test, eq, assert } from '../../test/harness';
import {
  DEFAULT_TARGET, selectDefault, selectChallenge, isChallengeId, isValidTarget,
  restoreTarget, targetRequestFields, targetQuery, sameTarget, targetLabel,
  targetOrderGate, type PaperTarget,
} from './paperTarget';

const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function runPaperTargetTests() {
  // ── ① 계좌 id가 없다 ──
  test('★ 선택값에 계좌 id 칸이 없다', () => {
    const t = selectChallenge(CID) as PaperTarget;
    eq(Object.keys(t).sort().join(','), 'challengeId,kind');
    eq((t as any).paperAccountId, undefined);
    eq((t as any).accountId, undefined);
  });

  test('★ 요청에 실리는 것은 challengeId뿐이다', () => {
    const f = targetRequestFields(selectChallenge(CID) as PaperTarget);
    eq(Object.keys(f).join(','), 'challengeId');
    eq(f.challengeId, CID);
    assert(!JSON.stringify(f).includes('account'), '요청에 계좌가 실렸습니다');
  });

  test('기본 계좌는 아무것도 싣지 않는다 — 빈 challengeId를 보내지 않는다', () => {
    const f = targetRequestFields(DEFAULT_TARGET);
    eq(Object.keys(f).length, 0);
    eq(targetQuery(DEFAULT_TARGET), '');
  });

  test('조회 쿼리도 challengeId 하나다', () => {
    eq(targetQuery(selectChallenge(CID) as PaperTarget), `?challengeId=${CID}`);
  });

  // ── ② 조용한 폴백이 없다 ──
  test('★ 모양이 아닌 challengeId는 기본 계좌가 되지 않고 null이다', () => {
    for (const v of ['', '   ', 'nope', null, undefined, 123, {}, "' OR 1=1 --"]) {
      eq(selectChallenge(v as any), null);
    }
  });

  test('challengeId는 UUID 모양만 받는다', () => {
    assert(isChallengeId(CID), '정상 UUID가 거부됐습니다');
    assert(isChallengeId(`  ${CID.toUpperCase()}  `), '공백·대문자가 거부됐습니다');
    assert(!isChallengeId('aaaaaaaa-aaaa-4aaa-8aaa'), '짧은 값이 통과했습니다');
  });

  test('고른 챌린지는 소문자로 정규화된다 — 같은 값이 두 개로 보이지 않는다', () => {
    eq((selectChallenge(CID.toUpperCase()) as PaperTarget).challengeId, CID);
  });

  // ── 저장값 복원 ──
  test('저장값이 깨져 있으면 기본 계좌다 — 고른 적 없는 상태의 정의다', () => {
    for (const v of ['', 'not json', '{', null, undefined, '{"kind":"WAT"}',
                     '{"kind":"CHALLENGE"}', '{"kind":"CHALLENGE","challengeId":"x"}']) {
      eq(restoreTarget(v).kind, 'DEFAULT');
      eq(restoreTarget(v).challengeId, null);
    }
  });

  test('정상 저장값은 그대로 복원된다', () => {
    const t = restoreTarget(JSON.stringify(selectChallenge(CID)));
    eq(t.kind, 'CHALLENGE');
    eq(t.challengeId, CID);
  });

  test('DEFAULT인데 challengeId가 붙어 있으면 계약 위반이다', () => {
    assert(!isValidTarget({ kind: 'DEFAULT', challengeId: CID }),
      'DEFAULT에 challengeId가 붙은 값이 통과했습니다');
    assert(isValidTarget(DEFAULT_TARGET), '기본 선택이 거부됐습니다');
  });

  // ── ③ 같은 값에서 나온다 ──
  test('★ 잔고 조회와 주문이 같은 선택에서 같은 장부를 가리킨다', () => {
    const t = selectChallenge(CID) as PaperTarget;
    const q = targetQuery(t);              // 조회가 쓰는 것
    const b = targetRequestFields(t);      // 주문이 쓰는 것
    assert(q.includes(CID), '조회가 그 챌린지를 가리키지 않습니다');
    eq(b.challengeId, CID);
    // 둘이 같은 챌린지를 가리킨다 — 하나만 바뀌는 길이 없다
    eq(q, `?challengeId=${b.challengeId}`);
  });

  test('같은 장부인지 비교할 수 있다', () => {
    const a = selectChallenge(CID) as PaperTarget;
    const b = selectChallenge(CID) as PaperTarget;
    assert(sameTarget(a, b), '같은 챌린지가 다르다고 나옵니다');
    assert(!sameTarget(a, DEFAULT_TARGET), '챌린지와 기본이 같다고 나옵니다');
    assert(sameTarget(DEFAULT_TARGET, selectDefault()), '기본끼리 다르다고 나옵니다');
  });

  test('이름이 장부를 구별한다', () => {
    assert(targetLabel(DEFAULT_TARGET) !== targetLabel(selectChallenge(CID) as PaperTarget),
      '기본과 챌린지 이름이 같습니다');
  });

  // ── ④ 주문 관문 ──
  test('기본 계좌는 언제나 주문을 받는다', () => {
    eq(targetOrderGate(DEFAULT_TARGET).allowed, true);
    eq(targetOrderGate(DEFAULT_TARGET, 'CLOSED').allowed, true);   // 상태는 무관하다
  });

  test('★ 챌린지는 RUNNING에서만 주문을 받는다', () => {
    const t = selectChallenge(CID) as PaperTarget;
    eq(targetOrderGate(t, 'RUNNING').allowed, true);
    for (const s of ['READY', 'CLOSING', 'CLOSED']) {
      eq(targetOrderGate(t, s).allowed, false);
    }
  });

  test('★ 상태를 모르면 주문하지 않는다 — 확인하지 못한 것은 통과가 아니다', () => {
    const t = selectChallenge(CID) as PaperTarget;
    for (const s of [null, undefined, '', 'running', 'WAT']) {
      eq(targetOrderGate(t, s as any).allowed, false);
    }
  });
}
