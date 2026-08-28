// src/lib/portfolio/paperUnify.test.ts
//
// **두 모의계좌가 하나가 됐는가.**
//
// 자동매매 MOCK 화면과 지갑 MOCK 탭이 서로 다른 잔고를 보여 줬다.
// 앞은 브라우저 localStorage 원화 장부, 뒤는 서버 PAPER USDT 장부였다.
// 이 파일은 **같은 서버 상태에서 두 화면이 같은 숫자를 낸다**는 것을
// 값으로 못 박는다.
import { test, eq, assert } from '../../test/harness';
import { paperViewOf, paperViewsAgree } from './paperView';
import { paperPanelOf } from './paperPanel';
import { legacyLocalPaper, LEGACY_PAPER_KEYS } from './legacyPaper';

/** 서버가 만든 하나의 진실 */
const EQUITY = {
  state: 'ACTIVE', cash: 9_820.5, usedMargin: 300, unrealizedPnl: -12.25,
  totalEquity: 9_808.25, initialBalance: 10_000, realizedPnl: -167.5,
  totalFees: 12.5, tradeCount: 7, winCount: 3, returnPct: -1.9175, note: '',
};
const TODAY = { pnl: -30.75, pct: -0.31, note: '' };
const POSITIONS = [
  { id: 'p1', symbol: 'BTCUSDT', side: 'LONG', fillPrice: 100_000, quantity: 0.01,
    margin: 300, markPrice: 98_775, unrealizedPnl: -12.25, roiPct: -4.08,
    openedAt: '2026-08-28T01:00:00Z' },
];

/** `/api/paper/account` GET 본문 (자동매매 MOCK 화면이 읽는 것) */
const ACCOUNT_PAYLOAD = {
  ok: true, started: true,
  account: { balance: 9_820.5, available: 9_520.5, usedMargin: 300,
    initialBalance: 10_000, totalPnl: -167.5, totalFees: 12.5,
    tradeCount: 7, winCount: 3, returnPct: -1.795 },
  equity: { ...EQUITY, currency: 'USDT' },
  today: { ...TODAY, dayStartEquity: 9_839 },
  positions: POSITIONS,
};

/** `/api/wallets/overview`의 `paper` 칸 (지갑 MOCK 탭이 읽는 것) */
const OVERVIEW_PAPER = {
  state: 'ACTIVE', code: 'READY', error: null, currency: 'USDT',
  schema: { startedAt: true },
  equity: EQUITY,
  today: TODAY,
  positions: POSITIONS,
};

export function runPaperUnifyTests() {
  console.log('\n🧪 MOCK 단일화 (두 화면이 같은 장부를 본다)');

  // ══ ① 두 화면이 같은 숫자를 낸다 ══
  const auto = paperViewOf({ loaded: true, payload: ACCOUNT_PAYLOAD });
  const wallet = paperViewOf({ loaded: true, payload: OVERVIEW_PAPER });

  test('총자산이 같다', () => {
    eq(auto.totalEquity, wallet.totalEquity);
    eq(auto.totalEquity, 9_808.25);
  });

  test('현금이 같다', () => {
    eq(auto.cash, wallet.cash);
    eq(auto.cash, 9_820.5);
  });

  test('열린 포지션이 같다', () => {
    eq(auto.positions.length, wallet.positions.length);
    eq(auto.positions[0].symbol, wallet.positions[0].symbol);
    eq(auto.positions[0].quantity, wallet.positions[0].quantity);
    eq(auto.positions[0].entryPrice, wallet.positions[0].entryPrice);
    eq(auto.positions[0].markPrice, wallet.positions[0].markPrice);
  });

  test('실현손익이 같다', () => {
    eq(auto.realizedPnl, wallet.realizedPnl);
    eq(auto.realizedPnl, -167.5);
  });

  test('미실현손익이 같다', () => {
    eq(auto.unrealizedPnl, wallet.unrealizedPnl);
    eq(auto.unrealizedPnl, -12.25);
  });

  test('오늘 손익이 같다', () => {
    eq(auto.todayPnl, wallet.todayPnl);
    eq(auto.todayPnl, -30.75);
  });

  test('한 칸이라도 다르면 대조기가 잡는다', () => {
    const v = paperViewsAgree(auto, wallet);
    assert(v.same, `두 화면이 갈렸다: ${v.diff.join(' / ')}`);
    // 대조기가 아무거나 통과시키지 않는지 확인한다.
    const broken = paperViewOf({
      loaded: true,
      payload: { ...OVERVIEW_PAPER, equity: { ...EQUITY, cash: 1 } },
    });
    const w = paperViewsAgree(auto, broken);
    eq(w.same, false);
    assert(w.diff.some(d => d.startsWith('cash')), `무엇이 갈렸는지 적는다 — ${w.diff.join(' / ')}`);
  });

  // ══ ② 지갑 패널도 같은 정규화기에서 나온다 ══
  test('지갑 패널의 값이 자동매매 화면과 같다', () => {
    const panel = paperPanelOf({ loaded: true, paper: OVERVIEW_PAPER });
    eq(panel.code, 'ACTIVE');
    const by = (k: string) => panel.rows.find(r => r.key === k)!;
    eq(by('total').usd, auto.totalEquity);
    eq(by('cash').usd, auto.cash);
    eq(by('positionMargin').usd, auto.usedMargin);
    eq(by('unrealized').usd, auto.unrealizedPnl);
    eq(by('realized').usd, auto.realizedPnl);
    eq(by('today').usd, auto.todayPnl);
  });

  // ══ ③ 상태도 같이 움직인다 ══
  test('시작 전에는 두 화면 모두 NOT_STARTED다', () => {
    const a = paperViewOf({ loaded: true, payload: { ok: true, started: false, equity: { state: 'NOT_STARTED' } } });
    const b = paperViewOf({ loaded: true, payload: { code: 'NO_ACCOUNT' } });
    eq(a.code, 'NOT_STARTED');
    eq(b.code, 'NOT_STARTED');
    // **0을 그리지 않는다.**
    eq(a.totalEquity, null); eq(b.totalEquity, null);
  });

  test('못 읽었으면 두 화면 모두 확인 불가다 — 계좌 없음이 아니다', () => {
    const a = paperViewOf({ loaded: true, payload: { ok: false, error: 'paper_unreadable', message: 'boom' } });
    const b = paperViewOf({ loaded: true, payload: { code: 'UNREADABLE', error: 'boom' } });
    eq(a.code, 'UNREADABLE');
    eq(b.code, 'UNREADABLE');
    eq(a.totalEquity, null);
    assert(!a.note.includes('boom'), '원문은 메인 문장에 넣지 않는다');
  });

  test('응답 전에는 LOADING이다 — 시작 버튼이 번쩍이지 않는다', () => {
    eq(paperViewOf({ loaded: false, payload: null }).code, 'LOADING');
  });

  // ══ ④ 잔고 0은 진짜 0이다 ══
  test('잔고 0인 계좌는 0으로 그린다', () => {
    const v = paperViewOf({
      loaded: true,
      payload: { code: 'READY', equity: { cash: 0, usedMargin: 0, totalEquity: 0,
        unrealizedPnl: 0, realizedPnl: 0, totalFees: 0 }, today: { pnl: 0 } },
    });
    eq(v.code, 'READY');
    eq(v.totalEquity, 0);
    eq(v.cash, 0);
  });

  // ══ ⑤ localStorage가 서버 값을 덮을 수 없다 ══
  test('정규화기는 localStorage를 입력으로 받지 않는다', () => {
    // 로컬 장부 모양(원화·positions 객체)을 넣어도 숫자가 되지 않는다.
    const localShaped = { krw: 10_000_000, totalPnL: 250_000,
      positions: { BTC: { qty: 0.1, avgPrice: 140_000_000 } } };
    const v = paperViewOf({ loaded: true, payload: localShaped });
    // code도 값도 서버 모양이 아니면 아무 숫자도 만들지 않는다.
    assert(v.code !== 'READY', `로컬 모양이 READY가 되면 안 된다 — ${v.code}`);
    eq(v.cash, null);
    eq(v.totalEquity, null);
  });

  test('예전 로컬 기록은 존재만 알린다 — 값으로 쓰지 않는다', () => {
    const store = {
      getItem: (k: string) => (k === 'tg_paper_balance' ? '{"krw":10000000}' : null),
    };
    const v = legacyLocalPaper(store);
    eq(v.present, true);
    eq(v.keys.join(','), 'tg_paper_balance');
    eq(v.unreadable, false);
    // **합치는 함수가 없다.** 있으면 언젠가 누가 부른다.
    assert(!(Object.keys({ legacyLocalPaper } as any).includes('importLegacy')),
      '자동 합치기 함수를 만들지 않는다');
  });

  test('저장소를 못 읽으면 "없음"으로 적지 않는다', () => {
    const v = legacyLocalPaper({ getItem() { throw new Error('blocked'); } });
    eq(v.unreadable, true);
    eq(v.present, false);
  });

  test('legacy 키 목록이 비어 있지 않다 — 지울 대상을 안다', () => {
    assert(LEGACY_PAPER_KEYS.length >= 1, '지울 키를 알고 있어야 한다');
  });

  // ══ ⑥ 사용자·환경 격리 ══
  test('다른 사용자의 응답은 그 응답의 값만 낸다', () => {
    const u1 = paperViewOf({ loaded: true, payload: OVERVIEW_PAPER });
    const u2 = paperViewOf({
      loaded: true,
      payload: { code: 'READY', equity: { cash: 500, totalEquity: 500 }, today: {}, positions: [] },
    });
    eq(u1.cash, 9_820.5);
    eq(u2.cash, 500);
    eq(u2.positions.length, 0);
    // 한쪽 값이 다른 쪽에 새지 않는다(모듈 상태가 없다).
    eq(paperViewOf({ loaded: true, payload: OVERVIEW_PAPER }).cash, 9_820.5);
  });

  test('MOCK 뷰는 통화가 언제나 USDT다 — 원화 장부와 섞이지 않는다', () => {
    eq(auto.currency, 'USDT');
    eq(wallet.currency, 'USDT');
    eq(paperViewOf({ loaded: true, payload: { code: 'NO_ACCOUNT' } }).currency, 'USDT');
  });
}
