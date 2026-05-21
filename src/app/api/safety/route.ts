// /api/safety — Safety layer: audit, kill switch, pre-order, health
import { NextRequest, NextResponse } from 'next/server';
import {
  validatePreOrder, logAudit, getAuditLog,
  activateKillSwitch, deactivateKillSwitch, getKillSwitchState,
  checkApiKeyHealth, recordLoss, recordTradeResult,
  getDailyLoss, getConsecutiveLoss, setCooldown,
  sendNotificationWithFallback,
} from '@/lib/safety';
import type { PreOrderInput } from '@/lib/safety/types';

// ── Simple admin check (add proper auth in production) ────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'traigo-admin-dev';
function isAdmin(req: NextRequest): boolean {
  return req.headers.get('x-admin-secret') === ADMIN_SECRET;
}
function userId(req: NextRequest): string {
  return req.headers.get('x-user-id') || 'anon';
}

// ─────────────────────────────────────────────────────────────
// GET — read-only queries
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'status';
  const uid    = userId(req);

  // ── Kill switch status ────────────────────────────────────
  if (action === 'status') {
    const ks = getKillSwitchState();
    return NextResponse.json({
      killSwitch:       ks,
      dailyLossKRW:     getDailyLoss(uid),
      consecutiveLoss:  getConsecutiveLoss(uid),
      timestamp:        new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── Audit log ─────────────────────────────────────────────
  if (action === 'audit') {
    const limit  = Math.min(100, parseInt(searchParams.get('limit') || '50'));
    const target = isAdmin(req) ? (searchParams.get('userId') || uid) : uid;
    const events = getAuditLog(target, limit);
    return NextResponse.json({ events, count: events.length });
  }

  // ── API key health ────────────────────────────────────────
  if (action === 'health') {
    const exchange   = searchParams.get('exchange') || '';
    const apiKey     = searchParams.get('apiKey')   || '';
    const secret     = searchParams.get('secret')   || '';
    const passphrase = searchParams.get('pass')     || undefined;
    if (!exchange || !apiKey || !secret) {
      return NextResponse.json({ error: 'exchange, apiKey, secret required' }, { status: 400 });
    }
    const result = await checkApiKeyHealth(exchange, apiKey, secret, passphrase);
    logAudit({ userId: uid, action: 'API_KEY_HEALTH_CHECK', resource: exchange, detail: { healthy: result.healthy, latencyMs: result.latencyMs }, result: result.healthy ? 'success' : 'error' });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ─────────────────────────────────────────────────────────────
// POST — write actions
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;
  const uid = userId(req);

  // ── Pre-order validation ──────────────────────────────────
  if (action === 'validate-order') {
    const input: PreOrderInput = {
      userId:      uid,
      connectionId:body.connectionId || '',
      exchange:    body.exchange || '',
      symbol:      body.symbol || '',
      side:        body.side || 'buy',
      quantity:    parseFloat(body.quantity || '0'),
      price:       parseFloat(body.price || '0'),
      leverage:    parseFloat(body.leverage || '1'),
      stopLoss:    body.stopLoss ? parseFloat(body.stopLoss) : undefined,
      takeProfit:  body.takeProfit ? parseFloat(body.takeProfit) : undefined,
      mode:        body.mode || 'paper',
      webhookId:   body.webhookId,
      strategyId:  body.strategyId,
    };

    const limits = body.limits || undefined;
    const result = await validatePreOrder(input, limits);

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // ── Record trade result (for consecutive loss tracking) ───
  if (action === 'record-result') {
    const { isWin, lossAmount } = body;
    recordTradeResult(uid, !!isWin);
    if (!isWin && lossAmount > 0) recordLoss(uid, parseFloat(lossAmount));
    logAudit({ userId: uid, action: 'TRADE_RESULT', resource: body.symbol || '?', detail: { isWin, lossAmount }, result: 'success' });
    return NextResponse.json({ ok: true });
  }

  // ── Kill switch (admin only) ──────────────────────────────
  if (action === 'kill-switch-on') {
    if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    const { reason } = body;
    if (!reason) return NextResponse.json({ error: 'reason required' }, { status: 400 });
    activateKillSwitch(reason, uid);
    return NextResponse.json({ ok: true, state: getKillSwitchState() });
  }

  if (action === 'kill-switch-off') {
    if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    deactivateKillSwitch(uid);
    return NextResponse.json({ ok: true, state: getKillSwitchState() });
  }

  // ── Manual cooldown (user or admin) ──────────────────────
  if (action === 'set-cooldown') {
    const minutes = parseInt(body.minutes || '60');
    const target  = isAdmin(req) ? (body.userId || uid) : uid;
    setCooldown(target, Math.min(minutes, 1440)); // max 24h
    logAudit({ userId: uid, action: 'MANUAL_COOLDOWN', resource: target, detail: { minutes }, result: 'success' });
    return NextResponse.json({ ok: true, minutes });
  }

  // ── Log audit event (client-side events) ─────────────────
  if (action === 'audit-log') {
    const event = logAudit({
      userId:   uid,
      action:   body.eventAction || 'CLIENT_EVENT',
      resource: body.resource || '',
      detail:   body.detail   || {},
      result:   body.result   || 'success',
    });
    return NextResponse.json({ ok: true, id: event.id });
  }

  // ── Notification with fallback ────────────────────────────
  if (action === 'notify') {
    const { title, message, severity, channels } = body;
    if (!title || !message) return NextResponse.json({ error: 'title, message required' }, { status: 400 });

    await sendNotificationWithFallback({
      userId: uid, title, message,
      severity: severity || 'info',
      channels: channels || ['app'],
    });

    // Telegram fallback
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat  = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChat && (channels?.includes('telegram') || severity === 'critical')) {
      try {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: tgChat,
            text: `🔔 [TRAIGO ${severity?.toUpperCase()}]\n${title}\n\n${message}`,
            parse_mode: 'HTML',
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        console.error('[TRAIGO] Telegram notification failed:', e);
      }
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
