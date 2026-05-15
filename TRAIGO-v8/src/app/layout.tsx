import React from 'react';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TRAIGO - 글로벌 투자 시뮬레이션 플랫폼',
  description: '170+ 글로벌 종목 · 모의투자 · AI 분석 · 완전 무료',
  keywords: ['모의투자','주식','코인','투자','paper trading'],
  openGraph: { title:'TRAIGO', description:'글로벌 투자 시뮬레이션', type:'website' },
};

export default function RootLayout({ children }: { children: React.ReactNode; }) {
  return (
    <html lang="ko">
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
        <meta name="theme-color" content="#060B14"/>
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
        <link rel="manifest" href="/manifest.json"/>
      </head>
      <body>{children}</body>
    </html>
  );
}
