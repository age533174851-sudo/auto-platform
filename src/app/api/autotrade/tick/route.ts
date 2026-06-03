// /api/autotrade/tick
// 입력: { asset, market, timeframe, conditions[] }
// 출력: { snapshot, evaluation: { allPass, details, passCount } }
//
// 실제 체결은 클라이언트에서 (paper 모드만), 이 API는 평가만.
// live 모드 체결은 [3] 거래소 연결 라운드에서 추가.

import { NextRequest, NextResponse } from 'next/server';
import { buildSnapshot, evaluateAll } from '@/lib/autotrade/engine';
import type { StrategyCondition } from '@/lib/strategies/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 타임프레임 → Binance interval
const TF_MAP: Record<string, string> = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
};

// 자산 → Binance symbol (crypto만 직접 지원, 나머지는 미지원 반환)
function toBinanceSymbol(asset: string, market: string): string | null {
  if (market !== 'crypto') return null;
  const a = asset.toUpperCase();
  // 일반적인 USDT 페어
  return `${a}USDT`;
}

interface KlineRow { closes: number[]; volumes: number[]; }

async function fetchKlines(symbol: string, interval: string, limit = 150): Promise<KlineRow | null> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data)) return null;
    const closes:  number[] = [];
    const volumes: number[] = [];
    for (const k of data) {
      if (Array.isArray(k) && k.length >= 6) {
        const c = parseFloat(k[4]);
        const v = parseFloat(k[5]);
        if (Number.isFinite(c)) closes.push(c);
        if (Number.isFinite(v)) volumes.push(v);
      }
    }
    if (closes.length === 0) return null;
    return { closes, volumes };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: {
    asset?:     string;
    market?:    string;
    timeframe?: string;
    conditions?: StrategyCondition[];
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const asset      = String(body.asset || '').trim().toUpperCase();
  const market     = String(body.market || 'crypto');
  const timeframe  = String(body.timeframe || '1h');
  const conditions = Array.isArray(body.conditions) ? body.conditions : [];

  if (!asset || conditions.length === 0) {
    return NextResponse.json({ error: 'missing_asset_or_conditions' }, { status: 400 });
  }

  const interval = TF_MAP[timeframe];
  if (!interval) {
    return NextResponse.json({ error: 'unsupported_timeframe' }, { status: 400 });
  }

  const sym = toBinanceSymbol(asset, market);
  if (!sym) {
    return NextResponse.json({
      error: 'market_not_supported',
      message: `${market} 시장의 ${asset}는 자동매매가 아직 지원되지 않습니다 (현재는 crypto만)`,
    }, { status: 400 });
  }

  const klines = await fetchKlines(sym, interval, 150);
  if (!klines) {
    return NextResponse.json({
      error: 'price_fetch_failed',
      message: `${sym} 가격 데이터를 가져오지 못했습니다`,
    }, { status: 502 });
  }

  const snapshot = buildSnapshot(klines.closes, klines.volumes);
  const evaluation = evaluateAll(conditions, snapshot);

  return NextResponse.json({
    asset,
    timeframe,
    snapshot,
    evaluation,
    timestamp: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
