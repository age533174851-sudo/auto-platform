// /api/asset-analysis
// 자산 종합 분석 — Binance 데이터 + 기술 지표 + AI 코멘트
//
// 입력: { asset, market, timeframe }
// 출력: {
//   snapshot: { price, change24h, volume },
//   indicators: { rsi, ema20, ema60, ema120, macd, ... },
//   diagnosis: { trend, momentum, volatility, signals[] },
//   aiComment: string,
//   source: 'openai' | 'fallback',
// }

import { NextRequest, NextResponse } from 'next/server';
import { buildSnapshot, calcRSI, calcEMA } from '@/lib/autotrade/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TF_MAP: Record<string, string> = {
  '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d',
};

function toBinanceSymbol(asset: string, market: string): string | null {
  if (market && market !== 'crypto') return null;
  const a = asset.toUpperCase().replace(/USDT$|KRW$/i, '');
  return `${a}USDT`;
}

interface DiagnosisResult {
  trend:        'bullish' | 'bearish' | 'neutral';
  momentum:     'strong' | 'moderate' | 'weak';
  volatility:   'high' | 'medium' | 'low';
  signals:      string[];
  buySignals:   number;
  sellSignals:  number;
  score:        number;     // -100 ~ +100
}

function diagnose(snap: any, closes: number[]): DiagnosisResult {
  const signals: string[] = [];
  let buy = 0, sell = 0;

  // RSI
  if (snap.rsi != null) {
    if (snap.rsi < 30)        { signals.push(`RSI ${snap.rsi.toFixed(1)} — 과매도 (매수 압력)`); buy++; }
    else if (snap.rsi > 70)   { signals.push(`RSI ${snap.rsi.toFixed(1)} — 과매수 (매도 압력)`); sell++; }
    else if (snap.rsi > 60)   { signals.push(`RSI ${snap.rsi.toFixed(1)} — 매수세 강함`); buy++; }
    else if (snap.rsi < 40)   { signals.push(`RSI ${snap.rsi.toFixed(1)} — 매도세 강함`); sell++; }
  }

  // EMA 배열
  if (snap.ema20 != null && snap.ema60 != null && snap.ema120 != null) {
    if (snap.ema20 > snap.ema60 && snap.ema60 > snap.ema120) {
      signals.push('EMA 정배열 (20>60>120) — 강한 상승 추세');
      buy += 2;
    } else if (snap.ema20 < snap.ema60 && snap.ema60 < snap.ema120) {
      signals.push('EMA 역배열 (20<60<120) — 강한 하락 추세');
      sell += 2;
    } else if (snap.ema20 > snap.ema60) {
      signals.push('단기(20) > 중기(60) — 단기 상승');
      buy++;
    } else {
      signals.push('단기(20) < 중기(60) — 단기 하락');
      sell++;
    }
  }

  // 거래량 vs 평균
  if (snap.volume != null && snap.volumeAvg != null) {
    const ratio = snap.volume / snap.volumeAvg;
    if (ratio > 2)        signals.push(`거래량 ${ratio.toFixed(2)}배 폭증 — 강한 관심`);
    else if (ratio > 1.5) signals.push(`거래량 ${ratio.toFixed(2)}배 — 평균 이상`);
    else if (ratio < 0.5) signals.push(`거래량 ${ratio.toFixed(2)}배 — 부진`);
  }

  // 변동성 (ATR-like: 최근 14봉 평균 변동폭)
  let volatility: 'high' | 'medium' | 'low' = 'medium';
  if (closes.length >= 15) {
    const recent = closes.slice(-14);
    const avg = recent.reduce((s,v)=>s+v,0) / recent.length;
    const stdev = Math.sqrt(recent.reduce((s,v)=>s+(v-avg)**2,0) / recent.length);
    const cv = avg > 0 ? stdev / avg : 0;
    if (cv > 0.05)      { volatility = 'high';   signals.push('변동성 높음 — 작은 사이즈 권장'); }
    else if (cv < 0.01) { volatility = 'low';    }
  }

  // 추세 / 모멘텀 / 점수
  const trend = buy > sell ? 'bullish' : sell > buy ? 'bearish' : 'neutral';
  const totalSignals = buy + sell;
  const momentum: 'strong' | 'moderate' | 'weak' =
    totalSignals >= 4 ? 'strong' :
    totalSignals >= 2 ? 'moderate' : 'weak';

  const score = Math.max(-100, Math.min(100, (buy - sell) * 25));

  return { trend, momentum, volatility, signals, buySignals: buy, sellSignals: sell, score };
}

async function aiComment(asset: string, diag: DiagnosisResult, snap: any): Promise<{ text: string; source: 'openai' | 'fallback' }> {
  const key = process.env.OPENAI_API_KEY || '';

  // Fallback: 룰 기반 한 줄 코멘트
  const fallback = () => {
    if (diag.trend === 'bullish' && diag.momentum === 'strong') {
      return `${asset}는 EMA 정배열과 매수 시그널이 우세한 강세 추세입니다. 다만 RSI 과매수와 변동성 확인 후 분할 진입 권장.`;
    }
    if (diag.trend === 'bearish' && diag.momentum === 'strong') {
      return `${asset}는 EMA 역배열과 매도 시그널이 우세한 약세 추세입니다. 추격 매수보다 반등 시 분할 매도가 안전합니다.`;
    }
    if (diag.trend === 'bullish') {
      return `${asset}는 단기 상승 시그널이 있으나 추세가 강하지 않습니다. 추가 확인 신호 (거래량, 캔들 패턴) 동반 시 진입 고려.`;
    }
    if (diag.trend === 'bearish') {
      return `${asset}는 단기 약세 시그널이 있습니다. 지지선 확인과 반등 캔들이 나올 때까지 관망 권장.`;
    }
    return `${asset}는 뚜렷한 방향성이 없는 중립 구간입니다. 박스권 매매 또는 돌파를 기다리는 것이 안전합니다.`;
  };

  if (!key) return { text: fallback(), source: 'fallback' };

  // OpenAI
  try {
    const sys = `당신은 20년 경력 트레이더입니다. 자산의 기술적 진단 결과를 한국어 2-3문장으로 명확하게 정리합니다.
규칙:
- 절대 "사세요" "매도하세요" 같은 단정 표현 금지
- "~가능성" "고려" "권장" 같은 완곡 표현 사용
- 리스크 1개 이상 언급
- 출력은 텍스트만, JSON 아님`;

    const userMsg = `자산: ${asset}
추세: ${diag.trend}
모멘텀: ${diag.momentum}
변동성: ${diag.volatility}
매수 시그널: ${diag.buySignals}개, 매도 시그널: ${diag.sellSignals}개
주요 시그널:
${diag.signals.map(s => '- ' + s).join('\n')}
현재가: ${snap.currentPrice}, RSI: ${snap.rsi?.toFixed(1) ?? '?'}, EMA20: ${snap.ema20?.toFixed(2) ?? '?'}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 250,
        temperature: 0.4,
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: userMsg },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`status_${r.status}`);
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content?.trim() || '';
    if (!text) throw new Error('empty');
    return { text, source: 'openai' };
  } catch {
    return { text: fallback(), source: 'fallback' };
  }
}

async function fetchKlines(symbol: string, interval: string, limit = 200) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data)) return null;
    const closes: number[] = [];
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
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const asset     = String(body.asset || '').trim().toUpperCase();
  const market    = String(body.market || 'crypto');
  const timeframe = String(body.timeframe || '1h');

  if (!asset) return NextResponse.json({ error: 'missing_asset' }, { status: 400 });
  const interval = TF_MAP[timeframe];
  if (!interval) return NextResponse.json({ error: 'unsupported_timeframe' }, { status: 400 });

  const sym = toBinanceSymbol(asset, market);
  if (!sym) {
    return NextResponse.json({
      error: 'market_not_supported',
      message: `${market} 시장의 ${asset}는 아직 자동 분석이 지원되지 않습니다. 차트를 직접 확인해주세요.`,
    }, { status: 400 });
  }

  const klines = await fetchKlines(sym, interval, 200);
  if (!klines) {
    return NextResponse.json({
      error: 'price_fetch_failed',
      message: '가격 데이터를 가져오지 못했습니다',
    }, { status: 502 });
  }

  const snapshot = buildSnapshot(klines.closes, klines.volumes);
  const diagnosis = diagnose(snapshot, klines.closes);
  const ai = await aiComment(asset, diagnosis, snapshot);

  return NextResponse.json({
    asset,
    timeframe,
    snapshot,
    diagnosis,
    aiComment:  ai.text,
    aiSource:   ai.source,
    timestamp:  Date.now(),
  }, { headers: { 'Cache-Control': 'public, s-maxage=60' } });
}
