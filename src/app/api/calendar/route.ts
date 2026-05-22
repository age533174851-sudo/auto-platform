// /api/calendar — Economic calendar events
// Tries Finnhub first; falls back to mock data (multilingual, all 4 langs)
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MOCK_EVENTS = [
  { id:'e1',  event:'CPI',            country:'US', date:'2025-05-15', time:'08:30', impact:'high',   forecast:'3.2%', previous:'3.1%', actual:'3.4%', unit:'%' },
  { id:'e2',  event:'FOMC',           country:'US', date:'2025-05-07', time:'14:00', impact:'high',   forecast:'5.25%', previous:'5.50%', actual:null,  unit:'%' },
  { id:'e3',  event:'NFP',            country:'US', date:'2025-05-02', time:'08:30', impact:'high',   forecast:'180K',  previous:'216K', actual:null,  unit:'K' },
  { id:'e4',  event:'GDP',            country:'US', date:'2025-04-30', time:'08:30', impact:'medium', forecast:'2.5%',  previous:'2.8%', actual:'2.3%',unit:'%' },
  { id:'e5',  event:'PMI',            country:'EU', date:'2025-05-22', time:'04:00', impact:'medium', forecast:'44.2',  previous:'44.4', actual:null,  unit:'' },
  { id:'e6',  event:'금통위',          country:'KR', date:'2025-05-16', time:'10:00', impact:'high',   forecast:'3.0%',  previous:'3.25%',actual:'3.0%',unit:'%' },
  { id:'e7',  event:'ECB',            country:'EU', date:'2025-06-12', time:'08:15', impact:'high',   forecast:'3.5%',  previous:'3.75%',actual:null,  unit:'%' },
  { id:'e8',  event:'PPI',            country:'US', date:'2025-05-14', time:'08:30', impact:'medium', forecast:'1.8%',  previous:'1.7%', actual:'2.0%',unit:'%' },
  { id:'e9',  event:'Retail Sales',   country:'US', date:'2025-05-16', time:'08:30', impact:'medium', forecast:'-0.1%', previous:'0.3%', actual:null, unit:'%' },
  { id:'e10', event:'ISM',            country:'US', date:'2025-06-02', time:'10:00', impact:'medium', forecast:'48.5',  previous:'47.4', actual:null,  unit:'' },
  { id:'e11', event:'Unemployment',   country:'KR', date:'2025-05-14', time:'08:00', impact:'low',    forecast:'2.9%',  previous:'2.8%', actual:'2.9%',unit:'%' },
  { id:'e12', event:'Consumer Conf',  country:'EU', date:'2025-05-28', time:'10:00', impact:'low',    forecast:'-14',   previous:'-15',  actual:null,  unit:'' },
  { id:'e13', event:'BOJ',            country:'JP', date:'2025-06-13', time:'02:00', impact:'high',   forecast:'0.1%',  previous:'0.1%', actual:null,  unit:'%' },
  { id:'e14', event:'Industrial Prod',country:'CN', date:'2025-05-16', time:'02:00', impact:'medium', forecast:'5.5%',  previous:'5.3%', actual:'5.7%',unit:'%' },
  { id:'e15', event:'Trade Balance',  country:'US', date:'2025-06-04', time:'08:30', impact:'low',    forecast:'-$65B', previous:'-$68B',actual:null,  unit:'' },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lang    = searchParams.get('lang') || 'ko';
  const country = searchParams.get('country') || 'all';

  const apiKey = process.env.FINNHUB_API_KEY || process.env.NEXT_PUBLIC_FINNHUB_API_KEY || '';

  let events = [...MOCK_EVENTS];
  let source = 'mock';

  // Try Finnhub if key configured
  if (apiKey) {
    try {
      const from = new Date().toISOString().slice(0, 10);
      const to   = new Date(Date.now() + 30 * 86400 * 1000).toISOString().slice(0, 10);
      const r = await fetch(
        `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.economicCalendar) && d.economicCalendar.length > 0) {
          events = d.economicCalendar.slice(0, 50).map((e: any, i: number) => ({
            id:       `f${i}`,
            event:    e.event || e.eventName || 'Unknown',
            country:  e.country || 'US',
            date:     e.date || '',
            time:     e.time || '00:00',
            impact:   e.impact === '3' ? 'high' : e.impact === '2' ? 'medium' : 'low',
            forecast: e.estimate != null ? String(e.estimate) : undefined,
            previous: e.prev      != null ? String(e.prev)     : undefined,
            actual:   e.actual    != null ? String(e.actual)   : undefined,
            unit:     e.unit || '%',
          }));
          source = 'finnhub';
        }
      }
    } catch { /* fallback to mock */ }
  }

  // Country filter
  if (country !== 'all') {
    events = events.filter(e => e.country === country);
  }

  return NextResponse.json({ events, source, lang }, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  });
}
