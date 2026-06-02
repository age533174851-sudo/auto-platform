// src/app/api/crypto/route.ts — Binance public ticker (no key needed)
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const KRW_FALLBACK = 1375;

const COINS = [
  { id:'BTC',  sym:'BTCUSDT',  nameKr:'비트코인',   nameEn:'Bitcoin',      logo:'bitcoin'      },
  { id:'ETH',  sym:'ETHUSDT',  nameKr:'이더리움',   nameEn:'Ethereum',     logo:'ethereum'     },
  { id:'SOL',  sym:'SOLUSDT',  nameKr:'솔라나',     nameEn:'Solana',       logo:'solana'       },
  { id:'XRP',  sym:'XRPUSDT',  nameKr:'리플',       nameEn:'XRP',          logo:'xrp'          },
  { id:'BNB',  sym:'BNBUSDT',  nameKr:'바이낸스코인',nameEn:'BNB',         logo:'binance-coin' },
  { id:'DOGE', sym:'DOGEUSDT', nameKr:'도지코인',   nameEn:'Dogecoin',     logo:'dogecoin'     },
  { id:'ADA',  sym:'ADAUSDT',  nameKr:'에이다',     nameEn:'Cardano',      logo:'cardano'      },
  { id:'AVAX', sym:'AVAXUSDT', nameKr:'아발란체',   nameEn:'Avalanche',    logo:'avalanche'    },
  { id:'TON',  sym:'TONUSDT',  nameKr:'톤코인',     nameEn:'Toncoin',      logo:'toncoin'      },
  { id:'LINK', sym:'LINKUSDT', nameKr:'체인링크',   nameEn:'Chainlink',    logo:'chainlink'    },
  { id:'SHIB', sym:'SHIBUSDT', nameKr:'시바이누',   nameEn:'Shiba Inu',    logo:'shiba-inu'    },
  { id:'SUI',  sym:'SUIUSDT',  nameKr:'수이',       nameEn:'Sui',          logo:'sui'          },
  { id:'PEPE', sym:'PEPEUSDT', nameKr:'페페',       nameEn:'Pepe',         logo:'pepe'         },
  { id:'LTC',  sym:'LTCUSDT',  nameKr:'라이트코인', nameEn:'Litecoin',     logo:'litecoin'     },
  { id:'MATIC',sym:'MATICUSDT',nameKr:'폴리곤',     nameEn:'Polygon',      logo:'polygon'      },
  { id:'DOT',  sym:'DOTUSDT',  nameKr:'폴카닷',     nameEn:'Polkadot',     logo:'polkadot'     },
  { id:'ARB',  sym:'ARBUSDT',  nameKr:'아비트럼',   nameEn:'Arbitrum',     logo:'arbitrum'     },
  { id:'OP',   sym:'OPUSDT',   nameKr:'옵티미즘',   nameEn:'Optimism',     logo:'optimism'     },
];

const MOCK: Record<string,{p:number;c:number}> = {
  BTC:{p:94_230_000,c:2.14}, ETH:{p:5_820_000,c:1.83}, SOL:{p:195_000,c:3.41},
  XRP:{p:760,c:-0.52},       BNB:{p:880_000,c:0.91},   DOGE:{p:240,c:1.23},
  ADA:{p:680,c:-1.10},       AVAX:{p:47_000,c:2.05},   TON:{p:7_200,c:0.73},
  LINK:{p:19_800,c:1.54},    SHIB:{p:0.027,c:3.20},    SUI:{p:4_800,c:4.11},
  PEPE:{p:0.014,c:5.30},     LTC:{p:105_000,c:0.88},   MATIC:{p:560,c:-0.40},
  DOT:{p:8_200,c:1.20},      ARB:{p:1_100,c:2.30},     OP:{p:2_400,c:1.80},
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ids = (searchParams.get('ids') || '').split(',').filter(Boolean);
  const coins = ids.length ? COINS.filter(c => ids.includes(c.id)) : COINS;

  let krw = KRW_FALLBACK;
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const d = await r.json(); krw = d.rates?.KRW ?? KRW_FALLBACK; }
  } catch { /* fallback */ }

  let source: 'binance'|'coingecko'|'mock' = 'mock';
  const data: any[] = [];

  try {
    const syms = coins.map(c => `"${c.sym}"`).join(',');
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=[${syms}]&type=MINI`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const tickers: any[] = await r.json();
      source = 'binance';
      for (const coin of coins) {
        const t = tickers.find(x => x.symbol === coin.sym);
        const m = MOCK[coin.id] ?? { p: 0, c: 0 };
        if (!t) {
          data.push({ ...coin, price: m.p, priceUsd: +(m.p/krw).toFixed(6), change24h: m.c, volume24h: 0, category:'crypto', status:'mock' });
        } else {
          const usd = parseFloat(t.lastPrice);
          data.push({ ...coin, price: Math.round(usd*krw), priceUsd: +usd.toFixed(6),
            change24h: +parseFloat(t.priceChangePercent).toFixed(2),
            volume24h: +parseFloat(t.quoteVolume).toFixed(0), category:'crypto', status:'live' });
        }
      }
    }
  } catch { /* fall to coingecko */ }

  // failover: CoinGecko
  if (data.length === 0) {
    try {
      const idMap: Record<string,string> = {
        BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin', XRP:'ripple',
        DOGE:'dogecoin', ADA:'cardano', AVAX:'avalanche-2', TON:'the-open-network',
        LINK:'chainlink', DOT:'polkadot', MATIC:'matic-network', SHIB:'shiba-inu',
        ARB:'arbitrum', SUI:'sui', UNI:'uniswap', OP:'optimism', APT:'aptos', INJ:'injective-protocol',
      };
      const cgIds = coins.map(c => idMap[c.id]).filter(Boolean).join(',');
      if (cgIds) {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd&include_24hr_change=true`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const d = await r.json();
          source = 'coingecko';
          for (const coin of coins) {
            const cg = d[idMap[coin.id]];
            const m = MOCK[coin.id] ?? { p: 0, c: 0 };
            if (cg?.usd) {
              data.push({ ...coin, price: Math.round(cg.usd*krw), priceUsd: +cg.usd.toFixed(6),
                change24h: +(cg.usd_24h_change ?? m.c).toFixed(2), volume24h: 0, category:'crypto', status:'live' });
            } else {
              data.push({ ...coin, price: m.p, priceUsd: +(m.p/krw).toFixed(6), change24h: m.c, volume24h: 0, category:'crypto', status:'mock' });
            }
          }
        }
      }
    } catch { /* fall to mock */ }
  }

  if (data.length === 0) {
    for (const coin of coins) {
      const m = MOCK[coin.id] ?? { p: 0, c: 0 };
      data.push({ ...coin, price: m.p, priceUsd: +(m.p/krw).toFixed(6), change24h: m.c, volume24h: 0, category:'crypto', status:'mock' });
    }
  }

  return NextResponse.json({ ok:true, source, status: source==='mock'?'mock':'live',
    failoverChain: ['binance','coingecko','mock'],
    updatedAt: new Date().toISOString(), krw, data },
    { headers:{ 'Cache-Control':'public, s-maxage=10, stale-while-revalidate=20' } });
}
