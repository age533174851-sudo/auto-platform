'use client';
import { useEffect, useRef } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { listStrategies } from '@/lib/strategies/store';
import {
  loadLogs, saveLog, getLastEvaluatedAt, setLastEvaluatedAt,
  paperBuy, paperSell, checkPaperExits, getOpenPositions,
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

        // 실시간 USD/KRW 환율 (실패 시 1375)
        let usdKrw = 1375;
        try {
          const fxr = await fetch('/api/fx');
          const fxd = await fxr.json();
          if (fxd?.rates?.USDKRW && fxd.rates.USDKRW > 500) usdKrw = fxd.rates.USDKRW;
        } catch {}

        // SL/TP 자동청산 감시 (paper 포지션)
        try {
          const openPos = getOpenPositions();
          if (openPos.length > 0) {
            // 보유 자산 현재가 조회
            const priceMap: Record<string, number> = {};
            for (const p of openPos) {
              try {
                const pr = await fetch(`/api/prices?action=coin&symbol=${encodeURIComponent(p.asset)}`);
                const pd = await pr.json();
                if (pd?.price && pd.price > 0) priceMap[p.asset] = pd.price;
              } catch {}
            }
            const exits = checkPaperExits(priceMap);
            for (const ex of exits) {
              recordTradePnL(ex.pnl);
              recordTradeResult(ex.pnl);
              saveLog({
                id: `log-${Date.now()}-exit-${ex.asset}`,
                strategyId: ex.stratId || 'auto-exit',
                strategyName: ex.reason === 'take_profit' ? '익절 자동청산' : '손절 자동청산',
                asset: ex.asset, timeframe: '-' as any, action: 'sell',
                status: 'triggered', at: Date.now(), mode: 'paper',
                conditionsAll: 1, conditionsPass: 1, conditionDetails: [],
                indicators: {} as any,
                filledPrice: ex.price, filledQuantity: ex.qty,
                reason: `${ex.reason === 'take_profit' ? '✅ 익절' : '🛑 손절'} 청산 · PnL ${ex.pnl >= 0 ? '+' : ''}${Math.floor(ex.pnl).toLocaleString('ko-KR')}원`,
              });
              if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
                try {
                  new Notification(`TRAIGO — ${ex.reason === 'take_profit' ? '익절' : '손절'} 자동청산`, {
                    body: `${ex.asset} @ ${ex.price.toLocaleString('ko-KR')} · PnL ${ex.pnl >= 0 ? '+' : ''}${Math.floor(ex.pnl).toLocaleString('ko-KR')}원`,
                    icon: '/icon-192.png',
                  });
                } catch {}
              }
            }
          }
        } catch {}

        // 리스크 가드 — 일일 한도/연속 손실/쿨다운 체크
        const guard = checkRiskGuard();
        if (!guard.pass) {
          // 한도 도달이면 전략 모두 비활성화
          if (guard.shouldDisable) {
            await autoDisableAllStrategies(guard.reason || '리스크 한도 도달');
            // 비활성화 로그
            saveLog({
              id:           `log-${Date.now()}-guard`,
              strategyId:   'risk-guard',
              strategyName: '리스크 가드',
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

            // 경제지표 회피 게이트 (CPI/FOMC/NFP)
            if (strat.avoidEconEvents) {
              try {
                const { checkEventWindow, parseCalendarEvents } = await import('@/lib/risk/eventGuard');
                const cr = await fetch('/api/calendar');
                const cd = await cr.json();
                // `data`와 `events` 둘 다 본다. 예전에는 `cd.events`만 봤는데
                // 라우트는 `data`만 줬다 — **항상 빈 배열**이었고, 그래서
                // 지표 회피가 켜져 있는데 한 번도 안 걸렸다.
                const rawEvents = (cd.data || cd.events || []).map((e: any) => ({
                  id: e.id, title: e.event || e.title, impact: e.impact,
                  date: e.date, time: e.time, at: e.dateTime ? new Date(e.dateTime).getTime() : undefined,
                }));
                const events = parseCalendarEvents(rawEvents);
                const guard = checkEventWindow(events, { beforeMin: 30, afterMin: 60, minImpact: 'high' });
                if (guard.blocked) {
                  saveLog({
                    id: `log-${Date.now()}-${strat.id.slice(-6)}`,
                    strategyId: strat.id, strategyName: strat.name,
                    asset: strat.asset, timeframe: strat.timeframe,
                    action: strat.action, status: 'blocked', at: Date.now(), mode: strat.mode,
                    conditionsAll: evaluation.details.length, conditionsPass: evaluation.passCount,
                    conditionDetails: evaluation.details, indicators: snapshot,
                    reason: `경제지표 회피: ${guard.reason}`,
                  });
                  continue;
                }
              } catch {}
            }

            // 시장상태(레짐) 게이트 — 나쁜 장에서 진입 차단
            if (strat.marketFilter && strat.marketFilter !== 'any' && snapshot.ema20 && snapshot.ema60 && price) {
              try {
                const { regimeAllowsEntry } = await import('@/lib/risk/regime');
                // 국면을 **손으로 만들지 않는다.**
                //
                // 예전에는 여기서 detectRegime의 계산식을 복사해 객체를 조립했다.
                // 그러면 판정이 두 벌이 되고, 한쪽만 고쳐진다 — 실제로
                // detectRegime에 '봉이 모자라면 판정하지 않는다'를 넣었을 때
                // 이 조립본은 그 검사를 통째로 비껴갔다. `allowEntry: true`가
                // 상수로 박혀 있었으므로 계산이 무엇이든 허용이었다.
                const ema20 = snapshot.ema20, ema60 = snapshot.ema60;
                const volPct = snapshot.atr && price ? (snapshot.atr / price) * 100 : 0;
                const gap = ((ema20 - ema60) / ema60) * 100;
                const pricePos = ((price - ema60) / ema60) * 100;
                const trendScore = Math.max(-100, Math.min(100, gap * 8 + pricePos * 2));
                const trend = trendScore > 12 ? 'uptrend' : trendScore < -12 ? 'downtrend' : 'sideways';
                const volatility = volPct >= 4 ? 'high_vol' : volPct < 1.2 ? 'low_vol' : 'normal_vol';
                // 이 화면은 봉 배열이 아니라 스냅샷(ema20/ema60/atr)을 갖고 있어
                // detectRegime을 그대로 부를 수 없다. 대신 그 값들이 **실제로
                // 계산된 것**임을 확인했을 때만 dataOk를 켠다 — 위 if 조건이
                // ema20·ema60·price가 모두 있음을 이미 보장한다.
                const regime = {
                  trend: trend as any, volatility: volatility as any,
                  label: '', trendScore, volPct, recommendation: '', allowEntry: true,
                  dataOk: Number.isFinite(ema20) && Number.isFinite(ema60) && Number.isFinite(price)
                          && ema60 !== 0,
                  bars: 0,
                  dataReason: '스냅샷 기반 판정 (봉 배열 없음)',
                };
                const gate = regimeAllowsEntry(regime, strat.action, strat.marketFilter);
                if (!gate.allowed) {
                  saveLog({
                    id: `log-${Date.now()}-${strat.id.slice(-6)}`,
                    strategyId: strat.id, strategyName: strat.name,
                    asset: strat.asset, timeframe: strat.timeframe,
                    action: strat.action, status: 'blocked', at: Date.now(), mode: strat.mode,
                    conditionsAll: evaluation.details.length, conditionsPass: evaluation.passCount,
                    conditionDetails: evaluation.details, indicators: snapshot,
                    reason: `시장상태 차단: ${gate.reason}`,
                  });
                  continue;
                }
              } catch {}
            }

            // ── live 모드: 실제 거래소 주문 ──────────────────────
            // ── 브라우저는 주문을 내지 않는다 ──
            //
            // **여기에 실주문 코드가 있었다.** 141줄이었고, 하는 일은
            // 이랬다: 60초 타이머가 전략을 평가하고, 조건이 맞으면
            // `/api/binance/futures/order`에 `LIVE_ORDER_CONFIRMED`를
            // 붙여 실제 주문을 냈다.
            //
            // 그 전략 목록은 전략빌더가 **localStorage**에 넣어 둔 것이다.
            // 그래서:
            //
            //   · 탭을 닫으면 **진입한 포지션을 아무도 청산하지 않는다**
            //   · 다른 기기에서는 그 전략이 존재하지도 않는다
            //   · 저장소를 지우면 열린 포지션의 주인이 사라진다
            //   · 워커가 지키는 관문(마이그레이션·청산감시·지문·소유권·
            //     킬스위치)을 **하나도 지나지 않는다**
            //
            // 즉 워커와 별개인 **두 번째 실행 권한**이었다. 실제 돈이
            // 들어가기 전에 없애야 하는 종류다.
            //
            // 관문으로 막는 대신 코드를 들어냈다. 관문은 되돌릴 수 있지만
            // 없는 코드는 되돌릴 수 없다 — 그리고 `scripts/check-browser-orders.mjs`가
            // 이 파일에 주문 호출이 다시 생기면 CI에서 실패시킨다.
            //
            // 실거래·테스트넷 자동매매는 **서버 예약**(autotrade_schedules)이
            // 유일한 경로다. 워커가 돌리고, 브라우저와 무관하게 청산·보호까지
            // 책임진다. 아래 모의(paper) 경로는 거래소에 닿지 않으므로 그대로 둔다.
            if (strat.mode === 'live') {
              saveLog({
                id: `log-${Date.now()}-${strat.id.slice(-6)}`,
                strategyId: strat.id, strategyName: strat.name,
                asset: strat.asset, timeframe: strat.timeframe,
                action: strat.action, status: 'blocked', at: Date.now(), mode: 'live',
                conditionsAll: evaluation.details.length, conditionsPass: evaluation.passCount,
                conditionDetails: evaluation.details, indicators: snapshot,
                reason: '브라우저는 자동 주문을 내지 않습니다 — 탭을 닫으면 진입한 포지션을 '
                  + '아무도 청산하지 않기 때문입니다. 자동 → 예약에서 서버 실행으로 등록하세요',
              });
              continue;
            }

            // paper 모드 — 모의 체결
            const amount = strat.order.amount;
            const result = strat.action === 'buy'
              ? paperBuy(strat.asset, price, amount, {
                  stopLossPct:   strat.risk?.stopLossPct,
                  takeProfitPct: strat.risk?.takeProfitPct,
                  stratId:       strat.id,
                })
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
