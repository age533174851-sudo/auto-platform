// src/lib/auth/ownerBootstrap.ts
//
// **자기 계좌에서 잠기지 않게 한다.**
//
// 무엇이 일어났나
// ───────────────
// 거래 권한 표(039)를 만들고 기본값을 VIEW_ONLY로 뒀다. 기본값이 좁은
// 것은 맞다 — "아직 설정 안 한 사람"이 곧 "전부 할 수 있는 사람"이 되면
// 안 된다.
//
// 그런데 **그 표에 값을 넣을 방법을 SQL 말고는 안 만들었다.** 그래서
// 마이그레이션을 실행한 순간 저장소 소유자 본인이 VIEW_ONLY가 됐고,
// 테스트넷 주문이 거래소에 닿기도 전에 막혔다.
//
// 이건 이 저장소에서 계속 고쳐 온 것과 같은 모양이다 — **화면에서 못
// 넣는 값을 서버가 요구하면 그 기능은 죽은 것이다.** 이번엔 내가 그걸
// 만들었다.
//
// 무엇을 하지 않는가
// ──────────────────
//  · **권한 검사를 지우지 않는다.**
//  · **모두를 관리자로 만들지 않는다.**
//  · **회원 등급(admin)이 거래 권한이 되게 하지 않는다.** 그 규칙은
//    그대로다 — 등급은 사용자를 관리하는 축이고, 이건 돈을 거는 축이다.
//
// 대신 **한 사람만** 환경변수로 지정한다. 그 값은 서버에만 있고,
// 클라이언트가 보낼 수 없다.
//
// 왜 환경변수인가
// ───────────────
// 첫 권한을 줄 사람이 있어야 한다. 그 사람을 데이터베이스에서 정하면
// 데이터베이스에 넣을 방법이 다시 필요해지고, 그게 지금 막힌 자리다.
// 배포 설정은 이미 사람이 손으로 넣는 곳이라 순환이 끊긴다.

import { capabilityOf, type TradingCapability } from './tradingCapability';

export interface OwnerBootstrap {
  /** 이 사용자에게 부트스트랩 권한을 줄 것인가 */
  applies: boolean;
  capability: TradingCapability | null;
  /** 왜 그렇게 봤는가 */
  reason: string;
  /** 소유자 지정 자체가 설정돼 있는가 */
  configured: boolean;
}

/**
 * 이 사용자가 지정된 소유자인가.
 *
 * `OWNER_USER_ID` — auth 사용자 id 하나. 쉼표로 여럿도 받는다(개발자
 * 계정이 둘인 경우). 비어 있으면 아무에게도 적용되지 않는다.
 *
 * `OWNER_CAPABILITY` — 줄 권한. 없으면 TESTNET이다. **LIVE_AUTO가
 * 기본이 되면 안 된다** — 잠긴 것을 푸는 것이 목적이지 실전을 켜는 것이
 * 아니고, 실전은 언제나 한 번 더 명시적으로 고르는 것이어야 한다.
 */
export function ownerBootstrap(
  userId: string | null | undefined,
  env: (k: string) => string | undefined = k => process.env[k],
): OwnerBootstrap {
  const raw = String(env('OWNER_USER_ID') ?? '').trim();
  const uid = String(userId ?? '').trim();

  if (!raw) {
    return { applies: false, capability: null, configured: false,
      reason: 'OWNER_USER_ID가 설정되지 않았습니다 — 부트스트랩이 아무에게도 적용되지 않습니다' };
  }
  if (!uid) {
    return { applies: false, capability: null, configured: true,
      reason: '사용자를 확인하지 못했습니다' };
  }

  const owners = raw.split(',').map(s => s.trim()).filter(Boolean);
  // **부분 일치를 받지 않는다.** 앞 몇 글자만 맞아도 통과하면 그건
  // 권한 검사가 아니다.
  if (!owners.includes(uid)) {
    return { applies: false, capability: null, configured: true,
      reason: '지정된 소유자가 아닙니다' };
  }

  const want = String(env('OWNER_CAPABILITY') ?? '').trim();
  // 지정이 없으면 TESTNET이다. 실전은 언제나 한 번 더 명시적으로 고른다.
  const cap = want ? capabilityOf(want) : ('TESTNET' as TradingCapability);

  return {
    applies: true, capability: cap, configured: true,
    reason: `OWNER_USER_ID로 지정된 계정입니다 — ${cap} 권한을 적용합니다`
      + (want ? '' : ' (OWNER_CAPABILITY 미설정이라 기본값 TESTNET)'),
  };
}

/**
 * 읽어 온 권한에 부트스트랩을 얹는다.
 *
 * **넓히는 쪽으로만 얹는다.** 저장된 값이 이미 더 넓으면 그대로 둔다 —
 * 환경변수 하나가 사람이 명시적으로 준 권한을 깎으면, 그건 부트스트랩이
 * 아니라 덮어쓰기다.
 */
export function applyBootstrap(
  stored: TradingCapability, boot: OwnerBootstrap,
  rank: Record<string, number>,
): { capability: TradingCapability; bootstrapped: boolean; reason: string } {
  if (!boot.applies || !boot.capability) {
    return { capability: stored, bootstrapped: false, reason: '' };
  }
  const cur = rank[stored] ?? 0;
  const next = rank[boot.capability] ?? 0;
  if (next <= cur) {
    return { capability: stored, bootstrapped: false,
      reason: '저장된 권한이 이미 같거나 넓어 부트스트랩을 적용하지 않았습니다' };
  }
  return { capability: boot.capability, bootstrapped: true, reason: boot.reason };
}
