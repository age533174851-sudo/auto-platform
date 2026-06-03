// /api/logo/batch — resolve multiple logos in ONE request
// GET  /api/logo/batch?symbols=AAPL,TSLA,NVDA&type=auto
// POST /api/logo/batch  body: { symbols: ["AAPL","TSLA"], type?: "auto" }
//
// Response:
//   {
//     ok: true,
//     items: { [SYMBOL]: { symbol, logoUrl, source, fallback } },
//     count: number
//   }

import { NextRequest, NextResponse } from 'next/server';
import { lookupLogo } from '../route';
import type { AssetType, LogoResponse } from '../route';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

interface BatchItem {
  symbol:   string;
  logoUrl:  string | null;
  source:   string;
  fallback: boolean;
}

const MAX_BATCH = 50;

async function processBatch(rawSymbols: string[], defaultType: AssetType): Promise<Record<string, BatchItem>> {
  const symbols = Array.from(new Set(
    rawSymbols
      .map(s => (s || '').trim().toUpperCase())
      .filter(Boolean),
  )).slice(0, MAX_BATCH);

  if (symbols.length === 0) return {};

  const results: Record<string, BatchItem> = {};
  const queue = [...symbols];
  const CONCURRENCY = 10;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const sym = queue.shift();
      if (!sym) continue;
      try {
        const resp: LogoResponse = await lookupLogo(sym, defaultType);
        results[sym] = {
          symbol:   resp.symbol,
          logoUrl:  resp.logoUrl,
          source:   resp.source,
          fallback: resp.fallback,
        };
      } catch {
        results[sym] = { symbol: sym, logoUrl: null, source: 'fallback', fallback: true };
      }
    }
  }));

  return results;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const symbolsParam = (url.searchParams.get('symbols') || '').trim();
  const defaultType = ((url.searchParams.get('type') || 'auto').toLowerCase()) as AssetType;

  if (!symbolsParam) {
    return NextResponse.json({ ok: false, items: {}, error: 'missing_symbols' }, { status: 400 });
  }
  const symbols = symbolsParam.split(',');
  const items = await processBatch(symbols, defaultType);
  return NextResponse.json(
    { ok: true, items, count: Object.keys(items).length },
    { headers: { 'Cache-Control': 'public, max-age=21600' } }, // 6h browser cache
  );
}

export async function POST(req: NextRequest) {
  let body: { symbols?: unknown; type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, items: {}, error: 'invalid_json' }, { status: 400 });
  }
  if (!body || !Array.isArray(body.symbols)) {
    return NextResponse.json({ ok: false, items: {}, error: 'missing_symbols' }, { status: 400 });
  }
  const rawSymbols = (body.symbols as unknown[]).map(s => String(s ?? ''));
  const defaultType = ((body.type || 'auto').toLowerCase()) as AssetType;
  const items = await processBatch(rawSymbols, defaultType);
  return NextResponse.json(
    { ok: true, items, count: Object.keys(items).length },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
