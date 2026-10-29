// src/lib/smoke/exposureAttestation.test.ts
//
// **Issue #344 — 막아 놓고 푸는 길이 없다.**
//
// 2026-10-16 BTCUSDT 두 회차는 `ENTRY=FAIL [-1111]`로 끝났고
// `ORDERS_ZERO`가 아예 기록되지 않았다. `unresolvedExposureBlock`은
// 그 두 줄을 `EXPOSURE_UNKNOWN`으로 읽어 **이 연결의 다음 스모크를
// 영구히 막는다.** 막는 것 자체는 맞다 — 모르는 것 위에 새 포지션을
// 열면 안 된다.
//
// 문제는 **푸는 길이 코드에 없다는 것**이다. 지금 남은 수단은 두 가지뿐이고
// 둘 다 쓰면 안 된다:
//
//   · 사람이 운영 DB를 직접 고쳐 PASS로 적는다 — 증거 없이 쓰는 PASS다
//   · 영원히 막힌 채로 둔다 — TESTNET 재시험이 불가능하다
//
// #343의 `legacy-evidence` 라우트는 지금 노출을 읽어 주지만
// `historicalEvidencePersisted: false`로 끝난다. 읽고 나서 할 수 있는 일이
// 없다. 그래서 보고서에 "사용자가 거래소에서 확인한 뒤 DB를 고쳐 주세요"가
// 남는다. **그 문장을 없애는 코드를 쓴다.**
//
// 무엇을 주장하고 무엇을 주장하지 않는가
// ──────────────────────────────────────
// 10월에 무슨 일이 있었는지는 **모른다. 영원히 모른다.** 그래서 과거의
// `state`·`verdict`·`ENTRY` 판정은 건드리지 않는다.
//
// 대신 **지금** 이 연결에 노출이 없다는 것을 증명한다. 차단의 목적이
// "살아 있는 노출 위에 새 포지션을 쌓지 않는 것"이므로, 그 목적에는
// 지금의 사실이 답이다. 다만 한 번의 조회는 원자적이지 않으므로
// **시간 간격을 둔 두 번의 관측**을 요구하고, 그 사이에 아무것도
// 생기지 않았을 때만 인정한다.

import { test, eq, assert } from '../../test/harness';
import { unresolvedExposureBlock } from './smokePlan';
import { attestationVerdict, planAttestation, observationOf,
  ATTEST_MIN_GAP_MS, ATTEST_MAX_AGE_MS } from './exposureAttestation';

// 시계를 고정한다. 사후 확인에는 유효 기간이 있어서 실제 시각을 쓰면
// 시험이 날짜에 따라 갈린다.
const NOW = Date.parse('2026-10-29T10:30:00.000Z');

/** 레거시 두 회차와 같은 모양 — OZ가 아예 없다 */
const legacyRow = (id: string, extra: Record<string, any> = {}) => ({
  id, connection_id: 'c-1', user_id: 'u-1', mode: 'TESTNET', symbol: 'BTCUSDT',
  state: 'UNKNOWN', verdict: 'UNKNOWN',
  steps: {
    PREFLIGHT: { state: 'PASS' },
    ENTRY: { state: 'FAIL', note: '[-1111] Precision is over the maximum defined for this asset' },
    POSITION_ZERO: { state: 'PASS' },
    // ORDERS_ZERO 없음 — 이것이 차단의 원인이다
  },
  ...extra,
});

export async function runExposureAttestationTests() {
  console.log('\n[#344 레거시 노출 — 막은 것을 푸는 길]');

  // ══════════ ① 차단은 지금도 맞다 (회귀) ══════════
  {
    const v = unresolvedExposureBlock({
      rows: [legacyRow('old-1'), legacyRow('old-2')], connectionId: 'c-1', nowMs: NOW,
    });
    test('ORDERS_ZERO가 없는 레거시 두 줄은 차단한다 (회귀)', () => {
      eq(v.blocked, true, '모르는 것 위에 새 회차를 열었다');
      eq(v.code, 'EXPOSURE_UNKNOWN', `판정이 ${v.code}다`);
      eq(v.offenders.length, 2, '막은 근거를 둘 다 적지 않았다');
    });
  }

  // ══════════ ② 증명된 사후 확인이 있으면 풀려야 한다 ══════════
  //
  // 시간 간격을 둔 두 번의 관측이 **둘 다** 포지션 0 · 일반 주문 0 ·
  // 조건부(Algo) 주문 0이고, 그 사이에 새로 생긴 것이 없다.
  {
    const attested = legacyRow('old-1', {
      steps: {
        PREFLIGHT: { state: 'PASS' },
        ENTRY: { state: 'FAIL', note: '[-1111]' },
        POSITION_ZERO: { state: 'PASS' },
        _attestation: {
          code: 'ATTESTED_FLAT',
          first: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
          second: { at: '2026-10-29T10:12:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
          sha: 'deadbeef', env: 'TESTNET', method: 'positionRisk+openOrders+openAlgoOrders',
        },
      },
    });
    const v = unresolvedExposureBlock({ rows: [attested], connectionId: 'c-1', nowMs: NOW });
    test('★★ 간격을 둔 두 번의 관측이 모두 비었으면 차단이 풀린다', () => {
      eq(v.blocked, false,
        `증거로 확인했는데도 막혀 있다 (${v.code}) — 푸는 길이 없으면 사람이 DB를 직접 고치게 된다`);
      eq(v.code, 'CLEAR', `판정이 ${v.code}다`);
    });
  }

  // ══════════ ③ 약한 증거로는 풀리지 않는다 ══════════
  const weak: [string, any][] = [
    ['관측이 한 번뿐', { code: 'ATTESTED_FLAT', first: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 } }],
    ['두 번째가 UNKNOWN', { code: 'ATTESTED_FLAT',
      first: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
      second: { at: '2026-10-29T10:12:00.000Z', code: 'UNKNOWN', positions: null, regular: null, algo: null } }],
    ['조건부 주문이 남아 있음', { code: 'ATTESTED_FLAT',
      first: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
      second: { at: '2026-10-29T10:12:00.000Z', code: 'EXPOSURE_OPEN', positions: 0, regular: 0, algo: 1 } }],
    ['code만 ATTESTED_FLAT이고 관측이 없음', { code: 'ATTESTED_FLAT' }],
    ['간격이 없음(같은 시각)', { code: 'ATTESTED_FLAT',
      first: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
      second: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 } }],
  ];
  for (const [label, att] of weak) {
    const v = unresolvedExposureBlock({
      rows: [legacyRow('old-1', {
        steps: { POSITION_ZERO: { state: 'PASS' }, _attestation: att },
      })],
      connectionId: 'c-1', nowMs: NOW,
    });
    test(`★★ ${label}이면 차단이 풀리지 않는다`, () => {
      eq(v.blocked, true, '약한 증거로 새 회차를 열었다');
    });
  }

  // ══════════ ④ 확인된 FAIL은 사후 확인으로 덮지 않는다 ══════════
  //
  // `ORDERS_ZERO=FAIL`은 "주문이 남은 것을 봤다"는 **기록된 사실**이다.
  // 지금 비어 있다고 그 사실을 PASS로 바꾸지 않는다.
  {
    const v = unresolvedExposureBlock({
      rows: [legacyRow('old-fail', {
        steps: {
          POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'FAIL', note: '손절 123 남음' },
          _attestation: {
            code: 'ATTESTED_FLAT',
            first: { at: '2026-10-29T10:00:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
            second: { at: '2026-10-29T10:12:00.000Z', code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0 },
          },
        },
      })],
      connectionId: 'c-1', nowMs: NOW,
    });
    test('★★ 기록된 FAIL은 사후 확인이 있어도 계속 막는다', () => {
      eq(v.blocked, true, '본 적 있는 잔여 주문을 사후 관측으로 덮었다');
      eq(v.code, 'UNPROTECTED_UNRESOLVED', `판정이 ${v.code}다`);
    });
  }

  // ══════════ ⑤ 다른 연결의 사후 확인은 이 연결을 풀지 않는다 ══════════
  {
    const v = unresolvedExposureBlock({
      rows: [
        legacyRow('other', {
          connection_id: 'c-2',
          steps: { POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'PASS' } },
        }),
        legacyRow('mine'),
      ],
      connectionId: 'c-1', nowMs: NOW,
    });
    test('다른 연결이 깨끗해도 이 연결은 막는다 (회귀)', () => {
      eq(v.blocked, true, '남의 연결 증거로 내 연결을 열었다');
      eq(v.offenders.join(','), 'mine', `막은 근거가 ${v.offenders.join(',')}다`);
    });
  }

  // ══════════ ⑥ 판정 정본 자체의 경계 ══════════
  {
    const obs = (atMs: number, over: Record<string, any> = {}) => ({
      at: new Date(atMs).toISOString(), code: 'OBSERVED_FLAT_NOW',
      positions: 0, regular: 0, algo: 0, ...over,
    });
    const att = (gapMs: number, ageMs: number, over: Record<string, any> = {}) => ({
      code: 'ATTESTED_FLAT',
      first: obs(NOW - ageMs - gapMs), second: obs(NOW - ageMs), ...over,
    });

    test('★ 간격이 정확히 하한이면 통과한다 (경계)', () => {
      const v = attestationVerdict(att(ATTEST_MIN_GAP_MS, 60_000), NOW);
      eq(v.accepted, true, `사유: ${v.reason}`);
    });
    test('★ 간격이 1ms 모자라면 통과하지 않는다 (경계)', () => {
      const v = attestationVerdict(att(ATTEST_MIN_GAP_MS - 1, 60_000), NOW);
      eq(v.accepted, false, '하한 아래를 통과시켰다');
      eq(v.code, 'TOO_CLOSE', `판정이 ${v.code}다`);
    });
    test('★ 유효 기간 안이면 통과한다 (경계)', () => {
      const v = attestationVerdict(att(ATTEST_MIN_GAP_MS, ATTEST_MAX_AGE_MS), NOW);
      eq(v.accepted, true, `사유: ${v.reason}`);
    });
    test('★★ 유효 기간을 넘으면 다시 확인한다 — 오래된 관측으로 오늘을 풀지 않는다', () => {
      const v = attestationVerdict(att(ATTEST_MIN_GAP_MS, ATTEST_MAX_AGE_MS + 1), NOW);
      eq(v.accepted, false, '몇 시간 전 관측으로 지금의 차단을 풀었다');
      eq(v.code, 'STALE', `판정이 ${v.code}다`);
    });
    test('★★ 관측 시각이 미래면 통과시키지 않는다 — 시계가 틀렸거나 기록이 조작됐다', () => {
      const v = attestationVerdict({
        code: 'ATTESTED_FLAT', first: obs(NOW + 60_000), second: obs(NOW + ATTEST_MIN_GAP_MS + 120_000),
      }, NOW);
      eq(v.accepted, false, '미래 시각 관측을 받아들였다');
      eq(v.code, 'STALE', `판정이 ${v.code}다`);
    });

    // **null은 0이 아니다.** 세 수치 중 하나라도 못 읽었으면 비었다고 하지 않는다.
    for (const k of ['positions', 'regular', 'algo']) {
      const v = attestationVerdict(
        att(ATTEST_MIN_GAP_MS, 60_000, { second: obs(NOW - 60_000, { [k]: null }) }), NOW);
      test(`★★ ${k}를 못 읽었으면(null) 0으로 세지 않는다`, () => {
        eq(v.accepted, false, 'null을 0건으로 읽었다');
        eq(v.code, 'NOT_FLAT', `판정이 ${v.code}다`);
      });
      const v2 = attestationVerdict(
        att(ATTEST_MIN_GAP_MS, 60_000, { second: obs(NOW - 60_000, { [k]: 1 }) }), NOW);
      test(`${k}가 1건이면 비었다고 하지 않는다`, () => {
        eq(v2.accepted, false, '남아 있는데 비었다고 했다');
      });
    }

    for (const [label, bad] of [
      ['없음', null], ['undefined', undefined], ['문자열', 'ATTESTED_FLAT'],
      ['숫자', 7], ['빈 객체', {}], ['code 불일치', { code: 'OBSERVED_FLAT_NOW' }],
      ['시각이 깨짐', { code: 'ATTESTED_FLAT', first: obs(NOW - 60_000), second: { ...obs(NOW - 60_000), at: '어제' } }],
    ] as [string, any][]) {
      const v = attestationVerdict(bad, NOW);
      test(`사후 확인이 ${label}이면 통과하지 않는다`, () => {
        eq(v.accepted, false, '깨진 기록을 증거로 썼다');
      });
    }

    test('현재 시각을 모르면 통과시키지 않는다', () => {
      const v = attestationVerdict(att(ATTEST_MIN_GAP_MS, 60_000), Number.NaN);
      eq(v.accepted, false, '시계를 모르는데 유효 기간을 판단했다');
    });
  }

  // ══════════ ⑦ 관측 계획기 — 사람은 "해소해" 한 마디만 한다 ══════════
  {
    const flatObs = (atMs: number) => ({
      at: new Date(atMs).toISOString(), code: 'OBSERVED_FLAT_NOW',
      positions: 0, regular: 0, algo: 0,
    });
    const plan = (current: any, obs: any, nowMs: number) => planAttestation({
      current, observation: obs, nowMs,
      method: 'positionRisk+openOrders+openAlgoOrders', env: 'TESTNET', sha: 'abc1234',
    });

    test('처음 부르면 첫 관측을 적고 간격을 알려 준다', () => {
      const p = plan(null, flatObs(NOW), NOW);
      eq(p.phase, 'FIRST', `단계가 ${p.phase}다`);
      eq(p.attestation?.code, 'PENDING', '완료되지 않았는데 ATTESTED_FLAT으로 적었다');
      eq(p.waitMs, ATTEST_MIN_GAP_MS, '다음 관측까지 기다릴 시간을 알려 주지 않았다');
    });

    test('★★ 간격이 차기 전에 또 부르면 완료되지 않는다 — 연타로 풀 수 없다', () => {
      const cur = { code: 'PENDING', first: flatObs(NOW - 60_000) };
      const p = plan(cur, flatObs(NOW), NOW);
      eq(p.phase, 'WAITING', `단계가 ${p.phase}다 — 1분 만에 두 번 봤다고 인정했다`);
      eq(p.attestation?.code, 'PENDING', '간격 없이 완료로 적었다');
      assert(p.waitMs > 0, '남은 시간을 알려 주지 않았다');
    });

    test('★★ 간격을 채우고 또 비어 있으면 완료된다', () => {
      const cur = { code: 'PENDING', first: flatObs(NOW - ATTEST_MIN_GAP_MS) };
      const p = plan(cur, flatObs(NOW), NOW);
      eq(p.phase, 'COMPLETED', `단계가 ${p.phase}다`);
      eq(p.attestation?.code, 'ATTESTED_FLAT', '완료인데 PENDING으로 적었다');
      // 완료된 기록은 그대로 판정 정본을 통과해야 한다 — 두 곳이 갈리면 안 된다.
      eq(attestationVerdict(p.attestation, NOW).accepted, true,
        '계획기가 만든 기록을 판정기가 거절했다 — 두 판단이 갈렸다');
    });

    test('★★ 두 번째에 노출이 보이면 쌓아 둔 것을 버린다 — 비어 있을 때까지 다시 뽑기 금지', () => {
      const cur = { code: 'PENDING', first: flatObs(NOW - ATTEST_MIN_GAP_MS) };
      const p = plan(cur, { at: new Date(NOW).toISOString(), code: 'EXPOSURE_OPEN', positions: 0, regular: 1, algo: 0 }, NOW);
      eq(p.phase, 'RESET', `단계가 ${p.phase}다`);
      eq(p.attestation, null, '노출을 본 뒤에도 첫 관측을 남겨 뒀다');
    });

    test('★★ 조회 실패도 처음부터 다시다 — 못 읽은 것은 0이 아니다', () => {
      const cur = { code: 'PENDING', first: flatObs(NOW - ATTEST_MIN_GAP_MS) };
      const p = plan(cur, { at: new Date(NOW).toISOString(), code: 'UNKNOWN', positions: null, regular: null, algo: null }, NOW);
      eq(p.phase, 'RESET', `단계가 ${p.phase}다`);
      eq(p.attestation, null, '못 읽었는데 쌓아 둔 것을 유지했다');
    });

    test('오래된 첫 관측 위에는 쌓지 않고 다시 첫 관측이 된다', () => {
      const cur = { code: 'PENDING', first: flatObs(NOW - ATTEST_MAX_AGE_MS - 1) };
      const p = plan(cur, flatObs(NOW), NOW);
      eq(p.phase, 'FIRST', `단계가 ${p.phase}다 — 유효 기간 지난 관측을 짝으로 썼다`);
    });

    test('observationOf는 못 읽은 수치를 0으로 바꾸지 않는다', () => {
      const o = observationOf({ code: 'UNKNOWN', positionCount: null, regularOrderCount: null, algoOrderCount: 3 }, NOW);
      eq(o.positions, null, 'null을 0으로 바꿨다');
      eq(o.algo, 3, '수치를 잃었다');
      eq(o.code, 'UNKNOWN', '판정을 잃었다');
    });
  }
}
