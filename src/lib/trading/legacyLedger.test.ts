// src/lib/trading/legacyLedger.test.ts
//
// **옛 장부를 거래에 쓰거나 서버 잔고와 합치는 길이 없는지 고정한다.**
import { test, eq, assert } from '../../test/harness';
import {
  LEGACY_LEDGERS, legacyLedgerInfo, isTradableLedger, legacyLedgerNotice,
  LEGACY_MIGRATION_POLICY,
} from './legacyLedger';
import { placeOrder, calcMetrics, type PaperAccount } from '../paper/engine';

export function runLegacyLedgerTests() {
  test('★ 옛 장부는 어느 것도 거래에 쓸 수 없다', () => {
    for (const id of LEGACY_LEDGERS) {
      eq(isTradableLedger(id), false);
      eq(legacyLedgerInfo(id)!.tradable, false);
    }
  });

  test('★ 옛 장부는 성과·통계의 근거가 아니다', () => {
    for (const id of LEGACY_LEDGERS) {
      eq(legacyLedgerInfo(id)!.usableForStats, false);
    }
  });

  test('두 장부가 각자 어느 저장소·어느 파일인지 적혀 있다', () => {
    const keys = LEGACY_LEDGERS.map(id => legacyLedgerInfo(id)!.storageKey);
    eq(keys.join(','), 'tg_paper_account_v1,tg_paper_balance_v1');
    for (const id of LEGACY_LEDGERS) {
      assert(/^src\/lib\//.test(legacyLedgerInfo(id)!.module), `${id}에 모듈 경로가 없습니다`);
    }
  });

  test('안내 문구가 무엇을 해야 하는지까지 말한다', () => {
    for (const id of LEGACY_LEDGERS) {
      const n = legacyLedgerNotice(id);
      assert(n.length > 20, `${id} 안내가 너무 짧습니다`);
      assert(/서버/.test(n), `${id} 안내가 정본이 어디인지 말하지 않습니다`);
    }
  });

  test('★ 옮기지도 합치지도 지우지도 않는다 — 정책이 코드에 적혀 있다', () => {
    eq(LEGACY_MIGRATION_POLICY.migrate, false);
    eq(LEGACY_MIGRATION_POLICY.merge, false);
    eq(LEGACY_MIGRATION_POLICY.erase, false);
    assert(LEGACY_MIGRATION_POLICY.why.length > 30, '정책에 이유가 적혀 있지 않습니다');
  });

  test('★ 이전·병합 함수가 아예 없다 — 붙일 자리를 두지 않는다', async () => {
    const mod: any = await import('./legacyLedger');
    for (const name of Object.keys(mod)) {
      assert(!/migrate|merge|import|transfer|copyTo|adopt/i.test(name),
        `이전·병합 함수가 생겼습니다: ${name}`);
    }
  });

  test('모르는 장부는 정보가 없다', () => {
    eq(legacyLedgerInfo('WAT' as any), null);
  });

  // ── 옛 모의매매 장부(LOCAL_KRW_PAPER)의 실현손익 ──
  //
  // 이 장부는 아직 '모의매매' 메뉴에서 쓰인다. 매도 기록의 실현손익이
  // **매수 때 낸 수수료를 빼지 않아서** 실제로 돈을 잃은 거래가 초록
  // (+)으로 적히고 있었다. 현금 변화와 실현손익이 같은 장부에서 갈린다.
  const fresh = (): PaperAccount => ({
    cash: 1_000_000, initialCash: 1_000_000, positions: [], orders: [], createdAt: 0,
  });

  test('★ 옛 모의매매: 실현손익은 매수·매도 수수료를 둘 다 뺀 현금 변화와 같다', () => {
    const a0 = fresh();
    const b = placeOrder(a0, { symbol: 'X', side: 'buy', price: 10_000, qty: 10 });
    assert(b.ok, b.error);
    const s = placeOrder(b.account!, { symbol: 'X', side: 'sell', price: 10_015, qty: 10 });
    assert(s.ok, s.error);
    const cashChange = s.account!.cash - a0.cash;          // −50.15
    assert(Math.abs(s.order!.realized! - cashChange) < 1e-6,
      `실현손익 ${s.order!.realized} ≠ 현금 변화 ${cashChange}`);
    assert(s.order!.realized! < 0, '수수료를 빼면 잃은 거래가 이긴 거래로 적혔다');
    // 포지션을 다 닫았으면 화면의 실현손익 합계와 총손익이 같아야 한다
    const m = calcMetrics(s.account!, () => null);
    assert(Math.abs(m.realized - m.pnl) < 1e-6, `실현 ${m.realized} ≠ 총손익 ${m.pnl}`);
    eq(m.winRate, 0);
  });

  test('옛 모의매매: 나눠 사고 나눠 팔아도 실현손익 합계가 현금 변화와 같다', () => {
    let a = fresh();
    const start = a.cash;
    for (const [side, price, qty] of [
      ['buy', 100, 30], ['buy', 130, 10], ['sell', 120, 25], ['buy', 90, 5], ['sell', 140, 20],
    ] as Array<['buy' | 'sell', number, number]>) {
      const r = placeOrder(a, { symbol: 'Y', side, price, qty });
      assert(r.ok, r.error);
      a = r.account!;
    }
    eq(a.positions.length, 0);
    const realized = a.orders.reduce((t, o) => t + (o.realized ?? 0), 0);
    assert(Math.abs(realized - (a.cash - start)) < 1e-6,
      `실현손익 합계 ${realized} ≠ 현금 변화 ${a.cash - start}`);
  });
}
