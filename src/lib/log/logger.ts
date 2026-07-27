// src/lib/log/logger.ts
// 중앙 로거 — 레벨(debug/info/warn/error/fatal) + 구조화 + 링버퍼 + fatal 에스컬레이션.
// 서버(API 라우트)와 클라이언트 양쪽에서 안전하게 동작.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;        // 발생 위치/모듈 (예: 'webhook', 'prices', 'auth')
  msg: string;
  ctx?: Record<string, any>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug', info: 'info', warn: 'warn', error: 'error', fatal: 'error',
};

// 환경별 최소 레벨 (prod는 info 이상만)
const MIN_LEVEL: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

const BUFFER_CAP = 300;
const buffer: LogEntry[] = [];
type Listener = (e: LogEntry) => void;
const listeners = new Set<Listener>();

function pushBuffer(e: LogEntry) {
  buffer.unshift(e);
  if (buffer.length > BUFFER_CAP) buffer.pop();
  listeners.forEach(l => { try { l(e); } catch {} });
}

function fmt(e: LogEntry): string {
  const t = new Date(e.ts).toISOString().slice(11, 23);
  const ctx = e.ctx && Object.keys(e.ctx).length ? ' ' + safeJson(e.ctx) : '';
  return `[${t}] ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}${ctx}`;
}

function safeJson(o: any): string {
  try { return JSON.stringify(o); } catch { return '[unserializable]'; }
}

// fatal은 텔레그램/영속화로 에스컬레이션 (서버 전용, best-effort)
async function escalate(e: LogEntry) {
  if (typeof window !== 'undefined') return;   // 클라이언트에선 스킵
  try {
    const { sendTelegram } = await import('@/lib/notify/telegram');
    await sendTelegram(`🔴 FATAL [${e.scope}] ${e.msg}\n${e.ctx ? safeJson(e.ctx) : ''}`);
  } catch {}
}

function write(level: LogLevel, scope: string, msg: string, ctx?: Record<string, any>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const entry: LogEntry = { ts: Date.now(), level, scope, msg, ctx };
  pushBuffer(entry);
  // 콘솔 출력 (구조화)
  try { (console[CONSOLE_METHOD[level]] as any)(fmt(entry)); } catch {}
  if (level === 'fatal') { void escalate(entry); }
}

export const log = {
  debug: (scope: string, msg: string, ctx?: Record<string, any>) => write('debug', scope, msg, ctx),
  info:  (scope: string, msg: string, ctx?: Record<string, any>) => write('info', scope, msg, ctx),
  warn:  (scope: string, msg: string, ctx?: Record<string, any>) => write('warn', scope, msg, ctx),
  error: (scope: string, msg: string, ctx?: Record<string, any>) => write('error', scope, msg, ctx),
  fatal: (scope: string, msg: string, ctx?: Record<string, any>) => write('fatal', scope, msg, ctx),
};

// 최근 로그 조회 (레벨 필터 옵션)
export function getRecentLogs(minLevel?: LogLevel, limit = 100): LogEntry[] {
  const min = minLevel ? LEVEL_ORDER[minLevel] : 0;
  return buffer.filter(e => LEVEL_ORDER[e.level] >= min).slice(0, limit);
}

export function subscribeLogs(cb: Listener): () => void { listeners.add(cb); return () => listeners.delete(cb); }

export function clearLogs() { buffer.length = 0; }
