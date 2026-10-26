// src/lib/intel/personaCanon.test.ts
//
// **확인하지 않은 것을 공식으로 적지 않는가. 인기를 정확도로 적지
// 않는가. 자료가 없는 것을 오답으로 적지 않는가.**
import { test, assert, eq } from '../../test/harness';
import {
  judgeAccount, checkClaim, judgeOutcome, accuracyStats, personaScorecard,
  mayCollectWith, FLAT_THRESHOLD_PCT, MIN_SCORED_SAMPLE,
  type AccountEvidence, type ExtractedClaim, type StatementRecord,
} from './personaCanon';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runPersonaCanonTests() {

  // ── ① 계정 검증 ──

  test('계정 ① 플랫폼 인증이 있으면 공식이다', () => {
    const j = judgeAccount({ platformVerified: true });
    eq(j.verdict, 'OFFICIAL_CONFIRMED'); eq(j.collectible, true); eq(j.attributable, true);
  });

  test('계정 ② 상호 링크되면 공식이다', () => {
    const j = judgeAccount({ linkedFromConfirmedSource: true, linksToConfirmedSource: true });
    eq(j.verdict, 'OFFICIAL_CONFIRMED');
  });

  test('★ 계정 ③ 한쪽 방향만 연결되면 발언을 그 사람 것으로 적지 않는다', () => {
    for (const e of [
      { linkedFromConfirmedSource: true },
      { linksToConfirmedSource: true },
    ] as AccountEvidence[]) {
      const j = judgeAccount(e);
      eq(j.verdict, 'CLAIMED_UNCONFIRMED');
      eq(j.attributable, false, '한쪽만 연결된 계정의 발언을 단정하지 않는다');
    }
  });

  test('★ 계정 ④ 증거가 없으면 공식으로 추정하지 않는다', () => {
    for (const e of [null, undefined, {}, { platformVerified: null }] as any[]) {
      const j = judgeAccount(e);
      eq(j.verdict, 'UNVERIFIED', String(JSON.stringify(e)));
      eq(j.collectible, false, '확인 안 된 계정은 수집 대상이 아니다');
      eq(j.attributable, false);
    }
  });

  test('★ 계정 ⑤ 입금·연락 유도는 한 건으로도 멈춘다', () => {
    for (const sig of ['PAYMENT_SOLICITATION', 'CONTACT_SOLICITATION'] as const) {
      const j = judgeAccount({ platformVerified: true, impersonationSignals: [sig] });
      eq(j.verdict, 'SUSPECTED_IMPERSONATION', sig);
      eq(j.collectible, false, '인증 배지가 있어도 멈춘다');
    }
  });

  test('계정 ⑥ 사칭 신호 2건이면 멈춘다', () => {
    const j = judgeAccount({ impersonationSignals: ['NAME_LOOKALIKE', 'RECENTLY_CREATED'] });
    eq(j.verdict, 'SUSPECTED_IMPERSONATION');
  });

  test('★ 계정 ⑦ 중복 계정은 수집하지 않는다 (통계가 두 번 세진다)', () => {
    const j = judgeAccount({ platformVerified: true, duplicateOfAccountId: 'acc-1' });
    eq(j.verdict, 'DUPLICATE_OF_KNOWN'); eq(j.collectible, false);
  });

  test('★ 수집기는 정본에 위임한다', () => {
    eq(mayCollectWith({ platformVerified: true }), true);
    eq(mayCollectWith({}), false);
    eq(mayCollectWith({ impersonationSignals: ['PAYMENT_SOLICITATION'] }), false);
  });

  // ── ② 발언 검증 ──

  const stmt = (over: Partial<StatementRecord> = {}): StatementRecord => ({
    quote: '비트코인은 이번 주 상승할 것',
    sourceUrl: 'https://example.com/v/1',
    spokenAtMs: 1_760_000_000_000,
    collectedAtMs: 1_760_000_100_000,
    ...over,
  });
  const claim = (over: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
    asset: 'BTCUSDT', direction: 'UP', horizonMs: 7 * 86_400_000, ...over,
  });

  test('발언 ① 원문·출처·시각·자산·방향·기간이 있으면 검증 대상이다', () => {
    const c = checkClaim(stmt(), claim());
    eq(c.usability, 'MEASURABLE'); eq(c.scorable, true);
  });

  test('★ 발언 ② 원문이나 출처가 없으면 기록하지 않는다', () => {
    eq(checkClaim(stmt({ quote: '' }), claim()).usability, 'UNSOURCED');
    eq(checkClaim(stmt({ sourceUrl: '  ' }), claim()).usability, 'UNSOURCED');
  });

  test('★ 발언 ③ 발언 시각이 없으면 검증할 수 없다', () => {
    for (const t of [null, undefined, 0, -1, Number.NaN] as any[]) {
      const c = checkClaim(stmt({ spokenAtMs: t }), claim());
      eq(c.usability, 'INCOMPLETE', String(t)); eq(c.scorable, false);
    }
  });

  test('★ 발언 ④ 자산·기간이 없으면 분모에 넣지 않는다', () => {
    eq(checkClaim(stmt(), claim({ asset: null })).scorable, false);
    eq(checkClaim(stmt(), claim({ horizonMs: null })).scorable, false);
    eq(checkClaim(stmt(), claim({ horizonMs: 0 })).scorable, false);
  });

  test('★ 발언 ⑤ 방향이 없거나 중립이면 맞고 틀림을 매기지 않는다', () => {
    for (const d of [null, undefined, 'NEUTRAL'] as any[]) {
      const c = checkClaim(stmt(), claim({ direction: d }));
      eq(c.usability, 'NOT_DIRECTIONAL', String(d)); eq(c.scorable, false);
    }
  });

  // ── ③ 사후 대조 ──

  test('대조 ① 상승 전망에 올랐으면 HIT', () => {
    const o = judgeOutcome(claim(), { priceAtStatement: 100, priceAtHorizon: 110, covered: true });
    eq(o.code, 'HIT'); eq(o.counted, true);
    assert(Math.abs((o.movePct ?? 0) - 10) < 1e-9);
  });

  test('대조 ② 상승 전망에 떨어졌으면 MISS', () => {
    eq(judgeOutcome(claim(), { priceAtStatement: 100, priceAtHorizon: 90, covered: true }).code, 'MISS');
  });

  test('대조 ③ 하락 전망도 같은 규칙이다', () => {
    const d = claim({ direction: 'DOWN' });
    eq(judgeOutcome(d, { priceAtStatement: 100, priceAtHorizon: 90, covered: true }).code, 'HIT');
    eq(judgeOutcome(d, { priceAtStatement: 100, priceAtHorizon: 110, covered: true }).code, 'MISS');
  });

  test('★ 대조 ④ 가격 자료가 구간을 덮지 않으면 오답이 아니다 (UNRESOLVED)', () => {
    const o = judgeOutcome(claim(), { priceAtStatement: 100, priceAtHorizon: 110, covered: false });
    eq(o.code, 'UNRESOLVED');
    eq(o.counted, false, '자료가 없는 것을 분모에 넣지 않는다');
    eq(o.movePct, null);
  });

  test('★ 대조 ⑤ 가격이 비면 UNRESOLVED다', () => {
    for (const w of [
      { priceAtStatement: null, priceAtHorizon: 110, covered: true },
      { priceAtStatement: 100, priceAtHorizon: null, covered: true },
      { priceAtStatement: 0, priceAtHorizon: 110, covered: true },
    ] as any[]) {
      eq(judgeOutcome(claim(), w).code, 'UNRESOLVED');
    }
    eq(judgeOutcome(claim(), null).code, 'UNRESOLVED');
  });

  test('★ 대조 ⑥ 임계 미만은 맞다고도 틀리다고도 하지 않는다', () => {
    const o = judgeOutcome(claim(),
      { priceAtStatement: 100, priceAtHorizon: 100.2, covered: true });
    eq(o.code, 'FLAT'); eq(o.counted, false);
    assert(FLAT_THRESHOLD_PCT > 0, '임계가 0이면 노이즈가 전부 판정된다');
  });

  test('★ 대조 ⑦ 인과를 주장하지 않는다 — 어떤 입력에서도', () => {
    const inputs = [
      [claim(), { priceAtStatement: 100, priceAtHorizon: 200, covered: true }],
      [claim(), { priceAtStatement: 100, priceAtHorizon: 50, covered: true }],
      [claim(), null], [null, null],
    ] as any[];
    for (const [c, w] of inputs) {
      eq(judgeOutcome(c, w).causality, 'NOT_ESTABLISHED',
        '발언 뒤 가격이 움직인 것은 그 발언이 원인이라는 증거가 아니다');
    }
  });

  // ── ④ 성과 통계 ──

  const mk = (code: string, n: number) => Array.from({ length: n }, () => ({ code } as any));

  test('★ 통계 ① 표본이 적으면 적중률을 적지 않는다', () => {
    const s = accuracyStats([...mk('HIT', 2), ...mk('MISS', 1)]);
    eq(s.scored, 3);
    eq(s.hitRatePct, null, '3건 중 2건으로 67%를 적으면 그 숫자가 근거처럼 쓰인다');
    eq(s.insufficient, true);
    assert(MIN_SCORED_SAMPLE >= 10, '최소 표본이 너무 작으면 의미가 없다');
  });

  test('통계 ② 표본이 차면 적중률을 준다', () => {
    const s = accuracyStats([...mk('HIT', 15), ...mk('MISS', 5)]);
    eq(s.scored, 20); eq(s.insufficient, false);
    assert(Math.abs((s.hitRatePct ?? 0) - 75) < 1e-9, String(s.hitRatePct));
  });

  test('★ 통계 ③ FLAT·UNRESOLVED는 분모에 들어가지 않는다', () => {
    const s = accuracyStats([...mk('HIT', 10), ...mk('MISS', 10),
      ...mk('FLAT', 50), ...mk('UNRESOLVED', 50)]);
    eq(s.scored, 20, 'FLAT·UNRESOLVED가 분모에 섞였다');
    eq(s.flat, 50); eq(s.unresolved, 50);
    assert(Math.abs((s.hitRatePct ?? 0) - 50) < 1e-9);
  });

  test('★ 통계 ④ 모르는 코드는 판정 불가로 센다', () => {
    const s = accuracyStats([{ code: 'WHAT' } as any, {} as any, { code: null }]);
    eq(s.scored, 0); eq(s.unresolved, 3, '모르는 값이 분모에 몰래 들어가지 않게');
  });

  test('통계 ⑤ 입력이 없으면 0건이고 적중률은 null이다', () => {
    for (const x of [null, undefined, []] as any[]) {
      const s = accuracyStats(x);
      eq(s.scored, 0); eq(s.hitRatePct, null);
    }
  });

  test('★ 통계 ⑥ 인기와 적중률을 합산하지 않는다', () => {
    const card = personaScorecard({
      accuracy: accuracyStats([...mk('HIT', 15), ...mk('MISS', 5)]),
      popularity: { followers: 1_000_000, viewsPerPost: 500_000 },
    });
    eq(card.combinedScore, null, '합성 점수를 만들면 화면이 그것만 보여 준다');
    eq(card.accuracy.causality, 'NOT_ESTABLISHED');
    assert(card.popularity.followers === 1_000_000, '인기 수치는 따로 남는다');
  });

  // ── ⑤ 정본이 순수한가 ──

  test('★ 판정 정본은 import·네트워크·주문 수단이 0이다', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/intel/personaCanon.ts'), 'utf8');
    eq(/^import /m.test(src), false, 'import이 생기면 순수 판정이 아니다');
    eq(src.includes('process.env'), false);
    eq(/\bfetch\s*\(/.test(src), false, '이 파일은 수집하지 않는다');
    for (const forbidden of ['placeOrder', 'futuresOrder', 'from(', 'supabase']) {
      eq(src.includes(forbidden), false, `${forbidden}가 보인다 — 판정 정본이 아니게 됐다`);
    }
  });

  test('★ 정본은 합성 점수 함수를 내놓지 않는다', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/intel/personaCanon.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert(!/combinedScore\s*:\s*number/.test(code),
      '합성 점수를 숫자로 내놓으면 인기와 정확도가 섞인다');
  });
}
