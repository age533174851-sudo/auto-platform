// src/lib/env/schema.ts
// 환경변수 검증 (zod) — 필수 누락은 error, 기능별 선택 키는 warn.
// 시작 시 1회 검증해 배포 설정 실수를 조기에 잡는다.
import { z } from 'zod';

// ── 핵심(필수): 없으면 앱 기본 동작 불가 ──
const coreSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url({ message: 'Supabase URL 형식이 아님' }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, 'anon key가 너무 짧음'),
});

// ── 실전 자동매매(주문 실행)에 필요 ──
const tradingKeys = ['SUPABASE_SERVICE_ROLE_KEY', 'WEBHOOK_SECRET', 'ENCRYPTION_KEY'] as const;

// ── 기능별 선택 키 (없으면 해당 기능만 비활성/모의) ──
const featureKeys: { key: string; feature: string }[] = [
  { key: 'OPENAI_API_KEY', feature: 'AI 뉴스 번역·브리핑' },
  { key: 'POLYGON_API_KEY', feature: '미국주식 실시간 시세' },
  { key: 'FINNHUB_API_KEY', feature: '미국주식 시세(대체)' },
  { key: 'TELEGRAM_BOT_TOKEN', feature: '텔레그램 알림' },
  { key: 'TELEGRAM_CHAT_ID', feature: '텔레그램 알림 대상' },
  { key: 'UPSTASH_REDIS_REST_URL', feature: '분산 락/캐시(Redis)' },
];

export interface EnvReport {
  ok: boolean;
  errors: string[];      // 필수 누락/형식 오류 (배포 차단 권고)
  warnings: string[];    // 선택 키 누락 (기능 저하)
  configured: string[];  // 설정된 키 목록 (값 노출 X)
  missingTrading: string[];
}

function present(v: string | undefined): boolean { return typeof v === 'string' && v.trim().length > 0; }

export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const configured: string[] = [];

  // 핵심 검증
  const core = coreSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!core.success) {
    for (const issue of core.error.issues) errors.push(`[필수] ${issue.path.join('.')}: ${issue.message}`);
  } else {
    configured.push('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  // 실전 자동매매 키 (경고 — 실전 안 쓰면 없어도 됨)
  const missingTrading: string[] = [];
  for (const k of tradingKeys) {
    if (present(env[k])) configured.push(k);
    else missingTrading.push(k);
  }
  if (missingTrading.length) warnings.push(`[실전거래] 미설정: ${missingTrading.join(', ')} — 실전/테스트넷 자동매매 시 필요`);

  // 기능 키
  for (const { key, feature } of featureKeys) {
    if (present(env[key])) configured.push(key);
    else warnings.push(`[기능] ${key} 미설정 → ${feature} 비활성(또는 모의)`);
  }

  return { ok: errors.length === 0, errors, warnings, configured, missingTrading };
}

// 시작 시 1회 검증 + 중앙 로거로 결과 보고 (중복 실행 방지)
let validated = false;
export function validateEnvOnce(): EnvReport {
  const report = validateEnv();
  if (!validated) {
    validated = true;
    // 동적 import로 순환참조 회피
    import('@/lib/log/logger').then(({ log }) => {
      if (report.errors.length) report.errors.forEach(e => log.fatal('env', e));
      if (report.warnings.length) report.warnings.forEach(w => log.warn('env', w));
      log.info('env', `환경변수 검증 완료 — 설정 ${report.configured.length}개 · 오류 ${report.errors.length} · 경고 ${report.warnings.length}`);
    }).catch(() => {});
  }
  return report;
}
