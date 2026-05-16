import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,       // allow pinch-zoom on iOS
  userScalable: true,
  viewportFit: 'cover',  // notch / safe-area-inset support
  themeColor: '#060B14',
};

export const metadata: Metadata = {
  title: 'TRAIGO — 글로벌 투자 시뮬레이션',
  description: '290+ 글로벌 종목 · 모의투자 · AI 분석 · 완전 무료',
  keywords: ['모의투자','주식','코인','투자','paper trading','트레이딩뷰'],
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TRAIGO',
  },
  openGraph: {
    title: 'TRAIGO',
    description: '글로벌 투자 시뮬레이션 플랫폼',
    type: 'website',
  },
  icons: {
    apple: [
      { url: '/icon-192.png', sizes: '192x192' },
      { url: '/icon-512.png', sizes: '512x512' },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" style={{ colorScheme: 'dark' }}>
      <head>
        {/* Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        {/* Apple PWA */}
        <meta name="apple-mobile-web-app-capable" content="yes"/>
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
        {/* Prevent iOS phone number detection */}
        <meta name="format-detection" content="telephone=no"/>
        {/* Prevent iOS text size adjustment */}
        <meta name="HandheldFriendly" content="true"/>
        {/* MS tiles */}
        <meta name="msapplication-TileColor" content="#060B14"/>
        {/* Prevent Safari from caching stale content */}
        <meta httpEquiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
      </head>
      <body style={{ background: '#060B14' }}>{children}</body>
    </html>
  );
}
