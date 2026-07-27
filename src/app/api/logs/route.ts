// src/app/api/logs/route.ts
// 최근 로그 조회 (관리자/디버깅용). 링버퍼 기반.
import { NextRequest, NextResponse } from 'next/server';
import { getRecentLogs, type LogLevel } from '@/lib/log/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const level = (searchParams.get('level') || undefined) as LogLevel | undefined;
  const limit = Math.min(300, Number(searchParams.get('limit')) || 100);
  const logs = getRecentLogs(level, limit);
  const counts = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } as Record<string, number>;
  for (const l of getRecentLogs(undefined, 300)) counts[l.level] = (counts[l.level] || 0) + 1;
  return NextResponse.json({ count: logs.length, counts, logs });
}
