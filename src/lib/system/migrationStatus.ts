// src/lib/system/migrationStatus.ts
//
// **"마이그레이션 적용하세요"를 화면에서 없앤다.**
//
// 예전에 이 자리에 있던 문장은 "Supabase SQL 편집기에서 056을 실행하세요"
// 였다. 그건 화면이 사람에게 숙제를 넘긴 것이다. 이제 적용은 migrate
// 워크플로가 자동으로 하고, 화면은 **시스템이 무엇을 했는지**만 적는다:
//
//   자동 적용 완료 · 자동 적용 중 · 권한이 없어 자동 처리하지 못함 ·
//   되돌릴 수 없는 변경이라 승인 대기
//
// 마지막 두 가지에서만 사람이 등장하고, 그때도 "무엇을 눌러라"가 아니라
// **딱 하나 필요한 것**을 말한다.

import { migrationPlanOf, migrationEntryGate, migrationDrift, type AppliedRow } from './migrationPlan';

export type MigrationHealth = 'ok' | 'warn' | 'bad' | 'unknown';

export interface MigrationStatus {
  health: MigrationHealth;
  code: 'UP_TO_DATE' | 'APPLYING' | 'NEEDS_APPROVAL' | 'FAILED' | 'DRIFT' | 'UNKNOWN' | 'NOT_TRACKED';
  detail: string;
  /** 자동으로 처리하지 못한 이유. 자동으로 되는 것이면 null */
  blockedReason: string | null;
  required: number;
  applied: number;
  pending: string[];
  failed: string[];
  /** 새 주문을 내도 되는가 */
  entryAllowed: boolean;
  entryReason: string;
}

export interface MigrationRow {
  filename: string;
  checksum: string | null;
  status: string | null;
  verified: boolean | null;
  applied_at?: string | null;
}

/**
 * 화면 한 줄.
 *
 * **rows가 null이면 '전부 적용됨'이 아니다.** 기록을 못 읽은 것과
 * 남은 게 없는 것은 완전히 다른 사실이고, 대응도 다르다.
 */
export function migrationStatusOf(i: {
  /** 코드가 요구하는 파일 이름 (migrationManifest.ts) */
  required: string[];
  /** DB의 schema_migrations. **못 읽었으면 null** */
  rows: MigrationRow[] | null;
  /** 파일별 체크섬 (manifest의 값) */
  checksums?: Record<string, string>;
  /**
   * `schema_migrations` 표가 존재하는가.
   *
   * **없는 것과 비어 있는 것은 다르다.** 표가 아직 없다는 것은 자동
   * 파이프라인이 연결되기 전이라는 뜻이지, DB가 코드보다 뒤처졌다는
   * 뜻이 아니다. 이 상태에서 진입을 막으면 멀쩡히 돌던 자동매매가
   * 이 기능을 배포한 순간 멈춘다.
   */
  tracked?: boolean;
}): MigrationStatus {
  const required = Array.isArray(i?.required) ? i.required.slice() : [];

  if (i?.tracked === false) {
    // **기록표가 없다는 것은 "적용됐다"가 아니다.**
    //
    // 처음에는 여기서 진입을 막지 않았다. 이 기능을 배포한 순간 자동매매가
    // 꺼지는 것이 더 나쁘다고 봤기 때문이다. 그건 틀린 판단이었다 —
    // 실제 돈이 걸린 시스템에서 **DB 스키마와 코드 버전이 다른데 신규
    // 주문을 계속 허용하면 안 된다.** 코드가 요구하는 칸이 없으면 쓰기는
    // 조용히 실패하고 매매는 계속된다(054가 정확히 그랬다).
    //
    // 막는 것은 **새로 여는 것뿐이다.** 이미 열린 포지션의 청산·보호주문
    // 정리·대조는 이 관문을 지나지 않는다 — 못 여는 것은 불편이고
    // 못 닫는 것은 사고다.
    return {
      health: 'bad', code: 'NOT_TRACKED',
      detail: `마이그레이션 적용 기록이 없습니다 — 코드가 요구하는 ${required.length}개가 DB에 있는지 확인할 수 없습니다`,
      // 최초 1회 권한 연결이 필요한 자리. **사람이 SQL을 붙여 넣는 일은 아니다.**
      blockedReason: 'DB 접속 권한(SUPABASE_DB_URL)이 한 번 연결되면 이후 마이그레이션은 전부 자동입니다',
      required: required.length, applied: 0, pending: required.slice(), failed: [],
      entryAllowed: false,
      entryReason: '마이그레이션 적용 여부를 확인할 수 없어 신규 진입을 막습니다 — '
        + '이미 열린 포지션의 청산·보호·복구는 계속 동작합니다',
    };
  }

  if (i?.rows == null) {
    return {
      health: 'unknown', code: 'UNKNOWN',
      detail: '마이그레이션 적용 기록을 읽지 못했습니다 — "전부 적용됨"이라는 뜻이 아닙니다',
      blockedReason: null,
      required: required.length, applied: 0, pending: [], failed: [],
      entryAllowed: false,
      entryReason: '적용 상태를 확인하지 못했습니다 — 확인하지 못한 것을 통과로 보지 않습니다',
    };
  }

  const rows = i.rows.filter(r => r && typeof r.filename === 'string');
  const failedRows = rows.filter(r => String(r.status) === 'FAILED');
  // 확인까지 끝난 것만 '적용됨'으로 센다. **psql이 0으로 끝난 것과
  // 표가 생긴 것은 다른 사실이다** — verified=false는 적용으로 치지 않는다.
  const okNames = new Set(rows.filter(r => String(r.status) !== 'FAILED' && r.verified !== false)
    .map(r => r.filename));

  const files = required.map(name => ({
    name,
    id: Number((/^(\d{3,})/.exec(name) || [])[1] ?? NaN),
    sql: '',
  })).map(f => ({ ...f, id: Number.isFinite(f.id) ? f.id : null }));

  const plan = migrationPlanOf({ files: files as any, applied: Array.from(okNames) });
  const gate = migrationEntryGate(plan);
  const pending = plan.pending;

  // 적용된 뒤 파일이 바뀐 경우 — DB의 스키마가 지금 코드와 다르다
  const checksums = i.checksums || {};
  const drift = Object.keys(checksums).length
    ? migrationDrift({
        files: files.map(f => ({ ...f, sql: '' })) as any,
        rows: rows.map(r => ({ name: r.filename, checksum: r.checksum, success: String(r.status) !== 'FAILED' })) as AppliedRow[],
        checksumOf: (f: any) => checksums[f.name] || '',
      }).filter(d => d.code === 'CHECKSUM_CHANGED')
    : [];

  if (failedRows.length > 0) {
    return {
      health: 'bad', code: 'FAILED',
      detail: `마이그레이션 ${failedRows.length}개가 실패한 채로 남아 있습니다 (${failedRows.map(r => r.filename).slice(0, 3).join(', ')})`,
      blockedReason: '자동 적용이 실패했습니다 — 실패한 SQL은 다시 자동으로 실행하지 않습니다',
      required: required.length, applied: okNames.size, pending,
      failed: failedRows.map(r => r.filename),
      entryAllowed: false,
      entryReason: '적용에 실패한 마이그레이션이 있어 새 주문을 막습니다',
    };
  }

  if (pending.length > 0) {
    return {
      health: 'warn', code: 'APPLYING',
      // **"적용하세요"가 아니라 "적용 중"이다.** 사람이 할 일이 아니다.
      detail: `${pending.length}개를 자동으로 적용하는 중입니다 (${pending.slice(0, 3).join(', ')})`,
      blockedReason: null,
      required: required.length, applied: okNames.size, pending, failed: [],
      entryAllowed: gate.allowed, entryReason: gate.reason,
    };
  }

  if (drift.length > 0) {
    return {
      health: 'warn', code: 'DRIFT',
      detail: `적용된 뒤 내용이 바뀐 마이그레이션이 ${drift.length}개 있습니다 (${drift.map(d => d.name).slice(0, 3).join(', ')})`,
      blockedReason: '이미 실행된 SQL을 다시 실행하지 않습니다 — 지금 DB 스키마가 파일과 다를 수 있습니다',
      required: required.length, applied: okNames.size, pending: [], failed: [],
      entryAllowed: true,
      entryReason: '적용은 모두 끝났습니다 (파일 변경은 별도로 확인이 필요합니다)',
    };
  }

  return {
    health: 'ok', code: 'UP_TO_DATE',
    detail: `마이그레이션 ${required.length}개가 모두 적용돼 있습니다 — 자동으로 처리했습니다`,
    blockedReason: null,
    required: required.length, applied: okNames.size, pending: [], failed: [],
    entryAllowed: true, entryReason: gate.reason,
  };
}
