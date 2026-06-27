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

// ── 통합 락: Redis SETNX 우선, 없으면 Supabase worker_lock 폴백 ──
async function acquireActionLock(name: string, ttl: number): Promise<boolean> {
  if (redisAvailable()) return lockNxEx(name, WORKER_ID, ttl);
  return acquireLock(name, WORKER_ID, ttl);
}
async function releaseActionLock(name: string): Promise<void> {
  if (redisAvailable()) await unlock(name); else await releaseLock(name, WORKER_ID);
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
  // stale 복구: PROCESSING인데 locked_until 지남 → PENDING
  try {
    await sb().from('jobs').update({ status: 'PENDING', locked_by: null, updated_at: new Date().toISOString() })
      .eq('status', 'PROCESSING').lt('locked_until', new Date().toISOString());
  } catch {}

  const { data: jobs } = await sb().from('jobs').select('*').eq('status', 'PENDING')
    .order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(10);
  if (!jobs || jobs.length === 0) return;

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
  const isMain = await acquireLock('main', WORKER_ID, POLL_SEC * 4);
  if (!isMain) { await heartbeat(WORKER_ID, 'standby', '다른 워커 활성 — 대기', errorCount); return; }
  await heartbeat(WORKER_ID, errorCount > 5 ? 'degraded' : 'running', 'jobs+monitor', errorCount);
  tickCount++;
  if (tickCount === 1 || tickCount % 20 === 0) console.log(`[worker] Polling jobs... (tick #${tickCount}, errors=${errorCount})`);
  await processPendingJobs();
  await monitorConnections();
}

async function startupChecks() {
  console.log('════════════════════════════════════════');
  console.log('  🚀 TRAIGO Worker started');
  console.log(`  id=${WORKER_ID}  poll=${POLL_SEC}s  redis=${redisAvailable() ? 'ON' : 'OFF(Supabase 락 폴백)'}`);
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
