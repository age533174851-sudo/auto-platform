#!/usr/bin/env node
// scripts/check-db-schema.mjs
//
// **실제 DB에 물어본다.**
//
// 왜 필요한가
// ───────────
// `check-table-drift.mjs`는 **저장소 안의 파일만** 본다. 코드가
// `.from('watchlists')`로 쓰고 `supabase/schema_v2.sql`에 정의가 있으면
// 통과한다 — 그런데 그 파일은 마이그레이션 파이프라인이 적용하지 않는다.
// **정의가 있다는 것과 DB에 있다는 것은 다른 사실이다.**
//
// 실제로 어긋난 예가 있다. `watchlists`는 두 파일에 서로 다른 모양으로
// 정의돼 있다:
//
//   schema.sql      user_id · name · symbols(jsonb) · is_default
//   schema_v2.sql   user_id · symbol · name_kr · symbol_ticker · …
//
// 코드는 뒤쪽을 쓴다. **`CREATE TABLE IF NOT EXISTS`라서 먼저 실행된
// 쪽이 이긴다** — schema.sql이 먼저 돌았다면 왓치리스트 동기화는 전부
// 조용히 실패한다. 파일만 봐서는 어느 쪽이 이겼는지 알 수 없다.
//
// 무엇을 하는가 / 하지 않는가
// ───────────────────────────
//   한다      information_schema.tables · information_schema.columns SELECT
//   안 한다   CREATE · ALTER · DROP · INSERT · UPDATE · DELETE — 하나도 없다
//
// 값은 로그에 남지 않는다
// ───────────────────────
// 접속 문자열은 지문(6자)만 찍는다. psql 오류 문구에서도 접속 정보를
// 지우고 출력한다.
//
// **조회 실패를 "표 없음"으로 적지 않는다**
// ─────────────────────────────────────────
// 못 붙었을 때와 없을 때는 다른 사실이다. 섞으면 다음 두 가지가 생긴다:
//   - 네트워크가 끊긴 것을 "표가 사라졌다"로 읽고 사람을 놀래킨다
//   - 반대로 "확인 못 함"을 통과로 적으면 검사가 꺼진 것과 같다
// 그래서 결과 코드를 셋으로 나눈다: VERIFIED · MISSING · UNVERIFIED.
// **UNVERIFIED도 실패다** — 확인하지 못한 것은 통과가 아니다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * 코드가 실제로 읽고 쓰는 칸.
 *
 * **추측으로 채우지 않았다.** 각 줄 옆에 그 칸을 쓰는 코드가 있다.
 * 여기 없는 칸이 DB에 더 있어도 상관없다 — 없는 것만 잡는다.
 */
const REQUIRED = {
  // src/lib/supabase/hooks.ts loadAlerts / saveAlert
  alerts: ['id', 'user_id', 'asset_id', 'name_kr', 'condition', 'value', 'active', 'triggered_at', 'created_at'],

  // src/lib/supabase/hooks.ts loadBacktestResults / saveBacktestResult
  backtest_results: ['id', 'user_id', 'strategy_id', 'strategy_name', 'asset', 'timeframe',
    'start_date', 'end_date', 'total_trades', 'win_rate', 'total_pnl', 'max_drawdown',
    'sharpe_ratio', 'params', 'equity_curve', 'created_at'],

  // src/lib/supabase/hooks.ts loadPnlReports / upsertPnlReport (onConflict: user_id,period)
  pnl_reports: ['id', 'user_id', 'period', 'realized_pnl', 'unrealized_pnl', 'total_fee',
    'trade_count', 'win_count', 'loss_count', 'win_rate', 'best_trade', 'worst_trade', 'tax_estimate'],

  // src/lib/supabase/hooks.ts loadPortfolio / savePortfolioPosition
  portfolio_positions: ['id', 'user_id', 'asset_id', 'name_kr', 'symbol', 'color', 'type',
    'avg_price', 'quantity', 'invested', 'target_price', 'stop_price', 'leverage', 'note', 'created_at'],

  // src/lib/supabase/hooks.ts loadOrders(select 목록) / saveOrder(insert)
  trade_orders: ['id', 'user_id', 'exchange_id', 'symbol', 'name_kr', 'side', 'price', 'quantity',
    'amount', 'leverage', 'fee', 'slippage', 'status', 'pnl', 'pnl_pct', 'mode', 'note',
    'emotion', 'opened_at', 'closed_at'],

  // src/app/api/strategies/route.ts (save record + update allowed 목록)
  // src/app/api/admin/route.ts emergency_stop → enabled · status
  trading_strategies: ['id', 'user_id', 'name', 'type', 'asset', 'asset_name_kr', 'timeframe',
    'leverage', 'max_leverage', 'risk_level', 'tp', 'sl', 'enabled', 'status', 'win_rate',
    'total_pnl', 'trades', 'max_daily_loss', 'max_position_size', 'cooldown_min', 'params',
    'description', 'exec_mode', 'created_at'],

  // src/app/api/watchlist/sync/route.ts (select 목록 + upsert record)
  watchlists: ['id', 'user_id', 'symbol', 'name_kr', 'symbol_ticker', 'color', 'category',
    'exchange', 'tv_symbol', 'added_at'],

  // src/lib/safety/auditStore.ts auditRow() — 실거래 주문·KILL·긴급정지가 남는 곳.
  // 마이그레이션(040)이 만들지만, **여기서도 확인한다.** 감사 기록이
  // insert 실패로 통째로 사라지는 것이 이 검사의 출발점이었다.
  audit_events: ['id', 'user_id', 'action', 'resource', 'result', 'detail', 'connection_id', 'created_at'],
};

/** 값을 보여주지 않고 같은 값인지만 말한다 */
function fingerprint(v) {
  if (!v) return null;
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 6);
}

function dbUrl() {
  for (const k of ['SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL_POOLER']) {
    const v = String(process.env[k] || '').trim();
    if (v) return { url: v, from: k };
  }
  return { url: '', from: null };
}

/** 로그·오류 문구에서 접속 문자열을 지운다. **한 번 새면 기록에 영원히 남는다** */
function scrub(text, url) {
  let s = String(text ?? '');
  if (!url) return s;
  s = s.split(url).join('[DB_URL 가림]');
  try {
    const u = new URL(url);
    for (const part of [u.password, u.username, u.host, u.hostname, u.port]) {
      if (part) s = s.split(part).join('[가림]');
    }
  } catch { /* URL 파싱 실패해도 위에서 통짜 치환은 했다 */ }
  return s;
}

/**
 * **SELECT만 보낸다.**
 *
 * `-c` 하나에 한 문장. 여기 들어오는 SQL은 이 파일 안에 상수로만
 * 있으며 사용자 입력이 섞이지 않는다.
 */
function selectOnly(url, sql) {
  if (!/^\s*select\b/i.test(sql)) {
    // 자기 자신을 지키는 문 — 나중에 누가 여기에 DDL을 넣지 못하게.
    return { ok: false, error: 'SELECT가 아닌 문장은 이 스크립트에서 실행하지 않습니다' };
  }
  try {
    const out = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', '-F', '\t', '-c', sql], {
      stdio: 'pipe', encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: '15',
        // 읽기 전용으로 못을 박는다. 이 세션에서는 쓰기가 아예 안 된다.
        PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=30000',
      },
    });
    return { ok: true, rows: String(out).split('\n').filter(Boolean).map(l => l.split('\t')) };
  } catch (e) {
    const raw = [e?.stderr, e?.stdout, e?.message].map(x => String(x ?? '')).join('\n').trim();
    return { ok: false, error: scrub(raw, url).slice(0, 1200) };
  }
}

// ── 여기서부터 실행 ──────────────────────────────────────────
const wanted = Object.keys(REQUIRED).sort();
const { url, from } = dbUrl();

/** 확인하지 못했다 — 없다고 적지 않는다 */
function unverified(reason, hint) {
  console.error('❌ UNVERIFIED — 실제 DB를 확인하지 못했습니다');
  console.error(`   ${reason}`);
  if (hint) console.error(`   ${hint}`);
  console.error('');
  console.error('   **이것은 "표가 없다"가 아닙니다.** 못 물어봤다는 뜻입니다.');
  console.error('   확인하지 못한 것은 통과가 아니므로 실패로 끝냅니다.');
  process.exit(1);
}

if (!url) {
  unverified(
    'SUPABASE_DB_URL(또는 DATABASE_URL·POSTGRES_URL)이 없습니다',
    'GitHub Actions에서는 secrets.SUPABASE_DB_URL을 env로 넘기세요. 값은 로그에 출력하지 않습니다.',
  );
}
console.log(`DB 접속 정보: ${from} (지문 ${fingerprint(url)}, 값은 출력하지 않습니다)`);

// psql이 있는지부터 본다 — 없는 것을 "표 없음"으로 읽으면 안 된다.
try {
  execFileSync('psql', ['--version'], { stdio: 'pipe', timeout: 15_000 });
} catch {
  unverified('psql을 실행할 수 없습니다', 'ubuntu-latest 러너에는 psql이 들어 있습니다. 로컬이라면 postgresql-client를 설치하세요.');
}

const list = wanted.map(t => `'${t}'`).join(',');

// ① 표가 있는가
const tRes = selectOnly(url,
  `SELECT table_name FROM information_schema.tables `
  + `WHERE table_schema = 'public' AND table_name IN (${list})`);
if (!tRes.ok) {
  unverified(`information_schema.tables 조회가 실패했습니다: ${tRes.error}`,
    '접속·권한·네트워크 문제일 수 있습니다 — 표가 없다는 뜻이 아닙니다.');
}

// ② 칸이 있는가
const cRes = selectOnly(url,
  `SELECT table_name, column_name FROM information_schema.columns `
  + `WHERE table_schema = 'public' AND table_name IN (${list})`);
if (!cRes.ok) {
  unverified(`information_schema.columns 조회가 실패했습니다: ${cRes.error}`,
    '접속·권한·네트워크 문제일 수 있습니다 — 칸이 없다는 뜻이 아닙니다.');
}

const present = new Set(tRes.rows.map(r => r[0]));
const cols = new Map();
for (const [t, c] of cRes.rows) {
  if (!cols.has(t)) cols.set(t, new Set());
  cols.get(t).add(c);
}

// 표는 있는데 칸을 하나도 못 읽었다면 그건 권한 문제다 — 없다고 적지 않는다.
const opaque = [...present].filter(t => !cols.has(t));
if (opaque.length > 0) {
  unverified(`표는 보이는데 칸 목록을 못 읽었습니다: ${opaque.join(' · ')}`,
    'information_schema.columns는 권한 있는 칸만 보여 줍니다 — 칸이 없다는 뜻이 아닙니다.');
}

let bad = 0;
const missingTables = [];
const missingCols = [];

for (const t of wanted) {
  if (!present.has(t)) { missingTables.push(t); continue; }
  const have = cols.get(t) ?? new Set();
  const lack = REQUIRED[t].filter(c => !have.has(c));
  if (lack.length) missingCols.push({ table: t, lack, have: have.size });
}

if (missingTables.length) {
  bad += 1;
  console.error(`❌ MISSING — 실제 DB에 없는 표: ${missingTables.join(' · ')}`);
  console.error('   코드가 이 표에 쓰고 있습니다. 그 쓰기는 조용히 실패합니다.');
  console.error('   supabase/migrations/에 CREATE TABLE을 넣으면 파이프라인이 자동으로 만듭니다.');
}

if (missingCols.length) {
  bad += 1;
  console.error('❌ MISSING — 표는 있는데 코드가 쓰는 칸이 없습니다');
  for (const m of missingCols) {
    console.error(`   ${m.table}: 없는 칸 ${m.lack.join(' · ')} (있는 칸 ${m.have}개)`);
  }
  console.error('   같은 이름의 표가 서로 다른 모양으로 두 번 정의돼 있으면 먼저 실행된 쪽이 이깁니다.');
  console.error('   (supabase/schema.sql과 supabase/schema_v2.sql의 watchlists가 그런 경우였습니다)');
}

if (bad === 0) {
  console.log(`✅ VERIFIED — 실제 DB에서 표 ${wanted.length}개와 필요한 칸을 모두 확인했습니다`);
  for (const t of wanted) console.log(`   ${t}: 칸 ${REQUIRED[t].length}개 확인`);
  console.log('   (읽기 전용 세션 · information_schema SELECT만 사용)');
} else {
  console.error('');
  console.error('   쓰기가 조용히 실패하는 표는 없는 것보다 나쁩니다.');
  console.error('   화면에는 "저장됨"이 뜨고 실제로는 아무것도 안 남습니다.');
}
process.exit(bad ? 1 : 0);
