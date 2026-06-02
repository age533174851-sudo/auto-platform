// src/lib/notify/telegram.ts — 텔레그램 봇 알림
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
export async function sendTelegram(text: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return { ok: false, error: 'no_telegram_config' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return { ok: false, error: e?.description || `HTTP ${r.status}` }; }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'telegram_error' }; }
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
