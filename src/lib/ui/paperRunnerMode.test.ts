// src/lib/ui/paperRunnerMode.test.ts
//
// **PAPER 1회 실행을 모의투자 탭에 올리는 일의 판정 + 배선 시험.**
//
// 터미널 하단 독에는 이미 `/api/paper/run`을 부르는 `DemoRunner`가 있었고
// 수동 버튼 두 개도 있었다. 모의투자 탭에는 없었다 — 기능이 아니라
// **배치**가 빠져 있었다.
//
// 그런데 그 컴포넌트를 그대로 옮기면 모의투자 탭이 **렌더에서 터진다**:
// `useTerminal()`이 provider 밖에서 예외를 던진다
// (`TerminalContext.tsx`: "useTerminal은 TerminalProvider 안에서만 쓸 수
// 있습니다"). 그래서 인증을 **prop으로 주입**한다(A안) — 컴포넌트는 하나로
// 두고, 터미널은 context에서 넣어 주고 모의투자 탭은 자기 토큰을 넣는다.
//
// 그리고 모의투자 탭에서는 **브라우저 주기 타이머를 노출하지 않는다.**
// 창을 닫으면 멈추는 타이머를 영속 수단으로 쓰면 "돌고 있는 줄 알았는데"가
// 생긴다. 수동 2버튼만 둔다 — 서버 기반 반복은 별도 단계다.
import { test, eq, assert } from '../../test/harness';
import { readFileSync, existsSync } from 'node:fs';
import {
  paperRunnerControls, mayStartTimer, paperRunRequest, paperRunOutcome,
} from './paperRunnerMode';

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const RUNNER = 'src/components/terminal/DemoRunner.tsx';
const PAPER_TAB = 'src/components/MockAutoTrade.tsx';
const DOCK = 'src/components/terminal/BottomDock.tsx';

function src(path: string): string {
  const s = read(path);
  // 못 읽은 것을 통과로 적지 않는다.
  assert(s != null, `${path}를 읽지 못했습니다 — 통과로 적지 않습니다`);
  return s!;
}

export function runPaperRunnerModeTests() {
  console.log('[PAPER 수동 실행 — 공용 컴포넌트를 두 화면이 함께 쓴다]');

  // ── 판정 (고정 입력) ──

  test('수동 전용이면 주기 타이머가 돌 수 없다', () => {
    eq(mayStartTimer({ manualOnly: true, on: true }), false);
    eq(mayStartTimer({ manualOnly: true, on: false }), false);
  });

  test('터미널(수동 전용 아님)에서는 켰을 때만 돈다', () => {
    eq(mayStartTimer({ on: true }), true);
    eq(mayStartTimer({ on: false }), false);
  });

  test('★ 수동 전용에는 시작/정지와 주기 선택을 노출하지 않는다', () => {
    const c = paperRunnerControls({ manualOnly: true });
    eq(c.showSwitch, false);
    eq(c.showIntervals, false);
    eq(c.showManualButtons, true);
  });

  test('수동 전용은 접지 않는다 — 두 버튼이 항상 보인다', () => {
    const c = paperRunnerControls({ manualOnly: true, dense: true, more: false });
    eq(c.showDetail, true);
    eq(c.showCollapseToggle, false);
    eq(c.showManualButtons, true);
  });

  test('터미널 기존 동작 유지 — 좁은 화면은 접고, 펼치면 전부 보인다', () => {
    const folded = paperRunnerControls({ dense: true, more: false });
    eq(folded.showSwitch, true);
    eq(folded.showDetail, false);
    eq(folded.showIntervals, false);
    eq(folded.showCollapseToggle, true);

    const open = paperRunnerControls({ dense: true, more: true });
    eq(open.showDetail, true);
    eq(open.showIntervals, true);
    eq(open.showManualButtons, true);
  });

  test('터미널 넓은 화면은 접지 않는다', () => {
    const wide = paperRunnerControls({ dense: false, more: false });
    eq(wide.showDetail, true);
    eq(wide.showCollapseToggle, false);
  });

  // ── 호출 모양 (고정 입력 — 렌더러 없이 시험한다) ──

  test('★ 인증이 없으면 요청을 만들지 않는다', () => {
    eq(paperRunRequest({ dryRun: false, auth: null }), null);
    eq(paperRunRequest({ dryRun: false, auth: '' }), null);
    eq(paperRunRequest({ dryRun: true, auth: '   ' }), null);
  });

  test('★ dry-run은 GET이고 본문이 없다 — 쓰기 의도가 없음을 모양이 말한다', () => {
    const r = paperRunRequest({ dryRun: true, auth: 'Bearer t', symbol: 'BTCUSDT' })!;
    eq(r.init.method, undefined);
    eq(r.init.body, undefined);
    assert(r.url.startsWith('/api/paper/run?symbols=BTCUSDT'), r.url);
    eq((r.init.headers as any).Authorization, 'Bearer t');
  });

  test('실제 사이클은 POST이고 심볼을 본문에 담는다', () => {
    const r = paperRunRequest({ dryRun: false, auth: 'Bearer t', symbol: 'ETHUSDT' })!;
    eq(r.init.method, 'POST');
    eq(r.url, '/api/paper/run');
    eq(r.init.body, JSON.stringify({ symbols: 'ETHUSDT' }));
    eq((r.init.headers as any).Authorization, 'Bearer t');
  });

  test('심볼이 없으면 빈 본문 — 서버 기본값에 맡긴다', () => {
    const r = paperRunRequest({ dryRun: false, auth: 'Bearer t' })!;
    eq(r.init.body, '{}');
  });

  test('심볼을 URL에 그대로 붙이지 않는다 (인코딩)', () => {
    const r = paperRunRequest({ dryRun: true, auth: 'Bearer t', symbol: 'A B&C' })!;
    assert(!/ /.test(r.url) && !/&C/.test(r.url), r.url);
  });

  // ── 결과 판정 (401 · 500 · ok:false · 갱신 여부) ──

  test('★ 401·500은 성공이 아니고 장부를 다시 읽지 않는다', () => {
    for (const httpOk of [false]) {
      const v = paperRunOutcome({ httpOk, body: { ok: false }, dryRun: false });
      eq(v.ok, false); eq(v.shouldReload, false);
    }
    // 본문을 못 읽은 경우(JSON 아님)도 성공이 아니다
    const nullBody = paperRunOutcome({ httpOk: false, body: null, dryRun: false });
    eq(nullBody.ok, false); eq(nullBody.shouldReload, false);
  });

  test('★ HTTP 200인데 본문이 ok:false면 성공으로 적지 않는다', () => {
    const v = paperRunOutcome({ httpOk: true, body: { ok: false }, dryRun: false });
    eq(v.ok, false); eq(v.shouldReload, false);
  });

  test('★ 성공한 실제 사이클은 주문이 없어도 장부를 다시 읽는다', () => {
    // 진입하지 않은 회차도 서버는 판단과 사유를 남긴다. 눌렀는데 화면이
    // 그대로면 "눌렸나?"가 된다.
    const v = paperRunOutcome({ httpOk: true, body: { ok: true }, dryRun: false });
    eq(v.ok, true); eq(v.shouldReload, true);
  });

  test('★ dry-run 성공은 절대 다시 읽지 않는다 — 쓴 것이 없다', () => {
    const v = paperRunOutcome({ httpOk: true, body: { ok: true }, dryRun: true });
    eq(v.ok, true); eq(v.shouldReload, false);
  });

  // ── 배선 (실제 소스) ──

  test('★ 공용 실행 컴포넌트는 터미널 context에 의존하지 않는다', () => {
    const s = src(RUNNER);
    // 터지는 원인은 **import와 훅 호출**이다. 왜 그렇게 했는지 적은 주석은
    // 남겨 두어야 하므로 문장이 아니라 코드를 본다.
    assert(!/from\s+['"][^'"]*TerminalContext['"]/.test(s),
      `${RUNNER}가 TerminalContext를 import합니다 — provider 밖(모의투자 탭)에서 렌더가 터집니다`);
    assert(!/^\s*const\s*\{[^}]*\}\s*=\s*useTerminal\(/m.test(s),
      `${RUNNER}가 useTerminal()을 호출합니다`);
  });

  test('★ 공용 실행 컴포넌트는 인증을 prop으로 받는다', () => {
    const s = src(RUNNER);
    assert(/auth\s*:\s*string\s*\|\s*null/.test(s),
      `${RUNNER}의 props에 auth: string | null 이 없습니다`);
  });

  test('★ 주기 타이머는 판정기를 거쳐서만 시작한다', () => {
    const s = src(RUNNER);
    assert(/mayStartTimer/.test(s),
      `${RUNNER}가 mayStartTimer를 거치지 않고 타이머를 돌립니다`);
  });

  test('★ 호출과 판정을 컴포넌트가 직접 짜지 않는다', () => {
    const s = src(RUNNER);
    assert(/paperRunRequest\(/.test(s), `${RUNNER}가 paperRunRequest를 거치지 않습니다`);
    assert(/paperRunOutcome\(/.test(s), `${RUNNER}가 paperRunOutcome을 거치지 않습니다`);
    // 예전 조건이 남아 있으면 판정이 두 곳이 된다.
    assert(!/closed\?\.length\s*\|\|/.test(s),
      `${RUNNER}에 갱신 조건이 따로 남아 있습니다 — 판정이 두 곳입니다`);
  });

  test('★ 모의투자 탭이 공용 실행 컴포넌트를 올린다', () => {
    const s = src(PAPER_TAB);
    assert(/<DemoRunner/.test(s), `${PAPER_TAB}에 DemoRunner가 없습니다 — PAPER 1회 실행 버튼이 그 탭에 없습니다`);
    assert(/manualOnly/.test(s), `${PAPER_TAB}이 manualOnly로 올리지 않습니다 — 주기 타이머가 노출됩니다`);
  });

  test('★ 모의투자 탭은 자기 토큰을 넘긴다', () => {
    const s = src(PAPER_TAB);
    assert(/<DemoRunner[^>]*auth=/.test(s.replace(/\n/g, ' ')),
      `${PAPER_TAB}이 auth를 넘기지 않습니다`);
  });

  test('★ 터미널은 기존대로 context 인증을 넣어 준다', () => {
    const s = src(DOCK);
    assert(/<DemoRunner[^>]*auth=/.test(s.replace(/\n/g, ' ')),
      `${DOCK}이 auth를 넘기지 않습니다 — 터미널 쪽이 로그인 없이 돕니다`);
  });

  test('모의투자 탭은 브라우저 주기 실행을 스스로 만들지 않는다', () => {
    const s = src(PAPER_TAB);
    // 30초 읽기 갱신(load)은 허용 — 매매가 아니라 조회다.
    const runCalls = s.match(/setInterval\([^)]*paper\/run/g) || [];
    eq(runCalls.length, 0);
  });
}
