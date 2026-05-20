// ─────────────────────────────────────────────────────────────
// TRAIGO Safety Engine
// Pre-order validation, duplicate prevention, audit logging
// ─────────────────────────────────────────────────────────────
import type {
  PreOrderInput, PreOrderResult, SafetyCheckResult,
  RiskLimits, AuditEvent, KillSwitchState,
} from './types';
import { DEFAULT_RISK_LIMITS } from './types';
import { calcTradePnL } from '../pnl';
import { getDefaultConfig, calcFeeAmount } from '../fees';
import { getDefaultFundingRate } from '../funding';
import type { ExchangeId } from '../exchanges/types';

// ─────────────────────────────────────────────────────────────
// In-memory stores (Supabase for persistence in production)
// ─────────────────────────────────────────────────────────────

// Idempotency: track processed webhook IDs (24h TTL)
const processedWebhooks = new Map<string, number>(); // id → timestamp

// Daily loss tracker per user
const dailyLoss = new Map<string, { loss: number; date: string }>();

// Consecutive loss tracker per user
const consecutiveLoss = new Map<string, { count: number; lastAt: string }>();

// Cooldown tracker per user
const cooldowns = new Map<string, number>(); // userId → cooldown-until timestamp

// Global kill switch
let globalKillSwitch: KillSwitchState = {
  active: false, reason: '', activatedBy: '', activatedAt: '',
};

// Audit log (in-memory, last 1000 events)
const auditLog: AuditEvent[] = [];

// ─────────────────────────────────────────────────────────────
// Audit Logging
// ─────────────────────────────────────────────────────────────
export function logAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>) {
  const entry: AuditEvent = {
    ...event,
    id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
  };
  auditLog.unshift(entry);
  if (auditLog.length > 1000) auditLog.pop();
  console.log(`[TRAIGO Audit] ${entry.action} | user=${entry.userId} | result=${entry.result} | ${JSON.stringify(entry.detail).slice(0, 120)}`);
  return entry;
}

export function getAuditLog(userId?: string, limit = 50): AuditEvent[] {
  const filtered = userId ? auditLog.filter(e => e.userId === userId) : auditLog;
  return filtered.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// Global Kill Switch (Admin only)
// ─────────────────────────────────────────────────────────────
export function activateKillSwitch(reason: string, adminId: string): void {
  globalKillSwitch = {
    active: true, reason,
    activatedBy: adminId,
    activatedAt: new Date().toISOString(),
  };
  logAudit({ userId: adminId, action: 'GLOBAL_KILL_SWITCH_ON', resource: 'system', detail: { reason }, result: 'success' });
  console.error(`[TRAIGO EMERGENCY] Global kill switch ACTIVATED by ${adminId}: ${reason}`);
}

export function deactivateKillSwitch(adminId: string): void {
  const prev = { ...globalKillSwitch };
  globalKillSwitch = { active: false, reason: '', activatedBy: '', activatedAt: '' };
  logAudit({ userId: adminId, action: 'GLOBAL_KILL_SWITCH_OFF', resource: 'system', detail: { prevReason: prev.reason }, result: 'success' });
}

export function getKillSwitchState(): KillSwitchState {
  return { ...globalKillSwitch };
}

// ─────────────────────────────────────────────────────────────
// Idempotency — Duplicate Webhook Prevention
// ─────────────────────────────────────────────────────────────
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function isDuplicateWebhook(webhookId: string): boolean {
  const now = Date.now();
  // Clean expired
  for (const [id, ts] of processedWebhooks.entries()) {
    if (now - ts > DEDUP_TTL_MS) processedWebhooks.delete(id);
  }
  if (processedWebhooks.has(webhookId)) return true;
  processedWebhooks.set(webhookId, now);
  return false;
}

// ─────────────────────────────────────────────────────────────
// Daily Loss Tracking
// ─────────────────────────────────────────────────────────────
export function recordLoss(userId: string, lossAmount: number, currency: 'KRW' | 'USD' = 'KRW'): void {
  const today = new Date().toISOString().slice(0, 10);
  const cur   = dailyLoss.get(userId);
  if (!cur || cur.date !== today) {
    dailyLoss.set(userId, { loss: lossAmount, date: today });
  } else {
    cur.loss += lossAmount;
  }
}

export function getDailyLoss(userId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const cur   = dailyLoss.get(userId);
  return (cur?.date === today) ? cur.loss : 0;
}

export function resetDailyLoss(userId: string): void {
  dailyLoss.delete(userId);
}

// ─────────────────────────────────────────────────────────────
// Consecutive Loss Tracking
// ─────────────────────────────────────────────────────────────
export function recordTradeResult(userId: string, isWin: boolean): void {
  if (isWin) {
    consecutiveLoss.set(userId, { count: 0, lastAt: new Date().toISOString() });
  } else {
    const cur = consecutiveLoss.get(userId) || { count: 0, lastAt: '' };
    consecutiveLoss.set(userId, { count: cur.count + 1, lastAt: new Date().toISOString() });
  }
}

export function getConsecutiveLoss(userId: string): number {
  return consecutiveLoss.get(userId)?.count ?? 0;
}

export function setCooldown(userId: string, minutes: number): void {
  cooldowns.set(userId, Date.now() + minutes * 60_000);
}

export function isInCooldown(userId: string): boolean {
  const until = cooldowns.get(userId);
  return until ? Date.now() < until : false;
}

export function getCooldownRemaining(userId: string): number {
  const until = cooldowns.get(userId) ?? 0;
  return Math.max(0, Math.round((until - Date.now()) / 60_000));
}

// ─────────────────────────────────────────────────────────────
// Liquidation Price Calculator
// ─────────────────────────────────────────────────────────────
export function calcLiquidationPrice(
  entryPrice: number,
  leverage:   number,
  side:       'buy' | 'sell',
  mmr:        number = 0.005,   // maintenance margin rate (0.5%)
): number {
  // Simplified formula: liq = entry × (1 ± (1 - mmr) / leverage)
  if (leverage <= 1) return 0;
  const factor = (1 - mmr) / leverage;
  return side === 'buy'
    ? entryPrice * (1 - factor)
    : entryPrice * (1 + factor);
}

// ─────────────────────────────────────────────────────────────
// PRE-ORDER VALIDATION (Main Safety Gate)
// ─────────────────────────────────────────────────────────────
export async function validatePreOrder(
  input:  PreOrderInput,
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
): Promise<PreOrderResult> {
  const checks:   SafetyCheckResult[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  let allowed = true;

  // ── 1. Global kill switch ────────────────────────────────
  if (globalKillSwitch.active) {
    checks.push({ pass: false, code: 'GLOBAL_KILL_SWITCH', message: `긴급 정지 활성화됨: ${globalKillSwitch.reason}`, severity: 'block' });
    blockers.push('전체 긴급 정지 상태 — 관리자에게 문의');
    allowed = false;
  } else {
    checks.push({ pass: true, code: 'GLOBAL_KILL_SWITCH', message: '긴급 정지 없음', severity: 'info' });
  }

  // ── 2. Paper mode guard ──────────────────────────────────
  if (input.mode === 'paper') {
    checks.push({ pass: true, code: 'PAPER_MODE', message: '모의투자 모드 — 실제 주문 없음', severity: 'info' });
  } else {
    checks.push({ pass: true, code: 'REAL_MODE', message: '실거래 모드 활성화됨', severity: 'warn' });
    warnings.push('⚠️ 실거래 모드: 실제 자산이 사용됩니다');
  }

  // ── 3. Duplicate webhook ─────────────────────────────────
  if (input.webhookId) {
    const isDup = isDuplicateWebhook(input.webhookId);
    if (isDup) {
      checks.push({ pass: false, code: 'DUPLICATE_WEBHOOK', message: `중복 웹훅 차단: ${input.webhookId}`, severity: 'block' });
      blockers.push('중복 웹훅 신호 — 이미 처리됨');
      allowed = false;
    } else {
      checks.push({ pass: true, code: 'DUPLICATE_WEBHOOK', message: '웹훅 ID 유효', severity: 'info' });
    }
  }

  // ── 4. Cooldown check ────────────────────────────────────
  if (isInCooldown(input.userId)) {
    const mins = getCooldownRemaining(input.userId);
    checks.push({ pass: false, code: 'COOLDOWN_ACTIVE', message: `쿨다운 중 (${mins}분 남음)`, severity: 'block' });
    blockers.push(`연속 손실 후 쿨다운 중 — ${mins}분 후 재개`);
    allowed = false;
  } else {
    checks.push({ pass: true, code: 'COOLDOWN_ACTIVE', message: '쿨다운 없음', severity: 'info' });
  }

  // ── 5. Daily loss limit ──────────────────────────────────
  const todayLoss = getDailyLoss(input.userId);
  const maxLoss   = limits.maxDailyLossKRW;
  if (todayLoss >= maxLoss) {
    checks.push({ pass: false, code: 'DAILY_LOSS_EXCEEDED', message: `일일 손실 한도 초과: ₩${todayLoss.toLocaleString()}`, severity: 'block' });
    blockers.push(`일일 손실 한도(₩${maxLoss.toLocaleString()}) 초과 — 오늘 거래 중단`);
    allowed = false;
  } else {
    const ratio = todayLoss / maxLoss;
    if (ratio > 0.7) warnings.push(`⚠️ 일일 손실 ${Math.round(ratio * 100)}% 소진 (₩${todayLoss.toLocaleString()} / ₩${maxLoss.toLocaleString()})`);
    checks.push({ pass: true, code: 'DAILY_LOSS_EXCEEDED', message: `일일 손실 한도 내 (${Math.round(ratio * 100)}%)`, severity: ratio > 0.7 ? 'warn' : 'info' });
  }

  // ── 6. Consecutive loss ──────────────────────────────────
  const consLoss = getConsecutiveLoss(input.userId);
  if (consLoss >= limits.maxConsecutiveLoss) {
    checks.push({ pass: false, code: 'CONSECUTIVE_LOSS', message: `연속 손실 ${consLoss}회 — 자동 정지`, severity: 'block' });
    blockers.push(`연속 손실 ${consLoss}회 달성 — 쿨다운 ${limits.cooldownMinutes}분`);
    setCooldown(input.userId, limits.cooldownMinutes);
    allowed = false;
  } else {
    if (consLoss > 0) warnings.push(`⚠️ 연속 손실 ${consLoss}/${limits.maxConsecutiveLoss}회`);
    checks.push({ pass: true, code: 'CONSECUTIVE_LOSS', message: `연속 손실 ${consLoss}/${limits.maxConsecutiveLoss}`, severity: consLoss > 0 ? 'warn' : 'info' });
  }

  // ── 7. Leverage check ────────────────────────────────────
  if (input.leverage > limits.maxLeverage) {
    checks.push({ pass: false, code: 'LEVERAGE_EXCEEDED', message: `레버리지 ${input.leverage}x > 최대 ${limits.maxLeverage}x`, severity: 'block' });
    blockers.push(`레버리지 한도 초과: ${input.leverage}x (최대: ${limits.maxLeverage}x)`);
    allowed = false;
  } else {
    if (input.leverage > limits.maxLeverage * 0.7) warnings.push(`⚠️ 고레버리지 사용: ${input.leverage}x`);
    checks.push({ pass: true, code: 'LEVERAGE_EXCEEDED', message: `레버리지 ${input.leverage}x`, severity: input.leverage > 5 ? 'warn' : 'info' });
  }

  // ── 8. Position size check ───────────────────────────────
  const posSize = input.quantity * input.price;
  if (posSize > limits.maxPositionSizeKRW) {
    checks.push({ pass: false, code: 'POSITION_SIZE', message: `포지션 크기 초과: ₩${posSize.toLocaleString()}`, severity: 'block' });
    blockers.push(`최대 포지션 크기 초과: ₩${posSize.toLocaleString()} > ₩${limits.maxPositionSizeKRW.toLocaleString()}`);
    allowed = false;
  } else {
    checks.push({ pass: true, code: 'POSITION_SIZE', message: `포지션 크기 OK`, severity: 'info' });
  }

  // ── 9. Stop loss required for high leverage ───────────────
  if (input.leverage >= 5 && !input.stopLoss) {
    checks.push({ pass: false, code: 'NO_STOP_LOSS', message: '레버리지 5x 이상 시 손절가 필수', severity: 'block' });
    blockers.push('고레버리지 사용 시 손절가 설정 필수');
    allowed = false;
  } else {
    checks.push({ pass: true, code: 'NO_STOP_LOSS', message: '손절 조건 OK', severity: 'info' });
  }

  // ── 10. Fee/slippage/funding estimates ───────────────────
  const feeConfig = getDefaultConfig(input.exchange as ExchangeId, 'futures');
  const entryVal  = posSize;
  const fee       = calcFeeAmount(entryVal, feeConfig, 'taker') * 2; // round trip
  const slip      = entryVal * 0.0003; // conservative slippage estimate
  const funding   = input.leverage > 1 ? getDefaultFundingRate(input.symbol).rate * entryVal * 3 : 0; // 24h

  // ── 11. Liquidation price ────────────────────────────────
  const liquidationPx = calcLiquidationPrice(input.price, input.leverage, input.side);
  const maxLoss = (entryVal / input.leverage); // max loss = margin

  if (input.stopLoss) {
    const stopDist = Math.abs(input.price - input.stopLoss) / input.price;
    if (stopDist < 0.002) {
      checks.push({ pass: false, code: 'STOP_TOO_TIGHT', message: '손절가가 진입가에 너무 가까움 (< 0.2%)', severity: 'warn' });
      warnings.push('손절가 거리 너무 좁음 — 변동성에 의해 즉시 청산될 수 있습니다');
    } else {
      checks.push({ pass: true, code: 'STOP_TOO_TIGHT', message: `손절 거리 OK (${(stopDist*100).toFixed(2)}%)`, severity: 'info' });
    }
  }

  // ── 12. Real mode requires double confirm ────────────────
  const requiresConfirm = input.mode === 'real';

  // Log audit
  logAudit({
    userId: input.userId,
    action: 'PRE_ORDER_CHECK',
    resource: input.symbol,
    detail: {
      exchange: input.exchange, side: input.side, qty: input.quantity,
      price: input.price, leverage: input.leverage, mode: input.mode,
      allowed, blockerCount: blockers.length,
    },
    result: allowed ? 'success' : 'blocked',
  });

  return {
    allowed,
    checks,
    warnings,
    blockers,
    estimatedFee:    Math.round(fee),
    estimatedSlip:   Math.round(slip),
    estimatedFund:   Math.round(funding),
    liquidationPx:   liquidationPx > 0 ? Math.round(liquidationPx) : undefined,
    maxLoss:         Math.round(maxLoss),
    requiresConfirm,
  };
}

// ─────────────────────────────────────────────────────────────
// API Key Health Check
// ─────────────────────────────────────────────────────────────
export async function checkApiKeyHealth(
  exchange: string,
  apiKey: string,
  secret: string,
  passphrase?: string,
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const { testExchange } = await import('../exchanges/router');
    const result = await testExchange(exchange as any, apiKey, secret, passphrase);
    return {
      healthy:   result.success,
      latencyMs: result.latencyMs ?? 0,
      error:     result.success ? undefined : result.message,
    };
  } catch (e: any) {
    return { healthy: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Notification Fallback (stub — real impl in API route)
// ─────────────────────────────────────────────────────────────
export interface NotificationPayload {
  userId:   string;
  title:    string;
  message:  string;
  severity: 'info' | 'warn' | 'critical';
  channels: ('app' | 'telegram' | 'email')[];
}

export async function sendNotificationWithFallback(payload: NotificationPayload): Promise<void> {
  // Primary: in-app (always log)
  console.log(`[TRAIGO Notify] [${payload.severity}] ${payload.title}: ${payload.message}`);
  logAudit({
    userId: payload.userId, action: 'NOTIFICATION_SENT', resource: 'notify',
    detail: { title: payload.title, severity: payload.severity, channels: payload.channels },
    result: 'success',
  });
  // Telegram/email: implemented in /api/safety/notify route
}
