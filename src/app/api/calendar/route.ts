// src/app/api/calendar/route.ts — Economic calendar (Finnhub + mock fallback)
import { NextRequest, NextResponse } from 'next/server';
import { withEventName } from '@/lib/calendar/normalize';
export const dynamic = 'force-dynamic';

// Multilingual event titles
const EVENTS_KO = [
  { id:'us-cpi',    title:'미국 소비자물가지수 (CPI)',    country:'US', impact:'high',   time:'08:30', forecast:'3.2%',  previous:'3.4%',  actual:null  },
  { id:'us-fomc',   title:'FOMC 금리 결정',              country:'US', impact:'high',   time:'14:00', forecast:'5.25%', previous:'5.25%', actual:null  },
  { id:'us-nfp',    title:'비농업 고용지수 (NFP)',         country:'US', impact:'high',   time:'08:30', forecast:'180K',  previous:'216K',  actual:null  },
  { id:'us-gdp',    title:'미국 GDP 성장률',              country:'US', impact:'high',   time:'08:30', forecast:'2.5%',  previous:'2.8%',  actual:null  },
  { id:'us-ppi',    title:'생산자물가지수 (PPI)',          country:'US', impact:'medium', time:'08:30', forecast:'1.8%',  previous:'2.0%',  actual:null  },
  { id:'us-pce',    title:'개인소비지출 물가 (PCE)',       country:'US', impact:'high',   time:'08:30', forecast:'2.8%',  previous:'2.7%',  actual:null  },
  { id:'us-ism',    title:'ISM 제조업 PMI',              country:'US', impact:'medium', time:'10:00', forecast:'48.5',  previous:'47.4',  actual:null  },
  { id:'us-retail', title:'미국 소매판매',                country:'US', impact:'medium', time:'08:30', forecast:'0.3%',  previous:'-0.1%', actual:null  },
  { id:'us-unemp',  title:'미국 실업률',                  country:'US', impact:'high',   time:'08:30', forecast:'3.9%',  previous:'3.8%',  actual:null  },
  { id:'eu-ecb',    title:'ECB 기준금리 결정',            country:'EU', impact:'high',   time:'14:15', forecast:'4.0%',  previous:'4.25%', actual:null  },
  { id:'eu-cpi',    title:'유로존 소비자물가',            country:'EU', impact:'high',   time:'10:00', forecast:'2.4%',  previous:'2.6%',  actual:null  },
  { id:'eu-pmi',    title:'유로존 제조업 PMI',           country:'EU', impact:'medium', time:'10:00', forecast:'44.8',  previous:'44.4',  actual:null  },
  { id:'kr-boc',    title:'한국은행 기준금리 결정',       country:'KR', impact:'high',   time:'10:00', forecast:'3.25%', previous:'3.50%', actual:null  },
  { id:'kr-cpi',    title:'한국 소비자물가지수',          country:'KR', impact:'medium', time:'08:00', forecast:'2.6%',  previous:'2.8%',  actual:null  },
  { id:'kr-trade',  title:'한국 무역수지',                country:'KR', impact:'medium', time:'08:00', forecast:'$2.1B', previous:'$1.8B', actual:null  },
  { id:'jp-boj',    title:'일본은행 금리 결정 (BOJ)',     country:'JP', impact:'high',   time:'12:00', forecast:'0.1%',  previous:'0.1%',  actual:null  },
  { id:'jp-cpi',    title:'일본 소비자물가',              country:'JP', impact:'medium', time:'08:30', forecast:'2.5%',  previous:'2.7%',  actual:null  },
  { id:'cn-pmi',    title:'중국 제조업 PMI',              country:'CN', impact:'high',   time:'09:00', forecast:'50.4',  previous:'50.1',  actual:null  },
  { id:'cn-cpi',    title:'중국 소비자물가',              country:'CN', impact:'medium', time:'09:30', forecast:'0.1%',  previous:'0.1%',  actual:null  },
  { id:'uk-boe',    title:'영국 기준금리 결정 (BOE)',     country:'UK', impact:'high',   time:'12:00', forecast:'5.0%',  previous:'5.25%', actual:null  },
];

const EVENTS_EN = EVENTS_KO.map(e => ({
  ...e,
  title: {
    'us-cpi':    'US Consumer Price Index (CPI)',
    'us-fomc':   'FOMC Interest Rate Decision',
    'us-nfp':    'US Non-Farm Payrolls',
    'us-gdp':    'US GDP Growth Rate (QoQ)',
    'us-ppi':    'US Producer Price Index (PPI)',
    'us-pce':    'PCE Price Index',
    'us-ism':    'ISM Manufacturing PMI',
    'us-retail': 'US Retail Sales',
    'us-unemp':  'US Unemployment Rate',
    'eu-ecb':    'ECB Interest Rate Decision',
    'eu-cpi':    'Eurozone CPI (Flash)',
    'eu-pmi':    'Eurozone Manufacturing PMI',
    'kr-boc':    'Bank of Korea Rate Decision',
    'kr-cpi':    'South Korea CPI',
    'kr-trade':  'South Korea Trade Balance',
    'jp-boj':    'Bank of Japan Rate Decision (BOJ)',
    'jp-cpi':    'Japan CPI',
    'cn-pmi':    'China NBS Manufacturing PMI',
    'cn-cpi':    'China CPI',
    'uk-boe':    'Bank of England Rate Decision (BOE)',
  }[e.id] || e.title,
}));

const EVENTS_JA = EVENTS_KO.map(e => ({
  ...e,
  title: {
    'us-cpi':    '米国消費者物価指数 (CPI)',
    'us-fomc':   'FOMC 政策金利決定',
    'us-nfp':    '米国非農業部門雇用者数 (NFP)',
    'us-gdp':    '米国 GDP 成長率',
    'us-ppi':    '米国生産者物価指数 (PPI)',
    'us-pce':    'PCE デフレーター',
    'us-ism':    'ISM 製造業景況指数',
    'us-retail': '米国小売売上高',
    'us-unemp':  '米国失業率',
    'eu-ecb':    'ECB 政策金利決定',
    'eu-cpi':    'ユーロ圏消費者物価指数',
    'eu-pmi':    'ユーロ圏製造業PMI',
    'kr-boc':    '韓国銀行 基準金利決定',
    'kr-cpi':    '韓国消費者物価指数',
    'kr-trade':  '韓国貿易収支',
    'jp-boj':    '日本銀行 政策金利決定',
    'jp-cpi':    '日本消費者物価指数',
    'cn-pmi':    '中国製造業PMI',
    'cn-cpi':    '中国消費者物価指数',
    'uk-boe':    '英国中央銀行 政策金利決定',
  }[e.id] || e.title,
}));

const EVENTS_ZH = EVENTS_KO.map(e => ({
  ...e,
  title: {
    'us-cpi':    '美国消费者价格指数 (CPI)',
    'us-fomc':   'FOMC 利率决议',
    'us-nfp':    '美国非农就业人数',
    'us-gdp':    '美国 GDP 增速',
    'us-ppi':    '美国生产者价格指数 (PPI)',
    'us-pce':    'PCE 价格指数',
    'us-ism':    'ISM 制造业PMI',
    'us-retail': '美国零售销售',
    'us-unemp':  '美国失业率',
    'eu-ecb':    '欧央行利率决议',
    'eu-cpi':    '欧元区CPI',
    'eu-pmi':    '欧元区制造业PMI',
    'kr-boc':    '韩国央行利率决议',
    'kr-cpi':    '韩国消费者价格指数',
    'kr-trade':  '韩国贸易差额',
    'jp-boj':    '日本银行利率决议',
    'jp-cpi':    '日本消费者价格指数',
    'cn-pmi':    '中国制造业PMI',
    'cn-cpi':    '中国消费者价格指数',
    'uk-boe':    '英国央行利率决议',
  }[e.id] || e.title,
}));

// Assign realistic upcoming dates
const now   = new Date();
const month = now.getMonth();
const year  = now.getFullYear();
function nextDate(dayOfMonth: number, offsetMonths = 0): string {
  const d = new Date(year, month + offsetMonths, dayOfMonth);
  return d.toISOString().slice(0, 10);
}
const DATES: Record<string, string> = {
  'us-cpi':    nextDate(15),
  'us-fomc':   nextDate(18),
  'us-nfp':    nextDate(7, 1),
  'us-gdp':    nextDate(25),
  'us-ppi':    nextDate(14),
  'us-pce':    nextDate(26),
  'us-ism':    nextDate(2, 1),
  'us-retail': nextDate(17),
  'us-unemp':  nextDate(7, 1),
  'eu-ecb':    nextDate(12),
  'eu-cpi':    nextDate(22),
  'eu-pmi':    nextDate(23),
  'kr-boc':    nextDate(16),
  'kr-cpi':    nextDate(5),
  'kr-trade':  nextDate(1),
  'jp-boj':    nextDate(20),
  'jp-cpi':    nextDate(19),
  'cn-pmi':    nextDate(31),
  'cn-cpi':    nextDate(11),
  'uk-boe':    nextDate(8),
};

function addDates(events: typeof EVENTS_KO) {
  return events.map(e => withEventName({
    ...e,
    date:   DATES[e.id] || nextDate(15),
    time:   e.time,
    // 시간대를 붙이지 않는다. 이건 예시 데이터인데 +09:00을 박으면
    // 미국 지표가 한국 시각으로 확정된 것처럼 보인다. 예시가 정밀한
    // 척하면 진짜와 구분이 더 어려워진다.
    dateTime: null,
  }));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lang    = searchParams.get('lang')    || 'ko';
  const country = searchParams.get('country') || 'all';
  const impact  = searchParams.get('impact')  || 'all';

  const eventMap: Record<string, typeof EVENTS_KO> = {
    ko: EVENTS_KO, en: EVENTS_EN, ja: EVENTS_JA, zh: EVENTS_ZH,
  };
  let events = addDates(eventMap[lang] ?? EVENTS_KO);

  // ── 1순위: 저장된 일정 ──
  // 크론이 모아 둔 실제 일정이 있으면 그걸 쓴다. 아래 목데이터는
  // 그럴듯한 가짜 숫자(FOMC 5.25% 같은)라서, 있는데 안 쓰면 사용자가
  // 지어낸 예상치를 실제 전망으로 읽는다.
  let source = 'mock';
  let status: 'live' | 'sample' = 'sample';
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/server');
    const sb = getSupabaseAdmin();
    if (sb) {
      const from = new Date(Date.now() - 2 * 86400000).toISOString();
      const { data, error } = await (sb.from('econ_events') as any)
        .select('id, timestamp_utc, event, impact, country, actual, forecast, previous, time_known')
        .gte('timestamp_utc', from)
        .order('timestamp_utc', { ascending: true })
        .limit(120);
      if (!error && Array.isArray(data) && data.length > 0) {
        source = 'db'; status = 'live';
        events = data.map((r: any) => {
          const t = new Date(r.timestamp_utc);
          return withEventName({
            id: String(r.id),
            title: r.event,
            country: r.country || '',
            date: t.toISOString().slice(0, 10),
            // 저장된 값은 UTC다. 화면이 보는 사람 시간대로 바꾸도록
            // ISO 전체를 넘긴다 — 여기서 특정 시간대로 굳히면 안 된다.
            time: t.toISOString().slice(11, 16),
            dateTime: t.toISOString(),
            impact: r.impact || 'unknown',
            // 시각을 아는가. FRED에서 온 행은 false다 — 회피 판정이
            // 이 값을 보고 그날 하루 전체를 막는다(lib/risk/eventGuard).
            time_known: r.time_known !== false,
            forecast: r.forecast ?? null,
            previous: r.previous ?? null,
            actual: r.actual ?? null,
          });
        });
      }
    }
  } catch { /* 저장분을 못 읽으면 아래로 내려간다 */ }

  // Try Finnhub if key is configured
  const finnKey = process.env.FINNHUB_API_KEY || '';
  if (finnKey && status !== 'live') {
    try {
      const from = now.toISOString().slice(0, 10);
      const to   = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const r = await fetch(
        `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${finnKey}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) {
        const d = await r.json();
        const cal: any[] = d.economicCalendar || [];
        if (cal.length > 0) {
          source = 'finnhub'; status = 'live';
          events = cal.slice(0, 30).map((ev: any, i: number) => withEventName({
            id:       `fh-${i}`,
            title:    ev.event || ev.eventName || 'Economic Event',
            country:  ev.country || 'US',
            date:     ev.date || nextDate(15),
            time:     ev.time || '08:30',
            // 시간대를 붙이지 않는다. 예전에는 +09:00을 박아서 미국 지표가
            // 한국 시각으로 해석됐다 — FOMC가 9시간 밀린다.
            dateTime: ev.time ? `${ev.date}T${ev.time}:00Z` : null,
            impact:   ev.impact === '3' ? 'high' : ev.impact === '2' ? 'medium' : 'low',
            forecast: ev.estimate != null ? String(ev.estimate) : null,
            previous: ev.prev     != null ? String(ev.prev)     : null,
            actual:   ev.actual   != null ? String(ev.actual)   : null,
          }));
        }
      }
    } catch { /* fallback to mock */ }
  }

  // Filters
  if (country !== 'all') events = events.filter(e => e.country === country);
  if (impact  !== 'all') events = events.filter(e => e.impact  === impact);

  return NextResponse.json({
    ok: true,
    // 예전에는 항상 'mock'이었다. 실제 데이터를 받아와도 그렇게 적으면
    // 화면이 진짜와 가짜를 구분할 수 없다.
    status, source, lang,
    data: events,
    // `events`라는 이름으로도 싣는다. 자동매매의 지표 회피 게이트가
    // `cd.events`를 읽고 있었는데 여기서는 `data`만 줘서 **항상 빈 배열**을
    // 받고 있었다 — 회피가 켜져 있는데 한 번도 안 걸렸다.
    events,
    sampleWarning: status === 'sample'
      ? '표시된 일정과 예상치는 예시입니다. 실제 발표 일정이 아니므로 매매 판단에 쓰지 마세요.'
      : null,
  },
    { headers:{ 'Cache-Control':'public, s-maxage=300, stale-while-revalidate=600' } });
}
