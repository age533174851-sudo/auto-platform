// src/lib/auth/promotionMap.ts
//
// "이 이메일에 어떤 등급을 줄 것인가" — **순수 함수**.
//
// ensureAdmin.ts에서 이 부분만 떼어낸 이유: 그 파일은 Supabase 클라이언트를
// 들고 있어서 테스트에서 부를 수 없다. 그런데 여기서 틀리면 결과가
// **권한 상승**이다 — 목록 파싱이 헐거우면 의도하지 않은 계정이 관리자가
// 되고, 등급 비교가 틀리면 소유자가 강등된다. 둘 다 화면에서는 안 보인다.
//
// 그래서 env 문자열을 받아 map을 만드는 부분만 따로 두고 테스트를 붙인다.

import { ROLE_RANK, type UserRole } from '../auth';

/**
 * 환경변수로 줄 수 있는 등급.
 *
 * 이 셋 말고는 환경변수로 못 준다. `founder`나 `vip` 같은 요금제성 등급을
 * 여기 넣으면 결제 상태와 환경변수가 서로 다른 말을 하게 된다.
 */
export const GRANTABLE_SOURCES: { env: string[]; role: UserRole }[] = [
  { env: ['ADMIN_EMAILS', 'ADMIN_EMAIL'], role: 'admin' },
  { env: ['DEVELOPER_EMAILS'],            role: 'developer' },
  { env: ['SUPER_ADMIN_EMAILS'],          role: 'super_admin' },
];

/** 쉼표·세미콜론·공백 어느 것으로 나눠도 받는다. @ 없는 조각은 버린다 */
export function parseEmailList(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .split(/[,;\s]+/)
    .map(p => p.trim().toLowerCase())
    .filter(e => e.length > 2 && e.includes('@'));
}

/**
 * 환경변수 읽기 함수를 받아 이메일 → 등급 맵을 만든다.
 *
 * 한 이메일이 여러 목록에 있으면 **가장 높은 등급**이 이긴다. 목록을 읽는
 * 순서에 따라 결과가 달라지면 안 되기 때문이다.
 */
export function buildPromotionMap(
  readEnv: (name: string) => string | undefined,
  sources = GRANTABLE_SOURCES,
): Map<string, UserRole> {
  const map = new Map<string, UserRole>();
  for (const { env, role } of sources) {
    for (const name of env) {
      for (const email of parseEmailList(readEnv(name))) {
        const prev = map.get(email);
        if (!prev || ROLE_RANK[role] > ROLE_RANK[prev]) map.set(email, role);
      }
    }
  }
  return map;
}

/**
 * 지금 등급에서 목표 등급으로 **올려야 하는가**.
 *
 * 올리기만 한다. 목표보다 높으면 그대로 두고, 등급 이름을 모르면 건드리지
 * 않는다 — 모르는 값을 낮은 것으로 취급해 덮어쓰면 그게 강등이 된다.
 */
export function shouldPromote(
  currentRole: string | null | undefined,
  target: UserRole | null,
): { promote: boolean; reason: string } {
  if (!target) return { promote: false, reason: '승급 목록에 없습니다' };

  const cur = String(currentRole ?? '').trim();
  if (!cur) return { promote: true, reason: `등급 없음 → ${target}` };

  const curRank = ROLE_RANK[cur as UserRole];
  if (typeof curRank !== 'number') {
    return { promote: false, reason: `알 수 없는 등급 '${cur}' — 승급하지 않습니다` };
  }
  if (curRank >= ROLE_RANK[target]) {
    return { promote: false, reason: `이미 ${cur} (${target} 이상)` };
  }
  return { promote: true, reason: `${cur} → ${target}` };
}
