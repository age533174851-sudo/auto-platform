// scripts/test-hub-accounts-seed.mjs
//
// 이 시험이 막는 것: **'통합 운용' 탭을 처음 여는 사람에게 갖지 않은
// 잔고·손익·포지션을 보여 주는 것.**
//
// 저장된 상태가 없을 때 `loadHubState`(src/lib/accounts/store.ts)는 예시
// 계좌 넷을 돌려줬다. 거기에는 "총 1,000만 원 · 오늘 +16.2만 원 · 실현손익
// +109.5만 원 · 누적 +14.12% · 단타 봇 실행 중 · BTC 5배 롱 등 포지션 6건"이
// 들어 있었고, 화면(`HubAccountsPage`, 로그인 필요 탭)은 그것을 사용자의
// 계좌와 똑같이 그렸다 — 예시라는 표시 없이. `dca.test.ts`가 막은 것과 같은
// 꼴이다: 모르는 것은 지어낸 값이 아니다. 없으면 **없다**고 그린다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(relativePath, globals = {}) {
  const path = new URL(`../${relativePath}`, import.meta.url);
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(source, {
    exports,
    console,
    require(id) { throw new Error(`예상하지 못한 import: ${id}`); },
    ...globals,
  });
  return exports;
}

function fakeWindow(stored = {}) {
  return {
    localStorage: {
      getItem: (k) => (k in stored ? stored[k] : null),
      setItem: (k, v) => { stored[k] = v; },
    },
  };
}

function assertNothingFabricated(state, where) {
  assert.ok(Array.isArray(state.accounts), `${where}: accounts가 배열이 아니다`);
  for (const a of state.accounts) {
    const tag = `${where}: '${a.name}'`;
    assert.equal(a.balance, 0, `${tag} 잔고 ${a.balance} — 넣은 적 없는 돈이다`);
    assert.equal(a.cash, 0, `${tag} 현금 ${a.cash} — 넣은 적 없는 돈이다`);
    assert.equal(a.realizedPnl, 0, `${tag} 실현손익 ${a.realizedPnl} — 한 적 없는 거래다`);
    assert.equal(a.todayPnl, 0, `${tag} 오늘 손익 ${a.todayPnl} — 한 적 없는 거래다`);
    assert.equal(a.cumulativeReturn, 0, `${tag} 누적 수익률 ${a.cumulativeReturn}%`);
    assert.deepEqual(Array.from(a.positions), [], `${tag} 포지션 ${a.positions.length}건 — 산 적 없다`);
    assert.notEqual(a.botActive, true, `${tag} 봇이 '실행 중' — 켠 적 없다`);
  }
}

test('★ 저장된 상태가 없으면 잔고·손익·포지션을 지어내지 않는다', () => {
  const store = load('src/lib/accounts/store.ts', { window: fakeWindow() });
  const state = store.loadHubState();
  assertNothingFabricated(state, '첫 방문');
  assert.equal(store.totalBalance(state), 0, '총 자산이 0이 아니다');
  assert.equal(store.totalTodayPnl(state), 0, '오늘 손익이 0이 아니다');
});

test('★ 서버 렌더(창 없음)에서도 지어내지 않는다', () => {
  const store = load('src/lib/accounts/store.ts');
  assertNothingFabricated(store.loadHubState(), '창 없음');
});

test('★ 초기화도 빈 상태로 돌아간다 — 예시 장부로 되돌리지 않는다', () => {
  const stored = {};
  const store = load('src/lib/accounts/store.ts', { window: fakeWindow(stored) });
  const fresh = store.resetHubState();
  assertNothingFabricated(fresh, '초기화');
  assertNothingFabricated(JSON.parse(stored[store.HUB_STORE_KEY]), '초기화 후 저장본');
});

test('저장된 상태가 있으면 그대로 읽는다 — 빈 상태로 덮지 않는다', () => {
  const saved = {
    version: 1,
    accounts: [{ id: 'mine', kind: 'longterm', name: '내 계좌', balance: 1234, cash: 34,
      realizedPnl: 5, todayPnl: 1, cumulativeReturn: 0.4, riskLevel: 'low', positions: [] }],
    transferRule: { enabled: false, toLongterm: 0, toCash: 0 },
    emergencyMode: false,
    recentSellActions: [],
  };
  const store = load('src/lib/accounts/store.ts', {
    window: fakeWindow({ tg_hub_accounts_v1: JSON.stringify(saved) }),
  });
  const state = store.loadHubState();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].balance, 1234);
});

test('계좌 칸(단타·장투·현금·자동매매)은 남는다 — 화면이 그릴 자리', () => {
  const store = load('src/lib/accounts/store.ts');
  const kinds = Array.from(store.loadHubState().accounts, (a) => a.kind);
  assert.deepEqual(kinds, ['shortterm', 'longterm', 'cash', 'autobot']);
});
