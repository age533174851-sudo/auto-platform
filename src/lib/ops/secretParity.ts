// src/lib/ops/secretParity.ts
//
// **웹과 워커가 같은 것을 보고 있는가.**
//
// 두 서비스가 같은 값을 들고 있어야 하는 자리가 아직 셋 남아 있다.
// 없앨 수 있는 것은 없앴다(EXIT_MONITOR_SECRET은 사라졌다). 남은 셋은
// 성질상 없앨 수 없다 — 웹과 워커가 **같은 데이터베이스**를 봐야 하고
// **같은 키로** 거래소 비밀을 풀어야 하기 때문이다.
//
// 그래서 없애는 대신 **어긋난 것을 조용히 지나가지 못하게** 한다.
//
// 왜 이게 위험한가
// ────────────────
// 암호화 키가 다르면 워커는 저장된 거래소 키를 풀지 못한다. 그런데
// 그 증상은 "키가 틀렸다"로 보이고, 사람은 거래소에서 키를 다시 발급받는다.
// 새 키를 넣어도 똑같이 안 되고, 그 사이 자동매매는 계속 시도한다.
//
// 데이터베이스가 다르면 더 조용하다. 워커는 멀쩡히 돌고, 배포는 성공이고,
// Fly는 started라고 하는데 **화면은 아무것도 못 본다.** 2026-08-19에
// 그것 때문에 사흘을 잃었다.
//
// 값은 다루지 않는다
// ─────────────────
// 지문(sha256 앞 6자)만 비교한다. 되찾을 수 없고, 같은지 다른지만 말한다.

export type Parity = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

export interface SecretPair {
  name: string;
  label: string;
  parity: Parity;
  /** 다르면 무슨 일이 나는가 */
  consequence: string;
  /** 이것 때문에 새 주문을 막아야 하는가 */
  blocksEntry: boolean;
}

function cmp(a: string | null | undefined, b: string | null | undefined): Parity {
  const x = String(a ?? '').trim(), y = String(b ?? '').trim();
  // **한쪽이라도 없으면 "같다"고 말하지 않는다.**
  if (!x || !y) return 'UNKNOWN';
  return x === y ? 'SAME' : 'DIFFERENT';
}

export interface ParityReport {
  code: 'SAME' | 'DIFFERENT' | 'UNKNOWN';
  pairs: SecretPair[];
  /** 새 주문을 내도 되는가 */
  entryAllowed: boolean;
  entryReason: string;
  summary: string;
}

/**
 * 웹과 워커의 지문을 맞춰 본다.
 *
 * **어긋나면 새 주문을 막는다.** 열려 있는 포지션의 청산은 막지 않는다 —
 * 못 여는 것은 불편이고 못 닫는 것은 사고다.
 */
export function secretParity(i: {
  webSupabaseFp: string | null | undefined;
  workerSupabaseFp: string | null | undefined;
  webEncryptionFp: string | null | undefined;
  workerEncryptionFp: string | null | undefined;
  /** 워커 기록 자체가 없으면(=아직 안 떴거나 057 이전) 비교할 것이 없다 */
  workerPresent: boolean;
}): ParityReport {
  if (!i?.workerPresent) {
    return {
      code: 'UNKNOWN', pairs: [], entryAllowed: true,
      entryReason: '워커가 지문을 아직 적지 않아 비교하지 않았습니다 (이 기준으로는 막지 않습니다)',
      summary: '워커 지문 기록이 없습니다 — 다음 배포에서 채워집니다',
    };
  }

  const pairs: SecretPair[] = [
    {
      name: 'SUPABASE_URL', label: '데이터베이스',
      parity: cmp(i.webSupabaseFp, i.workerSupabaseFp),
      consequence: '워커가 다른 데이터베이스에 씁니다 — 워커는 멀쩡히 도는데 화면은 아무것도 못 봅니다',
      blocksEntry: true,
    },
    {
      name: 'EXCHANGE_ENCRYPTION_KEY', label: '거래소 키 암호화',
      parity: cmp(i.webEncryptionFp, i.workerEncryptionFp),
      consequence: '워커가 저장된 거래소 키를 풀지 못합니다 — 증상은 "키가 틀렸다"로 보입니다',
      blocksEntry: true,
    },
  ];

  const different = pairs.filter(p => p.parity === 'DIFFERENT');
  const unknown = pairs.filter(p => p.parity === 'UNKNOWN');

  if (different.length > 0) {
    const blocking = different.filter(p => p.blocksEntry);
    return {
      code: 'DIFFERENT', pairs,
      entryAllowed: blocking.length === 0,
      entryReason: blocking.length === 0 ? '어긋난 값이 진입을 막지는 않습니다'
        : `${blocking.map(b => b.label).join(' · ')}이(가) 웹과 워커에서 다릅니다 — `
          + '새 주문을 막습니다. 이미 열린 포지션의 청산·보호는 계속 동작합니다',
      summary: different.map(d => `${d.label}: ${d.consequence}`).join(' / '),
    };
  }
  if (unknown.length > 0) {
    // 아직 한쪽이 안 적었다. **막지는 않는다** — 지문이 없다는 것은
    // 값이 다르다는 뜻이 아니고, 여기서 막으면 배포 직후마다 매매가 멎는다.
    return {
      code: 'UNKNOWN', pairs, entryAllowed: true,
      entryReason: `${unknown.map(u => u.label).join(' · ')} 지문이 아직 없어 비교하지 못했습니다`,
      summary: '일부 지문을 비교하지 못했습니다 — 같다는 뜻도 다르다는 뜻도 아닙니다',
    };
  }
  return {
    code: 'SAME', pairs, entryAllowed: true,
    entryReason: '웹과 워커가 같은 것을 보고 있습니다',
    summary: '데이터베이스·암호화 키 지문이 웹과 워커에서 같습니다',
  };
}

// ── 어디를 맞춰야 하는가 ──

export interface SyncTarget {
  name: string;
  /** GitHub Secrets에 있는가 */
  inSource: boolean;
  /** 이 값을 받아야 하는 곳 */
  destinations: Array<'vercel' | 'fly'>;
  /** 자동으로 밀어 넣을 수 있는가 */
  canPush: boolean;
  why: string;
}

/**
 * 값을 맞추는 일을 **사람이 두 대시보드를 오가며** 하지 않게 한다.
 *
 * 다만 값을 밀어 넣는 것은 되돌리기 어려운 일이다(워커가 재시작하고,
 * 틀린 값을 밀면 그 순간 전부 멈춘다). 그래서 **기본은 확인만**이고,
 * 밀어 넣는 것은 명시적 승인이 있을 때만이다.
 */
export function syncPlan(i: {
  /** GitHub Secrets에 있는 이름들 (값이 아니라 이름) */
  available: string[];
  /** Fly에 밀어 넣을 자격이 있는가 */
  canPushFly: boolean;
  /** Vercel에 밀어 넣을 자격이 있는가 */
  canPushVercel: boolean;
}): { targets: SyncTarget[]; blocked: string[] } {
  const has = (n: string) => (Array.isArray(i?.available) ? i.available : []).includes(n);

  const targets: SyncTarget[] = [
    {
      name: 'SUPABASE_URL', inSource: has('SUPABASE_URL'), destinations: ['vercel', 'fly'],
      canPush: !!i?.canPushFly, why: '웹과 워커가 같은 데이터베이스를 봐야 합니다',
    },
    {
      name: 'SUPABASE_SERVICE_ROLE_KEY', inSource: has('SUPABASE_SERVICE_ROLE_KEY'),
      destinations: ['vercel', 'fly'], canPush: !!i?.canPushFly,
      why: '워커가 표를 읽고 쓰려면 필요합니다',
    },
    {
      name: 'EXCHANGE_ENCRYPTION_KEY', inSource: has('EXCHANGE_ENCRYPTION_KEY'),
      destinations: ['vercel', 'fly'], canPush: !!i?.canPushFly,
      why: '저장된 거래소 키를 같은 키로 풀어야 합니다',
    },
    {
      name: 'ADMIN_SECRET', inSource: has('ADMIN_SECRET'), destinations: ['vercel', 'fly'],
      canPush: !!i?.canPushFly,
      why: '워커가 웹의 청산 감시를 부를 때 씁니다',
    },
  ];

  const blocked: string[] = [];
  for (const t of targets) {
    if (!t.inSource) blocked.push(`${t.name}: 기준값이 GitHub Secrets에 없습니다`);
  }
  if (!i?.canPushVercel) {
    blocked.push('Vercel: 관리 토큰이 없어 자동으로 밀어 넣지 못합니다 (VERCEL_TOKEN)');
  }
  if (!i?.canPushFly) {
    blocked.push('Fly: 관리 토큰이 없어 자동으로 밀어 넣지 못합니다 (FLY_API_TOKEN)');
  }
  return { targets, blocked };
}
