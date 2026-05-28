'use client';
import { useEffect, useRef } from 'react';
import { listStrategies } from '@/lib/strategies/store';
import {
  loadLogs, saveLog, getLastEvaluatedAt, setLastEvaluatedAt,
  paperBuy, paperSell,
} from '@/lib/autotrade/store';
import { checkRiskGuard, autoDisableAllStrategies, recordTradePnL, recordTradeResult } from '@/lib/risk/guard';
import type { ExecutionLog } from '@/lib/autotrade/types';

// 폴링 간격 — 60초 (모든 활성 전략 한 바퀴 평가)
const POLL_INTERVAL_MS = 60_000;
// 같은 전략 재평가 쿨다운 — 5분 (시그널 후 즉시 재진입 방지)
const RE_EVAL_COOLDOWN_MS = 5 * 60_000;

/**
 * AutoTradeEngine — 활성화된 전략들을 폴링하면서 시그널 평가.
 * - paper 모드: 모의 체결 + 로그
 * - live 모드: 안내 로그만 (실제 주문은 거래소 연결 후)
 *
 * 페이지 최상위에 1번만 마운트.
 * 백그라운드 동작이라 UI 없음 (return null).
 */
export default function AutoTradeEngine() {
  const runningRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const tick = async () => {
      // 동시 실행 방지
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const strategies = listStrategies().filter(s => s.enabled);
        if (strategies.length === 0) return;

        // 🛡️ 리스크 가드 — 일일 한도/연속 손실/쿨다운 체크
        const guard = checkRiskGuard();
        if (!guard.pass) {
          // 한도 도달이면 전략 모두 비활성화
          if (guard.shouldDisable) {
            await autoDisableAllStrategies(guard.reason || '리스크 한도 도달');
            // 비활성화 로그
            saveLog({
              id:           `log-${Date.now()}-guard`,
              strategyId:   'risk-guard',
              strategyName: '🛡️ 리스크 가드',
              asset:        '-',
              timeframe:    '-' as any,
              action:       'buy',
              status:       'blocked',
              at:           Date.now(),
              mode:         'paper',
              conditionsAll:  0,
              conditionsPass: 0,
              conditionDetails: [],
              indicators:    {},
              reason:        `자동매매 전체 정지: ${guard.reason}`,
            });
          }
          // 쿨다운이면 그냥 이번 tick 스킵 (다음 tick에서 다시 시도)
          return;
        }

        for (const strat of strategies) {
          try {
            // 쿨다운 체크 — 너무 자주 평가 X
            const lastAt = getLastEvaluatedAt(strat.id);
            if (Date.now() - lastAt < 30_000) continue;  // 최소 30초 간격

            const r = await fetch('/api/autotrade/tick', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                asset:      strat.asset,
                market:     strat.market,
                timeframe:  strat.timeframe,
                conditions: strat.conditions,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            setLastEvaluatedAt(strat.id, Date.now());

            if (!r.ok) {
              const errJson = await r.json().catch(() => ({}));
              const log: ExecutionLog = {
                id:           `log-${Date.now()}-${strat.id.slice(-6)}`,
                strategyId:   strat.id,
                strategyName: strat.name,
                asset:        strat.asset,
                timeframe:    strat.timeframe,
                action:       strat.action,
                status:       'error',
                at:           Date.now(),
                mode:         strat.mode,
                conditionsAll:  strat.conditions.length,
                conditionsPass: 0,
                conditionDetails: [],
                indicators:    {},
                reason:        errJson.message || `평가 실패 (status ${r.status})`,
              };
              saveLog(log);
              continue;
            }

            const d = await r.json();
            const { snapshot, evaluation } = d;

            // 시그널 발생?
            if (!evaluation.allPass) {
              // skipped 로그는 너무 많이 쌓이지 않게 — 매 평가마다는 X, 
              // 조건이 1개라도 통과한 경우만 기록 (관찰용)
              if (evaluation.passCount > 0) {
                const log: ExecutionLog = {
                  id:           `log-${Date.now()}-${strat.id.slice(-6)}`,
                  strategyId:   strat.id,
                  strategyName: strat.name,
                  asset:        strat.asset,
                  timeframe:    strat.timeframe,
                  action:       strat.action,
                  status:       'skipped',
                  at:           Date.now(),
                  mode:         strat.mode,
                  conditionsAll:  evaluation.details.length,
                  conditionsPass: evaluation.passCount,
                  conditionDetails: evaluation.details,
                  indicators:    snapshot,
                  reason:        `조건 ${evaluation.passCount}/${evaluation.details.length} 통과`,
                };
                saveLog(log);
              }
              continue;
            }

            // 시그널 발생!
            // 쿨다운 재설정 (5분간 같은 전략 재평가 안 함)
            setLastEvaluatedAt(strat.id, Date.now() + RE_EVAL_COOLDOWN_MS);

            const price = snapshot.currentPrice;

            // ── live 모드: 실제 거래소 주문 ──────────────────────
            if (strat.mode === 'live') {
              // 안전: 거래소 연결 ID 없으면 차단
              if (!strat.connectionId) {
                saveLog({
                  id: `log-${Date.now()}-${strat.id.slice(-6)}`,
                  strategyId: strat.id, strategyName: strat.name,
                  asset: strat.asset, timeframe: strat.timeframe,
                  action: strat.action, status: 'blocked', at: Date.now(), mode: 'live',
                  conditionsAll: evaluation.details.length, conditionsPass: evaluation.passCount,
                  conditionDetails: evaluation.details, indicators: snapshot,
                  reason: '거래소 연결이 지정되지 않았습니다. 전략에 거래소를 연결하세요.',
                });
                continue;
              }

              const amt = strat.order.amount;
              // 심볼 정규화: 'BTC' → 'BTCUSDT'
              const tradeSymbol = strat.asset.toUpperCase().replace(/USDT$/, '') + 'USDT';

              try {
                // 인증 토큰
                let authHeader = '';
                try {
                  const { getSupabaseClient } = await import('@/lib/supabase/client');
                  const sbc = getSupabaseClient();
                  if (sbc) {
                    const { data } = await sbc.auth.getSession();
                    if (data?.session?.access_token) authHeader = `Bearer ${data.session.access_token}`;
                  }
                } catch {}

                const orderRes = await fetch('/api/exchange/order', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) },
                  body: JSON.stringify({
                    connectionId: strat.connectionId,
                    symbol:       tradeSymbol,
                    side:         strat.action === 'buy' ? 'BUY' : 'SELL',
                    type:         'MARKET',
                    amount:       strat.action === 'buy' ? amt / 1375 : undefined,  // KRW→USDT 근사
                    confirmToken: 'LIVE_ORDER_CONFIRMED',
                  }),
                });
                const od = await orderRes.json().catch(() => ({}));

                saveLog({
                  id: `log-${Date.now()}-${strat.id.slice(-6)}`,
                  strategyId: strat.id, strategyName: strat.name,
                  asset: strat.asset, timeframe: strat.timeframe,
                  action: strat.action,
                  status: orderRes.ok && od.ok ? 'triggered' : 'error',
                  at: Date.now(), mode: 'live',
                  conditionsAll: evaluation.details.length, conditionsPass: evaluation.passCount,
                  conditionDetails: evaluation.details, indicators: snapshot,
                  filledPrice: orderRes.ok && od.ok ? (od.price || price) : undefined,
                  filledAmount: orderRes.ok && od.ok ? amt : undefined,
                  filledQuantity: od.qty,
                  reason: orderRes.ok && od.ok
                    ? `실전 체결 (주문ID ${od.orderId})`
                    : `실전 주문 실패: ${od.message || od.error || '알 수 없음'}`,
                });

                if (typeof window !== 'undefined' && 'Notification' in window &&
                    Notification.permission === 'granted') {
                  try {
                    new Notification(`TRAIGO — 실전 ${strat.action === 'buy' ? '매수' : '매도'} ${orderRes.ok && od.ok ? '체결' : '실패'}`, {
                      body: `${strat.asset} (${strat.name})${od.message ? ' · ' + od.message : ''}`,
                      icon: '/icon-192.png',
                    });
                  } catch {}
                }
              } catch (e) {
                saveLog({
                  id: `log-${Date.now()}-${strat.id.slice(-6)}`,
                  strategyId: strat.id, strategyName: strat.name,
                  asset: strat.asset, timeframe: strat.timeframe,
                  action: strat.action, status: 'error', at: Date.now(), mode: 'live',
                  conditionsAll: evaluation.details.length, conditionsPass: evaluation.passCount,
                  conditionDetails: evaluation.details, indicators: snapshot,
                  reason: `실전 주문 오류: ${e instanceof Error ? e.message : '네트워크 오류'}`,
                });
              }
              continue;
            }

            // paper 모드 — 모의 체결
            const amount = strat.order.amount;
            const result = strat.action === 'buy'
              ? paperBuy(strat.asset, price, amount)
              : paperSell(strat.asset, price, amount);

            // 매도 체결 시 PnL을 일일/연속 카운터에 기록
            // (paperSell만 pnl 반환. paperBuy는 진입이라 pnl 없음)
            if (result.ok && strat.action === 'sell' && typeof (result as any).pnl === 'number') {
              const pnl = (result as any).pnl;
              recordTradePnL(pnl);
              recordTradeResult(pnl);
            }

            const log: ExecutionLog = {
              id:           `log-${Date.now()}-${strat.id.slice(-6)}`,
              strategyId:   strat.id,
              strategyName: strat.name,
              asset:        strat.asset,
              timeframe:    strat.timeframe,
              action:       strat.action,
              status:       result.ok ? 'triggered' : 'error',
              at:           Date.now(),
              mode:         'paper',
              conditionsAll:  evaluation.details.length,
              conditionsPass: evaluation.passCount,
              conditionDetails: evaluation.details,
              indicators:    snapshot,
              filledPrice:    result.ok ? price : undefined,
              filledAmount:   result.ok ? amount : undefined,
              filledQuantity: result.qty,
              reason:         result.ok
                ? (typeof (result as any).pnl === 'number'
                    ? `PnL ${(result as any).pnl >= 0 ? '+' : ''}${Math.floor((result as any).pnl).toLocaleString('ko-KR')}원`
                    : undefined)
                : result.reason,
            };
            saveLog(log);

            // Notification API (권한 있으면)
            if (typeof window !== 'undefined' &&
                'Notification' in window &&
                Notification.permission === 'granted' &&
                result.ok) {
              try {
                new Notification(`TRAIGO — ${strat.action === 'buy' ? '매수' : '매도'} 체결`, {
                  body: `${strat.asset} @ ${price.toLocaleString('ko-KR')} (${strat.name})`,
                  icon: '/icon-192.png',
                });
              } catch {}
            }
          } catch (e) {
            // 개별 전략 실패는 무시하고 다음
          }
        }
      } finally {
        runningRef.current = false;
      }
    };

    // 첫 실행 (10초 후 — 다른 초기화 끝난 뒤)
    const initTimer = setTimeout(tick, 10_000);
    // 이후 주기적
    intervalRef.current = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(initTimer);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return null;
}
