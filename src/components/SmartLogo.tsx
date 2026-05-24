'use client';
import React, { useState, useEffect } from 'react';

const CRYPTO_LOGOS: Record<string, string> = {
  BTC:  'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
  ETH:  'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
  SOL:  'https://assets.coingecko.com/coins/images/4128/large/solana.png',
  XRP:  'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
  BNB:  'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
  DOGE: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
  ADA:  'https://assets.coingecko.com/coins/images/975/large/cardano.png',
  AVAX: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
  TON:  'https://assets.coingecko.com/coins/images/17980/large/ton_symbol.png',
  LINK: 'https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png',
  SHIB: 'https://assets.coingecko.com/coins/images/11939/large/shiba.png',
  SUI:  'https://assets.coingecko.com/coins/images/26375/large/sui_asset.jpeg',
  PEPE: 'https://assets.coingecko.com/coins/images/29850/large/pepe-token.jpeg',
  DOT:  'https://assets.coingecko.com/coins/images/12171/large/polkadot.png',
  LTC:  'https://assets.coingecko.com/coins/images/2/large/litecoin.png',
  MATIC:'https://assets.coingecko.com/coins/images/4713/large/polygon.png',
  ARB:  'https://assets.coingecko.com/coins/images/16547/large/photo_2023-03-29_21.47.00.jpeg',
  OP:   'https://assets.coingecko.com/coins/images/25244/large/Optimism.png',
};

const STOCK_DOMAINS: Record<string, string> = {
  AAPL:'apple.com',     MSFT:'microsoft.com',  NVDA:'nvidia.com',     TSLA:'tesla.com',
  GOOGL:'google.com',   GOOG:'google.com',     AMZN:'amazon.com',     META:'meta.com',
  AMD:'amd.com',        INTC:'intel.com',      PLTR:'palantir.com',   COIN:'coinbase.com',
  MSTR:'microstrategy.com', SHOP:'shopify.com',ORCL:'oracle.com',     ADBE:'adobe.com',
  NFLX:'netflix.com',   SMCI:'supermicro.com', PYPL:'paypal.com',     HOOD:'robinhood.com',
  AVGO:'broadcom.com',  QCOM:'qualcomm.com',   CRWD:'crowdstrike.com',SNOW:'snowflake.com',
};

function detectMarket(id: string): 'crypto'|'us_stock'|'kr_stock'|'etf'|'unknown' {
  const s = id.toUpperCase().trim();
  if (CRYPTO_LOGOS[s]) return 'crypto';
  if (/^\d{6}$/.test(s)) return 'kr_stock';
  if (STOCK_DOMAINS[s])  return 'us_stock';
  return 'unknown';
}

function getLogoUrl(id: string, providedUrl?: string): string | null {
  if (providedUrl) return providedUrl;
  const s = id.toUpperCase().trim();
  if (CRYPTO_LOGOS[s])         return CRYPTO_LOGOS[s];
  if (/^\d{6}$/.test(s))       return `https://ssl.pstatic.net/imgfinance/chart/item/area/day/${s}.png`;
  if (STOCK_DOMAINS[s])        return `https://logo.clearbit.com/${STOCK_DOMAINS[s]}`;
  return null;
}

function colorFor(id: string): string {
  const COLORS = ['#F59E0B','#6366F1','#EC4899','#10B981','#EF4444',
                  '#3B82F6','#8B5CF6','#14B8A6','#F97316','#06B6D4'];
  const s = id.toUpperCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash<<5)-hash + s.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

export interface SmartLogoProps {
  id:     string;
  name?:  string;
  size?:  number;
  url?:   string;      // optional explicit URL (overrides auto-detection)
  clr?:   string;      // optional explicit color
  style?: React.CSSProperties;
}

export function SmartLogo({ id, name, size = 36, url, clr, style }: SmartLogoProps) {
  const initial   = (name?.[0] || id?.[0] || '?').toUpperCase();
  const bg        = clr || colorFor(id || 'X');
  const [src, setSrc] = useState<string | null>(() => getLogoUrl(id, url));
  const [failed, setFailed] = useState(false);

  // Reset src when id changes (avoid stale cached image showing wrong logo)
  useEffect(() => {
    setFailed(false);
    setSrc(getLogoUrl(id, url));
  }, [id, url]);

  const wrap: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: failed || !src ? bg : '#0F1924',
    color: '#fff', fontWeight: 800, fontSize: size * 0.4,
    overflow: 'hidden', flexShrink: 0,
    border: `1px solid ${bg}40`,
    ...style,
  };

  if (failed || !src) {
    return <div style={wrap} role="img" aria-label={name || id}>{initial}</div>;
  }

  return (
    <div style={wrap} role="img" aria-label={name || id}>
      <img
        src={src}
        alt={name || id}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </div>
  );
}

export default SmartLogo;
