// 실제 PostgreSQL에 대고 10슬롯 원자성을 확인하기 위한 도구.
//
// **FakeDB는 보조 증거일 뿐 실제 DB 원자성의 증거가 아니다**(#531). 그래서
// 여기서는 모델을 흉내내지 않는다 — 진짜 백엔드 여러 개를 띄워 같은 캠페인
// 줄을 동시에 잡게 하고, 커밋된 것만 센다.
//
// 연결은 `TEN_SLOT_PG_URL`로만 받는다. 없으면 시험은 **건너뛴다고 말하고**
// 통과로 적지 않는다. 운영 DB를 가리키는 것을 막기 위해 호스트가
// localhost 계열이 아니면 거절한다 — 이 도구는 임시 DB를 만들고 지운다.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PG_URL_ENV = 'TEN_SLOT_PG_URL';
export const PG_RESTART_ENV = 'TEN_SLOT_PG_RESTART';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function psqlBin() {
  return process.env.TEN_SLOT_PSQL || 'psql';
}

/** 설정됐는가. 사유를 함께 돌려준다 — 못 돈 이유를 "통과"로 적지 않기 위해 */
export function pgTarget() {
  const raw = process.env[PG_URL_ENV];
  if (!raw) return { ok: false, reason: `${PG_URL_ENV}가 없습니다` };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: `${PG_URL_ENV}를 읽지 못했습니다` }; }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return { ok: false, reason: `${PG_URL_ENV}의 프로토콜이 postgres가 아닙니다` };
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    // 이 도구는 DB를 만들고 지운다. 원격 주소에는 절대 대지 않는다.
    return { ok: false, reason: '로컬 호스트가 아닙니다 — 이 도구는 임시 DB를 만들고 지웁니다' };
  }
  return { ok: true, url };
}

function dbUrl(url, database) {
  const next = new URL(url.toString());
  next.pathname = '/' + database;
  return next.toString();
}

/** 한 번 돌고 끝나는 psql. 실패하면 던진다 — 조용히 빈 결과를 돌려주지 않는다 */
export function psql(target, database, sql, { expectError = false } = {}) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-At', '-X', '-q', dbUrl(target.url, database), '-c', sql];
  let out;
  try {
    out = execFileSync(psqlBin(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (expectError) return { error: String(e.stderr || e.message) };
    throw new Error(`psql 실패: ${String(e?.stderr || e?.message).trim()}`);
  }
  if (expectError) throw new Error(`오류를 기대했는데 성공했습니다: ${out.trim()}`);
  return out.replace(/\n$/, '').split('\n').filter(l => l.length > 0);
}

export function psqlFile(target, database, path) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-At', '-X', '-q', dbUrl(target.url, database), '-f', path];
  try {
    return execFileSync(psqlBin(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`psql -f ${path} 실패: ${String(e?.stderr || e?.message).trim()}`);
  }
}

/**
 * 죽이거나 기다릴 수 있는 psql. 동시 경합과 "응답 유실"을 만드는 데 쓴다.
 *
 * 문장을 배열로 주면 **각각 따로** 보낸다 — 한 문장으로 묶으면 psql이
 * 전부 한 트랜잭션으로 보내서 "커밋한 직후"를 만들 수 없다.
 */
export function psqlSpawn(target, database, sql) {
  const statements = Array.isArray(sql) ? sql : [sql];
  const args = ['-v', 'ON_ERROR_STOP=1', '-At', '-X', '-q', dbUrl(target.url, database),
    ...statements.flatMap(s => ['-c', s])];
  const child = spawn(psqlBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { err += c; });
  const done = new Promise(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
  return { child, done };
}

const BOOTSTRAP = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS 'SELECT NULL::UUID';
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
`;

/**
 * 임시 DB를 만들고 지정한 마이그레이션만 적용한다.
 *
 * **마이그레이션 파일을 그대로 적용한다** — 시험용 스키마를 따로 적지 않는다.
 * 따로 적으면 "시험은 통과하는데 배포된 스키마는 다른" 상태가 만들어진다.
 */
export function createScratchDb(target, prefix, migrationFiles) {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  psql(target, target.url.pathname.slice(1) || 'postgres', `CREATE DATABASE ${name}`);
  psql(target, name, BOOTSTRAP);
  for (const file of migrationFiles) psqlFile(target, name, file);
  return name;
}

export function dropScratchDb(target, name) {
  psql(target, target.url.pathname.slice(1) || 'postgres',
    `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** 재시작을 실제로 돌릴 수 있는가. 못 돌리면 그 시험은 통과로 적지 않는다 */
export function restartCommand() {
  const raw = process.env[PG_RESTART_ENV];
  return raw && raw.trim() ? raw : null;
}

export function restartCluster() {
  const cmd = restartCommand();
  if (!cmd) throw new Error(`${PG_RESTART_ENV}가 없습니다 — 재시작을 확인할 수 없습니다`);
  execFileSync('/bin/sh', ['-c', cmd], { stdio: 'pipe', encoding: 'utf8' });
}

const q = v => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const n = v => (v === null || v === undefined ? 'NULL' : String(v));

/** 캠페인 개설 SQL */
export function openCampaignSql(c) {
  return `SELECT code, campaign_version FROM ten_slot_open_campaign(
    ${q(c.campaignId)}, ${q(c.userId)}, ${c.connectionId ? q(c.connectionId) : 'NULL'},
    ${q(c.environment || 'TESTNET')},
    ${c.startingEquityExpr === undefined ? n(c.startingEquity ?? 1000) : c.startingEquityExpr})`;
}

/**
 * 예약+의도 SQL. 인자 순서를 한 곳에만 적는다 — 시험마다 다시 적으면
 * 언젠가 한쪽만 바뀐다.
 */
/**
 * 시험이 쓰는 기본 캠페인 주인. `openCampaignSql`의 `userId`와 같아야
 * 소유권 검사를 통과한다 — 기본값을 한 곳에만 둔다.
 */
export const DEFAULT_OWNER = '11111111-1111-4111-8111-111111111111';

export function claimSql(a) {
  // **`??`로 기본값을 주지 않는다.** 그러면 시험이 일부러 넘긴 null이
  // 기본값으로 바뀌어, 거절해야 하는 경우가 통과로 보인다.
  const fill = (v, d) => (v === undefined ? d : v);
  // `Infinity`는 JS로 렌더하면 유효한 SQL이 아니다. 그런 값은 **SQL 식을
  // 그대로** 넘겨야 검사할 수 있다 (`'Infinity'::numeric`).
  const raw = (expr, v) => (expr === undefined ? v : expr);
  const e = a.exposure === undefined ? { positions: 0, openOrders: 0, pendingEntries: 0 } : a.exposure;
  return `SELECT code, slot_index, campaign_version, live_order_id FROM ten_slot_claim(
    ${q(a.campaignId)}, ${n(a.expectedVersion)}, ${a.clientOrderId === null ? 'NULL' : q(a.clientOrderId)},
    ${n(fill(a.requestedLots, 1))},
    ${n(e?.positions)}, ${n(e?.openOrders)}, ${n(e?.pendingEntries)},
    ${q(fill(a.exchange, 'binance'))}, ${q(fill(a.mode, 'TESTNET'))}, ${q(fill(a.symbol, 'BTCUSDT'))},
    ${q(fill(a.side, 'BUY'))}, ${q(fill(a.orderType, 'MARKET'))},
    ${raw(a.quantityExpr, n(fill(a.quantity, 0.001)))},
    ${raw(a.priceExpr, a.price == null ? 'NULL' : n(a.price))}, ${n(fill(a.leverage, 10))},
    ${a.reduceOnly ? 'TRUE' : 'FALSE'}, ${a.signalId ? q(a.signalId) : 'NULL'},
    ${raw(a.stopLossExpr, a.stopLoss == null ? 'NULL' : n(a.stopLoss))},
    ${raw(a.takeProfitExpr, a.takeProfit == null ? 'NULL' : n(a.takeProfit))},
    ${q(fill(a.stopPolicy, null))},
    ${q(fill(a.profileId, null))}, ${q(fill(a.presetId, null))},
    ${n(fill(a.contractVersion, null))},
    ${raw(a.adversePctExpr, n(fill(a.adversePct, null)))},
    ${raw(a.liqPctRawExpr, n(fill(a.liqPctRaw, null)))},
    ${q(fill(a.callerUserId, DEFAULT_OWNER))}, ${q(fill(a.callerConnectionId, null))})`;
}

/**
 * 커밋된 **의도 한 줄**을 그대로 읽는다.
 *
 * 예약 줄(`ten_slot_claims`)을 거치지 않고 `live_orders`를 직접 본다 —
 * 예약은 됐는데 의도에 계약이 안 적힌 상태를 보려면 장부 쪽을 봐야 한다.
 *
 * NULL은 빈 문자열로 돌려준다. 이 칸들은 전부 "값이 있으면 빈 문자열이
 * 아닌" 종류라서 구분이 선다. **빈 문자열을 0이나 '없음'으로 읽지 않는다 —
 * 기록이 없다는 뜻이다.**
 */
export function intentRow(target, db, clientOrderId) {
  const rows = psql(target, db, `SELECT
      coalesce(status, ''), coalesce(mode, ''), coalesce(order_type, ''),
      coalesce(price::text, ''),
      coalesce(stop_loss::text, ''), coalesce(take_profit::text, ''),
      coalesce(stop_policy, ''),
      coalesce(execution_profile_id, ''), coalesce(execution_preset_id, ''),
      coalesce(execution_contract_version::text, ''),
      coalesce(entry_adverse_distance_pct::text, ''),
      coalesce(entry_liquidation_distance_pct_raw::text, '')
    FROM live_orders WHERE client_order_id = ${q(clientOrderId)}`);
  if (rows.length === 0) return null;
  const f = String(rows[0]).split('|');
  return {
    status: f[0], mode: f[1], orderType: f[2], price: f[3],
    stopLoss: f[4], takeProfit: f[5], stopPolicy: f[6],
    profileId: f[7], presetId: f[8], contractVersion: f[9],
    adversePct: f[10], liqPctRaw: f[11],
  };
}

/** `ten_slot_kill` 호출 SQL. 정체성 기본값은 시험 주인과 같다 */
export function killSql(a) {
  const fill = (v, d) => (v === undefined ? d : v);
  return `SELECT code, campaign_version FROM ten_slot_kill(
    ${q(a.campaignId)}, ${q(fill(a.callerUserId, DEFAULT_OWNER))},
    ${q(fill(a.callerConnectionId, null))})`;
}

export function parseKill(rows) {
  const [line] = rows;
  if (!line) return { code: null };
  const [code, version] = String(line).split('|');
  return { code, version: version === '' ? null : Number(version) };
}

export function parseClaim(rows) {
  const [line] = rows;
  if (!line) return { code: null };
  const [code, slotIndex, version, orderId] = line.split('|');
  return {
    code,
    slotIndex: slotIndex === '' ? null : Number(slotIndex),
    version: version === '' ? null : Number(version),
    liveOrderId: orderId === '' ? null : orderId,
  };
}

/** 커밋된 것만 센다. 함수가 무엇을 돌려줬는지와 별개로 본다 */
export function readState(target, db, campaignId) {
  const [row] = psql(target, db, `SELECT
      (SELECT version FROM ten_slot_campaigns WHERE campaign_id = ${q(campaignId)}),
      (SELECT killed  FROM ten_slot_campaigns WHERE campaign_id = ${q(campaignId)}),
      (SELECT count(*) FROM ten_slot_slots WHERE campaign_id = ${q(campaignId)}
         AND status IN ('RESERVED','OPEN','CLOSING','UNKNOWN')),
      (SELECT count(*) FROM ten_slot_claims WHERE campaign_id = ${q(campaignId)}),
      -- 예약 줄을 거치지 않고 센다. 그래야 **예약 없이 남은 의도**가 보인다.
      (SELECT count(*) FROM live_orders
         WHERE client_order_id LIKE '%' || ${q(campaignId)} || '%'),
      (SELECT string_agg(status, ',' ORDER BY slot_index) FROM ten_slot_slots
         WHERE campaign_id = ${q(campaignId)})`);
  const [version, killed, active, claims, intents, statuses] = String(row).split('|');
  return {
    version: version === '' ? null : Number(version),
    killed: killed === 't',
    active: Number(active),
    claims: Number(claims),
    intents: Number(intents),
    statuses: statuses ? statuses.split(',') : [],
  };
}

/**
 * 같은 순간에 여러 백엔드가 같은 버전으로 들어가게 만든다.
 *
 * 시계로 맞추지 않는다 — 프로세스마다 들쭉날쭉하다. 대신 모두가 먼저
 * 공유 자문 잠금을 기다리게 하고, 그 잠금을 한 번에 풀어 출발시킨다.
 */
export function barrierSql(inner, lockKey = 991531) {
  return `SELECT pg_advisory_lock_shared(${lockKey}); ${inner}`;
}

export async function raceClaims(target, db, statements, lockKey = 991531) {
  // 배타 잠금을 쥐고 일꾼을 모두 띄운다. 일꾼은 공유 잠금에서 멈춰 선다.
  const gate = psqlSpawn(target, db,
    `SELECT pg_advisory_lock(${lockKey}); SELECT pg_sleep(${Number(process.env.TEN_SLOT_PG_GATE_MS || 400) / 1000});`);
  await new Promise(r => setTimeout(r, 150));
  const workers = statements.map(sql => psqlSpawn(target, db, barrierSql(sql, lockKey)));
  // 게이트가 끝나면(잠금 해제) 일꾼들이 동시에 풀려난다.
  await gate.done;
  const results = await Promise.all(workers.map(w => w.done));
  return results.map(r => ({ ...r, rows: r.out.replace(/\n$/, '').split('\n').filter(Boolean) }));
}

export function migrationPaths(root, names) {
  return names.map(name => {
    const path = `${root}/supabase/migrations/${name}`;
    readFileSync(path); // 없으면 여기서 분명히 실패한다
    return path;
  });
}
