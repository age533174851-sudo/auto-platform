// src/lib/system/migrationGate.ts
//
// **DB가 코드를 따라오지 못한 채로 주문을 내지 않는다.**
//
// 054가 없던 동안 워커는 멀쩡히 돌면서 버전을 못 적었다. 쓰기는 조용히
// 실패했고 매매는 계속됐다. 코드가 요구하는 칸이 DB에 없을 때 벌어지는
// 일이 정확히 그거다 — **조용히 틀린다.**
//
// 판정은 여기 없다(`migrationStatus.ts`). 이 파일은 읽어 오기만 한다.
import { migrationStatusOf, type MigrationStatus } from './migrationStatus';
import { MIGRATION_MANIFEST, REQUIRED_MIGRATIONS } from './migrationManifest';

/**
 * 지금 DB 상태로 새 주문을 내도 되는가.
 *
 * 읽기에 실패하면 `UNKNOWN`이고 **막는다.** 다만 기록표 자체가 아직
 * 없으면(파이프라인 연결 전) 막지 않는다 — 기록이 없는 것과 DB가
 * 뒤처진 것은 다른 사실이다.
 */
export async function migrationGate(sb: any): Promise<MigrationStatus> {
  let rows: any[] | null = null;
  let tracked: boolean | undefined = undefined;
  try {
    const { data, error } = await (sb as any)
      .from('schema_migrations')
      .select('filename, checksum, status, verified');
    if (!error && Array.isArray(data)) { rows = data; tracked = true; }
    else if (error && /does not exist|schema cache|relation/i.test(String(error.message))) {
      rows = []; tracked = false;
    }
    // 그 밖의 오류는 rows=null로 남는다 → UNKNOWN → 막는다
  } catch { /* null */ }

  const checksums: Record<string, string> = {};
  for (const m of MIGRATION_MANIFEST) checksums[m.name] = m.checksum;
  return migrationStatusOf({ required: REQUIRED_MIGRATIONS, rows, checksums, tracked });
}
