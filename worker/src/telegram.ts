// worker/src/telegram.ts — 단일 상주 프로세스라 in-memory 쿨다운 OK
const lastSent = new Map<string, number>();

function creds(channel: 'money' | 'system') {
  const tk = channel === 'money' ? process.env.TELEGRAM_MONEY_BOT_TOKEN : process.env.TELEGRAM_SYSTEM_BOT_TOKEN;
  const ch = channel === 'money' ? process.env.TELEGRAM_MONEY_CHAT_ID : process.env.TELEGRAM_SYSTEM_CHAT_ID;
  return { token: tk || process.env.TELEGRAM_BOT_TOKEN || '', chat: ch || process.env.TELEGRAM_CHAT_ID || '' };
}

// 발송 실패해도 절대 throw 안 함 (호출측 킬스위치 로직 보호)
export async function alert(
  channel: 'money' | 'system',
  severity: 'critical' | 'warning' | 'info',
  title: string,
  fields?: Record<string, string | number>,
  dedup?: string,
): Promise<{ ok: boolean; throttled?: boolean }> {
  try {
    if (severity === 'info') return { ok: true };
    const key = dedup || `${severity}:${channel}:${title}`;
    const cd = severity === 'critical' ? 180000 : 300000;
    const now = Date.now();
    if (lastSent.has(key) && now - (lastSent.get(key) as number) < cd) return { ok: false, throttled: true };
    lastSent.set(key, now);

    const { token, chat } = creds(channel);
    if (!token || !chat) return { ok: false };
    const icon = severity === 'critical' ? '🚨' : '⚠️';
    let text = `${icon} <b>TRAIGO ${severity === 'critical' ? 'EMERGENCY' : 'WARNING'}</b>\n\n<b>${title}</b>`;
    if (fields) for (const [k, v] of Object.entries(fields)) text += `\n${k}: ${v}`;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: r.ok };
  } catch { return { ok: false }; }
}
