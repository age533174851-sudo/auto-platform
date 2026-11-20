// 분류·상태·공개 여부는 서로 다른 축이다. 이 시험은 그 셋이 섞이지
// 않는지와, **되돌릴 수 없는 전이가 막혀 있는지**를 본다.
import { test, assert, eq } from '../../test/harness';
import {
  CATEGORIES, STATUSES, SEVERITIES, STATUS_NOT_YET, ALWAYS_PRIVATE,
  CATEGORY_LABEL, STATUS_LABEL, SEVERITY_LABEL,
  mustBePrivate, resolveVisibility, canChangeVisibility, canTransition,
  isTerminal, canUserReply, parseTicketInput, suggestSeverity,
  TITLE_MAX, BODY_MAX, STEPS_MAX, EXPECTED_MAX, ACTUAL_MAX,
  redactedOverflow, redactedOverflowMessage, ticketReportRow, TICKET_OPTIONAL_FIELDS,
} from './ticket';
import { redact } from './redact';

const ok = (o: any = {}) => parseTicketInput({ category: 'BUG', title: '봇이 안 켜져요', body: '실행 버튼을 눌러도 반응이 없습니다', ...o });

export function runFeedbackTicketTests() {
  // ── ① 되돌릴 수 없는 방향을 막는다 ──
  test('★★ 비공개를 공개로 바꾸는 전이는 없다 — 이미 읽힌 것은 못 되돌린다', () => {
    eq(canChangeVisibility('PRIVATE', 'PUBLIC'), false);
    eq(canChangeVisibility('PUBLIC', 'PRIVATE'), true);
    eq(canChangeVisibility('PRIVATE', 'PRIVATE'), true);
    eq(canChangeVisibility('PUBLIC', 'PUBLIC'), true);
  });

  test('★★ 거래·계정·보안 문의는 공개를 요청해도 비공개다', () => {
    for (const c of ALWAYS_PRIVATE) {
      eq(resolveVisibility(c, 'PUBLIC'), 'PRIVATE');
      eq(mustBePrivate(c), true);
    }
  });

  test('기능 제안은 공개를 고를 수 있다 — 다만 기본은 비공개다', () => {
    eq(resolveVisibility('FEATURE', 'PUBLIC'), 'PUBLIC');
    eq(resolveVisibility('FEATURE', undefined), 'PRIVATE');
    eq(resolveVisibility('UX', 'PUBLIC'), 'PUBLIC');
  });

  test('모르는 분류는 비공개로 떨어진다 — 열어 두지 않는다', () => {
    eq(resolveVisibility('UNKNOWN_KIND', 'PUBLIC'), 'PUBLIC');  // 분류 검증은 parse가 한다
    eq(resolveVisibility('ACCOUNT', 'PUBLIC'), 'PRIVATE');
  });

  // ── ② 아직 없는 상태를 화면에 띄우지 않는다 ──
  test('★★ AI 파이프라인 상태는 아직 상태 목록에 없다 — 가짜 진행 금지', () => {
    for (const s of STATUS_NOT_YET) {
      assert(!(STATUSES as readonly string[]).includes(s), `${s}가 상태 목록에 들어갔습니다`);
      eq(canTransition('RECEIVED', s), false);
    }
  });

  test('모든 상태에 사람이 읽을 이름이 있다', () => {
    for (const s of STATUSES) assert(typeof STATUS_LABEL[s] === 'string' && STATUS_LABEL[s] !== '', s);
    for (const c of CATEGORIES) assert(typeof CATEGORY_LABEL[c] === 'string' && CATEGORY_LABEL[c] !== '', c);
    for (const v of SEVERITIES) assert(typeof SEVERITY_LABEL[v] === 'string' && SEVERITY_LABEL[v] !== '', v);
  });

  // ── ③ 상태 전이 ──
  test('★★ 해결 완료에서 다시 열 수 있다 — "아직 안 됐어요"가 이 시스템의 핵심이다', () => {
    eq(canTransition('RESOLVED', 'REVIEWING'), true);
    eq(canTransition('RESOLVED', 'IN_PROGRESS'), true);
  });

  // ── #618의 상태 4종 ──
  test('★★ #618이 요구한 상태 넷이 있다 — 검증 중 · 보류 · 중복 · 재현 불가', () => {
    for (const s of ['VERIFYING', 'ON_HOLD', 'DUPLICATE', 'CANNOT_REPRODUCE'] as const) {
      assert((STATUSES as readonly string[]).includes(s), `${s}가 없습니다`);
      assert(typeof STATUS_LABEL[s] === 'string' && STATUS_LABEL[s] !== '', s);
    }
  });

  test('★★ 검증 중은 수정 중과 해결 사이에 있다 — 고쳤다고 적기 전에 확인한다', () => {
    eq(canTransition('IN_PROGRESS', 'VERIFYING'), true);
    eq(canTransition('VERIFYING', 'RESOLVED'), true);
    // 검증이 실패하면 되돌아간다
    eq(canTransition('VERIFYING', 'IN_PROGRESS'), true);
  });

  test('★★ 중복·재현 불가는 종결이 아니다 — 다시 열 수 있다', () => {
    for (const s of ['DUPLICATE', 'CANNOT_REPRODUCE', 'ON_HOLD'] as const) {
      eq(isTerminal(s), false);
      assert(canTransition(s, 'REVIEWING') || canTransition(s, 'IN_PROGRESS'),
        `${s}에서 다시 열 수 없습니다`);
      eq(canUserReply(s), true);
    }
  });

  test('★★ 종료된 문의는 어디로도 가지 않는다', () => {
    for (const s of STATUSES) {
      if (s === 'CLOSED') continue;
      eq(canTransition('CLOSED', s), false);
    }
    eq(isTerminal('CLOSED'), true);
    eq(isTerminal('RESOLVED'), false);
  });

  test('모르는 상태로는 못 간다 — 추측하지 않는다', () => {
    for (const bad of [null, undefined, '', 'DONE', 123, {}]) {
      eq(canTransition('RECEIVED', bad), false);
      eq(canTransition(bad, 'RESOLVED'), false);
    }
  });

  test('같은 상태로의 전이는 허용한다 — 중복 저장이 오류가 되면 안 된다', () => {
    for (const s of STATUSES) eq(canTransition(s, s), true);
  });

  test('종료 전에는 사용자가 답장할 수 있다', () => {
    for (const s of STATUSES) eq(canUserReply(s), s !== 'CLOSED');
    eq(canUserReply('AI_ANALYZING'), false);
  });

  // ── ④ 입력 검증 — 추측해서 채우지 않는다 ──
  test('★★ 모르는 분류는 OTHER로 바꾸지 않고 거절한다', () => {
    eq(parseTicketInput({ category: 'NOPE', title: 'a', body: 'b' }), null);
    eq(parseTicketInput({ title: 'a', body: 'b' }), null);
    eq(ok()!.category, 'BUG');
  });

  test('제목·내용이 비면 거절한다', () => {
    eq(ok({ title: '' }), null);
    eq(ok({ title: '   ' }), null);
    eq(ok({ body: '' }), null);
    eq(ok({ body: '   ' }), null);
  });

  test('길이 상한을 넘으면 자르지 않고 거절한다 — 잘린 글은 다른 글이다', () => {
    eq(ok({ title: 'ㄱ'.repeat(TITLE_MAX + 1) }), null);
    eq(ok({ body: 'ㄱ'.repeat(BODY_MAX + 1) }), null);
    assert(ok({ title: 'ㄱ'.repeat(TITLE_MAX) }) !== null, '상한 자체는 통과해야 합니다');
  });

  test('앞뒤 공백은 떼고 저장한다', () => {
    eq(ok({ title: '  제목  ' })!.title, '제목');
  });

  // ── #618의 재현 절차 · 기대 결과 · 실제 결과 ──
  test('세 칸은 비워 둘 수 있다 — 버그가 아닌 문의엔 해당이 없다', () => {
    const v = ok()!;
    eq(v.steps, null); eq(v.expected, null); eq(v.actual, null);
  });

  test('★★ 빈 문자열을 저장하지 않는다 — null로 둔다', () => {
    const v = ok({ steps: '   ', expected: '', actual: '\n' })!;
    eq(v.steps, null); eq(v.expected, null); eq(v.actual, null);
  });

  test('적으면 그대로 들어간다', () => {
    const v = ok({ steps: '1. 자동 탭\n2. 시작', expected: '봇이 켜짐', actual: '반응 없음' })!;
    eq(v.steps, '1. 자동 탭\n2. 시작');
    eq(v.expected, '봇이 켜짐');
    eq(v.actual, '반응 없음');
  });

  test('★★ 길이를 넘기면 자르지 않고 거절한다 — 잘린 재현 절차는 다른 절차다', () => {
    eq(ok({ steps: 'ㄱ'.repeat(STEPS_MAX + 1) }), null);
    eq(ok({ expected: 'ㄱ'.repeat(EXPECTED_MAX + 1) }), null);
    eq(ok({ actual: 'ㄱ'.repeat(ACTUAL_MAX + 1) }), null);
    assert(ok({ steps: 'ㄱ'.repeat(STEPS_MAX) }) !== null, '상한 자체는 통과해야 합니다');
  });

  test('글이 아닌 값은 거절한다 — 조용히 버리지 않는다', () => {
    for (const bad of [123, {}, []]) eq(ok({ steps: bad }), null);
  });

  test('요청이 객체가 아니면 거절한다', () => {
    for (const bad of [null, undefined, 'x', 123, []]) eq(parseTicketInput(bad), null);
  });

  test('★★ 버그 신고는 공개를 요청해도 비공개로 접수된다', () => {
    eq(ok({ visibility: 'PUBLIC' })!.visibility, 'PRIVATE');
    eq(parseTicketInput({ category: 'FEATURE', title: 'a', body: 'b', visibility: 'PUBLIC' })!.visibility, 'PUBLIC');
  });

  // ── ⑤ 심각도는 제안일 뿐이다 ──
  test('보안은 긴급, 주문·계정은 높음, 화면 제안은 낮음', () => {
    eq(suggestSeverity('SECURITY'), 'URGENT');
    eq(suggestSeverity('ORDER'), 'HIGH');
    eq(suggestSeverity('ACCOUNT'), 'HIGH');
    eq(suggestSeverity('UX'), 'LOW');
    eq(suggestSeverity('FEATURE'), 'LOW');
  });

  test('모든 분류에 심각도 제안이 있다', () => {
    for (const c of CATEGORIES) assert(SEVERITIES.includes(suggestSeverity(c)), c);
  });

  // ── 가린 뒤의 길이 ──
  //
  // 이 시험이 막는 것: **검증을 통과한 신고가 DB에서 조용히 막히고,
  // 사용자가 "다시 시도해 주세요"를 받는 것.** 같은 글은 다시 보내도
  // 똑같이 늘어나므로 그 안내로는 영원히 성공하지 못한다.

  test('한계 안이면 null이다 — 넘친 것이 없다', () => {
    eq(redactedOverflow({ title: '제목', body: '내용' }), null);
    eq(redactedOverflow({ body: '제목 없는 답글' }), null);
  });

  test('★ 제목이 넘치면 제목을 지목하고 초과분을 센다', () => {
    const v = redactedOverflow({ title: 'x'.repeat(TITLE_MAX + 7), body: '내용' });
    assert(v != null, '넘친 제목을 통과시켰다');
    eq(v!.field, 'title');
    eq(v!.max, TITLE_MAX);
    eq(v!.over, 7);
    eq(v!.length, TITLE_MAX + 7);
  });

  test('★ 내용이 넘치면 내용을 지목한다 — 제목이 멀쩡해도', () => {
    const v = redactedOverflow({ title: '제목', body: 'x'.repeat(BODY_MAX + 1) });
    assert(v != null, '넘친 내용을 통과시켰다');
    eq(v!.field, 'body');
    eq(v!.over, 1);
  });

  test('★ 답글에는 제목이 없다 — 제목 없이도 내용을 판정한다', () => {
    const v = redactedOverflow({ body: 'x'.repeat(BODY_MAX + 5) });
    assert(v != null && v.field === 'body' && v.over === 5);
  });

  test('제목을 먼저 지목한다 — 둘 다 넘쳤을 때 고칠 곳이 하나여야 한다', () => {
    const v = redactedOverflow({ title: 'x'.repeat(TITLE_MAX + 1), body: 'x'.repeat(BODY_MAX + 1) });
    assert(v != null && v.field === 'title');
  });

  test('★ 안내문에 글 내용이 섞이지 않는다 — 길이만 말한다', () => {
    const secret = 'a@b.co';
    const v = redactedOverflow({ title: '제목', body: secret + 'x'.repeat(BODY_MAX) });
    assert(v != null, '전제가 깨졌다');
    const msg = redactedOverflowMessage(v!);
    assert(!msg.includes(secret), '안내문이 글 내용을 담았다');
    assert(msg.includes(String(v!.over)), '얼마나 줄여야 하는지 숫자가 없다');
  });

  test('★★ 가림이 늘린 글도 이 판정이 잡는다 — redact와 함께', () => {
    // 짧은 이메일을 잔뜩 적은 신고. parseTicketInput은 통과시킨다.
    const raw = 'a@b.co\n'.repeat(Math.floor(BODY_MAX / 7));
    assert(raw.length <= BODY_MAX, '전제: 원문은 한계 안이어야 한다');
    assert(ok({ body: raw }) != null, '전제: 원문 검증은 통과한다');
    const r = redact(raw);
    const v = redactedOverflow({ title: '알림이 안 와요', body: r.text });
    // 가림이 늘렸으면 막아야 하고, 늘리지 않았으면 통과해야 한다.
    // **어느 쪽이든 판정과 실제가 어긋나면 실패한다.**
    eq(v == null, r.text.length <= BODY_MAX, `가림 후 ${r.text.length}자 / 한계 ${BODY_MAX}자`);
  });

  // ── ⑦ #618의 세 칸 — 칸만 있고 저장이 없었다 ──
  //
  // 마이그레이션 106에 `steps`·`expected`·`actual`이 있고
  // `parseTicketInput`이 셋을 검증하는데, 접수 라우트의 insert에는 셋이
  // **한 번도 나오지 않았다.** 사용자가 적은 재현 절차가 조용히 사라졌다.
  // 판정을 라우트에 두면 또 빠뜨리므로 **줄을 만드는 함수 하나**로 모은다.

  test('★★ 재현 절차·기대·실제가 저장 줄에 들어간다 — 라우트가 빠뜨릴 수 없다', () => {
    const parsed = ok({ steps: '1. 자동 탭\n2. 시작', expected: '봇이 켜짐', actual: '반응 없음' })!;
    const row: any = ticketReportRow({
      userId: 'u-1', parsed,
      title: parsed.title,
      optionals: { steps: parsed.steps, expected: parsed.expected, actual: parsed.actual },
      context: {}, redactions: [],
    });
    eq(row.steps, '1. 자동 탭\n2. 시작');
    eq(row.expected, '봇이 켜짐');
    eq(row.actual, '반응 없음');
  });

  test('★★ 선택 칸은 비어도 줄에 **있어야** 한다 — 없으면 다음 칸이 또 빠진다', () => {
    const parsed = ok()!;
    const row: any = ticketReportRow({
      userId: 'u-1', parsed, title: parsed.title,
      optionals: { steps: null, expected: null, actual: null },
      context: {}, redactions: [],
    });
    for (const f of TICKET_OPTIONAL_FIELDS) {
      assert(f in row, `저장 줄에 ${f} 칸이 없다 — 칸을 빠뜨리면 조용히 사라진다`);
      eq(row[f], null);
    }
  });

  test('★★ 저장 줄은 요청이 보낸 user_id를 쓰지 않는다', () => {
    const parsed = ok()!;
    const row: any = ticketReportRow({
      userId: 'u-real', parsed, title: parsed.title,
      optionals: { steps: null, expected: null, actual: null },
      context: {}, redactions: [],
    });
    eq(row.user_id, 'u-real');
    eq(row.status, 'RECEIVED');
  });

  test('★★ 선택 칸도 가림 뒤 길이를 본다 — 제목·본문만 보면 DB가 거절한다', () => {
    // 가림은 글을 늘린다. 늘어난 재현 절차가 4000자를 넘으면 106의 CHECK가
    // 막고, 사용자에게는 "다시 시도해 주세요"만 간다 — 영원히 실패한다.
    const v1 = redactedOverflow({ body: '내용', steps: 'ㄱ'.repeat(STEPS_MAX + 7) });
    assert(v1 != null, 'steps 초과를 잡지 못했다');
    eq(v1!.field, 'steps'); eq(v1!.max, STEPS_MAX); eq(v1!.over, 7);
    const v2 = redactedOverflow({ body: '내용', expected: 'ㄱ'.repeat(EXPECTED_MAX + 3) });
    assert(v2 != null, 'expected 초과를 잡지 못했다');
    eq(v2!.field, 'expected'); eq(v2!.over, 3);
    const v3 = redactedOverflow({ body: '내용', actual: 'ㄱ'.repeat(ACTUAL_MAX + 1) });
    assert(v3 != null, 'actual 초과를 잡지 못했다');
    eq(v3!.field, 'actual'); eq(v3!.over, 1);
  });

  test('★ 선택 칸이 한계 안이면 통과한다 — 과도 검출 없음', () => {
    eq(redactedOverflow({ body: '내용', steps: 'ㄱ'.repeat(STEPS_MAX) }), null);
    eq(redactedOverflow({ body: '내용', expected: 'ㄱ'.repeat(EXPECTED_MAX) }), null);
    eq(redactedOverflow({ body: '내용', actual: 'ㄱ'.repeat(ACTUAL_MAX) }), null);
    eq(redactedOverflow({ body: '내용', steps: null, expected: null, actual: null }), null);
  });

  test('★★ 안내문이 어느 칸인지 말한다 — "내용"이라고만 하면 못 고친다', () => {
    const m = redactedOverflowMessage(
      { field: 'steps', length: STEPS_MAX + 5, max: STEPS_MAX, over: 5 });
    assert(m.includes('재현 절차'), `어느 칸인지 말하지 않는다: ${m}`);
    assert(m.includes('5'), '얼마나 줄여야 하는지 숫자가 없다');
    assert(redactedOverflowMessage(
      { field: 'expected', length: 1, max: 1, over: 1 }).includes('기대한 결과'), 'expected 이름이 없다');
    assert(redactedOverflowMessage(
      { field: 'actual', length: 1, max: 1, over: 1 }).includes('실제 결과'), 'actual 이름이 없다');
  });

  test('★ 안내문은 어느 칸이든 글 내용을 담지 않는다', () => {
    const secret = 'sk-live-ABCDEF0123456789';
    for (const f of ['title', 'body', ...TICKET_OPTIONAL_FIELDS] as const) {
      const m = redactedOverflowMessage({ field: f as any, length: 10, max: 5, over: 5 });
      assert(!m.includes(secret), `${f} 안내문이 값을 담을 수 있는 모양이다`);
      assert(m.length > 0, `${f} 안내문이 비어 있다`);
    }
  });

}
