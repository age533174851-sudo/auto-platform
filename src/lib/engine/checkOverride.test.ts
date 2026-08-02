import { test, eq, assert } from '../../test/harness';
import {
  applyOverrides, canOverride, overridePrompt, waiveEventsFrom,
  NEVER_OVERRIDABLE, NEVER_REASON, type BlockerLike,
} from './checkOverride';

export function runCheckOverrideTests() {
  console.log('[점검 무시 — 물어보고 넘기되, 못 넘기는 것이 있다]');

  const b = (id: string, o: Partial<BlockerLike> = {}): BlockerLike =>
    ({ id, label: id, status: 'unknown', detail: '자세한 이유', blocks: true, ...o });

  // ── 넘길 수 있는가 ──────────────────────────────────────
  test('확인 못 한 항목은 넘길 수 있다', () => {
    eq(canOverride('LIQUIDATION_DISTANCE'), true);
    eq(canOverride('MODE'), true);
    eq(canOverride('STATE_RECONCILE'), true);
  });

  test('한도에 실제로 걸렸으면(fail) 못 넘긴다', () => {
    // 이 셋의 존재 이유가 "계속하고 싶은 바로 그 순간에 멈추는 것"이다.
    // 한 번 눌러 넘길 수 있으면 넘길 사람은 정확히 그 순간에 넘긴다.
    eq(canOverride('DAILY_LOSS_LIMIT', 'fail'), false);
    eq(canOverride('WEEKLY_LOSS_LIMIT', 'fail'), false);
    eq(canOverride('LOSS_STREAK', 'fail'), false);
  });

  // 한도를 '못 읽은 것'은 '걸린 것'이 아니다. 예전에는 id만 보고 잘라서
  // 둘이 같았고, 그 결과 손실 한도 표 하나를 못 읽으면 **다른 항목까지**
  // 확인창이 통째로 안 떴다(canAsk는 못 넘기는 항목이 있으면 false다).
  // 사용자에게는 "네/아니요가 안 나온다"로만 보였다.
  test('한도를 못 읽었으면(unknown) 물어볼 수 있다', () => {
    eq(canOverride('DAILY_LOSS_LIMIT', 'unknown'), true);
    eq(canOverride('WEEKLY_LOSS_LIMIT', 'unknown'), true);
    eq(canOverride('LOSS_STREAK', 'unknown'), true);
  });

  test('상태를 아예 모르면 못 넘긴다 — 모르는 것을 유리하게 읽지 않는다', () => {
    for (const id of NEVER_OVERRIDABLE) {
      eq(canOverride(id), false, `${id}가 상태 없이 통과했다`);
      eq(canOverride(id, null), false, `${id}가 status:null로 통과했다`);
      eq(canOverride(id, 'pass'), false, `${id}가 status:pass로 통과했다`);
    }
  });

  test('한도가 아닌 항목은 상태와 무관하게 넘길 수 있다', () => {
    eq(canOverride('MODE', 'fail'), true);
    eq(canOverride('MODE'), true);
  });

  test('빈 id는 못 넘긴다', () => {
    eq(canOverride(''), false);
    eq(canOverride(null), false);
    eq(canOverride(undefined), false);
  });

  // ── 확인창을 못 띄우면 이유가 있어야 한다 ────────────────
  test('canAsk가 false면 whyNoAsk가 반드시 있다', () => {
    const cases = [
      overridePrompt([]),
      overridePrompt(null),
      overridePrompt([b('DAILY_LOSS_LIMIT', { status: 'fail' })]),
      overridePrompt([b('MODE'), b('LOSS_STREAK', { status: 'fail' })]),
    ];
    for (const p of cases) {
      eq(p.canAsk, false);
      assert(p.whyNoAsk.length > 0, '왜 안 물어보는지가 비어 있다');
    }
  });

  test('못 읽은 손실 한도는 문구에 경고를 남긴다', () => {
    const p = overridePrompt([b('DAILY_LOSS_LIMIT', { status: 'unknown', label: '오늘 손실 한도' })]);
    eq(p.canAsk, true, p.whyNoAsk);
    assert(p.text.includes('모르는 상태'), `경고가 없다: ${p.text}`);
  });

  // ── 적용 ────────────────────────────────────────────────
  test('지목한 항목만 넘어간다', () => {
    const r = applyOverrides([b('MODE'), b('LIQUIDATION_DISTANCE')], ['MODE']);
    eq(r.waived.length, 1);
    eq(r.waived[0].id, 'MODE');
    eq(r.remaining.length, 1);
    eq(r.remaining[0].id, 'LIQUIDATION_DISTANCE');
  });

  test('전부 지목하면 아무것도 안 남는다', () => {
    const r = applyOverrides([b('MODE'), b('LIQUIDATION_DISTANCE')],
      ['MODE', 'LIQUIDATION_DISTANCE']);
    eq(r.remaining.length, 0);
    eq(r.waived.length, 2);
  });

  test('물어본 사이에 새로 막힌 항목은 그대로 막는다', () => {
    // 확인창을 띄운 시점의 목록과 다시 보낸 시점의 목록이 다를 수 있다.
    // 통짜 우회(force:true)를 두지 않는 이유가 정확히 이것이다.
    const r = applyOverrides([b('MODE'), b('DAILY_LOSS_LIMIT', { status: 'fail' })], ['MODE']);
    eq(r.remaining.length, 1);
    eq(r.remaining[0].id, 'DAILY_LOSS_LIMIT');
  });

  test('못 넘기는 항목은 지목해도 계속 막는다', () => {
    const r = applyOverrides([b('DAILY_LOSS_LIMIT', { status: 'fail' })], ['DAILY_LOSS_LIMIT']);
    eq(r.waived.length, 0);
    eq(r.refused.length, 1);
    // refused에만 넣고 remaining에서 빼면 **주문이 나간다.** 둘 다 들어가야 한다.
    eq(r.remaining.length, 1);
  });

  test('넘길 수 있는 것과 없는 것이 섞이면 없는 쪽이 이긴다', () => {
    const r = applyOverrides([b('MODE'), b('LOSS_STREAK', { status: 'fail' })],
      ['MODE', 'LOSS_STREAK']);
    eq(r.waived.length, 1);
    eq(r.remaining.length, 1);
    eq(r.remaining[0].id, 'LOSS_STREAK');
  });

  test('아무것도 지목 안 하면 전부 그대로 막힌다', () => {
    eq(applyOverrides([b('MODE')], []).remaining.length, 1);
    eq(applyOverrides([b('MODE')], null).remaining.length, 1);
    eq(applyOverrides([b('MODE')], undefined).remaining.length, 1);
  });

  test('요청이 배열이 아니면 아무것도 안 넘긴다', () => {
    // 이상한 값이 왔을 때 통과 쪽으로 기울면 그게 우회 경로가 된다.
    eq(applyOverrides([b('MODE')], 'MODE' as any).remaining.length, 1);
    eq(applyOverrides([b('MODE')], { MODE: true } as any).remaining.length, 1);
    eq(applyOverrides([b('MODE')], true as any).remaining.length, 1);
  });

  test('없는 id를 지목해도 아무 일도 안 일어난다', () => {
    const r = applyOverrides([b('MODE')], ['NOPE', '', null as any]);
    eq(r.remaining.length, 1);
    eq(r.waived.length, 0);
  });

  test('막힌 게 없으면 넘길 것도 없다', () => {
    const r = applyOverrides([], ['MODE']);
    eq(r.remaining.length, 0);
    eq(r.waived.length, 0);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(applyOverrides(null, null).remaining.length, 0);
    eq(applyOverrides(undefined, ['MODE']).remaining.length, 0);
  });

  // ── 확인창 문구 ─────────────────────────────────────────
  test('무엇을 넘기는지 항목마다 적는다', () => {
    const p = overridePrompt([b('MODE', { label: '운영 모드가 주문을 허용' })]);
    assert(p.text.includes('운영 모드가 주문을 허용'), p.text);
    assert(p.text.includes('자세한 이유'), p.text);
    eq(p.canAsk, true);
  });

  test('확인 못 함과 조건 불일치를 구분해서 설명한다', () => {
    const unk = overridePrompt([b('MODE', { status: 'unknown' })]);
    assert(unk.text.includes('모른다는 뜻'), unk.text);
    const bad = overridePrompt([b('MODE', { status: 'fail' })]);
    assert(bad.text.includes('조건에 맞지 않는'), bad.text);
  });

  test('한 건만 통과시킨다는 사실을 적는다 — 설정이 바뀌는 게 아니다', () => {
    assert(overridePrompt([b('MODE')]).text.includes('한 건만'), '문구 없음');
  });

  test('실자금이면 그렇게 적는다', () => {
    const p = overridePrompt([b('MODE')], { realMoney: true });
    assert(p.text.includes('실제 자금'), p.text);
  });

  test('못 넘기는 항목이 섞이면 묻지 않는다', () => {
    // 물어놓고 "네"를 눌렀는데 어차피 막히는 것이 제일 나쁘다.
    const p = overridePrompt([b('MODE'), b('DAILY_LOSS_LIMIT', { status: 'fail' })]);
    eq(p.canAsk, false);
    eq(p.blocked.length, 1);
    assert(p.text.includes('넘길 수 없는 항목'), p.text);
    assert(p.text.includes('한도가 아닙니다'), p.text);
  });

  test('넘길 수 있는 게 하나도 없으면 묻지 않는다', () => {
    eq(overridePrompt([]).canAsk, false);
    eq(overridePrompt(null).canAsk, false);
  });

  // ── 기록 ────────────────────────────────────────────────
  test('넘긴 것도 기록에 남는다 — 발동 안 함과 달라야 한다', () => {
    // 안 남기면 "한 번도 발동 안 함"과 "매번 넘김"이 화면에서 같아 보인다.
    const rows = waiveEventsFrom([b('MODE', { label: '운영 모드', status: 'unknown' })],
      { market: 'USDM', symbol: 'BTCUSDT' });
    eq(rows.length, 1);
    eq(rows[0].kind, 'MODE');
    eq(rows[0].status, 'waived');
    eq(rows[0].market, 'USDM');
    eq(rows[0].symbol, 'BTCUSDT');
    assert(rows[0].reason.includes('사용자가 확인하고 진행'), rows[0].reason);
    // 원래 상태를 함께 남긴다 — fail을 넘긴 것과 unknown을 넘긴 것은 다르다
    assert(rows[0].reason.includes('unknown'), rows[0].reason);
  });

  test('차단과 같은 status를 쓰지 않는다', () => {
    // 'blocked'로 적으면 안전장치가 막은 것처럼 보이는데 실제로는 나갔다.
    eq(waiveEventsFrom([b('MODE')])[0].status, 'waived');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(waiveEventsFrom(null).length, 0);
    eq(waiveEventsFrom([]).length, 0);
    eq(waiveEventsFrom([null as any]).length, 0);
  });

  // ── 목록 자체 ───────────────────────────────────────────
  test('못 넘기는 목록에 중복이 없다', () => {
    eq(new Set(NEVER_OVERRIDABLE).size, NEVER_OVERRIDABLE.length);
  });

  test('못 넘기는 항목에는 이유가 전부 붙어 있다', () => {
    // 이유 없이 회색으로 막으면 사용자는 화면이 고장 났다고 생각한다.
    for (const id of NEVER_OVERRIDABLE) {
      assert(!!NEVER_REASON[id], `${id}에 이유가 없습니다`);
    }
  });
}
