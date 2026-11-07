// src/lib/security/credentialExposure.test.ts
//
// **키·시크릿·토큰의 값이 어디에도 남지 않는가.**
//
// 이 저장소의 규칙은 "키·시크릿 값은 로그·응답·커밋 어디에도 남기지
// 않는다. **지문만 비교한다**"다. 그런데 "마스킹"이라는 이름으로 값의
// 일부를 계속 흘리는 자리가 셋 있었다:
//
//   · `crypto.ts`의 `maskKey`      앞 4 + 뒤 4 → 응답과 `api_key_masked` 컬럼
//   · `exchange/kis`의 복제된 같은 함수
//   · `auth/session-log`의 `session_token.slice(0, 8)`
//
// 8자를 알면 값을 되찾을 수 있냐고 물으면 아니다. 그런데 그 질문이
// 잘못됐다 — 유출 판단의 기준은 "복원 가능한가"가 아니라 **"그 값의
// 일부를 우리가 흘렸는가"**다. 거래소 지원 문의나 다른 유출과의 교차
// 대조에서 앞뒤 4자는 식별자로 충분히 쓸 수 있다.
import { test, eq, assert } from '../../test/harness';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maskKey } from '../exchanges/crypto';
import { fingerprintOf } from '../system/fingerprint';

/**
 * 소스를 읽되 **주석을 벗긴다.**
 *
 * 벗기지 않으면 검사가 자기 설명문을 규칙으로 읽는다. 이 파일을 쓰면서
 * 실제로 그렇게 됐다 — 주석에 인용한 옛 코드가 "되돌림"으로 잡혔다.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

export function runCredentialExposureTests() {
  console.log('[자격증명 노출 — 값은 어디에도 남기지 않는다]');

  // 실제로 쓰이는 모양의 값들. 거래소 키는 64자 영숫자다.
  const KEYS = [
    'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2',
    'sess-m1x2y3-abcdef0123456789',
    'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
  ];

  test('★ 표시값에 원래 값의 어떤 조각도 들어가지 않는다', () => {
    for (const k of KEYS) {
      const shown = maskKey(k);
      // 앞 4자·뒤 4자·앞 8자 — 예전 구현이 흘렸던 조각들
      for (const piece of [k.slice(0, 4), k.slice(-4), k.slice(0, 8), k.slice(-8)]) {
        assert(!shown.includes(piece),
          `표시값에 원래 값의 조각이 들어갔다: ${shown} ⊃ ${piece}`);
      }
      // 4자 이상 연속 일치가 아예 없어야 한다.
      for (let i = 0; i + 4 <= k.length; i += 1) {
        assert(!shown.includes(k.slice(i, i + 4)),
          `표시값에 원래 값의 연속 4자가 들어갔다: ${shown} ⊃ ${k.slice(i, i + 4)}`);
      }
    }
  });

  test('★ 같은 키는 같은 표시값, 다른 키는 다른 표시값', () => {
    // 사용자가 "어느 키인가"를 구별할 수 있어야 한다. 그게 마스킹을
    // 쓰던 이유이고, 지문이 그 일을 값 없이 한다.
    eq(maskKey(KEYS[0]), maskKey(KEYS[0]));
    assert(maskKey(KEYS[0]) !== maskKey(KEYS[1]), '다른 키가 같은 표시값을 받았다');
    eq(maskKey(KEYS[0]), `fp:${fingerprintOf(KEYS[0])}`);
  });

  test('★ 빈 값은 지문을 만들지 않는다', () => {
    for (const blank of ['', '   ', null, undefined]) {
      eq(maskKey(blank as any), '****');
    }
  });

  test('★ 표시값으로 길이를 알 수 없다', () => {
    // 길이도 단서다. 64자 키와 32자 키가 같은 길이의 표시값을 받아야 한다.
    const a = maskKey(KEYS[0]);
    const b = maskKey(KEYS[2]);
    eq(a.length, b.length);
  });

  // ── 소스에 되돌림이 들어오지 않는가 ──
  //
  //   값은 함수로 막았지만, 다른 자리에서 다시 `slice`로 조각을 만들면
  //   같은 유출이 돌아온다. 실제로 KIS 라우트가 같은 함수를 복제하고
  //   있었다 — 거래소 쪽을 고치는 동안 그쪽은 계속 흘렸다.
  test('★ 마스킹 정본이 조각을 만들지 않는다', () => {
    const src = read('../exchanges/crypto.ts');
    assert(!/key\.slice\(0, 4\) \+ '\*\*\*\*' \+ key\.slice\(-4\)/.test(src),
      '앞 4 + 뒤 4 마스킹이 돌아왔다');
    assert(/fingerprintOf\(key\)/.test(src), '지문을 쓰지 않는다');
  });

  test('★ 마스킹 함수가 복제되지 않았다', () => {
    const kis = read('../../app/api/exchange/kis/route.ts');
    assert(!/function maskKey/.test(kis), 'maskKey가 다시 복제됐다');
    assert(/import \{ maskKey \} from '@\/lib\/exchanges\/crypto'/.test(kis),
      '정본을 가져오지 않는다');
  });

  test('★ 세션 토큰의 일부도 응답에 담지 않는다', () => {
    const src = read('../../app/api/auth/session-log/route.ts');
    assert(!/session_token: s\.session_token \? s\.session_token\.slice/.test(src),
      '세션 토큰 앞부분을 응답에 담는 코드가 돌아왔다');
    assert(/session_fingerprint: fingerprintOf\(session_token\)/.test(src),
      '지문으로 바꾸지 않았다');
    // 응답 객체에서 토큰 칸 자체를 빼야 한다 — 스프레드로 되살아나기 쉽다.
    assert(/const \{ session_token, \.\.\.rest \} = s/.test(src),
      '스프레드가 토큰 칸을 그대로 되살린다');
  });

  test('★ 선물 캐시 열쇠에 키 조각을 넣지 않는다', () => {
    const src = read('../exchanges/futuresExec.ts');
    assert(!/t\.key\.slice\(/.test(src), '캐시 열쇠에 키 앞부분이 들어갔다');
    assert(/fingerprintOf\(t\.key\)/.test(src), '지문을 쓰지 않는다');
  });

  test('★ 서명 요청 로그에 키·서명·URL이 없다', () => {
    const src = read('../exchanges/binanceFutures.ts');
    // URL에는 `&signature=`가 들어 있다. URL을 찍으면 서명이 통째로 샌다.
    const logs = src.split('\n').filter((l) => /console\.(log|error|warn)/.test(l));
    for (const l of logs) {
      assert(!/\burl\b/.test(l), `로그에 URL(서명 포함)이 들어갔다: ${l.trim()}`);
      assert(!/\bsig\b/.test(l), `로그에 서명이 들어갔다: ${l.trim()}`);
      assert(!/\bkey\b/.test(l), `로그에 키가 들어갔다: ${l.trim()}`);
      assert(!/\bsecret\b/.test(l), `로그에 시크릿이 들어갔다: ${l.trim()}`);
    }
    assert(logs.length > 0, '로그 줄을 하나도 못 찾았다 — 검사가 돌지 않은 것이다');
  });
}
