// src/lib/auth/loginDiagnostic.ts
//
// **로그인이 왜 계속 풀리는가 — 추측하지 않고 잰다.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// "로그인이 계속 풀린다"는 증상이고, 원인은 최소 넷이다:
//
//   1. 주소가 매번 다르다 (미리보기 배포)
//   2. 브라우저가 저장소를 못 쓴다 (시크릿 모드·저장소 차단)
//   3. 토큰이 만료됐는데 갱신이 안 된다
//   4. 로그인한 적이 없다
//
// 넷 다 화면에는 똑같이 "로그인이 필요합니다"로 보인다. 그래서 고칠
// 때마다 "이번엔 됐나?"를 기다려야 했다. **재면 한 번에 끝난다.**
//
// 1번이 가장 흔하다
// ─────────────────
// Vercel 미리보기 주소는 커밋마다 바뀐다. 브라우저는 주소가 다르면
// 저장소를 따로 쓴다 — 그래서 **매번 새로 로그인해야 한다.** 코드로는
// 절대 못 고친다. 어느 주소로 들어왔는지 화면이 말해 줘야 한다.

export type FindingLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface Finding {
  id: string;
  label: string;
  level: FindingLevel;
  detail: string;
  action: string | null;
}

export interface DiagnosticInput {
  /** location.hostname */
  hostname: string | null;
  /** localStorage에 쓰고 읽는 것이 되는가. 못 해봤으면 null */
  storageOk: boolean | null;
  /** 세션이 있는가. 못 읽었으면 null */
  hasSession: boolean | null;
  /** access token 만료 시각(ms). 모르면 null */
  expiresAtMs: number | null;
  /** refresh token이 있는가. 이게 없으면 갱신 자체가 불가능하다 */
  hasRefreshToken: boolean | null;
  nowMs: number;
}

/**
 * Vercel 미리보기 주소인가.
 *
 * `-git-` 이 들어간 것은 브랜치 배포다 — 커밋마다 주소가 바뀐다.
 * 프로젝트 이름 뒤에 해시가 붙은 것도 배포별 주소다.
 */
export function isEphemeralHost(hostname: string | null | undefined): boolean {
  const h = String(hostname || '').toLowerCase();
  if (!h.endsWith('.vercel.app')) return false;
  // 브랜치 배포: <project>-git-<branch>-<team>.vercel.app
  if (h.includes('-git-')) return true;
  // 커밋 배포: <project>-<9자 해시>-<team>.vercel.app
  return /-[a-z0-9]{9}-/.test(h);
}

export function diagnose(input: DiagnosticInput): { findings: Finding[]; headline: string } {
  const f: Finding[] = [];
  const host = String(input?.hostname || '');

  // ── 1. 주소 ──
  if (!host) {
    f.push({ id: 'host', label: '접속 주소', level: 'unknown',
      detail: '주소를 확인하지 못했습니다', action: null });
  } else if (isEphemeralHost(host)) {
    f.push({
      id: 'host', label: '접속 주소', level: 'bad',
      detail: `${host} — 이 주소는 배포할 때마다 바뀝니다`,
      // **이건 코드로 못 고친다.** 브라우저가 주소별로 저장소를 나누기
      // 때문이고, 그건 브라우저의 보안 규칙이다.
      action: '고정 주소로 들어오세요. Vercel → 프로젝트 → Domains에 있는 주소입니다. 홈 화면에 바로가기로 만들어 두면 확실합니다',
    });
  } else if (host === 'localhost' || host === '127.0.0.1') {
    f.push({ id: 'host', label: '접속 주소', level: 'ok', detail: `${host} (개발)`, action: null });
  } else {
    f.push({ id: 'host', label: '접속 주소', level: 'ok',
      detail: `${host} — 고정 주소입니다`, action: null });
  }

  // ── 2. 저장소 ──
  if (input?.storageOk === false) {
    f.push({
      id: 'storage', label: '브라우저 저장소', level: 'bad',
      detail: '로그인 정보를 저장할 수 없습니다',
      action: '시크릿 모드이거나 쿠키·사이트 데이터가 차단돼 있습니다. 일반 창으로 열거나 이 사이트의 저장 허용을 켜세요',
    });
  } else if (input?.storageOk === true) {
    f.push({ id: 'storage', label: '브라우저 저장소', level: 'ok', detail: '쓰기·읽기 됩니다', action: null });
  } else {
    f.push({ id: 'storage', label: '브라우저 저장소', level: 'unknown',
      detail: '확인하지 못했습니다', action: null });
  }

  // ── 3. 세션 ──
  if (input?.hasSession === false) {
    f.push({ id: 'session', label: '로그인 상태', level: 'warn',
      detail: '지금 로그인되어 있지 않습니다', action: '로그인하세요' });
  } else if (input?.hasSession == null) {
    f.push({ id: 'session', label: '로그인 상태', level: 'unknown',
      detail: '세션을 읽지 못했습니다 — 로그아웃됐다는 뜻이 아닙니다', action: null });
  } else {
    f.push({ id: 'session', label: '로그인 상태', level: 'ok', detail: '로그인되어 있습니다', action: null });

    // ── 4. 갱신 가능한가 ──
    //
    // refresh token이 없으면 access token이 만료되는 순간 끝난다.
    // 한 시간마다 로그아웃되는 것처럼 보이는 전형적인 모양이다.
    if (input?.hasRefreshToken === false) {
      f.push({
        id: 'refresh', label: '자동 갱신', level: 'bad',
        detail: '갱신용 토큰이 없습니다 — 지금 토큰이 만료되면 로그아웃됩니다',
        action: '로그아웃했다가 다시 로그인하세요',
      });
    } else if (input?.hasRefreshToken === true) {
      f.push({ id: 'refresh', label: '자동 갱신', level: 'ok', detail: '갱신용 토큰이 있습니다', action: null });
    }

    // ── 5. 만료까지 ──
    const exp = input?.expiresAtMs;
    if (exp == null || !Number.isFinite(exp)) {
      f.push({ id: 'expiry', label: '토큰 만료', level: 'unknown',
        detail: '만료 시각을 모릅니다 — 언제까지 유효한지 알 수 없습니다', action: null });
    } else {
      const left = exp - input.nowMs;
      const mins = Math.round(left / 60_000);
      if (left <= 0) {
        f.push({ id: 'expiry', label: '토큰 만료', level: 'bad',
          detail: `이미 만료됐습니다 (${-mins}분 전)`,
          action: '화면을 새로고침하면 자동으로 갱신됩니다. 그래도 안 되면 다시 로그인하세요' });
      } else {
        f.push({ id: 'expiry', label: '토큰 만료', level: 'ok',
          detail: `${mins}분 남았습니다 — 만료 전에 자동으로 갱신됩니다`, action: null });
      }
    }
  }

  const bad = f.filter(x => x.level === 'bad');
  const headline = bad.length > 0
    ? bad[0].detail
    : f.some(x => x.level === 'unknown')
      ? '일부를 확인하지 못했습니다'
      : f.some(x => x.level === 'warn')
        ? '로그인이 필요합니다'
        : '로그인이 유지될 조건을 모두 갖췄습니다';

  return { findings: f, headline };
}
