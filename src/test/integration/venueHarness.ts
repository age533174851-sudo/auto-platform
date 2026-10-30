// src/test/integration/venueHarness.ts
//
// **실제 실행 경로를 돌리기 위한 하네스.**
//
// 왜 이것이 필요한가
// ──────────────────
// 지금까지 이 저장소의 주문 경로 검증은 두 겹이었다.
//
//   · 유닛 시험   — 판정 함수(순수)를 직접 불러 확인
//   · 정적 검사기 — 라우트·실행기가 그 판정을 **쓰는지** grep으로 확인
//
// 그런데 라우트·실행기의 **DB 쓰기**는 둘 중 어느 것도 돌려 보지 않았다.
// 그 경로는 `await import('@/…')`로 거래소 어댑터를 불러오고, 러너는
// CommonJS로 컴파일하므로 별칭이 런타임에 해석되지 않아 **올릴 수가
// 없었다.** 그래서 검사기 한 겹에만 의존했고, 변이 검증에서 그 자리의
// 변이는 "검사기만 RED"로 나왔다.
//
// 그 공백을 메운다. 러너에 별칭 해석을 붙였고(`run-tests.mjs`), 여기서는
// **HTTP 경계와 DB 경계만** 가짜로 바꾼다.
//
//   실제로 도는 것: 서명 생성 · 질의 조립 · 응답 파싱 · 체결 사실 추출
//                   (`fillFactsOf`·`gateFillOf`) · 장부 상태 판정
//                   (`ledgerStatusOf*`) · 상태 전이 검증 · DB 쓰기 호출
//   가짜로 바꾸는 것: `fetch` 한 겹 · Supabase 클라이언트 한 겹
//
// 순수 판정 함수만 이어 붙인 것을 통합 시험이라고 부르지 않기 위해,
// **반드시 실행기·라우트 함수 자체를 부른다.**

// ── 모의 거래소 (HTTP 경계) ──────────────────────────

export interface VenueCall {
  method: string;
  /** 질의 문자열을 **뺀** 경로. 서명·키가 들어 있는 부분은 보관하지 않는다 */
  path: string;
  host: string;
  /** 질의 파라미터 (signature는 제거). 주문 파라미터 확인용 */
  params: Record<string, string>;
  body: any;
  /** 인증 헤더가 **있었는가**. 값은 보관하지 않는다 */
  authed: boolean;
}

export interface VenueReply {
  status?: number;
  /** 본문. 함수면 호출 순서(0부터)를 받아 매번 다른 응답을 줄 수 있다 */
  json?: any | ((callIndex: number) => any);
  /** 네트워크 자체가 실패한다 (fetch가 던진다) */
  throws?: string;
  /** 응답이 오지 않는다 — AbortSignal.timeout과 같은 모양 */
  timeout?: boolean;
}

type Matcher = (c: VenueCall) => boolean;

export class FakeVenue {
  readonly calls: VenueCall[] = [];
  private rules: { match: Matcher; reply: VenueReply; label: string }[] = [];
  private hits = new Map<string, number>();

  /** 경로(부분 일치)에 응답을 붙인다. 먼저 등록한 규칙이 이긴다 */
  on(pathFragment: string, reply: VenueReply, method?: string): this {
    this.rules.push({
      label: pathFragment,
      match: (c) => c.path.includes(pathFragment) && (!method || c.method === method),
      reply,
    });
    return this;
  }

  /** 같은 /order 엔드포인트의 MARKET 진입과 조건부 보호주문을 구분한다.
   * HTTP 응답은 계속 가짜지만 실행기의 실제 fallback 분기를 시험한다. */
  onParams(pathFragment: string, method: string,
    params: Record<string, string>, reply: VenueReply): this {
    this.rules.push({
      label: `${pathFragment}:${method}:${JSON.stringify(params)}`,
      match: (c) => c.path.includes(pathFragment) && c.method === method
        && Object.entries(params).every(([k, v]) => c.params[k] === v),
      reply,
    });
    return this;
  }

  /** 이 경로를 몇 번 불렀는가 */
  countOf(pathFragment: string, method?: string): number {
    return this.calls.filter(
      (c) => c.path.includes(pathFragment) && (!method || c.method === method)).length;
  }

  /** 주문 전송 횟수 — 중복 주문 판정의 핵심 숫자 */
  orderSends(): VenueCall[] {
    return this.calls.filter((c) => c.method === 'POST'
      && /\/order\b|\/orders\b/.test(c.path));
  }

  install(): () => void {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = new URL(String(input));
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { if (k !== 'signature') params[k] = v; });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: VenueCall = {
        method: String(init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        host: url.host,
        params,
        body: init?.body ? safeJson(String(init.body)) : null,
        authed: !!(headers['X-MBX-APIKEY'] || headers.KEY || headers.SIGN),
      };
      this.calls.push(call);

      const rule = this.rules.find((r) => r.match(call));
      if (!rule) {
        throw new Error(`[FakeVenue] 규칙 없는 호출: ${call.method} ${call.path}`);
      }
      const n = this.hits.get(rule.label) ?? 0;
      this.hits.set(rule.label, n + 1);

      if (rule.reply.timeout) {
        // 실제 타임아웃과 같은 모양 — AbortSignal.timeout이 던지는 오류다.
        const e: any = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      if (rule.reply.throws) throw new Error(rule.reply.throws);

      const bodyVal = typeof rule.reply.json === 'function'
        ? (rule.reply.json as (i: number) => any)(n)
        : rule.reply.json;
      const status = rule.reply.status ?? 200;
      const text = JSON.stringify(bodyVal ?? {});
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => bodyVal ?? {},
        text: async () => text,
      } as any;
    };
    return () => { (globalThis as any).fetch = prev; };
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

// ── 모의 Supabase (DB 경계) ──────────────────────────
//
// 실행기가 실제로 쓰는 표면만 구현한다:
//   from(t).insert(row).select(cols).single()
//   from(t).select(cols).eq().in().order().limit().maybeSingle()
//   from(t).update(patch).eq()
//
// **쓰기를 기록한다.** 통합 시험이 확인하는 것은 "무엇이 장부에 적혔나"다.

export interface WriteLog {
  table: string;
  kind: 'insert' | 'update';
  patch: Record<string, any>;
  /** update가 걸린 조건 */
  where?: Record<string, any>;
}

export interface FakeDbOptions {
  /** 이 테이블의 update를 실패시킨다 (DB 기록 실패 재현) */
  failUpdatesOn?: string;
  /** Post-dispatch ACK write fault; the SENT CAS must still succeed. */
  failAckUpdate?: 'error' | 'zero-rows' | 'throw';
  /** 이 테이블의 insert를 실패시킨다. '23505'면 유니크 충돌 */
  failInsertCode?: { table: string; code: string };
  /** select를 실패시킨다 */
  failSelectsOn?: string;
}

export class FakeDb {
  readonly rows: Record<string, any[]> = {};
  readonly writes: WriteLog[] = [];
  private seq = 0;

  constructor(private opts: FakeDbOptions = {}) {}

  seed(table: string, rows: any[]): this {
    this.rows[table] = (this.rows[table] ?? []).concat(rows.map((r) => ({ ...r })));
    return this;
  }

  /** 지금 장부에 있는 줄 (복사본) */
  table(name: string): any[] {
    return (this.rows[name] ?? []).map((r) => ({ ...r }));
  }

  /** 한 줄 */
  row(name: string, where: Record<string, any>): any | null {
    return this.table(name).find((r) => Object.entries(where)
      .every(([k, v]) => r[k] === v)) ?? null;
  }

  from(table: string): any {
    const db = this;
    const filters: { col: string; vals: any[] }[] = [];
    let pending: { kind: 'insert' | 'update'; patch: any } | null = null;

    const apply = () => {
      let out = db.rows[table] ?? [];
      for (const f of filters) out = out.filter((r) => f.vals.includes(r[f.col]));
      return out;
    };

    const flushUpdate = () => {
      if (!pending || pending.kind !== 'update') return { data: [], error: null };
      if (db.opts.failUpdatesOn === table) {
        return { data: [], error: { message: `DB 쓰기 실패 (${table})`, code: 'XX000' } };
      }
      if (pending.patch.status === 'ACKED' && db.opts.failAckUpdate) {
        if (db.opts.failAckUpdate === 'throw') throw new Error('DB ACK 연결 끊김');
        if (db.opts.failAckUpdate === 'error') return { data: [], error: { code: 'XX000', message: 'DB ACK 쓰기 실패' } };
        return { data: [], error: null };
      }
      const where: Record<string, any> = {};
      for (const f of filters) where[f.col] = f.vals.length === 1 ? f.vals[0] : f.vals;
      const matched = apply();
      for (const r of matched) Object.assign(r, pending.patch);
      if (matched.length > 0) db.writes.push({ table, kind: 'update', patch: { ...pending.patch }, where });
      return { data: matched.map((r) => ({ ...r })), error: null };
    };

    const builder: any = {
      select(_cols?: string) {
        if (pending?.kind === 'insert') return builder;
        if (db.opts.failSelectsOn === table) {
          builder.__selectFails = true;
        }
        return builder;
      },
      eq(col: string, val: any) { filters.push({ col, vals: [val] }); return builder; },
      in(col: string, vals: any[]) { filters.push({ col, vals: [...vals] }); return builder; },
      order() { return builder; },
      limit() { return builder; },
      insert(row: any) { pending = { kind: 'insert', patch: row }; return builder; },
      update(patch: any) { pending = { kind: 'update', patch }; return builder; },

      async single() {
        if (pending?.kind === 'insert') {
          const f = db.opts.failInsertCode;
          if (f && f.table === table) {
            return { data: null, error: { code: f.code, message: `insert 실패 (${f.code})` } };
          }
          const row = { id: `row-${++db.seq}`, ...pending.patch };
          db.rows[table] = (db.rows[table] ?? []).concat([row]);
          db.writes.push({ table, kind: 'insert', patch: { ...pending.patch } });
          return { data: { id: row.id, status: row.status }, error: null };
        }
        const rows = apply();
        return { data: rows[0] ?? null, error: null };
      },
      async maybeSingle() {
        if (builder.__selectFails) return { data: null, error: { message: '조회 실패' } };
        if (pending?.kind === 'update') {
          const result = flushUpdate();
          return { data: result.data?.[0] ?? null, error: result.error };
        }
        const rows = apply();
        return { data: rows[0] ? { ...rows[0] } : null, error: null };
      },
      then(resolve: any, reject?: any) {
        // await로 바로 끝나는 체인 (update().eq() · select().in() 등)
        const run = async () => {
          if (pending?.kind === 'update') return flushUpdate();
          if (builder.__selectFails) return { data: null, error: { message: '조회 실패' } };
          return { data: apply().map((r) => ({ ...r })), error: null };
        };
        return run().then(resolve, reject);
      },
    };
    return builder;
  }
}

/** 암호화된 시크릿을 넣기 위한 키. 실행기가 실제 복호화를 거치게 한다 */
export function withCryptoEnv(): () => void {
  const prev = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'traigo-integration-test-key-0123456789';
  return () => {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prev;
  };
}
