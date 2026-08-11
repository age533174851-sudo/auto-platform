// worker/src/index.ts — TRAIGO 24h 워커
//
// 유일한 거래소 실행자: jobs 큐를 polling → 락 획득 → PROCESSING → 거래소 실행 → COMPLETED/FAILED
// + 모니터: Ghost Sync(읽기) / 킬스위치 active면 KILL_SWITCH_EXECUTE job 보장
//
// **거래소 로직은 여기 없다.**
// ────────────────────────────
// 예전에는 `./binance`를 직접 import해서 모든 job을 바이낸스 함수로 실행했다.
// 모니터도 `exchange_id = 'binance'`인 연결만 조회했다. 그래서 Gate 연결의
// job이 큐에 들어가면 **Gate 키를 들고 바이낸스에 서명 요청을 보냈다.**
//
// 지금은 웹(Vercel)이 쓰는 바로 그 모듈을 부른다
// (`src/lib/exchanges/futuresExec.ts` · `futuresAdapter.ts`). 거래소 코드를
// 두 벌로 두면 한쪽만 고쳐지고, 이 저장소에서 반복된 사고가 정확히 그
// 모양이었다 — **경로가 둘인데 한쪽만 고침.**
//
// 모르는 거래소는 UNSUPPORTED_EXCHANGE로 막는다. binance로 떨어뜨리지 않는다.
import { sb, acquireLock, releaseLock, heartbeat } from './supabase';
import { decryptSecret } from './crypto';
import { redisAvailable, lockNxEx, unlock } from './redis';
import { alert } from './telegram';

import {
  resolveExecExchange, jobExchangeCheck, futuresPlaceOrder, futuresSetTpsl,
  futuresClosePositionPct, futuresListPositions, futuresCountOpen,
  futuresFindOrderByClientId, unknownResultVerdict, reconcileDecision,
  UNSUPPORTED_EXCHANGE, EXCHANGE_MISMATCH, type ExecTarget,
} from '../../src/lib/exchanges/futuresExec';
import { futuresCancelAll, futuresCloseAll } from '../../src/lib/exchanges/futuresAdapter';
import { evaluateIfDue } from '../../src/lib/autotrade/evaluationRunner';
import { selectDueSchedules } from '../../src/lib/autotrade/schedulePoll';

// 이 워커가 실행할 수 있는 거래소. 모니터 조회도 이 목록을 쓴다 —
// 목록이 두 곳에 있으면 하나만 늘어난다.
const SUPPORTED_EXCHANGE_IDS = ['binance', 'gate', 'gateio', 'gate.io'];

// ── 자동매매 예약을 이 워커도 본다 ──
//
// **평가기를 새로 만들지 않는다.** 웹의 실행기가 쓰는 바로 그 함수를
// 부른다 — 판정·간격·선점·기록이 전부 거기 있다.
//
// 값은 어디에도 찍지 않는다. 있는지 없는지만 본다.
const APP_URL = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '');
const APP_ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// ── 부팅 즉시 출력 (파일이 로드되는 순간 찍힘 — Railway "빈 로그" 진단용) ──
console.log('🚀 TRAIGO Worker started');
console.log('📡 Connecting to Supabase...');
console.log('🔁 Polling jobs...');

// ── Worker id ──
//
// **호스트가 준 값을 먼저 쓴다.** 예전에는 WORKER_ID가 없으면 난수로
// 만들었는데, Fly에서는 그게 문제가 된다:
//
//   Machine 재시작 → 새 난수 id → 아래 stale 회수가 "이건 다른 워커가
//   쥔 잡인데 heartbeat가 끊겼다"로 읽는다 → 정당하게 회수한다 →
//   그런데 그 잡은 방금 재시작한 자신이 쥐고 있던 것이다
//
// Fly는 배포·스케일·호스트 이전마다 Machine을 갈아 끼우므로 이건 예외가
// 아니라 정상 경로다. FLY_MACHINE_ID는 같은 Machine이면 같은 값이라
// "재시작한 나"와 "다른 워커"를 구분할 수 있다.
//
// 난수 폴백은 남겨 둔다 — 로컬에서 돌릴 때 필요하다. 다만 호스트가 준
// 값이 있으면 그것이 언제나 먼저다.
const WORKER_ID =
  process.env.WORKER_ID
  || process.env.FLY_MACHINE_ID          // Fly
  || process.env.RAILWAY_REPLICA_ID      // Railway
  || process.env.CLOUD_RUN_EXECUTION     // Cloud Run
  || process.env.HOSTNAME                // 컨테이너 일반
  || `worker-local-${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * 이 잡의 멱등 키.
 *
 * **없으면 UNKNOWN에서 대조할 방법이 없다.** 예전 워커는 `placeOrder`에
 * clientOrderId 칸을 만들어 두고 index.ts에서 넘기지 않았다 — 만들어 놓고
 * 배선을 안 한 것이고, 그래서 중복 확인이 한 번도 돌지 않았다.
 *
 * 잡 id는 재시도해도 같다. 그게 정확히 필요한 성질이다.
 */
function idempotencyKey(job: any): string {
  const given = (job?.payload || {}).clientOrderId;
  if (given) return String(given);
  return `tg${String(job.id).replace(/-/g, '').slice(0, 20)}`;
}

// ── 거래소 실행 (action 분기) ────────────────────────────────────
//
// 거래소별 분기는 여기 없다. `ExecTarget` 하나를 만들어 공용 실행기에 넘긴다.
async function runAction(
  job: any, conn: any,
): Promise<{ ok: boolean; result?: any; error?: string; code?: string }> {
  // 1) 거래소 판정. **모르면 실행하지 않는다.**
  const match = jobExchangeCheck(job.exchange, conn.exchange_id);
  if (!match.ok) return { ok: false, error: match.message, code: match.code };
  const resolved = resolveExecExchange(conn.exchange_id);
  if (!resolved.exchange) {
    return { ok: false, error: resolved.message, code: UNSUPPORTED_EXCHANGE };
  }

  const { key, secret, testnet } = connCreds(conn);
  if (!key || !secret) return { ok: false, error: 'API 키 복호화 실패' };
  const t: ExecTarget = { exchange: resolved.exchange, key, secret, testnet };
  const p = job.payload || {};
  const mode = testnet ? 'TESTNET' : 'LIVE';

  switch (job.action) {
    case 'PLACE_ORDER': {
      const cid = idempotencyKey(job);
      // ── 보내기 전에 이미 나갔는지 본다 ──
      // 이 잡은 재시도될 수 있다. 앞선 시도가 응답만 못 받았을 수 있으므로,
      // 같은 clientOrderId가 거래소에 있으면 **다시 보내지 않는다.**
      if ((job.attempts || 0) > 0) {
        const look = await futuresFindOrderByClientId(t, job.symbol, cid);
        const d = reconcileDecision(look);
        if (d.action === 'ALREADY_PLACED') {
          return { ok: true, result: { reconciled: true, order: look.order, note: d.message } };
        }
        if (d.action === 'STILL_UNKNOWN') {
          return { ok: false, error: `${d.message} (${look.error || '사유 미상'})`, code: 'UNKNOWN' };
        }
      }
      const r = await futuresPlaceOrder(t, {
        symbol: job.symbol, side: job.side, type: (p.type || 'MARKET').toUpperCase(),
        quantity: Number(job.quantity), price: p.price ?? null,
        leverage: p.leverage ?? null, reduceOnly: !!p.reduceOnly, clientOrderId: cid,
      });
      return r.ok
        ? { ok: true, result: r }
        : { ok: false, error: r.error || '주문 실패', result: r, code: r.status };
    }
    case 'CLOSE_POSITION': {
      const r = await futuresClosePositionPct(t, job.symbol, Number(job.percent ?? 100));
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.message };
    }
    case 'CLOSE_ALL_POSITIONS': {
      const r = await futuresCloseAll(t.exchange, key, secret, testnet, 5);
      return r.success
        ? { ok: true, result: r }
        // remaining이 null이면 **못 읽은 것**이다. '잔여 0'으로 적지 않는다.
        : { ok: false, error: `잔여 ${r.remaining == null ? '확인 실패' : r.remaining}`, result: r };
    }
    case 'CANCEL_ALL_ORDERS': {
      const r = await futuresCancelAll(t.exchange, key, secret, testnet);
      return { ok: r.success, result: r, error: r.success ? undefined : r.message };
    }
    case 'SET_TPSL': {
      const r = await futuresSetTpsl(t, {
        symbol: job.symbol, positionSide: job.side,
        tpPrice: p.tpPrice ?? null, slPrice: p.slPrice ?? null,
        refPrice: p.refPrice ?? null, quantity: p.quantity ?? null,
        clientOrderId: idempotencyKey(job),
        // 손절 이동·본전 이동으로 같은 포지션에 여러 번 온다. 쌓이면
        // 포지션이 닫힌 뒤 남은 하나가 반대 포지션을 연다.
        replaceExisting: true,
      });
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.message, result: r };
    }
    case 'REVERSE_POSITION': {
      const close = await futuresClosePositionPct(t, job.symbol, 100);
      if (!close.ok) return { ok: false, error: `역방향 전 종료 실패: ${close.message}` };
      const newSide: 'BUY' | 'SELL' = job.side === 'LONG' ? 'SELL' : 'BUY';
      const open = await futuresPlaceOrder(t, {
        symbol: job.symbol, side: newSide, type: 'MARKET',
        quantity: Number(job.quantity), leverage: p.leverage ?? null,
        clientOrderId: `${idempotencyKey(job)}R`,
      });
      return open.ok
        ? { ok: true, result: { close, open } }
        : { ok: false, error: open.error || '역방향 진입 실패', result: { close, open }, code: open.status };
    }
    case 'KILL_SWITCH_EXECUTE': {
      const actionMode = (p.actionMode || 'BC').toUpperCase();
      const wantClose = actionMode.includes('D');
      // 1) Cancel All (Close 선행)
      const c = await futuresCancelAll(t.exchange, key, secret, testnet);
      // 2) Close All (D)
      let close: any = null;
      if (wantClose) close = await futuresCloseAll(t.exchange, key, secret, testnet, 5);
      // 3) Reconcile
      const rc = await futuresCountOpen(t);
      // **못 센 것은 0이 아니다.** null을 0으로 읽으면 잔여가 남은 채로
      // '킬스위치 완료'가 되고, 그게 정확히 이 기능이 막으려던 상황이다.
      const counted = rc.positions != null && rc.orders != null;
      const clean = counted && (wantClose ? rc.positions === 0 : true) && rc.orders === 0;
      if (clean) {
        await alert('money', 'critical', 'Kill Switch 완료 (Worker)', {
          Exchange: resolved.message, Mode: mode, Cancel: c.success ? 'OK' : '일부실패',
          Close: wantClose ? (close?.success ? 'OK' : `잔여 ${close?.remaining ?? '확인 실패'}`) : 'N/A',
        }, `ks_done:${job.connection_id}`);
        return { ok: true, result: { cancel: c, close, reconcile: rc } };
      }
      const remain = counted
        ? `잔여 포지션 ${rc.positions} · 주문 ${rc.orders}`
        : `잔여를 확인하지 못했습니다 (${rc.error || '조회 실패'}) — 거래소에서 직접 확인하세요`;
      await alert('money', 'critical', 'Kill Switch 잔여 — 거래소 직접 확인', {
        Exchange: resolved.message, Mode: mode,
        Positions: rc.positions ?? '확인 실패', Orders: rc.orders ?? '확인 실패',
      }, `ks_remain:${job.connection_id}`);
      return { ok: false, error: remain, result: { cancel: c, close, reconcile: rc } };
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

      // ── 만료된 주문은 실행하지 않는다 ──
      //
      // 이 워커는 멈춰 있던 적이 있다(Binance IP 지역 차단). 그동안 큐에 쌓인
      // 주문을 다시 켤 때 그대로 내보내면, 사용자가 몇 시간 전에 누르고 이미
      // 잊은 주문이 완전히 다른 시세에서 체결된다.
      //
      // 만료 시각은 적재하는 쪽이 payload.expiresAt에 새긴다
      // (src/lib/jobs/queueGuard.ts). 시각이 없는 주문 — 이 보호가 들어가기
      // 전에 쌓인 것 — 도 실행하지 않는다. 언제 만든 것인지 알 수 없는 주문을
      // 내보내는 쪽이 더 위험하다.
      //
      // 주문 계열에만 적용한다. 킬스위치·전량청산은 늦게라도 실행되는 것이
      // 맞다 — 위험을 줄이는 방향이다.
      if (job.action === 'PLACE_ORDER' || job.action === 'SET_TPSL') {
        const exp = (job.payload as any)?.expiresAt as string | undefined;
        const t = exp ? Date.parse(exp) : NaN;
        if (!Number.isFinite(t) || Date.now() > t) {
          const why = !exp
            ? '만료 시각이 없는 주문입니다. 언제 만들어진 것인지 알 수 없어 실행하지 않습니다.'
            : `${Math.round((Date.now() - t) / 1000)}초 지난 주문입니다. 그때 시세가 아니므로 실행하지 않습니다.`;
          await finalize(job, false, null, why);
          await alert('system', 'warning', '만료된 주문을 건너뜀',
            { Symbol: job.symbol || '-', Action: job.action, 사유: why }, `job_expired:${job.id}`);
          continue;
        }
      }

      const conn = await getConnection(job.connection_id);
      if (!conn) { await finalize(job, false, null, '연결 없음'); continue; }
      if (conn.has_withdrawal === true) { await finalize(job, false, null, '출금권한 키 거부'); continue; }

      const attempts = (job.attempts || 0) + 1;
      let res: { ok: boolean; result?: any; error?: string; code?: string };
      try { res = await runAction(job, conn); }
      catch (e: any) { res = { ok: false, error: e?.message || '실행 예외' }; }

      if (res.ok) {
        await finalize(job, true, res.result, null);
      } else {
        // ── 거래소가 안 맞으면 재시도해도 영원히 안 맞는다 ──
        // 다섯 번 더 시도해서 다섯 번 더 실패할 이유가 없고, 그 사이 로그는
        // 진짜 문제를 덮는다. 한 번에 끝내고 사람이 보게 한다.
        if (res.code === UNSUPPORTED_EXCHANGE || res.code === EXCHANGE_MISMATCH) {
          await finalize(job, false, res.result, res.error || res.code);
          await alert('system', 'critical', '거래소를 실행할 수 없어 잡을 종료했습니다',
            { Symbol: job.symbol || '-', Action: job.action, 사유: res.error || res.code || '?' },
            `job_exchange:${job.id}`);
          continue;
        }

        // ── UNKNOWN은 재시도하지 않는다 ──
        // "거래소가 받았는지 모르는" 상태다. 다시 보내면 중복 체결이 된다.
        // 조회로 확정한 뒤에만 다음 판단을 할 수 있으므로 여기서 멈춘다.
        //
        // 판정은 웹과 같은 함수를 쓴다(`unknownResultVerdict`). 예전에는 이
        // 정규식이 워커 안에만 있었고, 웹 경로에는 없었다.
        const unknown = res.code === 'UNKNOWN'
          || unknownResultVerdict(res.error).unknown;
        if (unknown) {
          await finalize(job, false, res.result,
            `응답을 받지 못해 결과를 확정할 수 없습니다(UNKNOWN). 중복 체결을 막기 위해 재시도하지 않습니다 — ` +
            `/api/orders/reconcile로 거래소와 대조하세요: ${res.error}`);
          await alert('system', 'warning', `주문 결과 미확정 (재시도 안 함)`,
            { Symbol: job.symbol || '-', Action: job.action, Error: res.error || '?' }, `job_unknown:${job.id}`);
          continue;
        }

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
//
// **`exchange_id = 'binance'`만 보지 않는다.**
// 예전에는 그랬다. 그래서 Gate 연결은 Ghost Sync도 안 돌고, 킬스위치가
// active여도 워커가 job을 만들어 주지 않았다 — 웹이 job 만드는 데 실패하면
// 아무도 안 만든다. **자가복구가 있다고 믿는 쪽이 없는 것보다 나쁘다.**
async function monitorConnections() {
  const { data: conns } = await sb().from('exchange_connections')
    .select('*').in('exchange_id', SUPPORTED_EXCHANGE_IDS);
  if (!conns) return;
  for (const conn of (conns as any[])) {
    if (conn.has_withdrawal === true) continue;

    const resolved = resolveExecExchange(conn.exchange_id);
    if (!resolved.exchange) continue;   // 여기 오면 안 되지만, 오면 건드리지 않는다

    const { key, secret, testnet } = connCreds(conn);
    if (!key || !secret) continue;
    const mode = testnet ? 'TESTNET' : 'LIVE';
    const t: ExecTarget = { exchange: resolved.exchange, key, secret, testnet };

    // Ghost Sync (읽기 전용)
    const pr = await futuresListPositions(t);
    if (!pr.ok) {
      // **조회 실패를 '포지션 없음'으로 읽지 않는다.** 그러면 열린 포지션
      // 전부에 대해 "거래소에서 사라졌다" 경고가 나간다.
      errorCount++;
      if (errorCount >= 3) {
        await alert('system', 'warning', 'Worker API 3회+ 실패',
          { Exchange: resolved.message, Mode: mode, Error: pr.error || '?' }, `api_fail:${conn.id}`);
      }
      continue;
    }
    errorCount = Math.max(0, errorCount - 1);
    const symset = new Set(pr.positions.map(p => p.symbol));
    const prev = prevPos[conn.id];
    if (prev) for (const s of prev) if (!symset.has(s)) {
      await alert('system', 'warning', 'Ghost Sync: 포지션 거래소 미존재',
        { Symbol: s, Exchange: resolved.message, Mode: mode }, `ghost:${conn.id}:${s}`);
    }
    prevPos[conn.id] = symset;

    // 킬스위치 active면 KILL_SWITCH_EXECUTE job 보장 (Vercel이 못 만들었어도 자가복구)
    const { data: ks } = await sb().from('kill_switch_state').select('active, action_mode').eq('connection_id', conn.id).maybeSingle();
    if (ks && ks.active) {
      const { data: existing } = await sb().from('jobs').select('id')
        .eq('connection_id', conn.id).eq('action', 'KILL_SWITCH_EXECUTE').in('status', ['PENDING', 'PROCESSING']).limit(1);
      if (!existing || existing.length === 0) {
        await sb().from('jobs').insert({
          user_id: conn.user_id, connection_id: conn.id,
          // **연결의 거래소를 그대로 적는다.** 예전에는 'binance'가 박혀
          // 있었다. Gate 연결에 그 잡이 붙으면 jobExchangeCheck가 막는다 —
          // 즉 킬스위치가 영원히 실행되지 않는다.
          exchange: String(conn.exchange_id),
          mode, action: 'KILL_SWITCH_EXECUTE',
          payload: { actionMode: ks.action_mode || 'BC' },
          status: 'PENDING', priority: 0, max_attempts: 10,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
    }
  }
}

// ── 예약 평가 (TESTNET 전용) ─────────────────────────
//
// 왜 워커가 이걸 하는가
// ─────────────────────
// 지금까지 평가를 깨우는 것은 GitHub Actions(cron */15) 하나뿐이었다.
// 그런데 **실제 실행이 40~80분씩 밀린 기록이 있다.** 원본 전략의 판단
// 창은 09:10~09:30이고 유예를 더해도 10:00까지라, 한 번 크게 밀리면
// 그날이 통째로 사라진다.
//
// 이 워커는 이미 몇 초마다 깨어난다. 예약도 같이 보면 스케줄러 지연에
// 기대지 않아도 된다. GitHub 쪽은 **예비로 남긴다** — 둘 중 하나가
// 죽어도 평가는 돈다.
//
// 두 개가 보는데 왜 두 번 안 들어가는가
// ────────────────────────────────────
// `evaluateIfDue`가 평가 직전에 `last_run_at`을 compare-and-set으로
// 선점한다. 먼저 가져간 쪽만 평가한다 — 그 판정은 웹과 같은 함수다.
let pollWarned = false;
async function pollSchedules(): Promise<void> {
  if (!APP_URL || !APP_ADMIN_SECRET) {
    // **한 번만 크게 말한다.** 매 tick 찍으면 로그가 덮여서 안 읽힌다.
    if (!pollWarned) {
      pollWarned = true;
      const missing = [!APP_URL ? 'APP_URL' : '', !APP_ADMIN_SECRET ? 'ADMIN_SECRET' : '']
        .filter(Boolean).join(', ');
      console.warn(`[schedules] 예약 평가를 건너뜁니다 — 없는 환경변수: ${missing}`);
      console.warn('[schedules] 이 상태에서는 GitHub autotrade-tick만 평가합니다 '
        + '— 스케줄이 밀리면 판단 창을 놓칠 수 있습니다.');
    }
    return;
  }

  const nowMs = Date.now();
  let rows: any[] = [];
  try {
    const { data, error } = await sb().from('autotrade_schedules')
      .select('*').eq('enabled', true).limit(100);
    if (error) throw new Error(error.message);
    rows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    // **'못 읽었다'를 '없다'로 읽지 않는다.** 조용히 넘기면 예약이 하나도
    // 없는 것과 구분이 안 된다.
    console.error('[schedules] 예약을 읽지 못했습니다:', e?.message || e);
    return;
  }

  const sel = selectDueSchedules(rows as any, nowMs);
  if (sel.due.length === 0) {
    // 건너뛴 이유는 가끔만 남긴다 — 매 tick 찍으면 로그가 덮인다.
    if (tickCount % 100 === 1 && sel.skipped.length > 0) {
      console.log(`[schedules] due 0건 · 건너뜀 ${sel.skipped.length}건 `
        + sel.skipped.slice(0, 3).map(x => `${x.symbol}:${x.code}`).join(' '));
    }
    return;
  }

  for (const { row, verdict } of sel.due) {
    try {
      console.log(`[schedules] ${row.symbol} 평가 시작 — ${verdict.code}`);
      const r = await evaluateIfDue(sb(), row as any, {
        origin: APP_URL, adminSecret: APP_ADMIN_SECRET, timeoutMs: 60_000,
      }, nowMs);
      if (r.record) {
        console.log(`[schedules] ${row.symbol} ${r.record.outcome} — ${r.record.summary}`);
      } else {
        // 선점을 놓쳤거나 그 사이 차례가 아니게 됐다. 오류가 아니다.
        console.log(`[schedules] ${row.symbol} 건너뜀 — ${r.due.reason}`);
      }
      if (r.saveError) console.warn(`[schedules] ${row.symbol} 기록 경고: ${r.saveError}`);
    } catch (e: any) {
      console.error(`[schedules] ${row.symbol} 평가 실패:`, e?.message || e);
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
  // 예약 평가도 main 락을 쥔 워커만 한다. 여러 워커가 동시에 보면 선점
  // 경쟁만 늘어난다 — 선점은 마지막 방어선이지 첫 방어선이 아니다.
  if (isMain) await pollSchedules();
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

  // ── 필수 env 검증 — 없으면 **종료한다** ──
  //
  // 값은 절대 출력하지 않는다. 이름만 적는다.
  //
  // 예전에는 누락을 console.error로 적고 **그대로 계속 돌았다.** 그러면:
  //   · Supabase 키가 없으니 jobs 조회가 매 초 실패한다
  //   · 암호화 키가 없으니 모든 주문이 'API 키 복호화 실패'로 끝난다
  //   · heartbeat는 계속 찍히므로 **화면에는 워커가 살아 있다고 뜬다**
  //
  // 마지막 줄이 문제다. 죽은 워커는 알아채지만, "돌고 있는데 아무것도 안
  // 하는" 워커는 아무도 모른다. Fly는 restart=always라 종료하면 재시작하고,
  // 크래시 루프는 로그에 그대로 남는다 — 그게 훨씬 잘 보인다.
  const missing: string[] = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.EXCHANGE_ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY) missing.push('EXCHANGE_ENCRYPTION_KEY (또는 ENCRYPTION_KEY)');
  if (missing.length) {
    console.error('❌ 필수 환경변수 누락:', missing.join(', '));
    console.error('   이 값들이 없으면 잡을 읽을 수도, 거래소 키를 복호화할 수도 없습니다.');
    console.error('   돌기만 하고 아무것도 못 하는 상태를 만들지 않기 위해 종료합니다.');
    console.error('   Fly: flyctl secrets set <NAME>=<VALUE> (값은 Secrets로만 넣습니다)');
    process.exit(1);
  }

  // 암호화 키 지문(6자리)만 찍는다. **값은 절대 찍지 않는다.**
  // Vercel과 같은 키인지 눈으로 대조하는 용도다 — 다르면 저장된 API secret을
  // 복호화할 수 없고, 그 증상은 '키가 틀렸다'로 보인다.
  try {
    const { createHash } = await import('crypto');
    const raw = String(process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '');
    console.log(`  🔑 암호화 키 지문: ${createHash('sha256').update(raw).digest('hex').slice(0, 6)}`
      + ' (Vercel의 EXCHANGE_ENCRYPTION_KEY 지문과 같아야 합니다)');
  } catch { /* 지문을 못 만들어도 워커는 돈다 */ }

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
