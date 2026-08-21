// src/lib/engine/autotradeHealth.ts
//
// **자동매매가 지금 도는가.** 한 화면에서 답한다.
//
// 왜 필요한가
// ───────────
// 이 프로젝트에서 가장 비싼 결함은 전부 같은 모양이었다 —
// **켜져 있다고 믿는데 실제로는 안 도는 것.**
//
//  · 크론이 vercel.json에 아예 없어서 한 번도 안 돌았다
//  · 화면은 `+₩847,000`을 띄우는데 엔진은 잠들어 있었다
//  · 예약 표가 없어서 실행기가 매번 조용히 끝났다
//  · 손절 감시 워크플로가 30회 연속 실패 중이었다(시크릿 미설정)
//
// 각각은 다른 원인이지만 사용자가 겪는 것은 하나다: **알 수가 없다.**
// 화면 여기저기에 조각조각 떠 있고, 그걸 다 모아야 판단이 된다.
//
// 이 파일이 지키는 것
// ───────────────────
// 1. **증거 없이 '돌고 있다'고 말하지 않는다.** 설정이 다 맞아도 실제로
//    돈 기록이 없으면 '아직 안 돌았다'이다. 설정과 실행은 다른 것이다.
// 2. **'확인 못 함'과 '안 됨'을 구분한다.** 조회에 실패한 것을 고장으로
//    적으면 사용자가 멀쩡한 것을 고치러 간다. 반대로 통과로 적으면
//    고장을 놓친다.
// 3. **막힌 항목마다 무엇을 해야 하는지 적는다.** "연결 없음"만 적으면
//    어디서 무엇을 눌러야 하는지 알 수 없다.

export type HealthState = 'ok' | 'bad' | 'unknown';

export interface HealthItem {
  id: string;
  label: string;
  state: HealthState;
  /** 지금 상태를 사실대로 */
  detail: string;
  /** 막혔을 때 무엇을 해야 하는가. ok면 빈 문자열 */
  action: string;
}

export interface HealthInput {
  /** autotrade_schedules 행들 (사용자 것) */
  schedules?: Array<{
    symbol?: string | null; enabled?: boolean | null; connection_id?: string | null;
    mode?: string | null; last_run_at?: string | null; last_result?: string | null;
    interval_min?: number | null;
  }> | null;
  /** cron_runs에서 읽은 daily-ladder 실행 기록 (최신순) */
  runs?: Array<{ status?: string | null; detail?: string | null; started_at?: string | null }> | null;
  /** 실행 기록을 못 읽었으면 그 이유. 빈 배열과 '못 읽음'은 다르다 */
  runsError?: string | null;
  /** 표가 아예 없을 때 */
  tableMissing?: boolean;
  /** 서버에 ADMIN_SECRET이 있는가. **값은 절대 받지 않는다** */
  adminSecretSet?: boolean;
  /** 서버에 CRON_SECRET이 있는가. 없으면 Vercel 크론이 401을 받는다 */
  cronSecretSet?: boolean;
  /**
   * 실주문이 **실제로 열려 있는가.** 스위치가 켜졌는지가 아니라
   * 이 환경에서 나갈 수 있는지다 — 미리보기는 스위치가 켜져 있어도 막힌다.
   */
  liveUnlocked?: boolean;
  /** 왜 열렸는지/막혔는지. 서버(liveTradingGate)가 준 그대로 */
  liveGate?: { env?: string; reason?: string; previewOverride?: boolean } | null;
  /** margin_pct 칸이 있는가 (마이그레이션 036). null이면 확인 못 함 */
  marginColumnPresent?: boolean | null;
  /** 켜진 예약의 연결 정보 — 모드와 목적지가 맞는지 본다 */
  connections?: Array<{ id?: string | null; is_testnet?: boolean | null }> | null;
  /** exit-monitor 실행 기록 (최신순). 포지션을 닫아 주는 크론이다 */
  exitRuns?: Array<{ status?: string | null; detail?: string | null; started_at?: string | null }> | null;
  /** 지금 열려 있는 계단식 거래 수. **null은 '못 읽음'이고 0이 아니다** */
  openTradeCount?: number | null;
  /** 크론이 도는 UTC 시각 */
  cronUtcHour?: number | null;
  /** 지금 시각 (ms). 테스트가 시계를 고정할 수 있어야 한다 */
  nowMs: number;
}

export interface HealthReport {
  items: HealthItem[];
  /** 한 줄 결론 */
  verdict: string;
  /**
   * 실제로 돌고 있는가.
   * **true는 실행 기록이 있을 때만.** null은 '확인하지 못했다'이고,
   * 그것을 false(고장)로도 true(정상)로도 읽지 않는다.
   */
  running: boolean | null;
  /** 가장 먼저 해야 할 일. 없으면 빈 문자열 */
  nextAction: string;
}

const DAY_MS = 24 * 3600_000;

const item = (id: string, label: string, state: HealthState, detail: string, action = ''): HealthItem =>
  ({ id, label, state, detail, action });

/** '3시간 전' 같은 말. 미래면 그렇게 적는다 — 시계 어긋남이 숨으면 안 된다 */
export function agoText(fromMs: number, nowMs: number): string {
  const d = nowMs - fromMs;
  if (!Number.isFinite(d)) return '시각 불명';
  if (d < 0) return `${Math.round(-d / 60000)}분 후 (시각이 미래입니다)`;
  const m = Math.floor(d / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 다음 크론까지 몇 시간인가 */
export function nextCronText(cronUtcHour: number | null | undefined, nowMs: number): string {
  // **Number(null)은 0이다.** 그대로 두면 '모른다'가 '자정에 돈다'가 되고,
  // 화면은 있지도 않은 다음 실행 시각을 자신 있게 적는다. 0시는 실제로
  // 쓸 수 있는 값이라 뒤의 범위 검사로도 안 걸린다.
  if (cronUtcHour == null) return '크론 시각을 알 수 없습니다';
  const h = Number(cronUtcHour);
  if (!Number.isFinite(h) || h < 0 || h > 23) return '크론 시각을 알 수 없습니다';
  const now = new Date(nowMs);
  const next = new Date(nowMs);
  next.setUTCHours(h, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  const mins = Math.round((next.getTime() - nowMs) / 60000);
  const kstHour = (h + 9) % 24;
  // '실행'이 아니라 '평가'다 — 주기가 와도 조건이 안 맞으면 주문하지 않는다.
  return `다음 평가 약 ${Math.floor(mins / 60)}시간 ${mins % 60}분 뒤 (한국 ${String(kstHour).padStart(2, '0')}:00)`;
}

export function autotradeHealth(input: HealthInput): HealthReport {
  const items: HealthItem[] = [];
  const now = input.nowMs;

  // ── 1) 예약 표 ──
  if (input.tableMissing) {
    items.push(item('table', '예약 표', 'bad',
      'autotrade_schedules 표가 없습니다',
      '마이그레이션 031~035를 자동으로 적용하는 중입니다'));
    return {
      items, running: false,
      verdict: '자동매매가 돌 수 없습니다 — 예약을 저장할 표가 없습니다',
      nextAction: items[0].action,
    };
  }

  const rows = Array.isArray(input.schedules) ? input.schedules : null;
  if (!rows) {
    items.push(item('table', '예약 표', 'unknown',
      '예약을 읽지 못했습니다',
      '잠시 뒤 새로고침해 보세요'));
  } else if (rows.length === 0) {
    items.push(item('table', '등록된 예약', 'bad',
      '등록된 예약이 없습니다',
      '아래에서 종목·연결을 고르고 자동매매를 켜세요'));
  } else {
    items.push(item('table', '등록된 예약', 'ok', `${rows.length}건`));
  }

  const on = (rows || []).filter(r => r?.enabled === true);

  // ── 2) 켜져 있는가 ──
  if (rows && rows.length > 0) {
    items.push(on.length > 0
      ? item('enabled', '스위치', 'ok', `${on.length}건 켜짐`)
      : item('enabled', '스위치', 'bad', '전부 꺼져 있습니다', '예약 카드의 스위치를 켜세요'));
  }

  // ── 3) 연결 ──
  //
  // 연결이 없으면 실행기가 불려도 주문을 낼 수 없다. 그런데 그건
  // '안 도는 것'처럼 보이지 않는다 — 매번 조용히 건너뛴다.
  if (on.length > 0) {
    const noConn = on.filter(r => !r?.connection_id);
    items.push(noConn.length === 0
      ? item('conn', '거래소 연결', 'ok', '켜진 예약에 연결이 지정돼 있습니다')
      : item('conn', '거래소 연결', 'bad',
          `${noConn.length}건에 연결이 없습니다 (${noConn.map(r => r?.symbol || '?').join(', ')})`,
          '예약 카드에서 거래소 연결을 고르세요 — 연결 없이는 주문이 나가지 않습니다'));
  }

  // ── 4) 자동 실행 열쇠 ──
  //
  // 크론이 진입 엔진을 부르려면 서버에 ADMIN_SECRET이 있어야 한다.
  // **값은 여기로 오지 않는다** — 있다/없다만 본다.
  if (input.adminSecretSet === true) {
    items.push(item('secret', '자동 실행 열쇠', 'ok', '설정돼 있습니다'));
  } else if (input.adminSecretSet === false) {
    items.push(item('secret', '자동 실행 열쇠', 'bad',
      'ADMIN_SECRET이 없어 크론이 진입 엔진을 부를 수 없습니다',
      'Vercel → Settings → Environment Variables에 ADMIN_SECRET을 넣고 재배포하세요'));
  } else {
    items.push(item('secret', '자동 실행 열쇠', 'unknown', '확인하지 못했습니다', ''));
  }

  // ── 4-b) 크론 열쇠 ──
  //
  // Vercel 크론은 Bearer CRON_SECRET으로 들어온다. 없으면 매일 401을
  // 받고 아무 일도 안 일어난다. ADMIN_SECRET과 **다른 값이고 둘 다 필요하다.**
  if (input.cronSecretSet === false) {
    items.push(item('cronsecret', '크론 열쇠', 'bad',
      'CRON_SECRET이 없어 Vercel 크론이 인증되지 않습니다',
      'Vercel → Settings → Environment Variables에 CRON_SECRET을 넣고 재배포하세요'));
  } else if (input.cronSecretSet === true) {
    items.push(item('cronsecret', '크론 열쇠', 'ok', '설정돼 있습니다'));
  }

  // ── 4-c) 실전 예약이라면 ──
  //
  // 여기가 이번에 가장 조용했던 구멍이다. 아래 셋 중 하나라도 어긋나면
  // **설정은 전부 초록인데 실전 주문이 한 건도 안 나간다.**
  const liveRows = on.filter(r => {
    const m = String(r?.mode || '').toUpperCase();
    return m.startsWith('LIVE') || m === 'SHADOW_LIVE';
  });

  if (liveRows.length > 0) {
    // (1) 실거래 잠금. 이게 안 풀려 있으면 진입 엔진이 403으로 끝난다.
    if (input.liveUnlocked === true) {
      // 미리보기 예외로 열린 것이면 초록으로 넘기지 않는다. 그건 정상
      // 상태가 아니라 **일부러 켜 둔 예외**이고, 예외는 보여야 한다.
      items.push(input.liveGate?.previewOverride
        ? item('livelock', '실거래 잠금', 'unknown',
            '미리보기(Preview) 배포인데 실주문이 열려 있습니다 — 일부러 켠 예외 상태입니다',
            '확인이 끝나면 ALLOW_LIVE_TRADING_ON_PREVIEW를 끄세요')
        : item('livelock', '실거래 잠금', 'ok',
            `풀려 있습니다${input.liveGate?.env ? ` (${input.liveGate.env})` : ''}`));
    } else if (input.liveUnlocked === false) {
      // **'스위치가 꺼짐'과 '미리보기라 막힘'은 다른 문제다.**
      // 둘 다 "잠겨 있습니다"로 적으면 사용자는 이미 켠 스위치를
      // 또 켜러 간다. 서버가 준 이유를 그대로 쓴다.
      items.push(item('livelock', '실거래 잠금',
        // 미리보기에서 막힌 것은 고장이 아니다. ❌로 두면 사용자가
        // 고치러 가고, 고치면 구멍이 열린다.
        input.liveGate?.env === 'preview' ? 'unknown' : 'bad',
        input.liveGate?.reason || '실거래가 잠겨 있어 실전 예약이 매번 403으로 끝납니다',
        // **미리보기에서는 할 일이 없다.** 막힌 것이 정상이므로 고치라고
        // 하면 안 된다 — 시키는 대로 하면 방금 닫은 구멍이 다시 열린다.
        input.liveGate?.env === 'preview'
          ? '실전 동작은 본 주소(Production)에서 확인하세요 — 여기서 고칠 것은 없습니다'
          : 'Vercel에 ALLOW_LIVE_TRADING=true를 넣고 재배포하세요'));
    } else {
      items.push(item('livelock', '실거래 잠금', 'unknown', '확인하지 못했습니다', ''));
    }

    // (2) 크론이 실제로 주문을 낼 수 있는 모드인가.
    //     LIVE_SMALL은 정의상 건마다 사람이 눌러야 한다. 예약에 걸어 두면
    //     매일 409로 끝나고, 화면에는 '켜짐'만 보인다.
    const needConfirm = liveRows.filter(r => String(r?.mode || '').toUpperCase() === 'LIVE_SMALL');
    if (needConfirm.length > 0) {
      items.push(item('automode', '자동 실행 가능 모드', 'bad',
        `${needConfirm.length}건이 LIVE_SMALL입니다 — 건마다 사람 확인이 필요한 모드라 예약으로는 주문이 나가지 않습니다`,
        '자동 화면에서 실전 스위치를 다시 저장하세요 (제한 자동매매로 바뀝니다) — 또는 매매 화면에서 직접 주문하세요'));
    } else {
      items.push(item('automode', '자동 실행 가능 모드', 'ok',
        `${liveRows.length}건이 확인 없이 실행 가능한 모드입니다`));
    }

    // (3) 모드와 연결의 목적지가 맞는가.
    //     실전 모드 + 테스트넷 연결이면 주문이 테스트넷으로 새고,
    //     반대면 실계좌 키로 데모 서버를 두드려 전부 실패한다(-2015).
    const connMap = new Map<string, boolean | null>();
    for (const c of (input.connections || [])) {
      if (c?.id) connMap.set(String(c.id), c.is_testnet === false);
    }
    if (connMap.size === 0) {
      items.push(item('dest', '연결 목적지', 'unknown', '연결 정보를 확인하지 못했습니다', ''));
    } else {
      const bad2 = liveRows.filter(r => {
        const isLive = r?.connection_id ? connMap.get(String(r.connection_id)) : undefined;
        return isLive === false;   // 실전 모드인데 테스트넷 연결
      });
      items.push(bad2.length === 0
        ? item('dest', '연결 목적지', 'ok', '실전 모드에 실전 연결이 걸려 있습니다')
        : item('dest', '연결 목적지', 'bad',
            `${bad2.length}건이 실전 모드인데 테스트넷 연결입니다 (${bad2.map(r => r?.symbol || '?').join(', ')})`,
            '자동 화면에서 실전 연결을 고르세요 — 지금은 주문이 테스트넷으로 나갑니다'));
    }
  }

  // ── 4-d) 증거금 칸 ──
  //
  // margin_pct가 없으면 증거금 예산이 가용 전액이 되고, 배율은 낮게
  // 역산된다. 화면에 100을 넣어도 5배가 나간다 — 에러 없이.
  if (input.marginColumnPresent === false) {
    items.push(item('margincol', '1회 증거금 칸', 'bad',
      'margin_pct 칸이 없어 배율이 낮게 역산됩니다 (화면에 100을 넣어도 그대로 안 나갑니다)',
      '마이그레이션 036을 자동으로 적용하는 중입니다'));
  } else if (input.marginColumnPresent === true) {
    items.push(item('margincol', '1회 증거금 칸', 'ok', '있습니다 (마이그레이션 036 적용됨)'));
  }

  // ── 5) **실제로 돌았는가** ──
  //
  // 여기가 이 파일의 핵심이다. 위 항목이 전부 초록이어도 실행 기록이
  // 없으면 **한 번도 안 돈 것**이다. 설정과 실행은 다른 것이고, 지금까지
  // 이 둘을 구분하지 않아서 "켜 놨는데 왜 아무 일도 없지"가 반복됐다.
  let running: boolean | null = null;
  const runs = Array.isArray(input.runs) ? input.runs : null;

  if (input.runsError) {
    items.push(item('ran', '실제 실행', 'unknown',
      `실행 기록을 읽지 못했습니다 (${input.runsError})`,
      '기록을 못 읽었을 뿐, 안 돌았다는 뜻은 아닙니다'));
  } else if (!runs || runs.length === 0) {
    items.push(item('ran', '실제 실행', 'bad',
      '실행 기록이 없습니다 — 아직 한 번도 안 돌았습니다',
      // 고정 시각이 있으면 그것만 적고, 없으면 **없다고 말한다.**
      // 예전에는 없을 때도 '아침 8시'를 만들어 냈다.
      input.cronUtcHour != null ? nextCronText(input.cronUtcHour, now)
        : '서버 실행기가 주기적으로 확인합니다 — 몇 분 뒤에도 비어 있으면 실행기 상태를 보세요'));
    running = false;
  } else {
    const last = runs[0];
    const t = last?.started_at ? new Date(last.started_at).getTime() : NaN;
    const okStatus = String(last?.status || '').toLowerCase();
    const when = Number.isFinite(t) ? agoText(t, now) : '시각 불명';

    if (!Number.isFinite(t)) {
      items.push(item('ran', '실제 실행', 'unknown',
        `마지막 실행 시각을 읽지 못했습니다 (${last?.detail || ''})`, ''));
    } else if (okStatus === 'failed') {
      items.push(item('ran', '실제 실행', 'bad',
        `마지막 실행이 실패했습니다 — ${when} · ${last?.detail || '이유 미상'}`,
        '아래 실행 기록의 이유를 보세요'));
      running = false;
    } else if (now - t > 2 * DAY_MS) {
      // 하루 1회 크론인데 이틀 넘게 기록이 없으면 멈춘 것이다.
      items.push(item('ran', '실제 실행', 'bad',
        `마지막 실행이 ${when}입니다 — 그 뒤로 돈 기록이 없습니다`,
        '크론이 멈췄을 수 있습니다. 배포 상태와 ADMIN_SECRET을 확인하세요'));
      running = false;
    } else {
      items.push(item('ran', '실제 실행', 'ok',
        `${when} · ${last?.detail || okStatus || '기록됨'}`));
      running = true;
    }
  }

  // ── 5-b) **포지션을 닫아 줄 크론은 도는가** ──
  //
  // 지금까지 진입만 보고 있었다. 그런데 여는 것과 닫는 것은 다른
  // 크론이다(exit-monitor). 그게 멈춰 있으면 트레일링 손절도 시간
  // 청산도 안 된다 — 진입이 안 되는 것보다 나쁘다.
  //
  // **열린 거래가 있을 때만 묻는다.** 포지션이 없는데 빨간 줄을 띄우면
  // 목록을 안 믿게 된다. 그리고 '열린 거래 0건'과 '못 읽음'은 다르다.
  if (input.openTradeCount != null && input.openTradeCount > 0) {
    const er = Array.isArray(input.exitRuns) ? input.exitRuns : null;
    const last = er && er.length > 0 ? er[0] : null;
    const t = last?.started_at ? new Date(last.started_at).getTime() : NaN;

    if (!er) {
      items.push(item('exitmon', '청산 감시', 'unknown',
        `열린 거래 ${input.openTradeCount}건 · 청산 감시 기록을 읽지 못했습니다`, ''));
    } else if (!last || !Number.isFinite(t)) {
      items.push(item('exitmon', '청산 감시', 'bad',
        `열린 거래 ${input.openTradeCount}건인데 청산 감시가 돈 기록이 없습니다 — 손절 이동·시간 청산이 일어나지 않습니다`,
        'Vercel 크론(exit-monitor)과 CRON_SECRET을 확인하세요'));
    } else if (String(last.status || '').toLowerCase() === 'failed') {
      items.push(item('exitmon', '청산 감시', 'bad',
        `청산 감시가 실패했습니다 — ${agoText(t, now)} · ${last.detail || '이유 미상'}`,
        '실패가 이어지면 열린 포지션이 손절 이동 없이 방치됩니다'));
    } else if (now - t > 2 * DAY_MS) {
      items.push(item('exitmon', '청산 감시', 'bad',
        `청산 감시가 ${agoText(t, now)} 이후로 안 돌았습니다 — 열린 거래 ${input.openTradeCount}건이 방치돼 있습니다`,
        '배포 상태와 크론 등록을 확인하세요'));
    } else {
      items.push(item('exitmon', '청산 감시', 'ok',
        `${agoText(t, now)} · 열린 거래 ${input.openTradeCount}건 감시 중`));
    }
  }

  // ── 6) 마지막에 무엇을 했는가 ──
  //
  // '돌았다'와 '진입했다'는 다르다. 대부분의 날은 조건이 안 맞아 진입하지
  // 않고, 그건 정상이다. 그 사실을 적어야 사용자가 기다릴 수 있다.
  const withRun = (rows || []).filter(r => r?.last_run_at);
  if (withRun.length > 0) {
    const latest = withRun
      .map(r => ({ r, t: new Date(String(r.last_run_at)).getTime() }))
      .filter(x => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t)[0];
    if (latest) {
      items.push(item('result', '마지막 판단', 'ok',
        `${latest.r.symbol || '?'} · ${agoText(latest.t, now)} · ${latest.r.last_result || '기록 없음'}`));
    }
  }

  // ── 결론 ──
  const bad = items.find(i => i.state === 'bad');
  const unknown = items.filter(i => i.state === 'unknown');

  let verdict: string;
  if (bad) {
    verdict = `자동매매가 돌지 않습니다 — ${bad.detail}`;
  } else if (running === true) {
    verdict = unknown.length > 0
      ? `돌고 있습니다 (확인 못 한 항목 ${unknown.length}개)`
      : '켜져 있고 실제로 돌고 있습니다';
  } else {
    // 나쁜 항목은 없는데 돌았다는 증거도 없다. **정상이라고 말하지 않는다.**
    verdict = '설정은 맞지만 실제로 돈 기록을 확인하지 못했습니다';
  }

  return { items, verdict, running, nextAction: bad?.action || '' };
}
