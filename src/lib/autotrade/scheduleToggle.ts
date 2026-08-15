// src/lib/autotrade/scheduleToggle.ts
//
// **켜고 끄는 것은 다시 만드는 것이 아니다.**
//
// 무슨 일이 있었나
// ────────────────
// 화면에서 my-original-v1 BTCUSDT · ETHUSDT의 [켜짐]을 눌렀는데 꺼지지
// 않았다. Supabase에서 직접 `UPDATE ... SET enabled=false`를 치니 두 줄
// 모두 정상으로 바뀌었다 — DB도 권한도 멀쩡했다.
//
// 원인은 **버튼이 UPDATE가 아니라 UPSERT를 부르고 있었다**는 것이다.
// 화면의 `toggle(row)`은 POST로 `{symbol, connectionId, mode, enabled}`를
// 보냈고, 거기에는 **어느 전략인지가 없었다.** 서버 POST는 strategyId가
// 없으면 계단식(LEGACY)으로 본다. 그래서 요청은 성공했지만, 바뀐 줄은
// 사용자가 누른 my-original-v1 줄이 아니라 **정체가 다른 줄**이었다.
// 화면은 200을 받았으니 성공이라고 적었고, 예약은 계속 켜져 있었다.
//
// 이 저장소에서 가장 자주 난 고장의 정확한 모양이다: **경로가 둘인데
// 한쪽만 고쳤다.** 저장(save)에는 strategyId를 실었고, 토글에는 안 실었다.
//
// 그래서 무엇을 바꾸는가
// ──────────────────────
// 기존 예약의 ON/OFF는 **정체를 다시 조립하지 않는다.** 이미 그 줄의
// 기본키(`schedule.id`)를 화면이 들고 있다. 그것 하나만 권위로 삼아
// `enabled` 한 칸만 UPDATE한다. 정체(strategy_id·symbol·connection_id·
// mode)와 크기 설정(leverage_cap·risk_pct·margin_pct·interval_min)은
// **요청에 실리지도 않으므로** 덮일 방법이 없다.
//
// 재연결(rebind)은 다른 일이다. 그건 실제로 `connection_id`를 바꾸는
// 변경이라 POST(upsert) 경로에 그대로 둔다. 다만 이제 **전략을 명시해서**
// 보낸다 — 안 보내면 위와 똑같이 정체가 갈린다.
//
// **ON/OFF와 재연결을 같은 mutation으로 묶지 않는다.** 하나로 묶여 있던
// 동안, 끄기 한 번이 연결과 전략까지 건드릴 수 있었다.

/** 예약 라우트. 화면과 테스트가 같은 문자열을 쓰게 한 곳에 둔다 */
export const SCHEDULE_ROUTE = '/api/autotrade/schedule';

/**
 * `enabled`가 켜져 있는가.
 *
 * **true만 켜짐이다.** 문자열 `'false'`는 truthy이고, 옛 줄에는 실제로
 * 문자열이 들어 있는 경우가 있었다. 켜짐 판정이 흔들리면 토글이 뒤집는
 * 방향도 같이 흔들린다.
 */
export function isEnabled(v: any): boolean {
  return v === true;
}

// ── 화면이 보내는 것 ─────────────────────────────────

export interface ToggleRequest {
  ok: boolean;
  /** 왜 못 보내는가. ok=true면 'OK' */
  code: 'OK' | 'NO_ID' | 'NO_CONNECTION';
  method: 'PATCH' | 'POST' | null;
  route: string | null;
  body: Record<string, any> | null;
  message: string;
}

/**
 * 기존 예약의 ON/OFF 요청.
 *
 * **POST를 쓰지 않는다.** 보내는 것은 `{id, enabled}` 둘뿐이고, 그 밖의
 * 어떤 칸도 실리지 않는다 — 실리지 않은 것은 덮일 수 없다.
 */
export function toggleRequest(row: any): ToggleRequest {
  const id = String(row?.id ?? '').trim();
  if (!id) {
    // **id가 없으면 POST로 되돌아가지 않는다.** 되돌아가면 정체를 다시
    // 조립하게 되고, 그게 지금 고치는 바로 그 고장이다.
    return {
      ok: false, code: 'NO_ID', method: null, route: null, body: null,
      message: '이 예약의 id를 화면이 들고 있지 않습니다 — 새로고침한 뒤 다시 시도하세요. '
        + '정체를 다시 조립해서 저장하지는 않습니다(다른 줄이 바뀔 수 있습니다)',
    };
  }
  return {
    ok: true, code: 'OK', method: 'PATCH', route: SCHEDULE_ROUTE,
    body: { id, enabled: !isEnabled(row?.enabled) },
    message: isEnabled(row?.enabled) ? '예약을 끕니다' : '예약을 켭니다',
  };
}

/**
 * 재연결 요청. **연결만 바꾼다.**
 *
 * 켜짐 상태는 그대로 둔다 — 껐던 예약이 연결을 고쳤다는 이유로 저절로
 * 켜지면 안 된다. 그리고 **전략을 명시한다**: 안 보내면 서버가 계단식으로
 * 되돌려 정체가 다른 줄이 만들어진다.
 */
export function rebindRequest(row: any, connectionId: string): ToggleRequest {
  const conn = String(connectionId ?? '').trim();
  if (!conn) {
    return {
      ok: false, code: 'NO_CONNECTION', method: null, route: null, body: null,
      message: '바꿀 거래소 연결을 먼저 고르세요 — 대신 골라 주지 않습니다',
    };
  }
  const strategyId = String(row?.strategyId ?? row?.strategy_id ?? '').trim();
  const strategyVersion = row?.strategyVersion ?? row?.strategy_version ?? null;
  return {
    ok: true, code: 'OK', method: 'POST', route: SCHEDULE_ROUTE,
    body: {
      symbol: row?.symbol, connectionId: conn, rebind: true, mode: row?.mode,
      // 켜짐 상태는 **그대로**다.
      enabled: isEnabled(row?.enabled),
      // **어느 전략의 줄인지 명시한다.** 이 두 줄이 없어서 지금 이 파일이 생겼다.
      ...(strategyId ? { strategyId } : {}),
      ...(strategyVersion == null || strategyVersion === '' ? {} : { strategyVersion: String(strategyVersion) }),
      // 크기 설정은 실어 보낸다 — upsert 경로라 안 실으면 null로 덮인다.
      leverageCap: row?.leverage_cap ?? undefined,
      riskPct: row?.risk_pct ?? undefined,
      marginPct: row?.margin_pct ?? undefined,
      intervalMin: row?.interval_min ?? undefined,
    },
    message: '이 예약의 연결만 바꿉니다',
  };
}

// ── 서버가 받는 것 ───────────────────────────────────

export interface PatchParse {
  ok: boolean;
  code: 'OK' | 'MISSING_ID' | 'INVALID_ENABLED';
  status: number;
  id: string;
  enabled: boolean | null;
  message: string;
}

/**
 * PATCH 본문 해석.
 *
 * **`enabled`는 boolean이어야 한다.** 문자열 `'false'`를 받아 Boolean()으로
 * 눕히면 끄려던 요청이 켜기가 된다. 모르는 모양은 400으로 막는다 —
 * 조용히 한쪽으로 눕히는 쪽이 언제나 더 나쁘다.
 */
export function parseTogglePatch(body: any): PatchParse {
  const id = String(body?.id ?? '').trim();
  if (!id) {
    return {
      ok: false, code: 'MISSING_ID', status: 400, id: '', enabled: null,
      message: '어느 예약인지(id)가 없습니다',
    };
  }
  if (typeof body?.enabled !== 'boolean') {
    return {
      ok: false, code: 'INVALID_ENABLED', status: 400, id, enabled: null,
      message: `enabled는 true 또는 false여야 합니다 (받은 값: ${JSON.stringify(body?.enabled)})`,
    };
  }
  return { ok: true, code: 'OK', status: 200, id, enabled: body.enabled, message: '' };
}

/**
 * UPDATE에 실을 것. **`enabled` 하나뿐이다.**
 *
 * 함수로 두는 이유는 하나다: 여기에 칸이 하나라도 늘면 테스트가 깨진다.
 * 정체나 크기 설정이 이 경로로 새어 들어오는 것을 코드가 아니라 테스트가
 * 막는다. PATCH와 DELETE가 같은 것을 쓴다 — 끄는 방법이 둘이면 한쪽만 고쳐진다.
 */
export function enabledUpdate(enabled: boolean): { enabled: boolean } {
  return { enabled: enabled === true };
}

/** UPDATE가 0줄을 바꿨을 때. **만들지 않는다** */
export function notFoundMessage(id: string): string {
  return `그 예약을 찾지 못했습니다 (id: ${id}) — 내 예약이 아니거나 이미 지워졌습니다. `
    + '새로 만들지 않습니다';
}

// ── 화면이 결과를 반영하는 법 ────────────────────────

/**
 * 서버가 돌려준 줄을 목록에 반영한다.
 *
 * **id가 맞는 줄만 바꾼다.** 못 찾으면 null이다 — 그때 화면은 짐작으로
 * 뒤집지 말고 GET으로 다시 읽어야 한다.
 */
export function applyToggleResult(rows: any[], updated: any): any[] | null {
  const id = String(updated?.id ?? '').trim();
  if (!id || !Array.isArray(rows)) return null;
  let hit = false;
  const next = rows.map(r => {
    if (String(r?.id ?? '') !== id) return r;
    hit = true;
    // 서버가 준 칸만 덮는다. 화면이 들고 있던 파생값(runtime·strategyName
    // 같은 것)은 다음 GET이 다시 채운다.
    return { ...r, ...updated };
  });
  return hit ? next : null;
}

/**
 * 실패했을 때 화면이 적을 말.
 *
 * **실패를 성공처럼 뒤집지 않는다.** 예전 토글은 응답을 제대로 안 보고
 * 다시 읽기만 했다 — 서버가 다른 줄을 바꿔도 화면은 조용했다.
 * 서버가 말한 이유를 그대로 옮긴다.
 */
export function toggleFailureNote(status: number, body: any): string {
  const said = String(body?.message ?? body?.error ?? '').trim();
  if (said) return `${said} (${status})`;
  return `예약 상태를 바꾸지 못했습니다 (${status}) — 화면 상태는 그대로 둡니다`;
}
