// src/lib/smoke/attestSchedule.test.ts
//
// **이 시험이 지키는 것 둘.**
//
// ① 사람이 두 번 누르지 않는다 — 간격이 차면 화면이 스스로 보낸다.
// ② 그렇다고 **되풀이하지 않는다** — 한 첫 관측에 자동 관측은 한 번이다.
//
// ②가 없으면 이 기능은 "비어 있을 때까지 다시 뽑기"가 된다. 그 금지는
// `planAttestation`의 주석이 먼저 적었고, 여기서 값으로 고정한다.
import { test, eq, assert } from '../../test/harness';
import { planAutoAttest, autoAttestKey, ATTEST_SCHEDULE_MARGIN_MS } from './attestSchedule';
import { ATTEST_MIN_GAP_MS } from './exposureAttestation';

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** 간격을 막 채운 첫 관측 */
const due = (over = ATTEST_SCHEDULE_MARGIN_MS + 1_000) =>
  iso(NOW - ATTEST_MIN_GAP_MS - over);
const row = (o: Partial<{ id: string; attested: boolean; canObserve: boolean; firstObservedAt: string | null }> = {}) => ({
  id: o.id ?? 'aaaaaaaa-0000-0000-0000-000000000001',
  attested: o.attested ?? false,
  canObserve: o.canObserve ?? true,
  firstObservedAt: o.firstObservedAt === undefined ? due() : o.firstObservedAt,
});
const plan = (candidates: any, tried: string[] = [], busy = false, nowMs = NOW) =>
  planAutoAttest({ nowMs, candidates, tried: new Set(tried), busy });

export function runAttestScheduleTests() {
  console.log('[노출 사후 확인 자동화 — 두 번 누르지 않는다, 그렇다고 되풀이하지 않는다]');

  // ── ① 자동으로 보낸다 ──
  test('간격과 여유를 넘기면 두 번째 관측을 보낸다', () => {
    const p = plan([row()]);
    eq(p.action, 'OBSERVE');
    assert(p.action === 'OBSERVE' && p.key.includes('@'), '열쇠에 첫 관측 시각이 들어가야 한다');
  });

  test('간격 전이면 기다리고, 남은 시간을 돌려준다', () => {
    const p = plan([row({ firstObservedAt: iso(NOW - 60_000) })]);
    eq(p.action, 'WAIT');
    assert(p.action === 'WAIT'
      && p.delayMs === ATTEST_MIN_GAP_MS + ATTEST_SCHEDULE_MARGIN_MS - 60_000,
      `남은 시간이 맞지 않습니다: ${p.action === 'WAIT' ? p.delayMs : '-'}`);
  });

  // ★ 경계 — 여유 없이 쏘면 서버가 TOO_CLOSE로 거절하고, 자동 관측은
  //   한 번뿐이므로 그 한 번이 사라진다.
  test('★ 간격을 정확히 채운 순간에는 아직 보내지 않는다 (시계 차이 여유)', () => {
    const p = plan([row({ firstObservedAt: iso(NOW - ATTEST_MIN_GAP_MS) })]);
    eq(p.action, 'WAIT');
    assert(p.action === 'WAIT' && p.delayMs === ATTEST_SCHEDULE_MARGIN_MS,
      '여유만큼 더 기다려야 한다');
  });

  // ── ② 되풀이하지 않는다 ──
  test('★ 같은 첫 관측에는 자동으로 두 번 보내지 않는다', () => {
    const r = row();
    const key = autoAttestKey(r)!;
    eq(plan([r]).action, 'OBSERVE');
    eq(plan([r], [key]).action, 'IDLE');
  });

  test('★ 첫 관측이 새로 적히면 한 번 더 받는다 (다른 상황이다)', () => {
    const old = row();
    const fresh = { ...old, firstObservedAt: due(ATTEST_SCHEDULE_MARGIN_MS + 2_000) };
    const key = autoAttestKey(old)!;
    assert(autoAttestKey(fresh) !== key, '시각이 다르면 열쇠가 달라야 한다');
    eq(plan([fresh], [key]).action, 'OBSERVE');
  });

  // ★ 이 시험이 이 파일의 이유다 — 노출이 보이면 서버가 기록을 지우고
  //   `firstObservedAt`이 null이 된다. 그때 자동으로 또 읽으면
  //   "비어 있을 때까지 다시 뽑기"다.
  test('★ 첫 관측이 없으면 자동으로 보내지 않는다 (첫 관측은 사용자의 명령)', () => {
    eq(plan([row({ firstObservedAt: null })]).action, 'IDLE');
    eq(plan([row({ firstObservedAt: '' })]).action, 'IDLE');
    eq(plan([row({ firstObservedAt: '어제' })]).action, 'IDLE');
  });

  // ── 건너뛰는 줄 ──
  test('끝난 줄과 복구가 필요한 줄은 건너뛴다', () => {
    eq(plan([row({ attested: true })]).action, 'IDLE');
    eq(plan([row({ canObserve: false })]).action, 'IDLE');
  });

  test('요청이 날아가 있으면 아무것도 하지 않는다', () => {
    eq(plan([row()], [], true).action, 'IDLE');
  });

  test('★ 첫 관측 시각이 미래면 보내지 않는다 — 서버가 거절한다', () => {
    eq(plan([row({ firstObservedAt: iso(NOW + 60_000) })]).action, 'IDLE');
  });

  test('★ 지금을 모르면 보내지 않는다', () => {
    eq(plan([row()], [], false, NaN).action, 'IDLE');
  });

  test('밀린 것이 여럿이면 가장 먼저 찬 것부터 한 번에 하나만', () => {
    const later = row({ id: 'bbbbbbbb-0000-0000-0000-000000000002',
      firstObservedAt: iso(NOW - ATTEST_MIN_GAP_MS - ATTEST_SCHEDULE_MARGIN_MS - 1_000) });
    const earlier = row({ id: 'cccccccc-0000-0000-0000-000000000003',
      firstObservedAt: iso(NOW - ATTEST_MIN_GAP_MS - ATTEST_SCHEDULE_MARGIN_MS - 99_000) });
    const p = plan([later, earlier]);
    eq(p.action, 'OBSERVE');
    assert(p.action === 'OBSERVE' && p.testId === earlier.id,
      '먼저 찬 줄을 골라야 한다');
  });

  test('오래된 첫 관측(6시간 초과)도 보낸다 — 그 쌍은 받아들여지지 않으므로 새 첫 관측이 된다', () => {
    const p = plan([row({ firstObservedAt: iso(NOW - 7 * 60 * 60_000) })]);
    eq(p.action, 'OBSERVE');
  });

  test('빈 목록·null·이상한 값에서 터지지 않는다', () => {
    eq(plan([]).action, 'IDLE');
    eq(plan(null).action, 'IDLE');
    eq(plan(undefined).action, 'IDLE');
    eq(plan('목록 아님' as any).action, 'IDLE');
    eq(plan([null, undefined, {}] as any).action, 'IDLE');
    eq(autoAttestKey(null), null);
    eq(autoAttestKey({ id: '', firstObservedAt: due() } as any), null);
  });
}
