// src/lib/jobs.ts — Vercel은 거래소 직접 호출 대신 jobs 큐에 적재만
export type JobAction =
  | 'CLOSE_POSITION' | 'CLOSE_ALL_POSITIONS' | 'CANCEL_ALL_ORDERS'
  | 'PLACE_ORDER' | 'SET_TPSL' | 'REVERSE_POSITION' | 'KILL_SWITCH_EXECUTE';

export interface EnqueueInput {
  userId: string;
  connectionId: string;
  action: JobAction;
  exchange?: string;
  mode?: string;            // TESTNET | LIVE
  symbol?: string;
  side?: string;
  quantity?: number;
  percent?: number;
  payload?: Record<string, any>;
  priority?: number;        // 낮을수록 우선 (킬스위치 0)
  maxAttempts?: number;
}

export async function enqueueJob(sb: any, j: EnqueueInput): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  try {
    const row = {
      user_id: j.userId,
      connection_id: j.connectionId,
      exchange: j.exchange || 'binance',
      mode: j.mode || null,
      action: j.action,
      symbol: j.symbol || null,
      side: j.side || null,
      quantity: j.quantity ?? null,
      percent: j.percent ?? null,
      payload: j.payload || {},
      status: 'PENDING',
      priority: j.priority ?? 5,
      attempts: 0,
      max_attempts: j.maxAttempts ?? 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await sb.from('jobs').insert(row).select('id').single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, jobId: data.id };
  } catch (e: any) { return { ok: false, error: e?.message || 'enqueue_failed' }; }
}
