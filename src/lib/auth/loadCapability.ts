// src/lib/auth/loadCapability.ts
//
// 저장된 거래 권한을 읽는다.
//
// **못 읽으면 가장 좁은 쪽이다.** 조회가 실패했을 때 넓은 쪽으로
// 떨어지면, 데이터베이스가 흔들리는 순간 모두가 실전 자동매매를 켤 수
// 있게 된다. 확인하지 못한 것은 통과가 아니다.

import { capabilityOf, CAP_RANK, DEFAULT_CAPABILITY, type TradingCapability } from './tradingCapability';
import { ownerBootstrap, applyBootstrap } from './ownerBootstrap';

export interface CapabilityRead {
  capability: TradingCapability;
  /** 실제로 읽었는가. false면 기본값으로 떨어진 것이다 */
  known: boolean;
  /**
   * 권한 체계가 **설치되어 있는가.**
   *
   * 이 구분이 중요한 이유
   * ─────────────────────
   * 마이그레이션을 아직 안 돌렸으면 표 자체가 없다. 그때 '가장 좁은
   * 권한'으로 막으면 **아무도 주문을 못 낸다** — 그리고 그걸 푸는
   * 유일한 방법이 SQL 실행이라, 사용자는 자기 계좌에서 잠긴다.
   *
   * 그건 안전이 아니라 고장이다. 아직 아무도 설정하지 않은 정책을
   * 강제하는 것이기 때문이다.
   *
   * 그래서 **표가 없으면 통과시키되 그 사실을 크게 적는다.** 지금
   * 상태는 권한 체계가 없던 어제와 같고, 표를 만드는 순간 엄격해진다.
   *
   * 반면 표는 있는데 **조회가 실패한 것**은 진짜 모름이다 — 그때는
   * 막는다. 둘을 같게 다루면 하나는 반드시 틀린다.
   */
  installed: boolean;
  /** 왜 그렇게 봤는가. 통과했으면 빈 문자열 */
  reason: string;
  /** OWNER_USER_ID 부트스트랩으로 넓어졌는가 */
  bootstrapped?: boolean;
}

/**
 * 저장된 값에 소유자 부트스트랩을 얹는다.
 *
 * **표에 값을 넣을 방법이 SQL뿐이면 잠긴 사람을 풀 수 없다.** 첫 권한을
 * 줄 사람을 데이터베이스에서 정하면 데이터베이스에 넣을 방법이 다시
 * 필요해지고, 그게 지금 막힌 자리다. 배포 설정은 이미 사람이 손으로
 * 넣는 곳이라 순환이 끊긴다.
 *
 * 넓히는 쪽으로만 얹는다 — 저장된 값이 이미 더 넓으면 그대로 둔다.
 */
function withBootstrap(read: CapabilityRead, userId: string, email?: string | null): CapabilityRead {
  const boot = ownerBootstrap({ userId, email });
  const r = applyBootstrap(read.capability, boot, CAP_RANK);
  if (!r.bootstrapped) return read;
  return {
    ...read, capability: r.capability, known: true, bootstrapped: true,
    reason: r.reason,
  };
}

export async function loadCapability(
  sb: any, userId: string | null | undefined,
  /**
   * 이메일. **OWNER_EMAIL로 지정한 경우 이게 없으면 영영 안 맞는다.**
   * 안 넘겨도 되지만, 그러면 이메일 지정은 동작하지 않는다 — 그래서
   * 못 넘긴 경우 아래에서 한 번 조회한다.
   */
  email?: string | null,
): Promise<CapabilityRead> {
  if (!sb || !userId) {
    return { capability: DEFAULT_CAPABILITY, known: false, installed: true,
      reason: '사용자를 확인하지 못해 가장 좁은 권한으로 봅니다' };
  }
  // 이메일을 안 받았고 OWNER_EMAIL이 설정돼 있으면 한 번 찾아본다.
  // **설정이 없으면 조회도 안 한다** — 아무도 안 쓰는 값을 위해 매
  // 주문마다 요청을 하나 더 보낼 이유가 없다.
  let mail = String(email ?? '').trim();
  if (!mail && String(process.env.OWNER_EMAIL ?? '').trim()) {
    try {
      const r = await (sb as any).auth?.admin?.getUserById?.(userId);
      mail = String(r?.data?.user?.email ?? '').trim();
    } catch { /* 못 읽으면 id로만 맞춰 본다 */ }
  }

  try {
    const { data, error } = await (sb as any).from('trading_capabilities')
      .select('capability').eq('user_id', userId).maybeSingle();
    if (error) {
      if (isMissingTable(error)) {
        return { capability: DEFAULT_CAPABILITY, known: false, installed: false,
          reason: '거래 권한 체계가 아직 설치되지 않았습니다 — '
                + '마이그레이션 039_trading_capability.sql을 실행하기 전까지는 권한을 강제하지 않습니다' };
      }
      // **조회 실패에는 부트스트랩을 얹지 않는다.** 진짜 모르는 상태이고,
      // 여기서 넓히면 데이터베이스가 흔들릴 때마다 소유자 권한이 살아난다.
      return { capability: DEFAULT_CAPABILITY, known: false, installed: true,
        reason: `권한을 읽지 못했습니다 (${error.message}) — 가장 좁은 권한으로 봅니다` };
    }
    if (!data) {
      // 행이 없는 것은 오류가 아니다. **아직 아무 권한도 안 준 것**이고,
      // 그건 기본값이 맞다.
      return withBootstrap({ capability: DEFAULT_CAPABILITY, known: true, installed: true,
        reason: '아직 거래 권한이 부여되지 않았습니다' }, userId, mail);
    }
    return withBootstrap(
      { capability: capabilityOf(data.capability), known: true, installed: true, reason: '' },
      userId, mail);
  } catch (e: any) {
    if (isMissingTable(e)) {
      return { capability: DEFAULT_CAPABILITY, known: false, installed: false,
        reason: '거래 권한 체계가 아직 설치되지 않았습니다' };
    }
    return { capability: DEFAULT_CAPABILITY, known: false, installed: true,
      reason: `권한 조회 실패 (${e?.message || e}) — 가장 좁은 권한으로 봅니다` };
  }
}

/**
 * 표가 없어서 실패한 것인가.
 *
 * PostgREST는 없는 표를 42P01로 돌려준다. 문구만 보고 가리면 다른
 * 오류가 '설치 안 됨'으로 읽혀 권한 검사가 통째로 열린다 — 그래서
 * 코드를 먼저 보고, 코드가 없을 때만 문구를 본다.
 */
function isMissingTable(err: any): boolean {
  const code = String(err?.code ?? '');
  if (code) return code === '42P01' || code === 'PGRST205';
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table');
}
