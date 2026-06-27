'use client';
import React from 'react';

export type DataSource =
  | 'binance' | 'fmp' | 'eodhd' | 'finnhub' | 'polygon'
  | 'newsapi' | 'financialjuice' | 'exchangerate'
  | 'openai' | 'supabase' | 'mock' | 'cache' | 'unknown';

const META: Record<DataSource, { label: string; color: string; live: boolean }> = {
  binance:        { label:'Binance',         color:'#F0B90B', live:true },
  fmp:            { label:'FMP',             color:'#6366F1', live:true },
  eodhd:          { label:'EODHD',           color:'#10B981', live:true },
  finnhub:        { label:'Finnhub',         color:'#3B82F6', live:true },
  polygon:        { label:'Polygon',         color:'#8B5CF6', live:true },
  newsapi:        { label:'NewsAPI',         color:'#EF4444', live:true },
  financialjuice: { label:'FinancialJuice',  color:'#F59E0B', live:true },
  exchangerate:   { label:'ExchangeRate',    color:'#06B6D4', live:true },
  openai:         { label:'OpenAI',          color:'#10A37F', live:true },
  supabase:       { label:'Supabase',        color:'#3ECF8E', live:true },
  mock:           { label:'MOCK',            color:'#F59E0B', live:false },
  cache:          { label:'CACHE',           color:'#64748B', live:false },
  unknown:        { label:'?',               color:'#64748B', live:false },
};

export interface SourceBadgeProps {
  source: DataSource | string;
  size?:  'sm' | 'md';
  style?: React.CSSProperties;
  showLabel?: boolean;
}

/** Compact badge showing data source — LIVE shows colored, MOCK shows orange */
export function SourceBadge({ source, size = 'sm', style, showLabel = true }: SourceBadgeProps) {
  const key = (String(source) || 'unknown').toLowerCase() as DataSource;
  const meta = META[key] || META.unknown;
  const fontSize = size === 'md' ? 10 : 9;
  const padding = size === 'md' ? '3px 8px' : '2px 6px';

  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap: 3,
      background: meta.color + '15',
      color: meta.color,
      border:`1px solid ${meta.color}40`,
      borderRadius: 4,
      padding,
      fontSize,
      fontWeight: 700,
      lineHeight: 1,
      flexShrink: 0,
      ...style,
    }}>
      <span style={{ width: 4, height: 4, borderRadius:'50%',
        background: meta.color,
        boxShadow: meta.live ? `0 0 4px ${meta.color}` : 'none',
      }}/>
      {showLabel && (meta.live ? meta.label : 'MOCK')}
    </span>
  );
}

/** Show LIVE / MOCK / ERR based on simple status string */
export function StatusBadge({ status }: { status: 'live' | 'mock' | 'error' | 'mixed' | 'loading' | string }) {
  const map: Record<string, { text: string; color: string }> = {
    live:    { text:'LIVE',    color:'#10B981' },
    mixed:   { text:'HYBRID',  color:'#3B82F6' },
    mock:    { text:'MOCK',    color:'#F59E0B' },
    error:   { text:'ERR',     color:'#EF4444' },
    loading: { text:'…',       color:'#64748B' },
  };
  const m = map[status] || map.loading;
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap: 4,
      background: m.color + '15',
      color: m.color,
      border: `1px solid ${m.color}40`,
      borderRadius: 12,
      padding:'2px 8px',
      fontSize: 9,
      fontWeight: 700,
      lineHeight: 1,
    }}>
      <span style={{ width: 4, height: 4, borderRadius:'50%', background: m.color }}/>
      {m.text}
    </span>
  );
}

export default SourceBadge;
