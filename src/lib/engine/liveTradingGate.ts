// src/lib/engine/liveTradingGate.ts
//
// **실거래를 열어도 되는 환경인가.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 지금까지 여섯 곳이 각자 `process.env.ALLOW_LIVE_TRADING !== 'true'`를
// 읽고 있었다. 판정이 여섯 벌이면 한 곳을 고쳐도 다섯 곳이 옛날 규칙으로
// 남는다. 그리고 그중 하나만 느슨해도 실주문은 그리로 나간다.
//
// 그런데 더 큰 구멍이 있었다
// ──────────────────────────
// **Preview 배포가 Production과 완전히 같게 동작했다.**
//
// Vercel 환경변수는 Environment(Production/Preview/Development)별로
// 범위를 정한다. `ALLOW_LIVE_TRADING`을 Preview에도 켜 두면, **PR을
// 열 때마다 생기는 미리보기 배포가 실계좌에 주문을 낼 수 있다.**
// 미리보기는 리뷰용이라 아무나 열어 보고, 크론·워크플로가 그 주소를
// 가리키게 되는 사고도 흔하다.
//
// 저장소 전체에 `VERCEL_ENV`를 보는 코드가 한 줄도 없었다. 즉 이
// 구분이 **존재한 적이 없다.**
//
// 규칙
// ────
// 실거래는 **Production에서만** 열린다. 미리보기에서 정말로 실주문을
// 내야 한다면(테스트넷 키로는 재현이 안 되는 문제를 쫓을 때) 별도
// 스위치를 하나 더 켜야 한다 — 실수로 켜지지 않도록 이름을 길게 뒀고,
// 켜져 있으면 응답에 그 사실이 그대로 실린다.
//
// **모르는 환경은 막는 쪽이다.** VERCEL_ENV가 없으면(로컬·자체 호스팅)
// Production으로 치지 않는다.

export interface LiveGateEnv {
  ALLOW_LIVE_TRADING?: string;
  VERCEL_ENV?: string;
  ALLOW_LIVE_TRADING_ON_PREVIEW?: string;
  NODE_ENV?: string;
}

export interface LiveGateVerdict {
  /** 실주문을 내도 되는가 */
  allowed: boolean;
  /** 왜 막혔는지 / 왜 열렸는지 — 사람이 읽는 문장 */
  reason: string;
  /** 어느 환경으로 판단했나. 화면·로그가 이걸 적어야 원인을 안다 */
  env: 'production' | 'preview' | 'development' | 'unknown';
  /** 잠금 스위치 자체는 켜져 있는가 (환경과 별개) */
  unlocked: boolean;
  /** 미리보기 예외로 열린 것인가. 켜져 있으면 반드시 눈에 띄어야 한다 */
  previewOverride: boolean;
}

function readEnv(e: LiveGateEnv): LiveGateVerdict['env'] {
  const v = String(e.VERCEL_ENV || '').toLowerCase();
  if (v === 'production' || v === 'preview' || v === 'development') return v;
  return 'unknown';
}

/**
 * 실거래를 열어도 되는가.
 *
 * 환경변수를 인자로 받는 이유: 테스트가 `process.env`를 건드리지 않고
 * 모든 조합을 확인할 수 있어야 한다. 실제 호출부는 아래 `liveTradingGate()`를
 * 쓴다.
 */
export function judgeLiveGate(e: LiveGateEnv): LiveGateVerdict {
  const unlocked = String(e.ALLOW_LIVE_TRADING) === 'true';
  const env = readEnv(e);
  const previewOverride = String(e.ALLOW_LIVE_TRADING_ON_PREVIEW) === 'true';

  // ── 미리보기는 스위치보다 **먼저** 본다 ──
  //
  // 순서가 뒤바뀌면 이런 모순이 나온다. Preview 배포에는 보통
  // ALLOW_LIVE_TRADING이 없다(Production 범위로만 켜 두니까). 그러면
  // '스위치 꺼짐' 가지로 빠져서 **"넣고 재배포하세요"**라고 안내한다.
  // 그건 방금 닫은 구멍을 다시 열라는 말이다.
  //
  // 미리보기에서 실주문이 안 나가는 것은 **고장이 아니라 정상**이다.
  // 그렇게 말해야 사용자가 되돌리지 않는다.
  if (env === 'preview' && !previewOverride) {
    return {
      allowed: false, env, unlocked, previewOverride: false,
      reason: '미리보기(Preview) 배포라 실주문을 내지 않습니다 — 이건 정상입니다. '
        + 'PR마다 새 미리보기가 생기고 누구나 열어 볼 수 있어서, 여기서 실계좌로 '
        + '주문이 나가면 막을 방법이 없습니다. 실전 동작은 본 주소(Production)에서 확인하세요.'
        + (unlocked
            ? ' (지금 이 배포에는 ALLOW_LIVE_TRADING이 켜져 있습니다 — Preview 체크를 해제하세요.)'
            : ''),
    };
  }

  if (!unlocked) {
    return {
      allowed: false, env, unlocked: false, previewOverride,
      reason: '실거래가 잠겨 있습니다 — Vercel에 ALLOW_LIVE_TRADING=true를 넣고 재배포하세요',
    };
  }

  if (env === 'production') {
    return { allowed: true, env, unlocked: true, previewOverride,
      reason: '실거래가 열려 있습니다 (Production)' };
  }

  if (env === 'preview') {
    // 위에서 !previewOverride는 이미 걸렀다. 여기 오는 것은 예외를
    // 명시적으로 켠 경우뿐이다.
    if (previewOverride) {
      // 열어 주되 **조용히 열지는 않는다.** 미리보기에서 실주문이
      // 나가는 것은 언제나 예외 상황이고, 예외는 보여야 한다.
      return { allowed: true, env, unlocked: true, previewOverride: true,
        reason: '⚠️ 미리보기(Preview) 배포인데 실주문이 열려 있습니다 '
          + '— ALLOW_LIVE_TRADING_ON_PREVIEW=true로 명시적으로 켠 상태입니다. '
          + '확인이 끝나면 반드시 끄세요.' };
    }
    return {
      allowed: false, env, unlocked: true, previewOverride: false,
      reason: '미리보기(Preview) 배포에서는 실주문을 내지 않습니다 — '
        + 'PR마다 새 미리보기가 생기고 누구나 열어 볼 수 있어서, 여기서 실계좌로 '
        + '주문이 나가면 막을 방법이 없습니다. Vercel 환경변수에서 '
        + 'ALLOW_LIVE_TRADING의 Preview 체크를 해제하세요 '
        + '(Production만 켜져 있으면 됩니다).',
    };
  }

  // development · unknown — 로컬, 자체 호스팅, 환경을 못 읽은 경우.
  // **Production으로 치지 않는다.** 모르는 환경을 유리하게 읽으면
  // 그 실수는 실제 돈으로만 드러난다.
  return {
    allowed: false, env, unlocked: true, previewOverride,
    reason: env === 'development'
      ? '개발(Development) 환경에서는 실주문을 내지 않습니다 — 테스트넷을 쓰세요'
      : '실행 환경을 확인하지 못해 실주문을 막았습니다 (VERCEL_ENV 없음). '
        + '자체 호스팅이라면 VERCEL_ENV=production을 명시하세요',
  };
}

/** 실제 호출부용. process.env를 읽어 판정한다. */
export function liveTradingGate(): LiveGateVerdict {
  return judgeLiveGate({
    ALLOW_LIVE_TRADING: process.env.ALLOW_LIVE_TRADING,
    VERCEL_ENV: process.env.VERCEL_ENV,
    ALLOW_LIVE_TRADING_ON_PREVIEW: process.env.ALLOW_LIVE_TRADING_ON_PREVIEW,
    NODE_ENV: process.env.NODE_ENV,
  });
}
