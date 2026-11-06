// src/lib/engine/connectionCreds.ts
//
// **연결 자격을 읽는 길을 하나로 만든다.**
//
// `exit-monitor`에는 같은 `credsOf`가 **두 벌** 있었다(보호주문 고아 정리
// 경로와 생명주기·Exact100X 경로). 두 벌이라서 실패 사유를 한 쪽만
// 고쳤고, 나머지 한 쪽은 세 가지 다른 사실을 계속 한 문장으로 뭉갰다.
// 같은 판단이 두 곳에 있으면 언젠가 갈린다 — 실제로 갈려 있었다.
//
// ★ 진단 **판정**은 여기 없다. `testnetReadiness.diagnoseCredential`이
//   정본이고 이 파일은 그 정본에 넘길 사실(있다/없다)만 모은다.
//
// ★ 진단에 시크릿 **값**을 넘기지 않는다. 평문은 이 파일 안에서만 쓰이고
//   진단 입력에는 boolean만 들어간다.
import { diagnoseCredential, type CredentialDiagnosis } from './testnetReadiness';

/** 거래소를 부를 때 쓰는 자격. **이 값은 로그에 싣지 않는다** */
export interface VenueCreds {
  exchange: 'binance' | 'gate';
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface CredsReader {
  /** 쓸 수 있으면 자격, 아니면 null. 이유는 `codeOf`가 말한다 */
  get(connectionId: string): Promise<VenueCreds | null>;
  /** 왜 못 쓰는가. 아직 읽지 않았으면 `NO_CONNECTION` (조회 실패는 `READ_FAILED`) */
  codeOf(connectionId: string): CredentialDiagnosis;
}

/**
 * 연결 하나당 한 번만 읽는 자격 판독기.
 *
 * **연결이 망을 정한다** — 환경변수가 아니라 그 포지션을 들고 있는 연결의
 * `is_testnet`이 정본이다.
 */
export function makeCredsReader(i: {
  sb: any;
  resolveExchange: (id: unknown) => { exchange: 'binance' | 'gate' | null };
  decrypt: (ciphertext: string) => string;
}): CredsReader {
  const cache = new Map<string, VenueCreds | null>();
  const diag = new Map<string, CredentialDiagnosis>();

  return {
    async get(connectionId: string): Promise<VenueCreds | null> {
      if (cache.has(connectionId)) return cache.get(connectionId) ?? null;
      let v: VenueCreds | null = null;
      let code: CredentialDiagnosis = 'NO_CONNECTION';
      try {
        // ★ **`error`를 받는다.** Supabase의 select는 실패해도 던지지
        //   않는다 — `{ data: null, error }`를 준다. 예전에는 `data`만
        //   받아서, 조회 장애가 `row = null`이 되어 `NO_CONNECTION`
        //   ("삭제된 연결")으로 적혔다. 고아 정리는 그 코드를 비실패
        //   skip으로 넘기므로, 지금 고쳐야 할 장애가 조용히 사라졌다.
        const { data, error } = await i.sb.from('exchange_connections')
          .select('api_key, api_secret_enc, has_withdrawal, is_testnet, exchange_id')
          .eq('id', connectionId).maybeSingle();
        const readFailed = !!error;
        const row: any = data ?? null;
        // **모르는 거래소를 바이낸스로 읽지 않는다.**
        const ex = row ? i.resolveExchange(row.exchange_id).exchange : null;
        let plain = '';
        let decrypted = false;
        if (row && String(row.api_secret_enc ?? '')) {
          try { plain = i.decrypt(String(row.api_secret_enc)); decrypted = !!plain; }
          catch { decrypted = false; }
        }
        // ★ 진단에는 **boolean만** 넘긴다. 평문·암호문·길이를 넘기지 않는다.
        //
        //   `hasWithdrawal`: 판독 실패·NULL은 '출금 권한 없음'의 증거가
        //   아니다. 원래 `=== true`는 NULL을 false로 바꿔 안전 차단을
        //   우회했다.
        //
        //   `readFailed`: 조회 실패를 **코드로** 넘긴다. 이 사실을 넘기지
        //   않으면 정본이 "row가 없다"로만 보고 NO_CONNECTION을 준다.
        code = diagnoseCredential({
          readFailed,
          rowFound: !!row,
          exchangeResolved: !!ex,
          hasWithdrawal: row ? (row.has_withdrawal === false ? false : null) : null,
          keyPresent: !!String(row?.api_key ?? ''),
          secretCiphertextPresent: !!String(row?.api_secret_enc ?? ''),
          secretDecrypted: decrypted,
        });
        if (code === 'READY' && ex) {
          v = {
            exchange: ex,
            apiKey: String(row.api_key),
            apiSecret: plain,
            testnet: row.is_testnet !== false,
          };
        }
      } catch {
        // **못 읽은 것을 "연결 없음"으로 적지 않는다.** 막는 방향은
        // 그대로(자격은 null)이고, 바뀌는 것은 사유다.
        v = null;
        code = 'READ_FAILED';
      }
      cache.set(connectionId, v);
      diag.set(connectionId, code);
      return v;
    },
    codeOf(connectionId: string): CredentialDiagnosis {
      return diag.get(connectionId) ?? 'NO_CONNECTION';
    },
  };
}
