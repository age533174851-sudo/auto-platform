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

export type CredentialState = 'CONNECTED' | 'MISSING' | 'INVALID' | 'UNKNOWN';

export interface CredentialProbe {
  credential: string;
  state: CredentialState;
  checkedAtMs: number | null;
  detail: string | null;
}

export interface BootstrapStatus {
  code: 'READY' | 'OPS_BOOTSTRAP_MISSING';
  ready: OpsCapability[];
  missing: CapabilityStatus[];
  summary: string;
}

/**
 * 실제로 써 본 결과를 읽는다.
 *
 * **"값이 있다"와 "그 값으로 된다"는 다른 사실이다.** 만료된 토큰은
 * 있는데 안 되고, 그건 없는 것과 대응이 다르다. 그래서 GitHub Actions가
 * 직접 써 보고 적은 결과(`ops_bootstrap`)를 그대로 읽는다.
 *
 * **기록이 없으면 UNKNOWN이다.** '아마 있겠지'로 읽지 않는다 — 그게
 * 화면에 'Railway'라고 적어 두던 것과 같은 종류의 거짓말이다.
 */
export function credentialStateOf(
  probes: CredentialProbe[] | null | undefined, name: string,
): CredentialState {
  if (!Array.isArray(probes)) return 'UNKNOWN';
  const row = probes.find(p => p && String(p.credential) === name);
  if (!row) return 'UNKNOWN';
  const s = String(row.state).toUpperCase();
  return (s === 'CONNECTED' || s === 'MISSING' || s === 'INVALID') ? (s as CredentialState) : 'UNKNOWN';
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
  /**
   * GitHub Actions가 실제로 써 보고 적은 결과. 없으면 undefined.
   *
   * 이게 있으면 `dbUrl`·`flyToken` 같은 추측 대신 이 값을 쓴다 —
   * **화면(Vercel)은 GitHub Secrets에 무엇이 있는지 볼 수 없다.**
   */
  probes?: CredentialProbe[] | null;
}): BootstrapStatus {
  // 실제로 써 본 결과가 있으면 그것이 우선이다.
  const probed = (name: string, fallback: boolean): { ready: boolean; note: string | null } => {
    const st = credentialStateOf(present?.probes, name);
    if (st === 'CONNECTED') return { ready: true, note: null };
    if (st === 'MISSING') return { ready: false, note: '값이 없습니다' };
    if (st === 'INVALID') return { ready: false, note: '값은 있으나 실제로 동작하지 않습니다 (만료·권한 부족)' };
    // 확인 기록이 없다. **추측하지 않는다** — 화면이 볼 수 있는 것만 본다.
    return { ready: fallback, note: fallback ? null : '아직 확인된 적이 없습니다' };
  };
  const db = probed('SUPABASE_DB_URL', !!present?.dbUrl);
  const fly = probed('FLY_API_TOKEN', !!present?.flyToken);
  const all: CapabilityStatus[] = [
    {
      capability: 'MIGRATE', label: '마이그레이션 자동 적용',
      ready: db.ready,
      // **이게 없으면 신규 진입도 막힌다.** 코드가 요구하는 칸이 DB에
      // 없는 채로 주문을 내면 쓰기가 조용히 실패하기 때문이다.
      withoutIt: '새 표·칸이 DB에 반영되지 않고, 그 상태에서는 신규 자동매매 진입이 막힙니다'
        + ' (이미 열린 포지션의 청산·보호는 계속 동작합니다)',
      missing: db.ready ? [] : [`SUPABASE_DB_URL (GitHub Secrets)${db.note ? ` — ${db.note}` : ''}`],
    },
    {
      capability: 'WORKER_CONTROL', label: '워커 자동 재시작·재배포',
      ready: fly.ready,
      withoutIt: '워커가 멈춰도 시스템이 스스로 되살리지 못합니다',
      missing: fly.ready ? [] : [`FLY_API_TOKEN (GitHub Secrets)${fly.note ? ` — ${fly.note}` : ''}`],
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
