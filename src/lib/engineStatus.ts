// src/lib/engineStatus.ts
// MOCK(브라우저 로컬) 자동매매 엔진의 상태를 localStorage로 공유.
// MockAutoTrade가 매 틱 기록 → 자동매매 상태판이 읽음.
const KEY = 'tg_mock_hb_v1';

export interface MockHeartbeat {
  running: boolean;
  at: number;              // 마지막 기록 시각 (ms)
  intervalSec: number;
  lastDecision?: string;   // 최근 AI 판단 요약
  confidence?: number;
  marketState?: string;
  openPositions?: number;
  todayFills?: number;
}

export function writeMockHeartbeat(hb: Partial<MockHeartbeat>) {
  if (typeof window === 'undefined') return;
  try {
    const prev = readMockHeartbeat();
    window.localStorage.setItem(KEY, JSON.stringify({ ...prev, ...hb, at: Date.now() }));
  } catch {}
}

export function readMockHeartbeat(): MockHeartbeat {
  if (typeof window === 'undefined') return { running: false, at: 0, intervalSec: 0 };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { running: false, at: 0, intervalSec: 0 };
}
