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
export async function migrationGate(sb: any): Promise<MigrationStatus & { read?: MigrationRead }> {
  let rows: any[] | null = null;
  let tracked: boolean | undefined = undefined;
  let readError: string | null = null;
  try {
    const { data, error } = await (sb as any)
      .from('schema_migrations')
      .select('filename, checksum, status, verified');
    if (!error && Array.isArray(data)) { rows = data; tracked = true; }
    else if (error && /does not exist|schema cache|relation/i.test(String(error.message))) {
      rows = []; tracked = false; readError = String(error.message);
    } else if (error) {
      readError = String(error.message);
    }
    // 그 밖의 오류는 rows=null로 남는다 → UNKNOWN → 막는다
  } catch (e: any) { readError = String(e?.message || e); }

  const checksums: Record<string, string> = {};
  for (const m of MIGRATION_MANIFEST) checksums[m.name] = m.checksum;
  const status = migrationStatusOf({ required: REQUIRED_MIGRATIONS, rows, checksums, tracked });

  // ── 몇 줄을 실제로 읽었는가 ──
  //
  // **"62개가 밀렸다"와 "표를 못 읽어서 62개를 못 찾았다"는 다른 사실이다.**
  //
  // migrate 워크플로는 같은 프로젝트(sgbysrvvxlluzffmgcho)에서
  // `적용됨 62 / 남음 1`이라고 했는데, 런타임 API는 `pendingCount: 62`라고
  // 했다. 같은 DB에서 62가 양쪽에 나오는 것은 우연이 아니다 — 런타임이
  // `schema_migrations`에서 **한 줄도 못 읽었을 때** 정확히 그 모양이 된다.
  //
  // 000은 이 표에 RLS를 켜면서 **정책을 하나도 만들지 않았다**
  // ("정책을 만들지 않으므로 anon·authenticated 키로는 한 줄도 보이지
  // 않는다"). service_role이면 RLS를 우회하므로 다 보이고, 아니면
  // **오류 없이 0줄**이다. worker_heartbeat의 0행 upsert와 같은 모양이다.
  //
  // 그래서 개수만 내보내지 않고 **몇 줄을 읽었는지**를 같이 내보낸다.
  // 추측하지 않고 응답만 보면 갈린다.
  const read: MigrationRead = {
    rowsRead: rows == null ? null : rows.length,
    tracked: tracked ?? null,
    error: readError,
    note: rows == null
      ? 'schema_migrations를 읽지 못했습니다 — 밀렸다는 뜻이 아닙니다'
      : rows.length === 0
        ? '표는 조회했지만 **한 줄도 보이지 않았습니다.** RLS가 SELECT를 0줄로 만들면 오류 없이 이 모양이 됩니다 (service_role이 아닌 키)'
        : `${rows.length}줄을 읽었습니다`,
  };
  return { ...status, read };
}

/** `schema_migrations`를 실제로 몇 줄 읽었는가. **개수와 다른 사실이다** */
export interface MigrationRead {
  /** 읽은 줄 수. **null은 "못 읽었다"이지 0이 아니다** */
  rowsRead: number | null;
  /** 표 자체가 있는가 */
  tracked: boolean | null;
  error: string | null;
  note: string;
}
