import { test, eq, assert } from '../../test/harness';
import { diagnose, isEphemeralHost, type DiagnosticInput } from './loginDiagnostic';

export function runLoginDiagnosticTests() {
  console.log('[로그인 진단 — 추측하지 않고 잰다]');

  const now = 1_800_000_000_000;
  const good = (o: Partial<DiagnosticInput> = {}): DiagnosticInput => ({
    hostname: 'traigo.app', storageOk: true, hasSession: true,
    expiresAtMs: now + 40 * 60_000, hasRefreshToken: true, nowMs: now, ...o,
  });
  const find = (i: DiagnosticInput, id: string) => diagnose(i).findings.find(f => f.id === id)!;

  // ── 주소 ────────────────────────────────────────────────
  test('브랜치 미리보기 주소를 잡아낸다', () => {
    // 커밋마다 주소가 바뀌어서 매번 새로 로그인해야 한다.
    assert(isEphemeralHost('auto-platform-git-claude-wor-9d9803-team.vercel.app'), '못 잡았다');
  });

  test('커밋별 배포 주소도 잡아낸다', () => {
    assert(isEphemeralHost('auto-platform-a1b2c3d4e-team.vercel.app'), '못 잡았다');
  });

  test('고정 vercel 주소는 문제로 보지 않는다', () => {
    eq(isEphemeralHost('auto-platform.vercel.app'), false);
  });

  test('직접 도메인은 문제 아니다', () => {
    eq(isEphemeralHost('traigo.app'), false);
    eq(isEphemeralHost('localhost'), false);
    eq(isEphemeralHost(''), false);
    eq(isEphemeralHost(null), false);
  });

  test('미리보기 주소면 무엇을 해야 하는지 적는다', () => {
    // 이건 코드로 못 고친다 — 브라우저의 보안 규칙이다.
    const r = find(good({ hostname: 'x-git-y-z.vercel.app' }), 'host');
    eq(r.level, 'bad');
    assert(r.action!.includes('Domains'), r.action!);
  });

  // ── 저장소 ──────────────────────────────────────────────
  test('저장소를 못 쓰면 원인으로 짚는다', () => {
    const r = find(good({ storageOk: false }), 'storage');
    eq(r.level, 'bad');
    assert(r.action!.includes('시크릿'), r.action!);
  });

  test('확인 못 한 저장소를 문제로 단정하지 않는다', () => {
    eq(find(good({ storageOk: null }), 'storage').level, 'unknown');
  });

  // ── 세션 ────────────────────────────────────────────────
  test('로그인 안 된 것과 못 읽은 것을 구분한다', () => {
    // 못 읽은 것을 로그아웃으로 그리면, 잠깐 끊긴 것 때문에 다시
    // 로그인하게 된다.
    eq(find(good({ hasSession: false }), 'session').level, 'warn');
    const unk = find(good({ hasSession: null }), 'session');
    eq(unk.level, 'unknown');
    assert(unk.detail.includes('로그아웃됐다는 뜻이 아닙니다'), unk.detail);
  });

  // ── 갱신 ────────────────────────────────────────────────
  test('갱신 토큰이 없으면 한 시간짜리 로그인이 된다', () => {
    // 한 시간마다 로그아웃되는 것처럼 보이는 전형적인 모양이다.
    const r = find(good({ hasRefreshToken: false }), 'refresh');
    eq(r.level, 'bad');
    assert(r.detail.includes('만료되면 로그아웃'), r.detail);
  });

  test('로그인 안 됐으면 갱신 항목을 안 만든다', () => {
    // 로그인도 안 했는데 "갱신 토큰 없음"이 뜨면 원인을 착각한다.
    assert(diagnose(good({ hasSession: false })).findings.every(f => f.id !== 'refresh'),
      '갱신 항목이 있으면 안 된다');
  });

  // ── 만료 ────────────────────────────────────────────────
  test('남은 시간을 분으로 알려준다', () => {
    const r = find(good({ expiresAtMs: now + 40 * 60_000 }), 'expiry');
    eq(r.level, 'ok');
    assert(r.detail.includes('40분'), r.detail);
  });

  test('이미 만료됐으면 그렇게 말한다', () => {
    const r = find(good({ expiresAtMs: now - 10 * 60_000 }), 'expiry');
    eq(r.level, 'bad');
    assert(r.detail.includes('10분 전'), r.detail);
  });

  test('만료 시각을 모르면 확인 불가다', () => {
    eq(find(good({ expiresAtMs: null }), 'expiry').level, 'unknown');
  });

  // ── 요약 ────────────────────────────────────────────────
  test('문제가 있으면 그 문제를 한 줄로 올린다', () => {
    const r = diagnose(good({ hostname: 'x-git-y-z.vercel.app' }));
    assert(r.headline.includes('바뀝니다'), r.headline);
  });

  test('다 정상이면 정상이라고 말한다', () => {
    assert(diagnose(good()).headline.includes('모두 갖췄'), diagnose(good()).headline);
  });

  test('확인 못 한 것이 있으면 정상이라고 안 한다', () => {
    const r = diagnose(good({ storageOk: null }));
    assert(r.headline.includes('확인하지 못'), r.headline);
  });

  test('문제가 확인 불가보다 먼저다', () => {
    const r = diagnose(good({ storageOk: null, hasRefreshToken: false }));
    assert(r.headline.includes('로그아웃'), r.headline);
  });
}
