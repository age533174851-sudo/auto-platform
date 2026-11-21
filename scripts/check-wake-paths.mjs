#!/usr/bin/env node
// scripts/check-wake-paths.mjs
//
// **누가 깨우는가. 길이 하나면 그것이 멈출 때 안전망이 없다.**
//
// 무엇이 있었나
// ─────────────
// 모의 자동매매 전체(진입·청산)를 깨우는 곳이 **하나뿐이었다** — Fly
// 워커의 `POST /api/paper/exit-monitor`. 워커가 꺼져 있으면 모의매매는
// 한 건도 돌지 않고, **걸어 둔 손절이 걸리지 않는다.** 진입을 놓치는
// 것과 손절이 안 걸리는 것은 잃는 것이 다르다.
//
// 자동매매(실거래) 쪽은 그때도 길이 셋이었다. **모의 쪽만 하나였다** —
// 같은 판단이 두 곳에 있는데 한쪽만 고친 것이고, 이 저장소가 가장 자주
// 내는 고장이다(CLAUDE.md "경로가 둘인데 한쪽만 고침").
//
// 왜 시험으로 못 잡나
// ───────────────────
// 깨우는 쪽은 코드가 아니라 **예약**이다. 유닛 시험은 `vercel.json`도
// `.github/workflows/`도 읽지 않고, 라우트 시험은 "누가 부르나"를 모른다.
// 그래서 저장소 루트에서 도는 이 검사기가 센다.
//
// ★ `vercel.json`에 잦은 크론을 넣는 실수를 **아무 검사기도 막지 않았다.**
//   Vercel Hobby는 크론을 하루 한 번만 허용하고, 더 잦게 적으면 **배포가
//   실패한다** — 그러면 그 라우트 하나가 아니라 전부가 안 올라간다.
//   `src/app/api/cron/reconcile/route.ts`가 실제로 겪은 그 실패를 기록하고
//   있는데, 기록은 관문이 아니다. 여기서 센다.
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const PAPER_ROUTE = 'src/app/api/paper/exit-monitor/route.ts';
const PAPER_PATH = '/api/paper/exit-monitor';
const WORKER = 'worker/src/index.ts';
const WF_DIR = '.github/workflows';
/**
 * 이 비밀 이름만 쓴다. 같은 비밀에 이름이 둘이면 언젠가 갈린다 —
 * `autotrade-tick`이 `EXIT_MONITOR_SECRET`으로 30회 넘게 연속 401이었다.
 * `ADMIN_SECRET`은 `scripts/sync-secrets.mjs`의 `NAMES`에 있고(관리됨),
 * `EXIT_MONITOR_URL`은 비밀이 아니라 주소다.
 *
 * ★ **이 목록은 여기 베껴 적혀 있다.** 관리 목록의 정본은 sync-secrets이고,
 *   그것을 읽어 판정하는 함수(`managedNamesFrom`)는 열려 있는 #591이
 *   `src/lib/ops/cronAuthContract.ts`에 만들고 있다. 지금 같은 파서를 또
 *   쓰면 같은 판단이 두 곳에 생긴다. **#591이 들어오면 이 상수를 지우고
 *   그 함수로 바꾼다** — 두 PR이 겹치지 않게 순서를 둔 것이고, 숨기지 않는다.
 */
const ALLOWED_SECRETS = new Set(['ADMIN_SECRET', 'EXIT_MONITOR_URL']);

let bad = 0;
const fail = (m) => { console.error(`❌ ${m}`); bad++; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};

/**
 * YAML 주석을 지운다. **주석으로 만족되는 검사기는 검사기가 아니다.**
 *
 * 이 파일이 보는 워크플로의 주석에는 경로·크론·비밀 이름이 설명으로
 * 적혀 있다. 주석을 남겨 두면 `run:`에서 curl을 지워도 규칙이 계속
 * 만족된다 — check-paper-multi-bot이 같은 함정에 한 번 빠졌다.
 *
 * 따옴표 안의 `#`은 주석이 아니므로, 앞쪽 따옴표 개수가 짝수일 때만 자른다.
 */
function stripYamlComments(src) {
  return src.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return '';
    let q1 = 0, q2 = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'") q1++;
      else if (c === '"') q2++;
      else if (c === '#' && q1 % 2 === 0 && q2 % 2 === 0
        && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

/**
 * 이 크론이 **하루 한 번 이하**인가.
 *
 * 분과 시가 둘 다 고정 숫자면 하루 한 번 이하다(주 단위도 포함된다).
 * 어느 쪽이든 `*`·`/`·`,`·`-`가 있으면 더 잦다.
 */
function atMostDaily(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;          // 모르는 모양 — 통과시키지 않는다
  return /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]);
}

// ── ① `vercel.json` 크론은 전부 하루 한 번 이하다 ──
{
  const raw = read('vercel.json');
  let cfg = null;
  try { cfg = JSON.parse(raw || '{}'); } catch { fail('vercel.json을 읽을 수 없습니다'); }
  for (const c of (cfg?.crons ?? [])) {
    const ok = atMostDaily(c?.schedule);
    if (ok === null) {
      fail(`vercel.json: 크론 모양을 읽을 수 없습니다 (${c?.path} · ${c?.schedule})`);
    } else if (!ok) {
      fail(`vercel.json: ${c.path}의 크론이 하루보다 잦습니다 (${c.schedule})`
        + '\n     Vercel Hobby는 하루 한 번만 허용하고, 더 잦으면 **배포가 실패합니다**'
        + '\n     — 그 라우트 하나가 아니라 전부가 안 올라갑니다.'
        + '\n     잦게 깨워야 하면 GitHub Actions로 부릅니다 (paper-tick.yml · watch/tick 참고)');
    }
  }
}

// ── ② 모의 자동매매를 깨우는 길이 **둘 이상**이다 ──
//
// (a) Fly 워커  (b) 예약된 워크플로. 하나를 다른 하나로 바꾸는 것은
// 고치는 것이 아니다 — 둘 다 있어야 한쪽이 멈출 때 남는 것이 있다.
{
  const worker = read(WORKER);
  if (!worker.includes(PAPER_PATH)) {
    fail(`${WORKER}: 모의 자동매매를 깨우지 않습니다 (${PAPER_PATH})`
      + '\n     워커 경로를 지우면 예약 하나만 남고, 다시 길이 하나입니다');
  }

  const files = existsSync(WF_DIR)
    ? readdirSync(WF_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')) : [];
  const wakers = [];
  for (const f of files) {
    const body = stripYamlComments(readFileSync(`${WF_DIR}/${f}`, 'utf8'));
    // **경로 필터는 깨우기가 아니다.** `paper-automation.yml`은 이 경로가
    // 바뀔 때 시험을 돌리는 것이고, 라우트를 부르지 않는다.
    if (!new RegExp(`curl[\\s\\S]{0,600}?${PAPER_PATH}`).test(body)) continue;
    const crons = [...body.matchAll(/-\s*cron:\s*'([^']+)'/g)].map(m => m[1]);
    wakers.push({ f, body, crons });
  }

  if (wakers.length === 0) {
    fail(`${WF_DIR}: 모의 자동매매를 깨우는 예약이 없습니다`
      + `\n     ${PAPER_PATH}를 부르는 길이 워커 하나뿐이면, 워커가 꺼진 동안`
      + '\n     **모의매매는 한 건도 돌지 않고 걸어 둔 손절이 걸리지 않습니다**');
  }

  for (const { f, body, crons } of wakers) {
    const where = `${WF_DIR}/${f}`;
    // (c) 예약이 **하루보다 잦아야** 안전망이다. 하루 한 번 쳐다보는
    //     청산 감시는 청산 감시가 아니다.
    if (crons.length === 0) {
      fail(`${where}: 라우트를 부르지만 예약이 없습니다`
        + ' — 사람이 눌러야 도는 것은 안전망이 아닙니다');
    }
    for (const c of crons) {
      const ok = atMostDaily(c);
      if (ok === null) fail(`${where}: 크론 모양을 읽을 수 없습니다 (${c})`);
      else if (ok) {
        fail(`${where}: 예약이 하루 한 번입니다 (${c})`
          + '\n     손절은 하루 한 번 쳐다보는 것으로 걸리지 않습니다');
      }
    }
    // (d) **새 시크릿 이름을 만들지 않는다.** 같은 비밀에 이름이 둘이면
    //     갈린다 — autotrade-tick이 그 사고로 30회 넘게 연속 401이었다.
    for (const m of body.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      if (!ALLOWED_SECRETS.has(m[1])) {
        fail(`${where}: 새 시크릿 이름을 씁니다 (${m[1]})`
          + `\n     깨우기는 ${[...ALLOWED_SECRETS].join(' · ')}만 씁니다`
          + '\n     — 같은 비밀에 이름이 둘이면 동기화가 한쪽만 맞춥니다');
      }
    }
    // (e) 실패를 조용히 넘기지 않는다
    if (!/exit 1/.test(body)) {
      fail(`${where}: 호출이 실패해도 작업이 성공으로 끝납니다`
        + ' — 안 깨워진 것을 아무도 모릅니다');
    }
    // (f) **보내는 메서드를 라우트가 받는가.** 어긋나면 조용히 405다.
    //     이 라우트는 POST만 내보내던 적이 있고, 그래서 GET으로 부르는
    //     예약을 넣어도 한 번도 돌지 않았다.
    const route = read(PAPER_ROUTE);
    const sends = /-X\s*POST|--request\s*POST|curl[\s\S]{0,600}?\s-d\s/.test(body)
      ? 'POST' : 'GET';
    if (!new RegExp(`export\\s+async\\s+function\\s+${sends}\\s*\\(`).test(route)) {
      fail(`${PAPER_ROUTE}: ${sends}을 받지 않는데 ${where}가 ${sends}으로 부릅니다`
        + ' — 405가 되고 회차는 한 번도 돌지 않습니다');
    }
  }
}

if (bad > 0) {
  console.error(`\n깨우기 경로 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log('✅ 깨우기 경로 — vercel 크론 일 단위 · 모의 깨우기 2중화 · 시크릿 이름 하나 · 메서드 일치 · 실패 노출');
