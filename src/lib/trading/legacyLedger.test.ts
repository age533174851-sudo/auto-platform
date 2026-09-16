// src/lib/trading/legacyLedger.test.ts
//
// **옛 장부를 거래에 쓰거나 서버 잔고와 합치는 길이 없는지 고정한다.**
import { test, eq, assert } from '../../test/harness';
import {
  LEGACY_LEDGERS, legacyLedgerInfo, isTradableLedger, legacyLedgerNotice,
  LEGACY_MIGRATION_POLICY,
} from './legacyLedger';

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
}
