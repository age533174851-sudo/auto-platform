// src/lib/system/statusReport.ts
//
// **지금 무엇이 실제로 돌고 있는가** — 판정만 하는 순수 부분.
//
// 왜 필요한가
// ───────────
// 이 저장소에서 하루에만 여덟 개를 찾았다. 전부 같은 모양이었다:
//
//   · 지표 회피 게이트가 빈 배열을 읽어 한 번도 안 막음
//   · 실전 분류가 SELECT에서 빠져 실전 탭이 영영 빔
//   · 연결 테스트가 환경을 안 넘겨 늘 실전 서버를 부름
//   · 선물 잔고를 없는 필드명으로 읽어 가용 증거금이 늘 0
//   · 백테스트에 손절·청산이 아예 없음
//   · 캘린더 크론이 vercel.json에 등록 안 됨
//   · 서비스워커 캐시 버전이 두 달째 그대로
//   · 수량 반올림이 수동 주문 경로에서 안 불림
//
// 전부 에러가 안 나고 화면이 멀쩡했다. 테스트 1400개도 안 잡았다 —
// 코드가 아니라 **배선**이 틀린 종류였기 때문이다.
//
// 그런 것을 매번 사람이 뒤져서 찾는 것은 방법이 아니다. 이 화면은
// "설정이 이렇습니다"를 안 보여준다. **마지막으로 실제로 일어난 일**만
// 보여준다.
//
// 세 가지를 구분한다
// ──────────────────
//   정상       최근에 실제로 돌았다
//   문제       돌아야 하는데 안 돌았거나 실패했다
//   확인 불가  **읽지 못했다.** 정상도 문제도 아니다
//
// 마지막 것이 이 파일의 존재 이유다. 못 읽은 것을 초록으로 그리면
// 이 화면 자체가 여덟 개 중 아홉 번째가 된다.

export type Health = 'ok' | 'warn' | 'bad' | 'unknown';

export interface StatusItem {
  id: string;
  label: string;
  health: Health;
  /** 화면에 그대로 띄울 한 줄 */
  detail: string;
  /** 사용자가 할 수 있는 일. 없으면 null */
  action: string | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 사람이 읽는 경과 시간 */
export function ago(ms: number | null | undefined, nowMs: number): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = nowMs - ms;
  if (d < 0) return '방금';
  if (d < MIN) return '방금';
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`;
  if (d < 24 * HOUR) return `${Math.floor(d / HOUR)}시간 전`;
  return `${Math.floor(d / (24 * HOUR))}일 전`;
}

export interface CronExpectation {
  job: string;
  label: string;
  /** 이 간격보다 오래 안 돌았으면 문제 (ms) */
  maxGapMs: number;
}

export interface CronRunRow {
  job: string;
  status?: string | null;
  detail?: string | null;
  started_at?: any;
}

/**
 * 크론 실행 이력 → 항목별 상태.
 *
 * @param rows **못 읽었으면 null**을 넘긴다. 빈 배열(한 번도 안 돎)과
 *             구분해야 한다 — 앞은 확인 불가, 뒤는 확인된 문제다.
 */
export function cronStatus(
  rows: CronRunRow[] | null | undefined,
  expected: CronExpectation[],
  nowMs: number,
): StatusItem[] {
  const known = Array.isArray(rows);

  return expected.map(e => {
    if (!known) {
      return {
        id: `cron:${e.job}`, label: e.label, health: 'unknown' as Health,
        detail: '실행 이력을 읽지 못했습니다 — 안 돌았다는 뜻이 아닙니다',
        action: '기록표(cron_runs)를 자동으로 적용하는 중입니다',
      };
    }

    // 이 작업의 실행만. 가장 최근 것 하나.
    let last: { ms: number; status: string; detail: string } | null = null;
    for (const r of rows!) {
      if (String(r?.job || '') !== e.job) continue;
      const t = Date.parse(String(r?.started_at ?? ''));
      if (!Number.isFinite(t)) continue;
      if (last == null || t > last.ms) {
        last = { ms: t, status: String(r?.status || ''), detail: String(r?.detail || '') };
      }
    }

    if (!last) {
      // 표는 읽었는데 이 작업의 기록이 없다. **확인된 문제다.**
      return {
        id: `cron:${e.job}`, label: e.label, health: 'bad',
        detail: '한 번도 실행된 적이 없습니다',
        action: 'vercel.json에 등록됐는지, CRON_SECRET이 맞는지 확인하세요',
      };
    }

    const gap = nowMs - last.ms;
    const when = ago(last.ms, nowMs);

    if (last.status === 'failed') {
      // **성공만 보면 안 된다.** "마지막 성공이 3일 전"과 "3일 동안 매번
      // 실패"가 똑같이 보이는데, 뒤쪽이 훨씬 급하고 더 조용하다.
      return {
        id: `cron:${e.job}`, label: e.label, health: 'bad',
        detail: `${when} 실패 — ${last.detail || '이유 없음'}`,
        action: '로그를 확인하세요',
      };
    }
    if (gap > e.maxGapMs) {
      return {
        id: `cron:${e.job}`, label: e.label, health: 'bad',
        detail: `${when}이 마지막입니다 (${Math.round(e.maxGapMs / HOUR)}시간마다 돌아야 합니다)`,
        action: 'vercel.json 등록과 배포 상태를 확인하세요',
      };
    }
    // 절반을 넘으면 미리 알린다. 완전히 멈춘 뒤에 아는 것보다 낫다.
    if (gap > e.maxGapMs / 2) {
      return {
        id: `cron:${e.job}`, label: e.label, health: 'warn',
        detail: `${when} · ${last.status === 'skipped' ? '할 일 없음' : last.detail || '정상'}`,
        action: null,
      };
    }
    return {
      id: `cron:${e.job}`, label: e.label, health: 'ok',
      detail: `${when} · ${last.status === 'skipped' ? '할 일 없음' : last.detail || '정상'}`,
      action: null,
    };
  });
}

export interface TableProbe {
  name: string;
  label: string;
  /** true=있음, false=없음, null=**확인 못 함** */
  exists: boolean | null;
  migration: string;
}

/** 마이그레이션이 적용됐는가 */
export function tableStatus(probes: TableProbe[]): StatusItem[] {
  return probes.map(p => {
    if (p.exists === null) {
      return {
        id: `table:${p.name}`, label: p.label, health: 'unknown' as Health,
        detail: '표가 있는지 확인하지 못했습니다',
        action: null,
      };
    }
    if (!p.exists) {
      return {
        id: `table:${p.name}`, label: p.label, health: 'bad' as Health,
        // **무엇을 해야 하는지 적는다.** '표 없음'만 적으면 사용자가
        // 할 수 있는 일이 없다.
        detail: `${p.name} 표가 없습니다 — 이 기능은 아무것도 기록하지 못합니다`,
        action: `마이그레이션 ${p.migration}을 자동으로 적용하는 중입니다`,
      };
    }
    return {
      id: `table:${p.name}`, label: p.label, health: 'ok' as Health,
      detail: '적용됨', action: null,
    };
  });
}

/**
 * **자동매매가 지금 돌 수 있는 상태인가.**
 *
 * 왜 따로 두는가
 * ──────────────
 * 표가 있는지, 크론이 도는지, 예약 줄이 있는지를 각각 초록불로 보여줘도
 * "그래서 자동매매가 도는 거야?"에는 답이 안 된다. 넷 중 하나만 빠져도
 * 아무 일도 안 일어나는데, 화면에는 초록 셋과 회색 하나가 보일 뿐이다.
 *
 * 실제로 이 저장소가 몇 달 동안 그 상태였다 — 설정은 다 있고, 에러도 안
 * 나고, **한 번도 안 돌았다.** 그래서 조건을 하나로 합쳐서 한 줄로 답한다.
 *
 * 순서가 있다. 앞이 안 되면 뒤는 볼 필요도 없다.
 */
export interface AutotradeProbe {
  /** autotrade_schedules 표가 있는가. null=확인 못 함 */
  tableExists: boolean | null;
  /** 켜져 있고 연결이 붙은 줄의 수. null=확인 못 함 */
  enabledRows: number | null;
  /** 그중 connection_id가 비어 있는 줄. 있으면 그 줄은 주문을 못 낸다 */
  rowsMissingConnection: number | null;
  /** ADMIN_SECRET이 서버에 있는가 (크론이 진입 엔진을 부를 때 쓴다) */
  adminSecretSet: boolean;
  /** CRON_SECRET이 서버에 있는가 */
  cronSecretSet: boolean;
  /** daily-ladder가 마지막으로 돈 시각. null=한 번도 안 돎(또는 기록 없음) */
  lastRunMs: number | null;
  lastResult: string | null;
}

export function autotradeStatus(p: AutotradeProbe, nowMs: number): StatusItem {
  const id = 'autotrade';
  const label = '자동매매';
  const bad = (detail: string, action: string): StatusItem =>
    ({ id, label, health: 'bad', detail, action });

  if (p.tableExists === null) {
    return { id, label, health: 'unknown',
      detail: '예약 표를 읽지 못해 판단할 수 없습니다', action: null };
  }
  if (!p.tableExists) {
    return bad('autotrade_schedules 표가 없습니다 — 크론이 읽을 것이 없습니다',
      '마이그레이션 031을 자동으로 적용하는 중입니다');
  }
  if (p.enabledRows === null) {
    return { id, label, health: 'unknown',
      detail: '켜진 예약이 있는지 확인하지 못했습니다', action: null };
  }
  if (p.enabledRows === 0) {
    // 표는 있는데 줄이 없다. 크론은 돌지만 **할 일이 없다.**
    return bad('켜진 자동매매 예약이 없습니다 — 크론이 돌아도 아무 일도 하지 않습니다',
      'autotrade_schedules에 enabled=true인 줄을 하나 만드세요');
  }
  if ((p.rowsMissingConnection ?? 0) > 0) {
    return bad(`예약 ${p.rowsMissingConnection}건에 거래소 연결이 없습니다 — 실행돼도 주문을 낼 수 없습니다`,
      '그 줄의 connection_id를 채우세요');
  }
  if (!p.adminSecretSet) {
    // 크론(GET)이 진입 엔진(POST)을 자기 자신에게 부를 때 쓴다.
    // 없으면 401로 조용히 죽고, 아무 데도 안 남는다.
    return bad('ADMIN_SECRET이 없습니다 — 크론이 진입 엔진을 부르지 못하고 401로 끝납니다',
      'Vercel 환경변수에 ADMIN_SECRET을 넣고 **재배포**하세요 (저장만 하면 적용되지 않습니다)');
  }
  if (!p.cronSecretSet) {
    return bad('CRON_SECRET이 없습니다 — Vercel 크론이 인증되지 않습니다',
      'Vercel 환경변수에 CRON_SECRET을 넣고 **재배포**하세요');
  }

  // 여기까지 왔으면 설정은 다 됐다. 이제 **실제로 돌았는가**만 남는다.
  if (p.lastRunMs == null) {
    return { id, label, health: 'warn',
      detail: '설정은 끝났는데 아직 한 번도 실행된 기록이 없습니다',
      // **하루 1회가 아니다.** 실행기는 주기적으로 예약을 확인한다.
      // 고정 시각을 적으면 "그 시각까지는 안 도는 게 정상"으로 읽힌다.
      action: '서버 실행기가 주기적으로 예약을 확인합니다. 몇 분 뒤에도 기록이 비어 있으면 실행기 상태를 확인하세요' };
  }
  const gap = nowMs - p.lastRunMs;
  // **하루 1회 전제로 잡아 둔 값이다.** 실행기는 그보다 자주 도는데
  // 30시간을 기준으로 두면 반나절 멈춰 있어도 '정상'으로 보인다.
  // 다만 예약마다 확인 주기가 달라서 여기서 정확한 값을 쓸 수 없다 —
  // 예약별 판정은 화면(nextRun)이 하고, 여기서는 확실히 이상한 구간만 잡는다.
  const stale = gap > 6 * 3_600_000;
  if (p.lastResult === 'failed') {
    return bad(`마지막 실행이 실패했습니다 (${ago(p.lastRunMs, nowMs)})`,
      '실행기록에서 실패 사유를 확인하세요');
  }
  if (stale) {
    return { id, label, health: 'warn',
      detail: `마지막 실행이 ${ago(p.lastRunMs, nowMs)}입니다 — 하루 넘게 안 돌았습니다`,
      action: 'Vercel 크론 등록과 최근 배포를 확인하세요' };
  }
  return { id, label, health: 'ok',
    detail: `마지막 실행 ${ago(p.lastRunMs, nowMs)} · ${p.lastResult || '결과 없음'}`,
    action: null };
}

export interface ConnProbe {
  /** 연결 개수. **null이면 못 읽은 것** */
  count: number | null;
  /** 마지막으로 확인에 성공한 시각 */
  lastOkMs: number | null;
  /** 확인 자체를 한 번도 안 한 연결 수 */
  untested: number;
}

/** 거래소·증권사 연결 */
export function connectionStatus(p: ConnProbe, nowMs: number): StatusItem {
  const base = { id: 'connections', label: '거래소·증권사 연결' };
  if (p.count == null) {
    return { ...base, health: 'unknown', detail: '연결 목록을 읽지 못했습니다', action: null };
  }
  if (p.count === 0) {
    // 문제가 아니다 — 모의만 쓰는 사람도 있다. 사실만 적는다.
    return { ...base, health: 'warn', detail: '연결이 없습니다 (모의만 가능)', action: '거래소나 증권사를 연결하세요' };
  }
  if (p.untested > 0) {
    return {
      ...base, health: 'warn',
      detail: `${p.count}개 중 ${p.untested}개는 한 번도 확인하지 않았습니다`,
      action: '연결 화면에서 확인을 눌러 보세요',
    };
  }
  if (p.lastOkMs == null) {
    // 확인 기록이 아예 없다. 연결은 있는데 지금도 되는지는 모른다.
    return { ...base, health: 'unknown', detail: `${p.count}개 · 마지막 확인 시각을 모릅니다`, action: '연결 확인을 눌러 보세요' };
  }
  const stale = nowMs - p.lastOkMs > 7 * 24 * HOUR;
  return {
    ...base,
    health: stale ? 'warn' : 'ok',
    detail: `${p.count}개 · 마지막 확인 ${ago(p.lastOkMs, nowMs)}`,
    action: stale ? '오래됐습니다 — 다시 확인해 보세요' : null,
  };
}

/** 전체 한 줄 요약 */
export function overallSummary(items: StatusItem[]): { health: Health; text: string } {
  const list = Array.isArray(items) ? items : [];
  const bad = list.filter(i => i.health === 'bad').length;
  const unknown = list.filter(i => i.health === 'unknown').length;
  const warn = list.filter(i => i.health === 'warn').length;

  if (bad > 0) {
    return { health: 'bad', text: `${bad}개가 돌지 않고 있습니다` };
  }
  // **확인 불가를 정상으로 합치지 않는다.** 못 읽은 것을 초록으로 그리면
  // 이 화면 자체가 "켜져 있다고 믿는데 안 도는" 것이 된다.
  if (unknown > 0) {
    return { health: 'unknown', text: `${unknown}개를 확인하지 못했습니다` };
  }
  if (warn > 0) {
    return { health: 'warn', text: `${warn}개는 알아둘 것이 있습니다` };
  }
  if (list.length === 0) {
    return { health: 'unknown', text: '확인한 항목이 없습니다' };
  }
  return { health: 'ok', text: `${list.length}개 모두 정상` };
}
