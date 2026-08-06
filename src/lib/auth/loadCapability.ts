// src/lib/auth/loadCapability.ts
//
// 저장된 거래 권한을 읽는다.
//
// **못 읽으면 가장 좁은 쪽이다.** 조회가 실패했을 때 넓은 쪽으로
// 떨어지면, 데이터베이스가 흔들리는 순간 모두가 실전 자동매매를 켤 수
// 있게 된다. 확인하지 못한 것은 통과가 아니다.

import { capabilityOf, DEFAULT_CAPABILITY, type TradingCapability } from './tradingCapability';

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
}

export async function loadCapability(
  sb: any, userId: string | null | undefined,
): Promise<CapabilityRead> {
  if (!sb || !userId) {
    return { capability: DEFAULT_CAPABILITY, known: false, installed: true,
      reason: '사용자를 확인하지 못해 가장 좁은 권한으로 봅니다' };
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
      return { capability: DEFAULT_CAPABILITY, known: false, installed: true,
        reason: `권한을 읽지 못했습니다 (${error.message}) — 가장 좁은 권한으로 봅니다` };
    }
    if (!data) {
      // 행이 없는 것은 오류가 아니다. **아직 아무 권한도 안 준 것**이고,
      // 그건 기본값이 맞다.
      return { capability: DEFAULT_CAPABILITY, known: true, installed: true,
        reason: '아직 거래 권한이 부여되지 않았습니다' };
    }
    return { capability: capabilityOf(data.capability), known: true, installed: true, reason: '' };
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
