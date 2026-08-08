#!/usr/bin/env node
// worker/main.mjs
//
// **브라우저를 닫아도 도는 실행기.** Fly에서 24시간 켜져 있는 프로세스다.
//
// 이 파일은 껍데기다
// ──────────────────
// 판정은 `src/lib/runtime/workerPlan.ts`가 한다 — 그 파일은 Fly를 모르고
// 순수 함수만 있다. 여기서 하는 일은 그 판정을 부르고, DB를 읽고 쓰고,
// 시그널을 받는 것뿐이다.
//
// 그래서 나중에 Railway나 Cloud Run으로 옮길 때 **이 파일만 바꾸면 된다.**
// 규칙은 안 바뀌므로 "재시작 후 중복 주문 없음"을 다시 증명하지 않아도 된다.
//
// 지금 하는 일
// ────────────
// 심장박동만 찍는다. 실제 판단·주문은 아직 안 붙였다.
//
// 왜: 붙이기 전에 열 가지가 실제로 검증돼야 한다 — 배포되는가, 심장박동이
// DB에 들어가는가, UI가 HEALTHY로 보는가, 임대를 잡는가, 브라우저를 닫아도
// 계속되는가, 재시작하면 복구되는가, 두 Worker를 동시에 띄워도 주문이 한 번만
// 나가는가. **그걸 확인하기 전에 주문 경로를 붙이면 무엇이 깨졌는지 모르는
// 채로 실주문이 나간다.**

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 심장박동 주기. `workerPlan`의 HEARTBEAT_EVERY_MS와 같아야 한다 —
// 여기서 따로 정하면 두 값이 갈린다.
const HEARTBEAT_EVERY_MS = 10_000;

/**
 * 이 Worker의 이름.
 *
 * **호스트가 준 값을 그대로 쓴다.** 여기서 만들어 내면 재시작할 때마다
 * 달라져서, 같은 Machine이 이어받는 것인지 새 Machine인지 구분할 수 없다.
 * 못 받으면 시작하지 않는다 — id 없이 임대를 잡으면 겹쳐 돌 수 있다.
 */
function workerId() {
  for (const v of [
    process.env.FLY_MACHINE_ID,
    process.env.RAILWAY_REPLICA_ID,
    process.env.CLOUD_RUN_EXECUTION,
    process.env.HOSTNAME,
    process.env.WORKER_ID,
  ]) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return null;
}

/** Supabase REST 한 번 부르기 */
async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ── 종료 ──────────────────────────────────────────────────
//
// **SIGTERM을 받으면 새 일을 시작하지 않는다.** 받은 뒤에 주문을 내면
// 그 주문의 결과를 아무도 확인하지 못한 채 프로세스가 사라지고, 그 주문은
// UNKNOWN으로 남는다. 다음 Worker는 체결됐는지 모른 채 시작한다.
//
// Fly는 배포·스케일·호스트 이전 때 SIGTERM을 보낸다. 즉 이건 예외가
// 아니라 정상 경로다.
let shuttingDown = false;
let inflight = 0;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} 받음 — 새 일을 받지 않습니다 (진행 중 ${inflight}개)`);

  // 진행 중인 것을 기다린다. 임대 만료(30초)보다 짧게 잡는다 —
  // 넘기면 Fly가 강제 종료하고, 그러면 기다린 의미가 없다.
  const deadline = Date.now() + 25_000;
  while (inflight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (inflight > 0) {
    console.error(`[worker] 진행 중 ${inflight}개를 마치지 못하고 종료합니다 — 대조가 필요합니다`);
  }

  // **임대를 놓는다.** 안 놓으면 다음 Worker가 만료를 기다려야 하고,
  // 배포할 때마다 30초씩 아무것도 안 돈다.
  try {
    const id = workerId();
    if (id && SUPABASE_URL && SERVICE_KEY) {
      await sb(`runtime_leases?owner_worker_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      console.log('[worker] 임대를 놓았습니다');
    }
  } catch (e) {
    console.error('[worker] 임대를 놓지 못했습니다:', e.message);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── 심장박동 ──────────────────────────────────────────────
//
// UI는 이 값을 보고 "실행기 정상"을 판정한다. 이 값이 없으면 UI는
// **RUNNING이라고 적지 않는다** — 켜짐과 돌고 있음은 다른 사실이다.
async function beat(id) {
  await sb('worker_heartbeats', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      worker_id: id,
      host: process.env.FLY_REGION ? `fly:${process.env.FLY_REGION}` : 'unknown',
      beat_at: new Date().toISOString(),
      // 지금 무엇을 하고 있는지. 껍데기만 있는 동안은 이렇게 정직하게 적는다.
      status: 'IDLE_NO_JOBS_WIRED',
      note: '심장박동만 구현됨 — 판단·주문은 아직 붙지 않았습니다',
    }]),
  });
}

async function main() {
  const id = workerId();

  // **id가 없으면 시작하지 않는다.** 지어내면 재시작마다 달라지고,
  // 그러면 임대 주인이 계속 바뀌어 두 Worker가 겹쳐 돌 수 있다.
  if (!id) {
    console.error('[worker] Worker id를 받지 못했습니다 (FLY_MACHINE_ID/HOSTNAME/WORKER_ID)');
    console.error('[worker] id 없이 임대를 잡으면 겹쳐 돌 수 있어 시작하지 않습니다');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[worker] SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다');
    console.error('[worker] fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...');
    process.exit(1);
  }

  console.log(`[worker] 시작 — id=${id} region=${process.env.FLY_REGION || '?'}`);
  console.log('[worker] 지금은 심장박동만 찍습니다. 판단·주문은 관문 통과 후에 붙입니다');

  while (!shuttingDown) {
    inflight++;
    try {
      await beat(id);
      console.log(`[worker] 심장박동 ${new Date().toISOString()}`);
    } catch (e) {
      // **죽지 않는다.** 한 번 실패했다고 프로세스가 끝나면 Fly가
      // 재시작하고, 그 사이 아무것도 안 돈다. 다음 주기에 다시 시도한다.
      console.error('[worker] 심장박동 실패:', e.message);
    } finally {
      inflight--;
    }
    // 종료 신호를 받았으면 더 기다리지 않는다.
    for (let i = 0; i < HEARTBEAT_EVERY_MS / 200 && !shuttingDown; i++) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

main().catch(e => {
  console.error('[worker] 치명적 오류:', e);
  process.exit(1);
});
