// src/lib/portfolio/walletTruthView.ts
//
// **"없음"과 "확인 못 함"을 화면이 섞지 않게 한다.**
//
// 실제로 화면이 이렇게 말한 적이 있다 — 동시에, 한 화면에서:
//
//   auth_required
//   이 환경에 연결된 계좌가 없습니다
//   다른 환경의 계좌 8개는 합산에서 제외
//
// 세 문장이 서로 모순이다. 인증이 안 돼서 **아무것도 못 읽었는데**
// "계좌가 없다"고 단정했고, 동시에 "다른 환경 계좌 8개"라는 숫자는
// 어디선가 만들어 냈다. 그리고 `auth_required`는 서버 내부 코드다 —
// 사용자에게 보여 줄 말이 아니다.
//
// 셋을 가른다
// ──────────
//   AUTH_UNKNOWN     로그인이 안 됐거나 만료됐다. **잔고를 모른다**
//   ACCOUNT_UNKNOWN  계좌 목록을 못 읽었다. **계좌가 없다는 뜻이 아니다**
//   BALANCE_UNKNOWN  계좌는 아는데 잔고를 못 읽었다
//   NO_ACCOUNT       **읽었고**, 정말 없다
//
// 마지막 것만 "없다"고 말할 수 있다.

export type WalletTruth =
  | 'OK'
  | 'AUTH_UNKNOWN'
  | 'ACCOUNT_UNKNOWN'
  | 'BALANCE_UNKNOWN'
  | 'NO_ACCOUNT';

export interface WalletTruthView {
  code: WalletTruth;
  /** 사용자에게 그대로 보여 줄 한 줄. **서버 코드가 들어가지 않는다** */
  message: string;
  /** 계좌 수를 말해도 되는가 */
  canStateAccounts: boolean;
  /** 잔고를 말해도 되는가 */
  canStateBalance: boolean;
  /** 다시 로그인해야 하는가 */
  needsLogin: boolean;
}

/** 서버 내부 코드가 화면에 새는 것을 막는다 */
const RAW_CODES: Record<string, string> = {
  auth_required: '로그인이 필요합니다',
  supabase_not_configured: '서버 설정을 확인하지 못했습니다',
  unauthorized: '로그인이 필요합니다',
  forbidden: '이 계정에는 권한이 없습니다',
};

/** 코드처럼 생겼는가 (snake_case 한 덩어리에 공백 없음) */
export function looksLikeCode(s: string): boolean {
  const t = String(s ?? '').trim();
  if (!t || /\s/.test(t)) return false;
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t);
}

/**
 * 서버 응답 → 화면이 할 말.
 *
 * **못 읽은 것을 "없음"으로 만들지 않는다.** 그리고 서버 코드를 그대로
 * 내보내지 않는다 — `auth_required`를 본 사용자는 무엇을 해야 할지 모른다.
 */
export function walletTruthOf(i: {
  /** HTTP 상태. 연결 자체가 안 됐으면 null */
  status: number | null;
  /** 응답 본문 */
  body?: { ok?: boolean; error?: string | null; message?: string | null } | null;
  /** 네트워크 예외 메시지 */
  networkError?: string | null;
  /** 서버가 읽어 준 연결 수. **못 읽었으면 null** */
  connections?: number | null;
}): WalletTruthView {
  const status = i?.status ?? null;
  const raw = String(i?.body?.error ?? '').trim();

  if (status === 401 || status === 403 || raw === 'auth_required' || raw === 'unauthorized') {
    return {
      code: 'AUTH_UNKNOWN',
      message: '로그인이 만료돼 지갑을 읽지 못했습니다 — 잔고나 계좌가 없다는 뜻이 아닙니다',
      // **아무것도 못 읽었다.** 계좌 수도 잔고도 말할 수 없다.
      canStateAccounts: false, canStateBalance: false, needsLogin: true,
    };
  }

  if (status == null) {
    return {
      code: 'ACCOUNT_UNKNOWN',
      message: `지갑을 읽지 못했습니다${i?.networkError ? ` (${String(i.networkError).slice(0, 120)})` : ''}`
        + ' — 잔고가 0이라는 뜻이 아닙니다',
      canStateAccounts: false, canStateBalance: false, needsLogin: false,
    };
  }

  if (status >= 400 || i?.body?.ok !== true) {
    const msg = String(i?.body?.message ?? '').trim();
    // 서버가 사람이 읽을 문장을 줬으면 그것을 쓰고, 코드만 왔으면 옮긴다.
    const human = msg && !looksLikeCode(msg) ? msg
      : (RAW_CODES[raw] || '지갑을 읽지 못했습니다');
    return {
      code: 'ACCOUNT_UNKNOWN',
      message: `${human} — 잔고나 계좌가 없다는 뜻이 아닙니다`,
      canStateAccounts: false, canStateBalance: false, needsLogin: false,
    };
  }

  // 여기부터는 서버를 읽었다.
  if (i?.connections == null) {
    return {
      code: 'ACCOUNT_UNKNOWN',
      message: '계좌 정보를 확인하지 못했습니다 — 계좌가 없다는 뜻이 아닙니다',
      canStateAccounts: false, canStateBalance: false, needsLogin: false,
    };
  }
  if (i.connections === 0) {
    // **읽었고, 정말 없다.** 이때만 "없다"고 말할 수 있다.
    return {
      code: 'NO_ACCOUNT',
      message: '연결된 거래소 계좌가 없습니다',
      canStateAccounts: true, canStateBalance: true, needsLogin: false,
    };
  }
  return {
    code: 'OK', message: '',
    canStateAccounts: true, canStateBalance: true, needsLogin: false,
  };
}

/**
 * 이 환경의 안내 문구.
 *
 * **환경에 계좌가 없는 것**과 **계좌 목록을 못 읽은 것**을 가른다.
 * 앞엣것만 "없습니다"라고 적는다.
 */
export function envNoteOf(i: {
  truth: WalletTruthView;
  env: string;
  /** 이 환경의 연결 수 */
  envConnections: number | null;
  /** 서버가 준 원래 안내(부분 실패 등) */
  serverNote?: string | null;
}): string {
  if (!i?.truth?.canStateAccounts) {
    // 못 읽었다. **여기서 "없습니다"라고 적으면 그게 그 모순이다.**
    return i.truth?.message || '계좌 정보를 확인하지 못했습니다';
  }
  if (i.envConnections == null) return '이 환경의 계좌 수를 확인하지 못했습니다';
  if (i.envConnections === 0) return `${i.env} 환경에 연결된 계좌가 없습니다`;
  return String(i.serverNote ?? '');
}

/**
 * "다른 환경의 계좌 N개는 합산에서 제외" — 그 N을 말해도 되는가.
 *
 * 같은 canonical source(서버가 준 계좌 목록)에서만 센다. 화면이 따로
 * 세면 두 숫자가 갈리고, 실제로 **아무것도 못 읽은 화면이 "8개"라고
 * 말한 적이 있다.**
 */
export function otherEnvNote(i: {
  truth: WalletTruthView;
  /** 서버가 준 전체 계좌 목록의 환경들 */
  accountEnvs: Array<string | null> | null;
  currentEnv: string;
}): string | null {
  if (!i?.truth?.canStateAccounts) return null;   // 못 읽었으면 숫자를 말하지 않는다
  if (!Array.isArray(i.accountEnvs)) return null;
  const others = i.accountEnvs.filter(e => String(e ?? '') !== i.currentEnv);
  if (others.length === 0) return null;
  const unknown = others.filter(e => !e).length;
  return `다른 환경의 계좌 ${others.length}개는 합산에서 제외했습니다`
    + (unknown > 0 ? ` (환경을 모르는 ${unknown}개 포함 — 어느 쪽에도 넣지 않았습니다)` : '');
}
