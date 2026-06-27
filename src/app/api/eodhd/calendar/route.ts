// /api/eodhd/calendar — Economic / earnings / dividends calendar
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const MOCK_ECON = [
  { id:'cpi-us',  title:'미국 CPI',        country:'US', date: new Date(Date.now()+86400_000).toISOString(),
    impact:'high',   forecast:'3.2%',  previous:'3.4%' },
  { id:'fomc-us', title:'FOMC 금리 결정',  country:'US', date: new Date(Date.now()+3*86400_000).toISOString(),
    impact:'high',   forecast:'5.25%', previous:'5.50%' },
  { id:'nfp-us',  title:'비농업 고용지수', country:'US', date: new Date(Date.now()+7*86400_000).toISOString(),
    impact:'high',   forecast:'180K',  previous:'216K' },
];

const MOCK_EARNINGS = [
  { symbol:'NVDA', date: new Date(Date.now()+86400_000).toISOString(),  estimate:5.59, actual:null },
  { symbol:'AAPL', date: new Date(Date.now()+5*86400_000).toISOString(),estimate:1.51, actual:null },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = (searchParams.get('type') || 'economic').toLowerCase();
  const key  = process.env.EODHD_API_KEY || '';

  if (!key) {
    if (type === 'earnings') {
      return NextResponse.json({ ok:true, source:'mock', type, data: MOCK_EARNINGS });
    }
    return NextResponse.json({ ok:true, source:'mock', type, data: MOCK_ECON });
  }

  try {
    const from = new Date().toISOString().slice(0,10);
    const to   = new Date(Date.now() + 30*86400_000).toISOString().slice(0,10);
    let url = '';
    if (type === 'earnings') {
      url = `https://eodhistoricaldata.com/api/calendar/earnings?from=${from}&to=${to}&api_token=${key}&fmt=json`;
    } else if (type === 'dividends') {
      url = `https://eodhistoricaldata.com/api/calendar/dividends?from=${from}&to=${to}&api_token=${key}&fmt=json`;
    } else {
      url = `https://eodhistoricaldata.com/api/economic-events?from=${from}&to=${to}&api_token=${key}&fmt=json`;
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const data = Array.isArray(d) ? d : Array.isArray(d?.earnings) ? d.earnings : [];
    if (data.length === 0) throw new Error('Empty');
    return NextResponse.json({ ok:true, source:'live', type, data: data.slice(0, 50) });
  } catch (e) {
    console.error('[eodhd/calendar]', e);
    return NextResponse.json({
      ok:true, source:'mock', type,
      data: type === 'earnings' ? MOCK_EARNINGS : MOCK_ECON,
    });
  }
}
