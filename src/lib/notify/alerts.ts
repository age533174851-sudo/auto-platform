// src/lib/notify/alerts.ts
// Telegram 알림 엔진 — Upstash Redis 기반 쿨다운/중복방지/집계/격상 + Supabase 감사로그
// 듀얼봇: money(매매/PnL/킬스위치), system(인프라/API/Ghost)

import { redis, redisAvailable } from '@/lib/redis';

export type Severity = 'critical' | 'warning' | 'info';
export type Channel = 'money' | 'system';

export interface AlertInput {
  severity: Severity;
  eventType: string;                  // kill_switch, close_all, api_timeout, ghost_sync ...
  title: string;
  channel?: Channel;                  // 미지정 시 자동 라우팅
  exchange?: string;
  symbol?: string;
  message?: string;
  fields?: Record<string, string | number>;
  mode?: string;                      // TESTNET / LIVE
}

const CRIT_COOLDOWN = 180;            // 3분
const WARN_BUFFER   = 300;            // 5분 버퍼
const WARN_ESC_WINDOW = 3600;        // 1시간
const WARN_ESC_COUNT  = 10;           // 1h 10회 → critical 격상
const CRIT_ESC_AGE  = 10 * 60 * 1000; // 10분 지속 → 양쪽 봇

// money: 자금/포지션 관련. system: 인프라/연결.
function routeChannel(eventType: string): Channel {
  const moneyEv = ['kill_switch', 'close_all', 'cancel_all', 'fill', 'pnl', 'reconcile_fail', 'liquidation'];
  return moneyEv.some(e => eventType.includes(e)) ? 'money' : 'system';
}

function botCreds(channel: Channel): { token: string; chat: string } {
  const tk = channel === 'money' ? process.env.TELEGRAM_MONEY_BOT_TOKEN : process.env.TELEGRAM_SYSTEM_BOT_TOKEN;
  const ch = channel === 'money' ? process.env.TELEGRAM_MONEY_CHAT_ID : process.env.TELEGRAM_SYSTEM_CHAT_ID;
  // 레거시 단일봇으로 폴백
  return { token: tk || process.env.TELEGRAM_BOT_TOKEN || '', chat: ch || process.env.TELEGRAM_CHAT_ID || '' };
}

function fmt(a: AlertInput, extra?: string): string {
  const icon = a.severity === 'critical' ? '🚨' : a.severity === 'warning' ? '⚠️' : 'ℹ️';
  const head = a.severity === 'critical' ? 'TRAIGO EMERGENCY' : a.severity === 'warning' ? 'TRAIGO WARNING' : 'TRAIGO INFO';
  let s = `${icon} <b>${head}</b>\n\n<b>${a.title}</b>`;
  if (a.exchange) s += `\nExchange: ${a.exchange}`;
  if (a.mode)     s += `\nMode: ${a.mode}`;
  if (a.symbol)   s += `\nSymbol: ${a.symbol}`;
  if (a.message)  s += `\n${a.message}`;
  if (a.fields && Object.keys(a.fields).length) { s += '\n'; for (const [k, v] of Object.entries(a.fields)) s += `\n${k}: ${v}`; }
  if (extra) s += extra;
  return s;
}

async function rawSend(channel: Channel, text: string): Promise<{ ok: boolean; error?: string }> {
  const { token, chat } = botCreds(channel);
  if (!token || !chat) return { ok: false, error: `no_${channel}_bot_config` };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return { ok: false, error: e?.description || `HTTP ${r.status}` }; }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'telegram_error' }; }
}

async function logAlert(sb: any, row: any) {
  if (!sb) return;
  try { await sb.from('telegram_alert_log').insert({ created_at: new Date().toISOString(), ...row }); } catch {}
}

export interface AlertResult { ok: boolean; sent?: boolean; throttled?: boolean; buffered?: boolean; escalated?: boolean; count?: number; error?: string; redis?: boolean; }

// 메인 진입점. 발송 실패/Redis 없음에도 절대 throw하지 않음 (호출측 로직 보호).
export async function dispatchAlert(a: AlertInput, sb?: any): Promise<AlertResult> {
  const channel = a.channel || routeChannel(a.eventType);
  const dedup = `alert:${a.severity}:${(a.exchange || '-').toLowerCase()}:${a.eventType}:${a.symbol || 'ALL'}`;
  const base = { severity: a.severity, channel, event_type: a.eventType, exchange: a.exchange || null, symbol: a.symbol || null, dedup_key: dedup, message: a.title };

  // ── INFO: 실시간 발송 금지, 로그만 (daily summary용) ──
  if (a.severity === 'info') {
    await logAlert(sb, { ...base, sent: false, throttled: false, aggregated_count: 0, error: null });
    return { ok: true, sent: false, redis: redisAvailable() };
  }

  // ── WARNING: 5분 버퍼링 + 1h 10회 격상 ──
  if (a.severity === 'warning') {
    const escKey = `${dedup}:esc`;
    const escCount = (await redis.incr(escKey)) as number | null;
    if (escCount != null) await redis.expire(escKey, WARN_ESC_WINDOW);
    if (escCount != null && escCount >= WARN_ESC_COUNT) {
      // 격상 → critical로 즉시 발송 (양쪽 봇)
      const text = fmt({ ...a, severity: 'critical' }, `\n\n⏫ (1시간 내 ${escCount}회 — Critical 격상)`);
      const m = await rawSend('money', text); const sysr = await rawSend('system', text);
      await logAlert(sb, { ...base, severity: 'critical', sent: m.ok || sysr.ok, throttled: false, escalated: true, aggregated_count: escCount, error: m.ok ? null : m.error });
      await redis.del(escKey);
      return { ok: m.ok || sysr.ok, escalated: true, count: escCount, redis: redisAvailable() };
    }

    const bufKey = `${dedup}:buf`;
    const startKey = `${dedup}:bufstart`;
    await redis.rpush(bufKey, JSON.stringify({ t: Date.now(), title: a.title, fields: a.fields || {} }));
    await redis.expire(bufKey, WARN_BUFFER + 60);
    const started = await redis.get(startKey);
    if (!started) {
      await redis.setEx(startKey, String(Date.now()), WARN_BUFFER + 60);
      await logAlert(sb, { ...base, sent: false, throttled: true, aggregated_count: 1, error: null });
      return { ok: true, buffered: true, redis: redisAvailable() };
    }
    // 버퍼 5분 경과 → 묶어서 flush (도착 시점 flush; cron 없을 때의 현실적 방식)
    if (Date.now() - Number(started) >= WARN_BUFFER * 1000) {
      const items = (await redis.lrange(bufKey, 0, -1)) as string[] | null;
      const n = Array.isArray(items) ? items.length : 1;
      const text = fmt(a, `\n\n(지난 5분간 동일 유형 ${n}건 — 묶음 발송)`);
      const res = await rawSend(channel, text);
      await redis.del(bufKey); await redis.del(startKey);
      await logAlert(sb, { ...base, sent: res.ok, throttled: false, aggregated_count: n, error: res.ok ? null : res.error });
      return { ok: res.ok, sent: res.ok, count: n, redis: redisAvailable() };
    }
    await logAlert(sb, { ...base, sent: false, throttled: true, aggregated_count: 0, error: null });
    return { ok: true, buffered: true, redis: redisAvailable() };
  }

  // ── CRITICAL: 즉시 발송 + 3분 쿨다운 + 쿨다운 중 count 누적 + 만료 후 요약 ──
  const cooldownKey = dedup;
  const countKey = `${dedup}:count`;
  const firstKey = `${dedup}:first`;
  const set = await redis.setNxEx(cooldownKey, String(Date.now()), CRIT_COOLDOWN);

  // Redis 없으면 set===null → 쿨다운 못 걸지만 그래도 즉시 발송 (fail-open)
  if (set === 'OK' || set === null) {
    // 직전 쿨다운 동안 누적된 count 있으면 요약 첨부
    let extra = '';
    const pending = await redis.get(countKey);
    if (pending && Number(pending) > 0) { extra = `\n\n(지난 ${CRIT_COOLDOWN / 60}분간 동일 이벤트 ${pending}회 발생)`; await redis.del(countKey); }

    // 지속 격상: firstKey 없으면 기록, 있고 10분 경과면 system봇도 발송
    let escalated = false;
    const first = await redis.get(firstKey);
    if (!first) { await redis.setEx(firstKey, String(Date.now()), 1800); }
    else if (Date.now() - Number(first) >= CRIT_ESC_AGE) { escalated = true; }

    const res = await rawSend(channel, fmt(a, extra) + (escalated ? '\n\n⏫ 10분 이상 지속 — Emergency Stop 검토 필요' : ''));
    if (escalated) await rawSend('system', fmt(a, '\n\n⏫ Critical 10분+ 지속 (양쪽 봇 통지)'));
    await logAlert(sb, { ...base, sent: res.ok, throttled: false, escalated, aggregated_count: pending ? Number(pending) : 0, error: res.ok ? null : res.error });
    return { ok: res.ok, sent: res.ok, escalated, redis: redisAvailable() };
  }

  // 쿨다운 중 → count 누적, 발송 안 함
  const c = (await redis.incr(countKey)) as number | null;
  if (c != null) await redis.expire(countKey, CRIT_COOLDOWN + 60);
  await logAlert(sb, { ...base, sent: false, throttled: true, aggregated_count: c || 0, error: null });
  return { ok: false, throttled: true, count: c || 0, redis: redisAvailable() };
}
