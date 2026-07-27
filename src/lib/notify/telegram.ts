// src/lib/notify/telegram.ts — 텔레그램 봇 알림
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
export interface TgButton { text: string; callback_data?: string; url?: string }

export async function sendTelegram(text: string, opts?: { buttons?: TgButton[][] }): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return { ok: false, error: 'no_telegram_config' };
  try {
    const body: any = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (opts?.buttons?.length) body.reply_markup = { inline_keyboard: opts.buttons };
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return { ok: false, error: e?.description || `HTTP ${r.status}` }; }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'telegram_error' }; }
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://auto-platform-zeta.vercel.app';

// 매수 완료 카드 — 수익률 + [일시정지][전량청산][웹열기] 버튼
export function entryCard(p: { symbol: string; side: string; price: number; amount: number; leverage?: number; mode: string; pnlPct?: number; connectionId?: string }): { text: string; buttons: TgButton[][] } {
  const sideKr = /sell|short|숏/i.test(p.side) ? '매도' : '매수';
  const pnlLine = p.pnlPct != null ? `\n수익률: <b>${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%</b>` : '';
  const text =
    `🟢 <b>${sideKr} 완료</b> [${p.mode}]\n` +
    `━━━━━━━━━━━━━\n` +
    `종목: <b>${p.symbol}</b>${p.leverage ? ` · ${p.leverage}x` : ''}\n` +
    `체결가: ${p.price.toLocaleString()}\n` +
    `금액: ${p.amount.toLocaleString()}원${pnlLine}\n` +
    `━━━━━━━━━━━━━`;
  const cid = p.connectionId || '';
  const buttons: TgButton[][] = [[
    { text: '⏸ 일시정지', callback_data: `pause:${cid}` },
    { text: '🔴 전량청산', callback_data: `closeall:${cid}` },
  ], [
    { text: '🌐 웹 열기', url: `${APP_URL}/?tab=auto` },
  ]];
  return { text, buttons };
}

export function fmtEntry(p: { symbol: string; side: string; price: number; amount: number; leverage?: number; mode: string }) {
  return `🟢 <b>진입</b> [${p.mode}]\n${p.symbol} ${p.side}${p.leverage ? ` ${p.leverage}x` : ''}\n진입가: ${p.price.toLocaleString()}\n금액: ${p.amount.toLocaleString()}원`;
}
export function fmtExit(p: { symbol: string; reason: string; price: number; pnl: number }) {
  const emoji = p.pnl >= 0 ? '✅' : '🔴';
  const reasonKr = p.reason === 'take_profit' ? '익절' : p.reason === 'trailing_stop' ? '트레일링' : p.reason === 'stop_loss' ? '손절' : '청산';
  return `${emoji} <b>${reasonKr}</b>\n${p.symbol}\n청산가: ${p.price.toLocaleString()}\n손익: ${p.pnl >= 0 ? '+' : ''}${Math.round(p.pnl).toLocaleString()}원`;
}
export function fmtError(msg: string) { return `⚠️ <b>오류</b>\n${msg}`; }
export function fmtCircuit(reason: string) { return `🛑 <b>서킷브레이커</b>\n${reason}`; }
// 매매 결과 카드 — 익절/손절을 수익률·손익금·보유시간·누적과 함께 리치하게
export function exitCard(p: {
  symbol: string; reason: string; entryPrice?: number; exitPrice: number;
  pnl: number; pnlPct?: number; holdMin?: number; cumPnl?: number; mode?: string;
}): { text: string; buttons: TgButton[][] } {
  const win = p.pnl >= 0;
  const emoji = win ? '✅' : '🔻';
  const reasonKr = p.reason === 'take_profit' ? '익절' : p.reason === 'trailing_stop' ? '트레일링 스탑'
    : p.reason === 'stop_loss' ? '손절' : p.reason === 'manual' ? '수동 청산' : '청산';
  const bar = win ? '🟩🟩🟩' : '🟥🟥🟥';
  const lines = [
    `${emoji} <b>${reasonKr} 완료</b>${p.mode ? ` [${p.mode}]` : ''}`,
    `━━━━━━━━━━━━━`,
    `종목: <b>${p.symbol}</b>`,
  ];
  if (p.entryPrice) lines.push(`진입 → 청산: ${p.entryPrice.toLocaleString()} → ${p.exitPrice.toLocaleString()}`);
  else lines.push(`청산가: ${p.exitPrice.toLocaleString()}`);
  if (p.pnlPct != null) lines.push(`${bar}\n수익률: <b>${win ? '+' : ''}${p.pnlPct.toFixed(2)}%</b>`);
  lines.push(`손익: <b>${win ? '+' : ''}${Math.round(p.pnl).toLocaleString()}원</b>`);
  if (p.holdMin != null) lines.push(`보유: ${p.holdMin}분`);
  if (p.cumPnl != null) lines.push(`오늘 누적: ${p.cumPnl >= 0 ? '+' : ''}${Math.round(p.cumPnl).toLocaleString()}원`);
  lines.push(`━━━━━━━━━━━━━`);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://auto-platform-zeta.vercel.app';
  const buttons: TgButton[][] = [[
    { text: '📊 복기 보기', url: `${appUrl}/?tab=review` },
    { text: '🌐 웹 열기', url: `${appUrl}/?tab=auto` },
  ]];
  return { text: lines.join('\n'), buttons };
}


// ── 구조화 긴급 알림 (Redis 엔진에 위임 — 호환 래퍼) ──────────────
export type AlertLevel = 'critical' | 'warning' | 'info';
export interface TelegramAlert {
  level?: AlertLevel;
  severity?: AlertLevel;
  channel?: 'money' | 'system';
  title: string;
  eventType: string;
  message?: string;
  fields?: Record<string, string | number>;
  mode?: string;
  exchange?: string;
  symbol?: string;
  dedupKey?: string;
}

export async function sendTelegramAlert(a: TelegramAlert, sb?: any): Promise<{ ok: boolean; throttled?: boolean; error?: string }> {
  const { dispatchAlert } = await import('@/lib/notify/alerts');
  const res = await dispatchAlert({
    severity: (a.severity || a.level || 'warning'),
    channel: a.channel,
    eventType: a.eventType,
    title: a.title,
    message: a.message,
    fields: a.fields,
    mode: a.mode,
    exchange: a.exchange,
    symbol: a.symbol,
  }, sb);
  return { ok: res.ok, throttled: res.throttled, error: res.error };
}
