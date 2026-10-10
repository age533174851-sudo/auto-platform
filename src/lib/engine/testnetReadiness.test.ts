// src/lib/engine/testnetReadiness.test.ts
//
// **⑤B-3A-3 — 실측을 시작할 수 있는지 정직하게 판정하는가.**
//
// 여기서 지키는 것의 절반은 "하지 않는다"다: 세 사실을 한 문장으로
// 뭉개지 않는다, null을 통과로 적지 않는다, 기존 연결을 고쳐서 준비
// 상태를 만들지 않는다, **시크릿을 애초에 받지 않는다.**
import { test, assert, eq } from '../../test/harness';
import {
  diagnoseCredential, credentialDiagnosisReason,
  binanceTestnetReadiness, binanceTestnetDiagnoseGate, sampleReadiness, classifyFailures,
  type ConnectionFacts,
} from './testnetReadiness';
import { makeCredsReader } from './connectionCreds';
import { envHealthProbeVerdict } from '../exchanges/testnetHealthGate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXACT100X = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };

const okCreds = {
  rowFound: true, exchangeResolved: true, hasWithdrawal: false,
  keyPresent: true, secretCiphertextPresent: true, secretDecrypted: true,
};

const conn = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  connectionId: 'c-1', exchange: 'binance', testnet: true, active: true,
  permissionRead: true, permissionTrade: true, hasWithdrawal: false,
  credential: 'READY', ...over,
});

export function runTestnetReadinessTests() {
  // #308의 보안 정책은 순수 함수뿐 아니라 운영 라우트가 실제로 사용해야 한다.
  // 주석을 근거로 삼지 않고 GET 본문에서 인증 → 정책 → TESTNET 고정을 확인한다.
  const healthRoutePath = resolve(__dirname, '../../app/api/exchange/testnet-check/route.ts');
  const routeGuardViolations = (source: string): string[] => {
    const getAt = source.indexOf('export async function GET(req: NextRequest)');
    if (getAt < 0) return ['GET 라우트를 찾지 못했습니다'];
    const body = source.slice(getAt)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const at = (fragment: string) => body.indexOf(fragment);
    const problems: string[] = [];
    const auth = at("await requireAdmin(req.headers.get('authorization'))");
    const authExit = at('if (guard instanceof Response) return guard;');
    const live = at("url.searchParams.has('live')");
    const policy = at('envHealthProbeVerdict({');
    const policyExit = at('if (!policy.ok)');
    const reject = at('return NextResponse.json({ error: policy.code }');
    const testnet = at('const testnet = true;');
    const binance = at('checkBinanceFutures(testnet)');
    const gate = at('checkGateFutures(testnet)');

    if (auth < 0 || authExit < auth) problems.push('관리자 Bearer 인증 관문이 빠졌습니다');
    if (policy < 0 || live < policy || policyExit < live) problems.push('live 쿼리 존재 여부가 정책에 전달되지 않습니다');
    if (policyExit < policy || reject < policyExit
        || !body.includes("policy.code === 'LIVE_PROBE_FORBIDDEN' ? 403 : 400")) {
      problems.push('정책 거부 결과가 HTTP 거부 응답으로 연결되지 않았습니다');
    }
    if (testnet < 0 || testnet < reject
        || binance < testnet || gate < testnet) {
      problems.push('거래소 호출이 TESTNET 상수에 고정되지 않았습니다');
    }
    if (auth < 0 || live < authExit || policyExit < authExit || testnet < authExit) {
      problems.push('인증 전에 거래소 환경을 평가하거나 요청합니다');
    }
    return problems;
  };

  test('★ 환경변수 진단 GET에 관리자 인증·LIVE 차단·TESTNET 고정이 모두 배선돼 있다', () => {
    const source = readFileSync(healthRoutePath, 'utf8');
    const bad = routeGuardViolations(source);
    eq(bad.length, 0, `보안 배선 위반: ${bad.join(' / ')}`);
  });

  test('★ #308 배선 M1~M4 방어 삭제 변이가 각각 RED다', () => {
    const source = readFileSync(healthRoutePath, 'utf8');
    const variants: Array<[string, string, string]> = [
      ['M1 인증 관문 삭제', "const guard = await requireAdmin(req.headers.get('authorization'));",
        'const guard = null;'],
      ['M2 LIVE 호스트 선택 복귀', 'const testnet = true;',
        "const testnet = url.searchParams.get('live') !== '1';"],
      ['M3 정책 거부 무시', 'if (!policy.ok) {',
        'if (false) {'],
      ['M4 ?live=0 통과', "url.searchParams.has('live')",
        "url.searchParams.get('live') === '1'"],
    ];
    for (const [name, before, after] of variants) {
      assert(source.includes(before), `변이 ${name}의 대상 코드가 없어졌습니다`);
      const mutated = source.replace(before, after);
      assert(routeGuardViolations(mutated).length > 0,
        `${name}을 제거해도 라우트 계약 검사가 통과했습니다`);
    }
  });

  test('★ 환경변수 거래소 진단은 LIVE 선택을 어떤 값으로도 허용하지 않는다', () => {
    for (const exchange of [null, 'binance', 'gate'] as const) {
      const ok = envHealthProbeVerdict({ hasLiveQuery: false, exchange });
      eq(ok.code, 'READY');
      eq(ok.ok, true);
      const blocked = envHealthProbeVerdict({ hasLiveQuery: true, exchange });
      eq(blocked.code, 'LIVE_PROBE_FORBIDDEN');
      eq(blocked.ok, false);
    }
  });

  test('★ 지원하지 않는 환경변수 거래소는 조회 후보로 두지 않는다', () => {
    for (const exchange of ['okx', 'bybit', 'BINANCE', 'binance;gate']) {
      const v = envHealthProbeVerdict({ hasLiveQuery: false, exchange });
      eq(v.code, 'UNSUPPORTED_EXCHANGE');
      eq(v.ok, false);
    }
    eq(envHealthProbeVerdict({ hasLiveQuery: false, exchange: '' }).code, 'READY');
  });


  // 진단은 TESTNET에만 나갈 수 있다. 순수 사실 판정이라 실키가 없다.
  test('★ Binance TESTNET만 네트워크 진단 자격이 있다', () => {
    const safe = {
      exchange: 'binance', testnet: true, active: true,
      hasWithdrawal: false, keyPresent: true, secretCipherPresent: true,
    };
    eq(binanceTestnetDiagnoseGate(safe).code, 'READY');
    const blocked: Array<[Partial<typeof safe>, string]> = [
      [{ testnet: false }, 'NOT_TESTNET'],
      [{ testnet: null as any }, 'NOT_TESTNET'],
      [{ testnet: undefined as any }, 'NOT_TESTNET'],
      [{ exchange: 'gate' }, 'NOT_BINANCE'],
      [{ exchange: '' }, 'NOT_BINANCE'],
      [{ active: false }, 'CONNECTION_INACTIVE'],
      [{ active: null as any }, 'CONNECTION_INACTIVE'],
      [{ hasWithdrawal: true }, 'WITHDRAWAL_UNCONFIRMED'],
      [{ hasWithdrawal: null as any }, 'WITHDRAWAL_UNCONFIRMED'],
      [{ hasWithdrawal: undefined as any }, 'WITHDRAWAL_UNCONFIRMED'],
      [{ keyPresent: false }, 'KEY_MISSING'],
      [{ secretCipherPresent: false }, 'SECRET_MISSING'],
    ];
    for (const [change, expected] of blocked) {
      const r = binanceTestnetDiagnoseGate({ ...safe, ...change });
      eq(r.ok, false);
      eq(r.code, expected);
    }
  });


  // ── 자격 진단 ──

  test('전부 갖춰지면 READY다', () => {
    eq(diagnoseCredential(okCreds), 'READY');
    eq(credentialDiagnosisReason('READY'), '');
  });

  test('★ 세 사실을 한 문장으로 뭉개지 않는다', () => {
    const cases: Array<[any, string]> = [
      [{ ...okCreds, rowFound: false }, 'NO_CONNECTION'],
      [{ ...okCreds, exchangeResolved: false }, 'UNSUPPORTED_EXCHANGE'],
      [{ ...okCreds, hasWithdrawal: true }, 'WITHDRAWAL_ENABLED'],
      [{ ...okCreds, keyPresent: false }, 'KEY_MISSING'],
      [{ ...okCreds, secretCiphertextPresent: false }, 'SECRET_MISSING'],
      [{ ...okCreds, secretDecrypted: false }, 'DECRYPT_FAILED'],
    ];
    const seen = new Set<string>();
    for (const [facts, want] of cases) {
      const got = diagnoseCredential(facts);
      eq(got, want, `★ ${want}를 ${got}로 읽었다`);
      seen.add(got);
    }
    eq(seen.size, 6, '★ 서로 다른 원인이 같은 코드로 뭉개졌다');
  });

  test('★ 출금 권한을 확인하지 못한 것(null)을 통과로 적지 않는다', () => {
    for (const v of [null, undefined]) {
      eq(diagnoseCredential({ ...okCreds, hasWithdrawal: v as any }), 'WITHDRAWAL_ENABLED',
        '★ 출금 권한 미확인을 "없음"으로 읽었다');
    }
  });

  test('없는 row의 출금 권한을 먼저 묻지 않는다 (순서가 의미를 가진다)', () => {
    eq(diagnoseCredential({ ...okCreds, rowFound: false, hasWithdrawal: true }), 'NO_CONNECTION');
  });

  test('★ 사유 문구에 값이 들어갈 자리가 없다', () => {
    for (const c of ['NO_CONNECTION', 'UNSUPPORTED_EXCHANGE', 'WITHDRAWAL_ENABLED',
                     'KEY_MISSING', 'SECRET_MISSING', 'DECRYPT_FAILED'] as const) {
      const r = credentialDiagnosisReason(c);
      assert(r.length > 0, `${c} 사유가 비었다`);
      assert(!/\$\{|%s|\+ *(key|secret)/i.test(r), `★ ${c} 사유에 값을 끼울 자리가 있다`);
      assert(!/[A-Za-z0-9+/]{20,}={0,2}/.test(r), `★ ${c} 사유에 값처럼 보이는 문자열이 있다`);
    }
  });

  test('★ 진단 입력에 시크릿 문자열을 받는 칸이 없다', () => {
    // 받지 않으면 흘릴 수도 없다. 전부 boolean이어야 한다.
    for (const [k, v] of Object.entries(okCreds)) {
      eq(typeof v, 'boolean', `★ ${k}가 boolean이 아니다 — 값을 받고 있다`);
    }
    for (const k of Object.keys(okCreds)) {
      assert(!/^(apiKey|apiSecret|secret|key|ciphertext|plaintext)$/i.test(k),
        `★ 값을 담을 이름의 칸이 있다 (${k})`);
    }
  });

  // ── 연결 준비 상태 ──

  test('binance + testnet + 권한이 맞으면 READY다', () => {
    const v = binanceTestnetReadiness([conn()]);
    eq(v.code, 'READY');
    eq(v.ready, true);
    eq(v.connectionId, 'c-1');
  });

  test('★ Binance TESTNET 연결이 없으면 없다고 적는다', () => {
    // Gate TESTNET 하나 + Binance LIVE 둘 — 현재 실제 상태와 같은 모양
    const v = binanceTestnetReadiness([
      conn({ connectionId: 'gate', exchange: 'gate', testnet: true, permissionTrade: false }),
      conn({ connectionId: 'bn-1', testnet: false }),
      conn({ connectionId: 'bn-2', testnet: false }),
    ]);
    eq(v.code, 'NO_BINANCE_TESTNET_CONNECTION', '★ Gate나 LIVE를 후보로 셌다');
    eq(v.ready, false);
    eq(v.connectionId, null);
  });

  test('★ 빈 목록도 통과시키지 않는다', () => {
    for (const x of [[], null, undefined]) {
      eq(binanceTestnetReadiness(x as any).code, 'NO_BINANCE_TESTNET_CONNECTION');
    }
  });

  test('★ LIVE 연결은 testnet 플래그가 꺼져 있으면 후보가 아니다', () => {
    eq(binanceTestnetReadiness([conn({ testnet: false })]).code,
      'NO_BINANCE_TESTNET_CONNECTION', '★ LIVE 연결을 TESTNET 후보로 셌다');
    for (const t of [null, undefined]) {
      eq(binanceTestnetReadiness([conn({ testnet: t as any })]).code,
        'NO_BINANCE_TESTNET_CONNECTION', '★ testnet 미확인을 true로 읽었다');
    }
  });

  test('각 결격 사유가 따로 나온다', () => {
    eq(binanceTestnetReadiness([conn({ active: false })]).code, 'CONNECTION_INACTIVE');
    eq(binanceTestnetReadiness([conn({ permissionRead: false })]).code, 'READ_PERMISSION_MISSING');
    eq(binanceTestnetReadiness([conn({ permissionTrade: false })]).code, 'TRADE_PERMISSION_MISSING');
    eq(binanceTestnetReadiness([conn({ hasWithdrawal: true })]).code,
      'WITHDRAWAL_PERMISSION_PRESENT');
    eq(binanceTestnetReadiness([conn({ credential: 'DECRYPT_FAILED' })]).code,
      'CREDENTIALS_UNUSABLE');
  });

  test('★ 출금 권한이 거래 권한보다 먼저 막는다', () => {
    // 출금 가능한 키는 거래 권한을 묻기 전에 멈춰야 한다
    const v = binanceTestnetReadiness([conn({ hasWithdrawal: true, permissionTrade: false })]);
    eq(v.code, 'WITHDRAWAL_PERMISSION_PRESENT', '★ 출금 가능한 키를 더 들여다봤다');
  });

  test('★ 출금 권한 미확인(null)도 막는다', () => {
    for (const w of [null, undefined]) {
      eq(binanceTestnetReadiness([conn({ hasWithdrawal: w as any })]).code,
        'WITHDRAWAL_PERMISSION_PRESENT');
    }
  });

  test('★ 복호화 상태를 아직 진단하지 않으면 READY라고 쓰지 않는다', () => {
    for (const credential of [null, undefined] as const) {
      const v = binanceTestnetReadiness([conn({ credential })]);
      eq(v.ready, false);
      eq(v.code, 'CREDENTIALS_UNUSABLE');
    }
  });

  test('★ 판독기는 NULL·미확인 출금 권한을 false로 바꾸지 않는다', async () => {
    const probe = async (hasWithdrawal: boolean | null | undefined) => {
      const reader = makeCredsReader({
        sb: { from: () => ({
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: {
              api_key: 'dummy-key', api_secret_enc: 'dummy-cipher',
              has_withdrawal: hasWithdrawal, is_testnet: true,
              exchange_id: 'binance',
            }, error: null };
          },
        }) },
        resolveExchange: () => ({ exchange: 'binance' as const }),
        decrypt: () => 'dummy-secret',
      });
      const creds = await reader.get('test-connection');
      return { creds, code: reader.codeOf('test-connection') };
    };

    for (const v of [true, null, undefined] as const) {
      const r = await probe(v);
      eq(r.code, 'WITHDRAWAL_ENABLED');
      eq(r.creds, null, '출금 권한 미확인 상태에서 자격을 건넸다');
    }
    const safe = await probe(false);
    eq(safe.code, 'READY');
    assert(safe.creds !== null, '출금 권한 없음이 확인돼도 자격이 차단됐다');
  });

  test('쓸 수 있는 연결이 하나라도 있으면 그것을 고른다', () => {
    const v = binanceTestnetReadiness([conn({ connectionId: 'bad', active: false }), conn({ connectionId: 'good' })]);
    eq(v.code, 'READY');
    eq(v.connectionId, 'good');
  });

  // ── 표본 자격 (정본 위임) ──

  test('표본 자격은 기존 정본과 같은 판단을 한다', () => {
    const base = { testnet: true, exchange: 'binance', side: 'LONG' as const,
      executionIdentity: EXACT100X, positionAmt: 0.01 };
    eq(sampleReadiness(base).code, 'READY');
    eq(sampleReadiness({ ...base, testnet: false }).code, 'NOT_TESTNET');
    eq(sampleReadiness({ ...base, exchange: 'gate' }).code, 'VENUE_UNSUPPORTED');
    eq(sampleReadiness({ ...base, positionAmt: 0 }).code, 'POSITION_NOT_OPEN');
    eq(sampleReadiness({ ...base, positionAmt: -0.01 }).code, 'SIDE_MISMATCH');
    eq(sampleReadiness({ ...base, positionAmt: null }).code, 'NO_EXACT100X_POSITION');
    eq(sampleReadiness({ ...base,
      executionIdentity: { profileId: 'SCALP_HIGH_LEV', presetId: 'STABILIZE', contractVersion: 2 },
    }).code, 'IDENTITY_MISMATCH');
  });

  test('★ Gate TESTNET은 VENUE_UNSUPPORTED다 — Exact100X 표본이 아니다', () => {
    const v = sampleReadiness({ testnet: true, exchange: 'gate', side: 'LONG',
      executionIdentity: EXACT100X, positionAmt: 0.01 });
    eq(v.code, 'VENUE_UNSUPPORTED', '★ Gate를 Exact100X 실측 표본으로 받았다');
    eq(v.ready, false);
  });

  // ── 실패 분류 ──

  test('★ 실패를 경로별·원인별로 나눠 센다', () => {
    const b = classifyFailures([
      { path: 'GENERIC_PROTECTION_SWEEP', code: 'WITHDRAWAL_ENABLED' },
      { path: 'GENERIC_PROTECTION_SWEEP', code: 'WITHDRAWAL_ENABLED' },
      { path: 'GENERIC_PROTECTION_SWEEP', code: 'NO_CONNECTION' },
      { path: 'EXACT100X_AUTHORITY', code: 'NO_CONNECTION' },
    ]);
    eq(b.length, 3, '★ 서로 다른 경로·원인을 한 줄로 합쳤다');
    eq(b[0].count, 2);
    const gen = b.find(x => x.path === 'GENERIC_PROTECTION_SWEEP' && x.code === 'NO_CONNECTION');
    const ex = b.find(x => x.path === 'EXACT100X_AUTHORITY' && x.code === 'NO_CONNECTION');
    eq(gen?.count, 1);
    eq(ex?.count, 1, '★ 고아 정리 실패와 Exact100X 실패를 섞어 셌다');
  });

  test('빈 입력은 빈 결과다 (0을 지어내지 않는다)', () => {
    for (const x of [[], null, undefined]) eq(classifyFailures(x as any).length, 0);
  });

  // ── 권한 없음 ──

  test('★ readiness 모듈에 주문·DB·연결 생성 수단이 없다', async () => {
    const src = await import('./testnetReadiness');
    for (const bad of ['sendClose', 'placeFuturesOrder', 'createConnection',
                       'upsertConnection', 'setTestnet', 'execSql', 'query',
                       'decryptSecret', 'applyMigration']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });

  test('★ 표본 자격 판정을 복제하지 않았다 (정본에 위임한다)', async () => {
    const src = await import('./testnetReadiness');
    // 정본과 같은 코드 집합을 쓰는지 — 직접 세 리터럴을 비교하지 않는지
    const v = src.sampleReadiness({ testnet: true, exchange: 'binance', side: 'SHORT',
      executionIdentity: EXACT100X, positionAmt: -0.02 });
    eq(v.code, 'READY', 'SHORT 음수 수량이 정본에서 통과해야 한다');
  });
}
