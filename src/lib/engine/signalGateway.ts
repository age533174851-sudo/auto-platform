// src/lib/engine/signalGateway.ts
// Signal Gateway — 파인스크립트/전략엔진이 보내는 표준 신호를 수신·검증.
// 핵심: 신호는 "무엇을 할지"만 담고, 주문 금액·레버리지는 담지 않는다(백엔드가 결정).
// 흐름: 신호 수신 → 스키마 검증 → 위험 계산 → 충돌 조정 → 주문 실행.

export interface StandardSignal {
  strategyId: string;       // "btc-scalping-01"
  symbol: string;           // "BTCUSDT"
  signal: 'LONG' | 'SHORT' | 'CLOSE';
  confidence: number;       // 0~1
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number;
  timeframe: string;        // "5m"
  timestamp: number;
  // 전략군 (위험 프로파일 결정)
  bucket?: StrategyBucket;
}

export type StrategyBucket = 'scalping' | 'daytrading' | 'swing' | 'position' | 'longterm' | 'grid' | 'arbitrage' | 'hedge';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  signal?: StandardSignal;
}

// 전략군별 권장 거래당 위험 (계좌 대비 %) — 문서 표 반영
export const BUCKET_RISK: Record<StrategyBucket, { min: number; max: number; label: string }> = {
  scalping:   { min: 0.1, max: 0.3, label: '초단타' },
  daytrading: { min: 0.3, max: 0.7, label: '단타' },
  swing:      { min: 0.5, max: 1.0, label: '스윙' },
  position:   { min: 0.5, max: 1.5, label: '포지션' },
  longterm:   { min: 0.5, max: 1.5, label: '장기투자' },
  grid:       { min: 0.2, max: 0.5, label: '그리드' },
  arbitrage:  { min: 0.1, max: 0.3, label: '차익거래' },
  hedge:      { min: 0.2, max: 0.5, label: '헤지' },
};

const isNum = (v: any) => typeof v === 'number' && isFinite(v);

// 신호 스키마 검증 — 주문 금액/레버리지가 들어오면 경고(신호에 있으면 안 됨)
export function validateSignal(raw: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['신호가 객체가 아닙니다'], warnings };

  if (!raw.strategyId || typeof raw.strategyId !== 'string') errors.push('strategyId 누락');
  if (!raw.symbol || typeof raw.symbol !== 'string') errors.push('symbol 누락');
  if (!['LONG', 'SHORT', 'CLOSE'].includes(raw.signal)) errors.push('signal은 LONG/SHORT/CLOSE 중 하나여야 함');
  if (!isNum(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) errors.push('confidence는 0~1 범위');
  if (raw.signal !== 'CLOSE') {
    if (!isNum(raw.entryPrice) || raw.entryPrice <= 0) errors.push('entryPrice 유효하지 않음');
    if (!isNum(raw.stopLoss) || raw.stopLoss <= 0) errors.push('stopLoss 유효하지 않음 (위험 계산 필수)');
    // 손절 방향 검증
    if (isNum(raw.entryPrice) && isNum(raw.stopLoss)) {
      if (raw.signal === 'LONG' && raw.stopLoss >= raw.entryPrice) errors.push('LONG 손절가는 진입가보다 낮아야 함');
      if (raw.signal === 'SHORT' && raw.stopLoss <= raw.entryPrice) errors.push('SHORT 손절가는 진입가보다 높아야 함');
    }
  }
  if (!isNum(raw.timestamp)) warnings.push('timestamp 누락 — 수신시각으로 대체');

  // 신호에 주문 크기/레버리지가 있으면 무시 경고 (백엔드가 결정)
  if (raw.amount != null || raw.quantity != null) warnings.push('amount/quantity는 무시됩니다 — 주문 크기는 백엔드가 결정');
  if (raw.leverage != null) warnings.push('leverage는 무시됩니다 — 레버리지는 위험 기준으로 백엔드가 결정');

  if (errors.length) return { valid: false, errors, warnings };

  const signal: StandardSignal = {
    strategyId: raw.strategyId, symbol: raw.symbol, signal: raw.signal,
    confidence: raw.confidence, entryPrice: raw.entryPrice, stopLoss: raw.stopLoss,
    takeProfit: isNum(raw.takeProfit) ? raw.takeProfit : undefined,
    timeframe: raw.timeframe || '?', timestamp: isNum(raw.timestamp) ? raw.timestamp : Date.now(),
    bucket: raw.bucket && BUCKET_RISK[raw.bucket as StrategyBucket] ? raw.bucket : inferBucket(raw.timeframe),
  };
  return { valid: true, errors, warnings, signal };
}

// 타임프레임으로 전략군 추론
function inferBucket(tf?: string): StrategyBucket {
  if (!tf) return 'swing';
  const t = tf.toLowerCase();
  if (/^\d+s$/.test(t) || t === '1m' || t === '3m') return 'scalping';
  if (/^(5|15|30)m$/.test(t)) return 'daytrading';
  if (/^(1|2|4)h$/.test(t)) return 'swing';
  if (t === '1d' || t === 'd') return 'position';
  if (/^(1w|w|1M)$/.test(t)) return 'longterm';
  return 'swing';
}
