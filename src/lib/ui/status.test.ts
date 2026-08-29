// src/lib/ui/status.test.ts
//
// 스크린샷에서 실제로 본 것들을 못 박는다:
//   `0.00000000 USDT` + "계좌가 없습니다"가 **동시에** 떠 있었고,
//   `column paper_accounts.started_at does not exist`가 빨간 박스에 있었고,
//   '확인 불가'가 한 화면에 열다섯 번 있었다.
import { test, eq, assert } from '../../test/harness';
import {
  STATUS_TONE, STATUS_LABEL, envView, ENV_VIEW,
  accountStatusOf, unknownSummaryOf, looksLikeRawError, splitDiagnostics, statusNotice,
} from './status';
import { UNKNOWN_LABEL } from './display';

export function runStatusTests() {
  console.log('\n🧪 상태 표현 — 없음·못 읽음·0을 섞지 않는다');

  // ══ ① 상태 색조 ══
  test('막힌 것만 빨갛다 — 못 읽은 것은 빨강이 아니다', () => {
    eq(STATUS_TONE.ERROR, 'bad');
    eq(STATUS_TONE.WARNING, 'warn');
    eq(STATUS_TONE.UNKNOWN, 'muted');
    eq(STATUS_TONE.DISABLED, 'muted');
    eq(STATUS_TONE.SUCCESS, 'good');
  });

  test("모른다는 문구는 한 곳에서 나온다", () => {
    eq(STATUS_LABEL.UNKNOWN, UNKNOWN_LABEL);
  });

  // ══ ② 환경 ══
  test('실전만 실제 돈이고, 실전과 테스트넷만 주문 전에 다시 묻는다', () => {
    eq(ENV_VIEW.LIVE.realMoney, true);
    eq(ENV_VIEW.TESTNET.realMoney, false);
    eq(ENV_VIEW.MOCK.realMoney, false);
    eq(ENV_VIEW.LIVE.confirmBeforeOrder, true);
    eq(ENV_VIEW.TESTNET.confirmBeforeOrder, true);
    eq(ENV_VIEW.MOCK.confirmBeforeOrder, false);
  });

  test('세 환경의 색이 서로 다르다 — 구분이 색으로도 보여야 한다', () => {
    const tones = [ENV_VIEW.LIVE.tone, ENV_VIEW.TESTNET.tone, ENV_VIEW.MOCK.tone];
    eq(new Set(tones).size, 3, `색이 겹친다 — ${tones.join(',')}`);
  });

  test('모르는 환경을 실전으로 승격하지 않는다', () => {
    eq(envView(null).env, 'TESTNET');
    eq(envView(undefined).env, 'TESTNET');
    eq(envView('LIVE' as any).env, 'LIVE');
  });

  test('모의 환경은 거래소로 안 나간다고 말한다', () => {
    assert(ENV_VIEW.MOCK.meaning.includes('거래소'), ENV_VIEW.MOCK.meaning);
    assert(ENV_VIEW.LIVE.meaning.includes('실제'), ENV_VIEW.LIVE.meaning);
  });

  // ══ ③ NO_ACCOUNT ≠ UNREADABLE ≠ READY(0) ══
  test('계좌 없음 · 못 읽음 · 잔고 0은 서로 다른 문장이다', () => {
    const none = accountStatusOf({ code: 'NO_ACCOUNT' });
    const un = accountStatusOf({ code: 'UNREADABLE' });
    const zero = accountStatusOf({ code: 'READY', balance: 0 });
    const three = [none.headline, un.headline, zero.headline];
    eq(new Set(three).size, 3, `문장이 겹친다 — ${three.join(' / ')}`);
  });

  test('못 읽었다는 것은 0도 아니고 계좌 없음도 아니라고 적는다', () => {
    const un = accountStatusOf({ code: 'UNREADABLE' });
    eq(un.kind, 'UNKNOWN');
    assert(un.detail!.includes('0이라는 뜻'), un.detail);
    assert(un.detail!.includes('계좌가 없다는 뜻도'), un.detail);
  });

  test('잔고 0은 정상이다 — 실패로 그리지 않는다', () => {
    const zero = accountStatusOf({ code: 'READY', balance: 0 });
    eq(zero.kind, 'SUCCESS');
    eq(zero.tone, 'good');
    assert(zero.detail!.includes('정상'), zero.detail);
  });

  test('계좌 없음은 실패가 아니라 아직 안 만든 상태다', () => {
    eq(accountStatusOf({ code: 'NO_ACCOUNT' }).kind, 'DISABLED');
  });

  test('코드를 안 주면 정상이라고 하지 않는다', () => {
    eq(accountStatusOf(null).code, 'UNREADABLE');
    eq(accountStatusOf({ code: null }).kind, 'UNKNOWN');
  });

  test('환경 이름이 문장 앞에 붙는다', () => {
    assert(accountStatusOf({ code: 'NO_ACCOUNT', envLabel: '모의' }).headline.startsWith('모의'),
      accountStatusOf({ code: 'NO_ACCOUNT', envLabel: '모의' }).headline);
  });

  // ══ ④ 반복 '확인 불가'를 한 장으로 ══
  test('못 읽은 것이 없으면 카드를 띄우지 않는다', () => {
    const s = unknownSummaryOf([{ label: '현금', known: true }, { label: '증거금', known: true }]);
    eq(s.any, false);
    eq(s.headline, null);
  });

  test('일부만 못 읽으면 개수와 항목을 한 줄로 모은다', () => {
    const s = unknownSummaryOf([
      { label: '현금', known: true },
      { label: '증거금', known: false },
      { label: '실현손익', known: false },
    ]);
    eq(s.any, true);
    eq(s.count, 2);
    eq(s.all, false);
    assert(s.headline!.includes('2개'), s.headline!);
    assert(s.detail!.includes('증거금') && s.detail!.includes('실현손익'), s.detail!);
  });

  test('전부 못 읽었으면 그렇게 말한다 — 일부라고 하지 않는다', () => {
    const s = unknownSummaryOf([{ label: 'a', known: false }, { label: 'b', known: false }]);
    eq(s.all, true);
    assert(s.headline!.includes('하나도'), s.headline!);
  });

  test('못 읽은 것은 실패가 아니라 모름이다', () => {
    eq(unknownSummaryOf([{ label: 'a', known: false }]).kind, 'UNKNOWN');
  });

  test('빈 목록을 정상으로도 실패로도 읽지 않는다', () => {
    eq(unknownSummaryOf([]).any, false);
    eq(unknownSummaryOf(null).any, false);
  });

  // ══ ⑤ raw error는 본문에서 뗀다 ══
  test('DB 오류 원문을 사용자 본문으로 보지 않는다', () => {
    assert(looksLikeRawError('column paper_accounts.started_at does not exist'), '못 잡았다');
    assert(looksLikeRawError('relation "x" does not exist'), '못 잡았다');
    assert(looksLikeRawError('PGRST202 not found'), '못 잡았다');
    assert(looksLikeRawError('at foo (/app/x.ts:12:3)'), '스택을 못 잡았다');
  });

  test('사람이 쓴 문장은 원문으로 오해하지 않는다', () => {
    eq(looksLikeRawError('모의 계좌를 아직 시작하지 않았습니다'), false);
    eq(looksLikeRawError('시세를 받지 못했습니다'), false);
    eq(looksLikeRawError(''), false);
  });

  test('원문이 섞이면 앞의 사람 문장만 본문에 남고 원문은 진단으로 간다', () => {
    const r = splitDiagnostics('모의 계좌를 읽지 못했습니다 (column paper_accounts.started_at does not exist)');
    assert(!r.body.includes('does not exist'), `본문에 원문이 남았다 — ${r.body}`);
    assert(r.body.includes('읽지 못했습니다'), r.body);
    assert(r.diagnostics!.includes('does not exist'), '원문을 버리면 안 된다');
  });

  test('원문만 있으면 본문은 사람 문장으로 대체한다 — 빈칸으로 두지 않는다', () => {
    const r = splitDiagnostics('column x does not exist');
    eq(r.body, UNKNOWN_LABEL);
    assert(!!r.diagnostics, '원문은 남긴다');
  });

  test('원문을 버리지 않는다 — 진단에서 찾을 수 있어야 한다', () => {
    const raw = 'PGRST116: JSON object requested, multiple rows returned';
    eq(splitDiagnostics(raw).diagnostics, raw);
  });

  test('알림으로 만들면 첫 줄이 짧고 원문은 본문 밖이다', () => {
    const n = statusNotice('ERROR', '모의 계좌를 읽지 못했습니다 (column paper_accounts.started_at does not exist)');
    eq(n.level, 'blocking');
    assert(!n.headline.includes('does not exist'), n.headline);
    assert(!!(n as any).diagnostics, '원문은 진단으로 남는다');
  });

  test('모름은 blocking이 아니다 — 빨간 박스를 늘리지 않는다', () => {
    eq(statusNotice('UNKNOWN', '값을 읽지 못했습니다').level, 'info');
    eq(statusNotice('WARNING', '지연되고 있습니다').level, 'warn');
  });
}
