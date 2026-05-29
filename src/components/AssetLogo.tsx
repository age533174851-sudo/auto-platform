'use client';
import { useState, useEffect } from 'react';
import { buildSourceList, getBgColor, getInitials } from '@/lib/logoResolver';

interface AssetLogoProps {
  ticker:     string;
  size?:      number;
  name?:      string;       // Korean/English name for initials fallback
  logoUrl?:   string;       // external URL override (e.g. from API)
  clr?:       string;       // brand color override
  className?: string;
  style?:     React.CSSProperties;
}

/**
 * AssetLogo — universal asset logo component.
 *
 * Features:
 * - Multi-source fallback (curated DB → API URL → FMP → initials)
 * - Loading skeleton
 * - No broken images
 * - Korean / Unicode initials support
 * - Deterministic color per ticker
 */
export default function AssetLogo({
  ticker,
  size = 36,
  name,
  logoUrl,
  clr,
  className,
  style,
}: AssetLogoProps) {
  const bg      = getBgColor(ticker, clr);
  const inits   = getInitials(ticker, name);
  const r       = Math.round(size * 0.5);
  const sources = buildSourceList(ticker, logoUrl);

  const [srcIdx,    setSrcIdx]    = useState(0);
  const [loaded,    setLoaded]    = useState(false);
  const [allFailed, setAllFailed] = useState(false);

  // Reset on ticker change
  useEffect(() => {
    setSrcIdx(0);
    setLoaded(false);
    setAllFailed(sources.length === 0);
  }, [ticker, logoUrl]);  // eslint-disable-line

  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: r,
    flexShrink: 0, overflow: 'hidden',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative',
    ...style,
  };

  const handleError = () => {
    if (srcIdx + 1 < sources.length) {
      setSrcIdx(i => i + 1);
      setLoaded(false);
    } else {
      setAllFailed(true);
    }
  };

  // ── Initials fallback (always works) ──
  if (allFailed || sources.length === 0) {
    return (
      <div
        className={className}
        style={{
          ...base,
          background: `linear-gradient(135deg,${bg}CC,${bg}66)`,
          border: `1px solid ${bg}44`,
        }}
        aria-label={ticker}
      >
        <span style={{
          color: '#fff',
          fontWeight: 900,
          fontSize: Math.max(8, size * 0.34),
          fontFamily: 'monospace',
          letterSpacing: -0.5,
          lineHeight: 1,
          userSelect: 'none',
        }}>
          {inits}
        </span>
      </div>
    );
  }

  // ── Image with skeleton ──
  return (
    <div
      className={className}
      style={{ ...base, background: `${bg}18`, border: `1px solid ${bg}30` }}
      aria-label={ticker}
    >
      {/* Shimmer skeleton while loading */}
      {!loaded && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: r,
          background: 'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.2s infinite',
        }}/>
      )}
      {/* Initials shown while image loads */}
      {!loaded && (
        <span style={{
          position: 'absolute',
          color: `${bg}80`,
          fontWeight: 900,
          fontSize: Math.max(7, size * 0.28),
          fontFamily: 'monospace',
          userSelect: 'none',
        }}>
          {inits}
        </span>
      )}
      <img
        key={`${ticker}-${srcIdx}`}
        src={sources[srcIdx]}
        alt={ticker}
        loading="lazy"
        decoding="async"
        style={{
          width: size * 0.74,
          height: size * 0.74,
          objectFit: 'contain',
          opacity: loaded ? 1 : 0,
          transition: 'opacity 0.18s ease',
          display: 'block',
          position: 'relative',
          zIndex: 1,
        }}
        onLoad={() => setLoaded(true)}
        onError={handleError}
      />
    </div>
  );
}
