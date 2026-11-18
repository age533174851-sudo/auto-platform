// 분류·상태·공개 여부는 서로 다른 축이다. 이 시험은 그 셋이 섞이지
// 않는지와, **되돌릴 수 없는 전이가 막혀 있는지**를 본다.
import { test, assert, eq } from '../../test/harness';
import {
  CATEGORIES, STATUSES, SEVERITIES, STATUS_NOT_YET, ALWAYS_PRIVATE,
  CATEGORY_LABEL, STATUS_LABEL, SEVERITY_LABEL,
  mustBePrivate, resolveVisibility, canChangeVisibility, canTransition,
  isTerminal, canUserReply, parseTicketInput, suggestSeverity,
  TITLE_MAX, BODY_MAX,
} from './ticket';

const ok = (o: any = {}) => parseTicketInput({ category: 'BUG', title: '봇이 안 켜져요', body: '실행 버튼을 눌러도 반응이 없습니다', ...o });

export function runSupportTicketTests() {
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
}
