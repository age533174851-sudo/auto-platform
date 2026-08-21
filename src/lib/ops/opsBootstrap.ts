// src/lib/ops/opsBootstrap.ts
//
// **자동화가 못 하는 일은 딱 세 가지뿐이어야 한다.**
//
//   1. 최초 한 번 외부 서비스 권한 연결
//   2. 새 API 키·토큰 자체의 발급
//   3. 실제 자금·파괴적 변경에 대한 명시적 승인
//
// 나머지가 "사용자가 해야 할 것"으로 남아 있으면 그건 자동화 미완성이다.
// 이 파일은 **1번에 해당하는 것만** 골라서, 무엇이 없어서 무엇을 못 하는지
// 한 줄로 말한다.
//
// 값은 다루지 않는다
// ─────────────────
// 있는지 없는지만 본다. 값도, 지문도 여기서는 필요 없다 — 필요한 건
// "이 자동화가 지금 가능한가"뿐이다.

export type OpsCapability =
  /** 마이그레이션 자동 적용 */
  | 'MIGRATE'
  /** 워커 재시작·재배포 */
  | 'WORKER_CONTROL'
  /** 청산 감시 호출 */
  | 'EXIT_MONITOR'
  /** 거래소 조회·주문 */
  | 'EXCHANGE';

export interface CapabilityStatus {
  capability: OpsCapability;
  label: string;
  ready: boolean;
  /** 없으면 무엇을 못 하는가 */
  withoutIt: string;
  /** 무엇이 있어야 하는가 (이름만. **값은 절대 적지 않는다**) */
  missing: string[];
}

export interface BootstrapStatus {
  code: 'READY' | 'OPS_BOOTSTRAP_MISSING';
  ready: OpsCapability[];
  missing: CapabilityStatus[];
  summary: string;
}

/**
 * 지금 시스템이 스스로 할 수 있는 일과 없는 일.
 *
 * 이미 있는 자격을 먼저 재사용한다 — **사용자에게 같은 값을 두 번 넣게
 * 하지 않는다.** 예를 들어 청산 감시는 워커가 이미 가진 `ADMIN_SECRET`을
 * 쓴다. 그래서 여기에 `EXIT_MONITOR_SECRET`은 없다.
 */
export function bootstrapStatus(present: {
  /** DDL을 실행할 수 있는 DB 접속 (SUPABASE_DB_URL 등) */
  dbUrl: boolean;
  /** 워커를 재시작·재배포할 수 있는 토큰 (FLY_API_TOKEN) */
  flyToken: boolean;
  /** 서버끼리 서로를 부를 때 쓰는 값 (ADMIN_SECRET) */
  adminSecret: boolean;
  /** 거래소 키를 푸는 값 */
  encryptionKey: boolean;
  /** 서비스 롤 (읽기·쓰기) */
  serviceRole: boolean;
}): BootstrapStatus {
  const all: CapabilityStatus[] = [
    {
      capability: 'MIGRATE', label: '마이그레이션 자동 적용',
      ready: !!present?.dbUrl,
      withoutIt: '새 표·칸이 생겨도 DB에 반영되지 않습니다 — 코드만 앞서 나갑니다',
      missing: present?.dbUrl ? [] : ['SUPABASE_DB_URL (GitHub Secrets)'],
    },
    {
      capability: 'WORKER_CONTROL', label: '워커 자동 재시작·재배포',
      ready: !!present?.flyToken,
      withoutIt: '워커가 멈춰도 시스템이 스스로 되살리지 못합니다',
      missing: present?.flyToken ? [] : ['FLY_API_TOKEN (GitHub Secrets)'],
    },
    {
      capability: 'EXIT_MONITOR', label: '청산 감시 자동 실행',
      // **새 시크릿을 만들지 않았다.** 워커가 이미 가진 값을 쓴다.
      ready: !!(present?.adminSecret),
      withoutIt: '트레일링·본전 이동·시간 청산이 돌지 않습니다',
      missing: present?.adminSecret ? [] : ['ADMIN_SECRET (Vercel · Fly 공통)'],
    },
    {
      capability: 'EXCHANGE', label: '거래소 조회·주문',
      ready: !!(present?.encryptionKey && present?.serviceRole),
      withoutIt: '저장된 거래소 키를 풀 수 없어 주문이 나가지 않습니다',
      missing: [
        ...(present?.encryptionKey ? [] : ['EXCHANGE_ENCRYPTION_KEY']),
        ...(present?.serviceRole ? [] : ['SUPABASE_SERVICE_ROLE_KEY']),
      ],
    },
  ];

  const missing = all.filter(c => !c.ready);
  const ready = all.filter(c => c.ready).map(c => c.capability);

  if (missing.length === 0) {
    return { code: 'READY', ready, missing: [],
      summary: '외부 서비스 권한이 모두 연결돼 있습니다 — 일상 운영에 사용자가 할 일은 없습니다' };
  }
  return {
    code: 'OPS_BOOTSTRAP_MISSING', ready, missing,
    // **한 번만, 정확히 무엇이 필요한지.** 대시보드를 돌아다니게 하지 않는다.
    summary: `${missing.length}가지 권한이 아직 연결되지 않았습니다: `
      + missing.map(m => m.missing.join(' · ')).join(' / ')
      + ' — 한 번 연결하면 이후 운영에 사람이 개입할 일이 없습니다',
  };
}
