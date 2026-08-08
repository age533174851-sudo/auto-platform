// scripts/check-runtime.mjs
//
// **브라우저 타이머로 도는 것을 '상시 실행'이라고 부르지 않는다.**
//
// MOCK 자동매매가 `setInterval(10초)`로 돈다. 다른 메뉴로 가면
// component가 unmount되고 타이머가 사라진다. 그런데 화면에는
// '자동매매 실행 중'이라고 적혀 있다.
//
// 이건 MOCK 하나의 문제가 아니다. 새 자동 기능을 만들 때마다 같은
// 실수가 반복되므로, **화면 안에서 실행되는 것을 CI가 세게 한다.**
//
// 무엇을 세는가
// ─────────────
// 화면 파일(.tsx) 안의 `setInterval`. 이 저장소에서 그것은 둘 중 하나다:
//
//   A. 실행       — 주문·체결·판단을 만든다. **서버로 옮겨야 한다**
//   B. 새로고침    — 서버 상태를 다시 읽기만 한다. 화면에 있어도 된다
//
// 둘을 구분하는 것은 사람이다. 그래서 목록을 만들고 분류를 적게 한다 —
// 분류가 없는 새 타이머가 생기면 CI가 막는다.
//
// 이 스크립트는 "타이머를 쓰지 마라"가 아니다. **"어느 쪽인지 적어라"**다.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SEARCH_DIRS = ['src/components', 'src/app'];

/**
 * 이미 분류된 타이머.
 *
 * `EXEC`  — 실행을 만든다. 서버로 옮겨야 하는 빚이다.
 * `POLL`  — 서버 상태를 다시 읽기만 한다. 화면에 있어도 된다.
 * `UI`    — 시계 표시, 애니메이션 같은 순수 화면.
 */
const CLASSIFIED = new Map([
  // ── A. 실행 (서버로 옮겨야 한다) ──
  ['src/components/MockAutoTrade.tsx',
    'EXEC — MOCK 자동매매가 브라우저 타이머로 판단·체결을 만든다. '
    + '화면을 떠나면 멈춘다. Worker로 옮겨야 한다'],
  ['src/components/AutoTradeEngine.tsx',
    'EXEC — 전략빌더 전략을 60초마다 평가한다. 화면이 닫히면 안 돈다'],
  ['src/components/terminal/DemoRunner.tsx',
    'EXEC — 데모 실행기. 데모라 서버로 옮길 필요는 없지만 상시 실행이 아니다'],
  ['src/components/terminal/ScheduledExitPanel.tsx',
    'EXEC — 예약 청산 감시. 화면이 닫히면 청산이 안 걸린다. '
    + '못 여는 것은 불편이고 못 닫는 것은 사고다 — 우선순위가 높다'],

  // ── B. 새로고침 (화면에 있어도 된다) ──
  ['src/components/AutotradeControl.tsx', 'POLL — 서버 예약 상태를 다시 읽기만 한다'],
  ['src/components/AutoStatusBoard.tsx', 'POLL — 상태판 새로고침'],
  ['src/components/ApiHealthMonitor.tsx', 'POLL — API 상태 확인'],
  ['src/components/terminal/PaperWallet.tsx', 'POLL — 모의 지갑 잔고 새로고침'],
  ['src/components/terminal/OrderPane.tsx', 'POLL — 호가·포지션 새로고침'],
  ['src/components/terminal/SpotOrderPanel.tsx', 'POLL — 현물 잔고 새로고침'],
  ['src/components/terminal/BottomDock.tsx', 'POLL — 포지션·미체결 새로고침'],
  ['src/components/terminal/LedgerPanel.tsx', 'POLL — 장부 새로고침'],
  ['src/components/terminal/ChartPane.tsx', 'POLL — 차트 갱신'],
  ['src/components/terminal/WalletTree.tsx', 'POLL — 지갑 트리 새로고침'],
  ['src/components/terminal/WatchPanel.tsx', 'POLL — 관심종목 시세'],
  ['src/components/terminal/SymbolSearch.tsx', 'POLL — 검색 결과 갱신'],
  ['src/components/terminal/LeftRail.tsx', 'POLL — 좌측 레일 상태'],
  ['src/components/pages/TradingPage.tsx', 'POLL — 시세 갱신'],
  ['src/components/pages/AutoPage.tsx', 'POLL — 실행 기록 새로고침'],
  ['src/components/pages/ChartTab.tsx', 'POLL — 차트 갱신'],
  ['src/components/pages/BriefingPage.tsx', 'POLL — 브리핑 갱신'],
  ['src/components/pages/AlertsPage.tsx', 'POLL — 알림 조건 확인(브라우저 전용)'],
  ['src/components/pages/SharedUI.tsx', 'UI — 시계·애니메이션'],
  ['src/components/ui/DataBadge.tsx', 'UI — 데이터 신선도 표시'],
  ['src/app/chart/page.tsx', 'POLL — 차트 갱신'],
]);

const files = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.tsx')) continue;
    files.push(p);
  }
}
for (const d of SEARCH_DIRS) walk(d);

const found = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  if (/\bsetInterval\s*\(/.test(text)) found.push(f);
}

const unclassified = found.filter(f => !CLASSIFIED.has(f));
const stale = [...CLASSIFIED.keys()].filter(f => !found.includes(f));

let bad = false;

if (unclassified.length > 0) {
  console.error('\n❌ 분류 안 된 화면 타이머:');
  for (const f of unclassified) console.error(`   · ${f}`);
  console.error('\n   화면 안의 setInterval은 둘 중 하나입니다:');
  console.error('     EXEC — 주문·체결·판단을 만든다 → **서버로 옮겨야 합니다**');
  console.error('     POLL — 서버 상태를 다시 읽기만 한다 → 화면에 있어도 됩니다');
  console.error('     UI   — 시계·애니메이션');
  console.error('\n   scripts/check-runtime.mjs의 CLASSIFIED에 어느 쪽인지 적으세요.');
  console.error('   브라우저가 살아 있어야만 동작하는 것을 "상시 실행"이라고 부르면 안 됩니다.');
  bad = true;
}

if (stale.length > 0) {
  console.error('\n⚠ CLASSIFIED에 있는데 타이머가 없는 파일:');
  for (const f of stale) console.error(`   · ${f}`);
  console.error('\n   목록에서 지우세요 — 낡은 목록은 다음에 진짜로 생긴 것을 덮습니다.');
  bad = true;
}

if (bad) process.exit(1);

const exec = [...CLASSIFIED.entries()].filter(([, v]) => v.startsWith('EXEC'));
console.log(`✅ 화면 타이머 ${found.length}개 · 분류 안 된 것 0개`);
console.log(`   서버로 옮겨야 하는 실행 타이머 ${exec.length}개 — 이게 갚아야 할 빚입니다:`);
for (const [f] of exec) console.log(`     · ${f}`);
