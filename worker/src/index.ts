// worker/src/index.ts — TRAIGO 24h 워커 (Railway)
// 유일한 거래소 실행자: jobs 큐를 polling → 락 획득 → PROCESSING → 거래소 실행 → COMPLETED/FAILED
// + 모니터: Ghost Sync(읽기) / 킬스위치 active면 KILL_SWITCH_EXECUTE job 보장
import { sb, acquireLock, releaseLock, heartbeat } from './supabase';
import { decryptSecret } from './crypto';
import { redisAvailable, lockNxEx, unlock } from './redis';
import { getPositions, cancelAllOrders, closeAllPositions, countOpen, placeOrder, closePositionPct, setTpsl } from './binance';
import { alert } from './telegram';

// ── 부팅 즉시 출력 (파일이 로드되는 순간 찍힘 — Railway "빈 로그" 진단용) ──
console.log('🚀 TRAIGO Worker started');
console.log('📡 Connecting to Supabase...');
console.log('🔁 Polling jobs...');

const WORKER_ID = process.env.WORKER_ID || `worker-${Math.random().toString(36).slice(2, 8)}`;
const POLL_SEC = Math.max(1, Math.min(15, parseInt(process.env.WORKER_POLL_SEC || '3', 10)));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let errorCount = 0;
const prevPos: Record<string, Set<string>> = {};

// ── 액션 락 ──
// Redis가 있으면 SETNX, 없으면 worker_lock 테이블의 CAS를 쓴다.
//
// 예전에는 Redis가 없으면 그냥 true를 돌려줬다(no-op). "jobs의 atomic claim이
// 중복을 막는다"는 주석이 붙어 있었지만, 그 claim은 같은 잡 행을 두 워커가
// 동시에 가져가는 것만 막는다. 아래 stale 복구가 아직 실행 중인 잡을 PENDING
// 으로 되돌리면 다른 워커가 정당하게 claim해서 같은 주문을 또 낸다.
// Redis는 현재 배포에 설정돼 있지 않으므로, 이 경로가 실제로 쓰인다.
async function acquireActionLock(name: string, ttl: number): Promise<boolean> {
  if (redisAvailable()) return lockNxEx(name, WORKER_ID, ttl);
  return acquireLock(name, WORKER_ID, ttl);
}
async function releaseActionLock(name: string): Promise<void> {
  if (redisAvailable()) { await unlock(name); return; }
  await releaseLock(name, WORKER_ID);
}

async function getConnection(connId: string): Promise<any | null> {
  const { data } = await sb().from('exchange_connections').select('*').eq('id', connId).maybeSingle();
  return data || null;
}
function connCreds(conn: any): { key: string; secret: string; testnet: boolean } {
  return { key: conn.api_key || '', secret: decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''), testnet: conn.is_testnet === true };
}

// ── 거래소 실행 (action 분기) ────────────────────────────────────
async function runAction(job: any, conn: any): Promise<{ ok: boolean; result?: any; error?: string }> {
  const { key, secret, testnet } = connCreds(conn);
  if (!key || !secret) return { ok: false, error: 'API 키 복호화 실패' };
  const p = job.payload || {};
  const mode = testnet ? 'TESTNET' : 'LIVE';

  switch (job.action) {
    case 'PLACE_ORDER': {
      const r = await placeOrder(key, secret, testnet, { symbol: job.symbol, side: job.side, type: p.type || 'MARKET', quantity: Number(job.quantity), price: p.price, leverage: p.leverage, reduceOnly: !!p.reduceOnly });
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case 'CLOSE_POSITION': {
      const r = await closePositionPct(key, secret, testnet, job.symbol, job.side, Number(job.percent ?? 100));
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case 'CLOSE_ALL_POSITIONS': {
      const r = await closeAllPositions(key, secret, testnet, 5);
      return r.ok ? { ok: true, result: r } : { ok: false, error: `잔여 ${r.remaining}` };
    }
    case 'CANCEL_ALL_ORDERS': {
      const r = await cancelAllOrders(key, secret, testnet);
      return { ok: r.ok, result: r };
    }
    case 'SET_TPSL': {
      const r = await setTpsl(key, secret, testnet, job.symbol, job.side, p.tpPrice ?? null, p.slPrice ?? null);
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case 'REVERSE_POSITION': {
      const close = await closePositionPct(key, secret, testnet, job.symbol, job.side, 100);
      if (!close.ok) return { ok: false, error: `역방향 전 종료 실패: ${close.error}` };
      const newSide = job.side === 'LONG' ? 'SELL' : 'BUY';
      const open = await placeOrder(key, secret, testnet, { symbol: job.symbol, side: newSide, type: 'MARKET', quantity: Number(job.quantity), leverage: p.leverage });
      return open.ok ? { ok: true, result: { close, open } } : { ok: false, error: open.error };
    }
    case 'KILL_SWITCH_EXECUTE': {
      const actionMode = (p.actionMode || 'BC').toUpperCase();
      const wantClose = actionMode.includes('D');
      // 1) Cancel All (Close 선행)
      const c = await cancelAllOrders(key, secret, testnet);
      // 2) Close All (D)
      let close: any = null;
      if (wantClose) close = await closeAllPositions(key, secret, testnet, 5);
      // 3) Reconcile
      const rc = await countOpen(key, secret, testnet);
      const clean = (wantClose ? rc.positions === 0 : true) && rc.orders === 0;
      if (clean) {
        await alert('money', 'critical', 'Kill Switch 완료 (Worker)', { Mode: mode, Cancel: c.ok ? 'OK' : '일부실패', Close: wantClose ? (close?.ok ? 'OK' : `잔여 ${close?.remaining}`) : 'N/A' }, `ks_done:${job.connection_id}`);
        return { ok: true, result: { cancel: c, close, reconcile: rc } };
      }
      // 잔여 → 실패로 반환해 재시도 (포지션 0까지)
      await alert('money', 'critical', 'Kill Switch 잔여 — 거래소 직접 확인', { Mode: mode, Positions: rc.positions, Orders: rc.orders }, `ks_remain:${job.connection_id}`);
      return { ok: false, error: `잔여 포지션 ${rc.positions} · 주문 ${rc.orders}`, result: { cancel: c, close, reconcile: rc } } as any;
    }
    default:
      return { ok: false, error: `알 수 없는 action: ${job.action}` };
  }
}

// ── 잡 처리: stale 복구 → PENDING 조회 → 락 → claim → 실행 → finalize ──
async function processPendingJobs() {
  // ── stale 복구 ──
  //
  // PROCESSING인데 locked_until이 지난 잡을 PENDING으로 되돌린다. 그런데
  // "만료 = 워커가 죽음"이 아니다. 거래소 호출이 느려서 60초를 넘겼을 뿐인
  // 살아 있는 워커의 잡을 되돌리면, 다른 워커가 같은 주문을 또 낸다.
  //
  // 그래서 두 조건을 모두 요구한다:
  //   1) 만료 후 유예 시간(GRACE)까지 지났을 것
  //   2) 해당 잡을 쥔 워커의 heartbeat가 끊겼을 것
  // 살아 있는 워커의 잡은 아무리 느려도 회수하지 않는다.
  const STALE_GRACE_MS = 120_000;
  try {
    const cutoff = new Date(Date.now() - STALE_GRACE_MS).toISOString();
    const { data: stale } = await sb().from('jobs')
      .select('id, locked_by, locked_until')
      .eq('status', 'PROCESSING').lt('locked_until', cutoff).limit(20);

    if (Array.isArray(stale) && stale.length) {
      // 최근 살아 있는 워커 목록
      const aliveSince = new Date(Date.now() - 90_000).toISOString();
      const { data: beats } = await sb().from('worker_heartbeat')
        .select('worker_id, last_seen, status').gt('last_seen', aliveSince);
      const alive = new Set(
        (Array.isArray(beats) ? beats : [])
          .filter((b: any) => b.status !== 'stopped')
          .map((b: any) => String(b.worker_id)),
      );

      for (const j of stale as any[]) {
        if (j.locked_by && alive.has(String(j.locked_by))) {
          console.warn(`[jobs] ${String(j.id).slice(0, 8)} 만료됐지만 보유 워커 ${j.locked_by}가 살아 있어 회수하지 않음`);
          continue;
        }
        await sb().from('jobs')
          .update({ status: 'PENDING', locked_by: null, updated_at: new Date().toISOString() })
          .eq('id', j.id).eq('status', 'PROCESSING').eq('locked_by', j.locked_by);
        console.warn(`[jobs] ${String(j.id).slice(0, 8)} stale 회수 (보유 워커 ${j.locked_by || '?'} heartbeat 없음)`);
      }
    }
  } catch { /* 회수 실패는 다음 주기에 다시 시도한다 */ }

  const { data: jobs, error: qErr } = await sb().from('jobs').select('*').eq('status', 'PENDING')
    .order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(10);
  if (qErr) { console.error('[jobs] ❌ PENDING 조회 실패:', qErr.message, '— jobs 테이블/RLS/service_role 키 확인'); return; }
  console.log(`[jobs] pending count=${jobs?.length ?? 0}`);
  if (!jobs || jobs.length === 0) return;
  console.log(`[jobs] picked ${jobs[0].id.slice(0,8)} ${jobs[0].action} ${jobs[0].symbol || ''} status=${jobs[0].status}`);

  for (const job of jobs as any[]) {
    const actionLockKey = `lock:action:${job.exchange}:${job.connection_id}:${job.action}:${job.symbol || 'ALL'}`;
    const jobLockKey = `lock:job:${job.id}`;
    // 동일 포지션 동시 실행 방지 (CLOSE/CLOSE_ALL/REVERSE/KILL_SWITCH)
    const gotAction = await acquireActionLock(actionLockKey, 30);
    if (!gotAction) continue;
    const gotJob = await acquireActionLock(jobLockKey, 30);
    if (!gotJob) { await releaseActionLock(actionLockKey); continue; }

    try {
      // claim (race-safe): PENDING → PROCESSING 한 워커만 성공
      const { data: claimed } = await sb().from('jobs')
        .update({ status: 'PROCESSING', locked_by: WORKER_ID, locked_until: new Date(Date.now() + 60000).toISOString(), attempts: (job.attempts || 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('status', 'PENDING').select();
      if (!claimed || claimed.length === 0) continue;  // 다른 워커가 가져감
      console.log(`[worker] Processing job ${job.id.slice(0,8)} ${job.action} ${job.symbol || ''} (attempt ${(job.attempts||0)+1}/${job.max_attempts||5})`);

      const conn = await getConnection(job.connection_id);
      if (!conn) { await finalize(job, false, null, '연결 없음'); continue; }
      if (conn.has_withdrawal === true) { await finalize(job, false, null, '출금권한 키 거부'); continue; }

      const attempts = (job.attempts || 0) + 1;
      let res: { ok: boolean; result?: any; error?: string };
      try { res = await runAction(job, conn); }
      catch (e: any) { res = { ok: false, error: e?.message || '실행 예외' }; }

      if (res.ok) {
        await finalize(job, true, res.result, null);
      } else {
        const willRetry = attempts < (job.max_attempts || 5);
        if (willRetry) {
          await sb().from('jobs').update({ status: 'PENDING', error: res.error || '실패', result: res.result || null, locked_by: null, locked_until: new Date(Date.now() + 5000).toISOString(), updated_at: new Date().toISOString() }).eq('id', job.id);
        } else {
          await finalize(job, false, res.result, res.error || '최대 재시도 초과');
          if (job.mode === 'LIVE') await alert('system', 'warning', `Job 최종 실패: ${job.action}`, { Symbol: job.symbol || '-', Error: res.error || '?' }, `job_fail:${job.id}`);
        }
      }
    } finally {
      await releaseActionLock(jobLockKey);
      await releaseActionLock(actionLockKey);
    }
  }
}

async function finalize(job: any, ok: boolean, result: any, error: string | null) {
  await sb().from('jobs').update({
    status: ok ? 'COMPLETED' : 'FAILED', result: result || null, error,
    completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), locked_by: null,
  }).eq('id', job.id);
}

// ── 모니터: Ghost Sync(읽기) + 킬스위치 active면 job 보장 ──────────
async function monitorConnections() {
  const { data: conns } = await sb().from('exchange_connections').select('*').eq('exchange_id', 'binance');
  if (!conns) return;
  for (const conn of (conns as any[])) {
    if (conn.has_withdrawal === true) continue;
    const { key, secret, testnet } = connCreds(conn);
    if (!key || !secret) continue;
    const mode = testnet ? 'TESTNET' : 'LIVE';

    // Ghost Sync (읽기 전용)
    let positions: any[] = [];
    try { positions = await getPositions(key, secret, testnet); errorCount = Math.max(0, errorCount - 1); }
    catch (e: any) { errorCount++; if (errorCount >= 3) await alert('system', 'warning', 'Worker API 3회+ 실패', { Mode: mode, Error: e?.message || '?' }, `api_fail:${conn.id}`); continue; }
    const symset = new Set(positions.map((p: any) => p.symbol));
    const prev = prevPos[conn.id];
    if (prev) for (const s of prev) if (!symset.has(s)) await alert('system', 'warning', 'Ghost Sync: 포지션 거래소 미존재', { Symbol: s, Mode: mode }, `ghost:${conn.id}:${s}`);
    prevPos[conn.id] = symset;

    // 킬스위치 active면 KILL_SWITCH_EXECUTE job 보장 (Vercel이 못 만들었어도 자가복구)
    const { data: ks } = await sb().from('kill_switch_state').select('active, action_mode').eq('connection_id', conn.id).maybeSingle();
    if (ks && ks.active) {
      const { data: existing } = await sb().from('jobs').select('id')
        .eq('connection_id', conn.id).eq('action', 'KILL_SWITCH_EXECUTE').in('status', ['PENDING', 'PROCESSING']).limit(1);
      if (!existing || existing.length === 0) {
        await sb().from('jobs').insert({ user_id: conn.user_id, connection_id: conn.id, exchange: 'binance', mode, action: 'KILL_SWITCH_EXECUTE', payload: { actionMode: ks.action_mode || 'BC' }, status: 'PENDING', priority: 0, max_attempts: 10, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
    }
  }
}

let tickCount = 0;
async function tick() {
  tickCount++;
  if (tickCount === 1 || tickCount % 20 === 0) console.log(`[worker] tick #${tickCount} (errors=${errorCount})`);
  // ★ job 처리는 락과 무관하게 항상 실행 (PENDING→PROCESSING atomic claim이 중복 방지)
  await processPendingJobs();
  // 모니터(Ghost Sync/킬스위치 job 보장)는 main 락으로 중복 방지 — 락 인프라 없으면 단일 워커로 간주해 진행
  let isMain = true;
  try { isMain = await acquireLock('main', WORKER_ID, POLL_SEC * 4); } catch { isMain = true; }
  await heartbeat(WORKER_ID, errorCount > 5 ? 'degraded' : 'running', isMain ? 'jobs+monitor' : 'jobs(standby monitor)', errorCount);
  if (isMain) await monitorConnections();
  // 계단식 청산 감시(트레일링·본전이동·시간청산)는 이 워커가 하지 않는다.
  // Binance가 이 서버의 IP 지역을 차단해 주문이 나가지 않기 때문이다
  // (jobs 테이블에 "Service unavailable from a restricted location" 기록).
  // Vercel(regions: hnd1)의 /api/autotrade/exit-monitor가 담당한다.
  // 여기서 다시 켜면 같은 포지션에 손절 이동이 두 번 나갈 수 있다.
}

async function startupChecks() {
  console.log('════════════════════════════════════════');
  console.log('  🚀 TRAIGO Worker started');
  console.log(`  id=${WORKER_ID}  poll=${POLL_SEC}s  redis=${redisAvailable() ? 'ON(액션락 활성)' : 'OFF(액션락 생략·atomic claim으로 중복방지)'}`);
  console.log('════════════════════════════════════════');

  // 필수 env 검증 (값은 노출 안 함)
  const missing: string[] = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.EXCHANGE_ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY (또는 EXCHANGE_ENCRYPTION_KEY)');
  if (missing.length) {
    console.error('❌ 필수 환경변수 누락:', missing.join(', '));
    console.error('   Railway → Variables 에서 설정 후 재배포하세요.');
  }

  // Supabase 연결 확인 (jobs 테이블 조회)
  try {
    const { error } = await sb().from('jobs').select('id').limit(1);
    if (error) console.error('⚠️  Supabase 연결됨 but jobs 조회 실패:', error.message, '— jobs.sql 실행했는지 확인');
    else console.log('✅ Connected to Supabase (jobs 테이블 확인됨)');
  } catch (e: any) {
    console.error('❌ Supabase 연결 실패:', e?.message || e, '— SUPABASE_URL/SERVICE_ROLE_KEY 확인');
  }
}

async function main() {
  await startupChecks();
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig as any, async () => {
    if (stopping) return; stopping = true;
    console.log('[worker] 종료 신호 수신 — heartbeat stopped 기록 후 종료');
    try { await heartbeat(WORKER_ID, 'stopped', 'shutdown', errorCount); await releaseLock('main', WORKER_ID); } catch {}
    process.exit(0);
  });
  while (!stopping) {
    const t0 = Date.now();
    try { await tick(); }
    catch (e: any) { errorCount++; console.error('[worker] tick error', e?.message); try { await heartbeat(WORKER_ID, 'degraded', 'tick error', errorCount); } catch {} }
    await sleep(Math.max(500, POLL_SEC * 1000 - (Date.now() - t0)));
  }
}

main().catch((e) => { console.error('[worker] fatal', e); process.exit(1); });
