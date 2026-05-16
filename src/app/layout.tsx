import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)',  color: '#060B14' },
    { media: '(prefers-color-scheme: light)', color: '#060B14' },
  ],
};

export const metadata: Metadata = {
  title: 'TRAIGO — 글로벌 투자 시뮬레이션',
  description: '290+ 글로벌 종목 모의투자 · AI 분석 · TradingView 차트 · 완전 무료',
  keywords: ['모의투자','주식','코인','투자','paper trading','트레이딩뷰','자동매매'],
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TRAIGO',
    startupImage: [
      {
        url: '/icon-512.png',
        media: '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)',
      },
    ],
  },
  openGraph: {
    title: 'TRAIGO — 투자 시뮬레이션',
    description: '290+ 종목 모의투자 · AI 분석 · 완전 무료',
    type: 'website',
    images: [{ url: '/icon-512.png', width: 512, height: 512, alt: 'TRAIGO' }],
  },
  twitter: {
    card: 'summary',
    title: 'TRAIGO',
    description: '글로벌 투자 시뮬레이션 플랫폼',
    images: ['/icon-512.png'],
  },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg',        type: 'image/svg+xml' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180' },
      { url: '/icon-192.png',          sizes: '192x192' },
    ],
    shortcut: '/icon-192.png',
  },
  other: {
    'mobile-web-app-capable': 'yes',
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
        <meta name="apple-mobile-web-app-title" content="TRAIGO"/>
        {/* Prevent iOS phone/date detection */}
        <meta name="format-detection" content="telephone=no,date=no,email=no,address=no"/>
        {/* Prevent iOS text size adjustment */}
        <meta name="HandheldFriendly" content="true"/>
        {/* Windows tile */}
        <meta name="msapplication-TileColor" content="#060B14"/>
        <meta name="msapplication-TileImage" content="/icon-192.png"/>
        {/* Preload critical font */}
        <link
          rel="preload"
          href="https://fonts.gstatic.com/s/sora/v12/xMQOuFFYT72X5wkB_18qmnndmSe6f8I.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body style={{ background: '#060B14', margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}
