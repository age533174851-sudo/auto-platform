// 비밀이 새는 것은 되돌릴 수 없다. 그래서 이 시험은 **값이 남아 있지
// 않은지**를 직접 확인한다 — "지웠다고 적혀 있다"가 아니라.
import { test, assert, eq } from '../../test/harness';
import { redact, redactionNotice, MASK } from './redact';

/** 결과 어디에도 원문 조각이 없어야 한다 */
function gone(secret: string, r: ReturnType<typeof redact>) {
  assert(!r.text.includes(secret), `본문에 남았습니다: ${r.text.slice(0, 60)}`);
  assert(!JSON.stringify(r.hits).includes(secret), '반환값(hits)에 값이 담겼습니다');
}

export function runFeedbackRedactTests() {
  // ── ① 거래소 에러를 통째로 붙여넣는 경우 ──
  test('★★ 붙여넣은 바이낸스 요청에서 API 키가 사라진다', () => {
    const key = 'vmPUZE6mv9SD5V5e14y7Ju91duEh8A08dM2SHuM0';
    const r = redact(`주문이 안 돼요\nX-MBX-APIKEY: ${key}\n도와주세요`);
    gone(key, r);
    assert(r.text.includes('주문이 안 돼요') && r.text.includes('도와주세요'), '본문까지 지웠습니다');
    eq(r.redacted, true);
  });

  test('★★ signature 쿼리도 지운다', () => {
    const sig = '9f3c1b2a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';
    const r = redact(`GET /fapi/v2/account?timestamp=1700000000&signature=${sig}`);
    gone(sig, r);
  });

  // ── ② 폐기할 수 없는 것 ──
  test('★★ 시드 구문 12단어를 지운다 — 폐기할 수 없는 비밀이다', () => {
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const r = redact(`지갑 복구가 안 됩니다. 제 단어는 ${seed} 입니다.`);
    gone(seed, r);
    assert(r.text.includes(MASK.SEED_PHRASE), r.text);
    eq(r.hits.find((h) => h.kind === 'SEED_PHRASE')?.count, 1);
  });

  test('24단어 시드도 지운다', () => {
    const w = ['abandon','ability','able','about','above','absent','absorb','abstract','absurd','abuse',
      'access','accident','account','accuse','achieve','acid','acoustic','acquire','across','act',
      'addict','address','adjust','admit'];
    const r = redact(w.join(' '));
    gone(w.join(' '), r);
  });

  test('★★ 평범한 영어 문장을 시드로 오인하지 않는다', () => {
    const s = 'the order button does not respond when i tap it on my phone screen today ok';
    const r = redact(s);
    eq(r.text, s);
    eq(r.redacted, false);
  });

  // ★★ 시드 뒤에 영단어 하나만 붙어도 12단어 시드는 그대로 남아 있었다.
  //    예전 판정은 "연속 단어 수가 정확히 12·15·18·21·24"였고, 이 시험은
  //    13단어를 **지우지 않는 것**을 확인하고 있었다 — 그런데 그 13단어
  //    안에 12단어 시드가 통째로 들어 있다. 사람은 시드 뒤에 "thanks"·
  //    "please help"를 붙여 쓴다. 폐기할 수 없는 비밀이라 막는 쪽으로 틀린다.
  test('★★ 12단어 시드 뒤에 단어가 붙어도 지운다 (13단어)', () => {
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const r = redact(`${seed} account`);
    gone(seed, r);
    eq(r.hits.find((h) => h.kind === 'SEED_PHRASE')?.count, 1);
  });

  test('★★ 시드 뒤에 "please help"를 붙여 써도 지운다 (14단어)', () => {
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const r = redact(`지갑 복구가 안 돼요 ${seed} please help`);
    gone(seed, r);
    assert(r.text.includes('지갑 복구가 안 돼요'), '본문까지 지웠습니다');
  });

  test('★★ 24단어보다 긴 줄에 시드가 뒤쪽에 있어도 남지 않는다', () => {
    const lead = 'please check this wallet backup phrase since recovery keeps failing every time today'; // 13단어 + 시드 12 = 25
    const seed = 'zebra zero zone zoo young youth yellow wrong wrist write wolf woman';
    const r = redact(`${lead} ${seed}`);
    for (const w of seed.split(' ')) assert(!r.text.includes(w), `시드 단어가 남았습니다: ${w}`);
  });

  test('11단어는 시드 길이가 아니다 — 지우지 않는다', () => {
    const s = 'abandon ability able about above absent absorb abstract absurd abuse access';
    eq(redact(s).hits.find((h) => h.kind === 'SEED_PHRASE'), undefined);
  });

  // ── ③ 토큰 ──
  test('★★ JWT는 토큰으로 지운다 — API 키로 잡히지 않는다', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const r = redact(`로그인이 안 돼요. Authorization: Bearer ${jwt}`);
    gone(jwt, r);
    assert(r.hits.some((h) => h.kind === 'TOKEN'), JSON.stringify(r.hits));
  });

  test('PEM 개인키는 블록 전체를 지운다', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----';
    const r = redact(`키를 넣었는데 안 돼요\n${pem}`);
    gone('MIIEpAIBAAKCAQEA1234', r);
    assert(r.text.includes(MASK.PRIVATE_KEY), r.text);
  });

  // ── ④ 비밀번호 ──
  test('★★ 비밀번호는 짧아도 지운다', () => {
    for (const s of ['password: hunter2', '비밀번호=abc123', 'pwd:  Qq1!']) {
      const r = redact(s);
      assert(r.text.includes(MASK.PASSWORD), `지우지 못했습니다: ${s} → ${r.text}`);
    }
  });

  // ── ⑤ 개인정보 ──
  test('이메일·전화번호·주민등록번호를 지운다', () => {
    const r = redact('연락처 hong@example.com · 010-1234-5678 · 900101-1234567');
    gone('hong@example.com', r); gone('010-1234-5678', r); gone('900101-1234567', r);
    for (const k of ['EMAIL', 'PHONE', 'KR_RRN'] as const) {
      assert(r.hits.some((h) => h.kind === k), `${k}를 못 잡았습니다: ${JSON.stringify(r.hits)}`);
    }
  });

  // ── ⑥ 이름표 없는 긴 키 ──
  test('이름표가 없어도 32자 이상 영숫자 혼합은 지운다', () => {
    const key = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    gone(key, redact(`이거 넣으래서 넣었어요 ${key}`));
  });

  test('★★ 긴 숫자나 긴 한글을 키로 오인하지 않는다', () => {
    for (const s of ['주문번호 12345678901234567890123456789012345', '자동매매가안되는문제가계속발생하고있습니다정말답답합니다']) {
      eq(redact(s).text, s);
    }
  });

  // ── ⑦ 계약: 값을 돌려주지 않는다 ──
  test('★★ 반환값은 종류와 개수뿐이다 — 값을 담지 않는다', () => {
    const r = redact('apiKey: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    for (const h of r.hits) {
      eq(Object.keys(h).sort().join(','), 'count,kind');
      eq(typeof h.count, 'number');
    }
  });

  test('같은 종류가 여러 번이면 개수로 합친다', () => {
    const r = redact('a@b.com 그리고 c@d.com');
    eq(r.hits.filter((h) => h.kind === 'EMAIL').length, 1);
    eq(r.hits.find((h) => h.kind === 'EMAIL')?.count, 2);
  });

  // ── ⑧ 입력이 글이 아닐 때 ──
  test('글이 아니면 빈 글을 돌려주고 지웠다고 하지 않는다', () => {
    for (const bad of [null, undefined, 123, {}, []]) {
      const r = redact(bad as any);
      eq(r.text, '');
      eq(r.redacted, false);
      eq(r.hits.length, 0);
    }
  });

  test('비밀이 없으면 글이 그대로다', () => {
    const s = '모바일에서 봇 실행 버튼을 눌러도 반응이 없어요';
    const r = redact(s);
    eq(r.text, s); eq(r.redacted, false); eq(redactionNotice(r.hits), null);
  });

  // ── ⑨ 사용자에게 보여 줄 줄 ──
  test('★★ 안내 문구에도 값이 들어가지 않는다', () => {
    const key = 'vmPUZE6mv9SD5V5e14y7Ju91duEh8A08dM2SHuM0';
    const r = redact(`X-MBX-APIKEY: ${key}`);
    const notice = redactionNotice(r.hits)!;
    assert(!notice.includes(key), `안내 문구에 값이 들어갔습니다: ${notice}`);
    assert(notice.includes('API 키'), notice);
  });
}
