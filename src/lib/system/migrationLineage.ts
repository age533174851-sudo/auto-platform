// src/lib/system/migrationLineage.ts
//
// ⑤B-3A-2 — **마이그레이션 번호가 두 갈래로 갈라지지 않게 한다.**
//
// 무엇이 일어났나
// ───────────────
// `feat/exact100x-exit-authority`는 `origin/main`에서 갈라진 뒤
// (merge-base d716864e) 자체 `089_live_orders_execution_identity.sql`을
// 만들었다. 그 사이 main에도 `089_auth_profile_identity_sync.sql`이
// 생겼고 **production ledger에 이미 적용됐다.**
//
// 그래서 같은 번호 089가 두 가지 다른 SQL을 가리켰다. 로컬에서는 보이지
// 않는다 — 번호를 바꾸고 manifest를 다시 구우면 **자기 일관적이기
// 때문에** 기존 검사기가 전부 초록이다. 충돌은 **base(main)에 대해서만**
// 보인다.
//
// 그래서 이 판정은 작업 트리 목록과 **base 목록을 함께** 받는다.
//
// ★ 이 파일은 DB를 적용하지 않는다. 번호 계보만 본다.
// ★ 번호 중복을 허용하는 예외를 만들지 않는다. 기존
//   `check-migrations.mjs`의 "번호 중복 = error"는 그대로 살아 있다.

/** 마이그레이션 파일 한 줄. `sql`은 **본문 그대로**다(주석 포함) */
export interface MigrationFile {
  name: string;
  /** 파일 이름 앞의 번호. 번호가 없으면 null (LEGACY 사본) */
  id: number | null;
  sql: string;
}

export type LineageCode =
  | 'OK'
  /** 같은 번호가 두 파일을 가리킨다 */
  | 'DUPLICATE_NUMBER'
  /** 선언한 순서와 번호 순서가 다르다 */
  | 'OUT_OF_ORDER'
  /** 선언한 번호 사이에 빈 칸이 있다 */
  | 'GAP'
  /** base에 있던 파일이 작업 트리에 없다 */
  | 'BASE_FILE_MISSING'
  /** base에 있던 파일의 내용이 달라졌다 */
  | 'BASE_FILE_CHANGED'
  /** 우리 번호가 base가 이미 쓰는 번호와 겹친다 */
  | 'COLLIDES_WITH_BASE'
  /** 선언한 파일이 작업 트리에 없다 */
  | 'DECLARED_FILE_MISSING';

export interface LineageVerdict {
  ok: boolean;
  code: LineageCode;
  reason: string;
}

/**
 * ⑤B가 더하는 마이그레이션 — **이름과 번호를 함께 선언한다.**
 *
 * 번호만 파일 이름에 두면, 파일을 옮겨도 코드는 아무것도 모른다.
 * 여기 적어 두면 옮긴 것과 실수로 겹친 것이 구분된다.
 *
 * ★ 번호는 base(main)가 쓰는 가장 큰 번호보다 **커야 한다.** production
 *   ledger가 089까지 적용돼 있으므로 090부터다.
 */
export const EXACT100X_MIGRATIONS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 90, name: '090_live_orders_execution_identity.sql' },
  { id: 91, name: '091_live_orders_entry_risk_snapshot.sql' },
  { id: 92, name: '092_exact100x_risk_observations.sql' },
  { id: 93, name: '093_exact100x_risk_observations_rls.sql' },
  { id: 94, name: '094_exact100x_exit_escape_observations.sql' },
];

const ok = (): LineageVerdict => ({ ok: true, code: 'OK', reason: '' });
const no = (code: LineageCode, reason: string): LineageVerdict => ({ ok: false, code, reason });

/**
 * 계보가 성립하는가.
 *
 * `files` 작업 트리의 마이그레이션 목록
 * `baseFiles` base(origin/main)의 마이그레이션 목록
 *
 * **base를 못 읽었으면 통과시키지 않는다.** 빈 배열이면 비교가 무의미한데
 * 그것을 "겹치지 않음"으로 적으면 바로 이 사고가 다시 난다.
 */
export function checkMigrationLineage(i: {
  files: readonly MigrationFile[];
  baseFiles: readonly MigrationFile[];
  declared?: ReadonlyArray<{ id: number; name: string }>;
}): LineageVerdict {
  const files = i?.files ?? [];
  const baseFiles = i?.baseFiles ?? [];
  const declared = i?.declared ?? EXACT100X_MIGRATIONS;

  if (baseFiles.length === 0) {
    return no('BASE_FILE_MISSING',
      'base(origin/main)의 마이그레이션 목록을 읽지 못했습니다'
      + ' — 비교하지 못한 것을 "겹치지 않음"으로 적지 않습니다');
  }

  const byName = new Map(files.map(f => [f.name, f]));

  // ① 번호 중복 — 순서가 두 갈래가 되면 어느 쪽이 먼저인지 알 수 없다
  const seen = new Map<number, string>();
  for (const f of files) {
    if (f.id == null) continue;
    const prev = seen.get(f.id);
    if (prev != null) {
      return no('DUPLICATE_NUMBER', `번호 ${f.id}가 두 파일을 가리킵니다: ${prev} · ${f.name}`);
    }
    seen.set(f.id, f.name);
  }

  // ② base에 있던 파일은 **그대로** 있어야 한다
  for (const b of baseFiles) {
    const mine = byName.get(b.name);
    if (!mine) {
      return no('BASE_FILE_MISSING',
        `base에 있는 ${b.name}이 작업 트리에 없습니다`
        + ' — 이미 적용된 마이그레이션을 지우면 ledger와 저장소가 갈라집니다');
    }
    if (mine.sql !== b.sql) {
      return no('BASE_FILE_CHANGED',
        `base의 ${b.name} 내용이 달라졌습니다`
        + ' — 이미 적용된 파일을 고치면 체크섬이 어긋납니다');
    }
  }

  // ③ 선언한 파일이 실제로 있는가 · 이름의 번호와 선언이 맞는가
  for (const d of declared) {
    const mine = byName.get(d.name);
    if (!mine) {
      return no('DECLARED_FILE_MISSING', `선언한 ${d.name}이 작업 트리에 없습니다`);
    }
    if (mine.id !== d.id) {
      return no('OUT_OF_ORDER',
        `${d.name}의 파일 번호(${mine.id})가 선언(${d.id})과 다릅니다`);
    }
  }

  // ④ base가 이미 쓰는 번호와 겹치지 않는가
  const baseIds = new Set(baseFiles.map(b => b.id).filter((n): n is number => n != null));
  const baseMax = baseIds.size ? Math.max(...baseIds) : -1;
  // ★ `baseIds.has(d.id)`를 따로 보지 않는다 — **도달할 수 없기
  //   때문이다.** base가 그 번호를 쓰면 그 파일은 ②에서 트리에 있어야
  //   하고, 그러면 우리 파일과 **번호가 겹쳐** ①이 먼저 잡는다. 죽은
  //   가지를 남겨 두면 돌연변이가 그것을 건드려도 아무 일이 없다
  //   (MIG-L3c가 그렇게 새 나갔다). 아래 한 줄이 전부 덮는다:
  //   겹쳤다면 d.id <= max(baseIds) = baseMax가 반드시 참이다.
  for (const d of declared) {
    if (d.id <= baseMax) {
      const other = baseFiles.find(b => b.id === d.id)?.name;
      return no('COLLIDES_WITH_BASE',
        `${d.name}의 번호 ${d.id}가 base의 마지막 번호 ${baseMax} 뒤가 아닙니다`
        + (other ? ` — base의 ${other}과 같은 번호입니다` : ''));
    }
  }

  // ⑤ 선언한 번호가 오름차순이고 **빈 칸이 없는가**
  for (let k = 1; k < declared.length; k += 1) {
    const prev = declared[k - 1];
    const cur = declared[k];
    if (cur.id <= prev.id) {
      return no('OUT_OF_ORDER', `${cur.name}(${cur.id})이 ${prev.name}(${prev.id}) 뒤가 아닙니다`);
    }
    if (cur.id !== prev.id + 1) {
      return no('GAP', `${prev.name}(${prev.id})과 ${cur.name}(${cur.id}) 사이에 빈 번호가 있습니다`);
    }
  }
  if (declared.length && declared[0].id !== baseMax + 1) {
    return no('GAP',
      `첫 번호 ${declared[0].id}가 base 마지막 ${baseMax} 바로 뒤가 아닙니다`);
  }

  return ok();
}

/** 파일 이름에서 번호를 읽는다. 없으면 null — **0이 아니다** */
export function migrationIdOf(name: string): number | null {
  const m = /^(\d{3})_/.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}
