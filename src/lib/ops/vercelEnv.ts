// src/lib/ops/vercelEnv.ts
//
// **Vercel 쪽만 사람이 대시보드에서 넣고 있었다.**
//
// `syncPlan`은 Vercel을 목적지로 적어 두고도 실제로는 이렇게만 말했다:
//
//   'Vercel: 관리 토큰이 없어 자동으로 밀어 넣지 못합니다 (VERCEL_TOKEN)'
//
// 만들어 놓고 배선을 안 한 것이다. 이 파일이 그 배선이다.
//
// 이 파일이 다루지 않는 것
// ────────────────────────
// **비밀 값을 로그로 만들지 않는다.** 요청 본문을 만들어 돌려주기는
// 하지만, 그 본문을 출력하는 코드는 여기에도 부르는 쪽에도 없다.
// 결과를 사람에게 보여줄 때는 이름과 지문만 쓴다.
//
// 읽어서 대조할 수 없다
// ─────────────────────
// Vercel은 `type: 'encrypted'`인 환경변수의 값을 **다시 돌려주지 않는다.**
// 그래서 "밀어 넣기 전에 같은지 본다"를 API로는 할 수 없다.
//
// 그건 오히려 맞는 성질이다 — 확인은 **돌고 있는 앱**에서 해야 한다
// (`/api/system/runtime-health`가 지문을 준다). 저장소가 사흘을 잃은
// 고장이 "밀어 넣었으니 맞았겠지"에서 나왔기 때문이다.

export interface VercelTarget {
  projectId: string;
  /** 팀 프로젝트면 필요하다. 개인이면 없다 */
  teamId?: string | null;
}

/** 어느 환경에 넣는가. **preview·development에 실계좌 값을 넣지 않는다** */
export type VercelEnvTarget = 'production' | 'preview' | 'development';

export interface VercelRequest {
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON 문자열. **출력 금지** */
  body?: string;
}

function q(t: VercelTarget): string {
  const team = String(t?.teamId ?? '').trim();
  return team ? `?teamId=${encodeURIComponent(team)}` : '';
}

function assertTarget(t: VercelTarget): void {
  const p = String(t?.projectId ?? '').trim();
  if (!p) throw new Error('Vercel 프로젝트 id가 없습니다');
  if (!/^[A-Za-z0-9_-]+$/.test(p)) throw new Error('Vercel 프로젝트 id가 올바르지 않습니다');
  const team = String(t?.teamId ?? '').trim();
  if (team && !/^[A-Za-z0-9_-]+$/.test(team)) throw new Error('Vercel 팀 id가 올바르지 않습니다');
}

/** 지금 어떤 이름들이 있는가. **값은 안 온다 — 이름과 id만 쓴다** */
export function vercelEnvListRequest(t: VercelTarget): VercelRequest {
  assertTarget(t);
  const sep = q(t) ? '&' : '?';
  return { path: `/v9/projects/${t.projectId}/env${q(t)}${sep}decrypt=false`, method: 'GET' };
}

/**
 * 새로 넣는다.
 *
 * **`production`만 기본값이다.** preview에 실계좌 값이 들어가면, PR
 * 프리뷰 하나가 실계좌를 만지게 된다 — 그건 브라우저 자동매매를 없앤
 * 이유와 같은 종류의 사고다.
 */
export function vercelEnvCreateRequest(i: {
  target: VercelTarget;
  name: string;
  value: string;
  envTargets?: VercelEnvTarget[];
}): VercelRequest {
  assertTarget(i.target);
  const name = String(i?.name ?? '').trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`환경변수 이름이 올바르지 않습니다 (${name})`);
  if (!String(i?.value ?? '')) throw new Error(`${name}: 빈 값을 넣지 않습니다 — 그건 지우는 것과 같습니다`);
  const targets = (i?.envTargets && i.envTargets.length > 0) ? i.envTargets : ['production'];
  return {
    path: `/v10/projects/${i.target.projectId}/env${q(i.target)}`,
    method: 'POST',
    body: JSON.stringify({ key: name, value: i.value, type: 'encrypted', target: targets }),
  };
}

/** 이미 있는 것을 고친다 */
export function vercelEnvUpdateRequest(i: {
  target: VercelTarget;
  envId: string;
  value: string;
  envTargets?: VercelEnvTarget[];
}): VercelRequest {
  assertTarget(i.target);
  const id = String(i?.envId ?? '').trim();
  if (!id) throw new Error('환경변수 id가 없습니다');
  if (!String(i?.value ?? '')) throw new Error('빈 값을 넣지 않습니다 — 그건 지우는 것과 같습니다');
  const targets = (i?.envTargets && i.envTargets.length > 0) ? i.envTargets : ['production'];
  return {
    path: `/v9/projects/${i.target.projectId}/env/${id}${q(i.target)}`,
    method: 'PATCH',
    body: JSON.stringify({ value: i.value, type: 'encrypted', target: targets }),
  };
}

export type UpsertAction = 'CREATE' | 'UPDATE' | 'SKIP';

export interface UpsertPlan {
  action: UpsertAction;
  envId: string | null;
  reason: string;
}

/**
 * 만들 것인가 고칠 것인가.
 *
 * **production을 담당하는 항목만 고친다.** Vercel은 같은 이름을
 * 환경별로 따로 둘 수 있어서, preview용 항목을 골라 고치면 실서비스는
 * 그대로 옛 값으로 돈다 — 그리고 로그에는 성공이 남는다.
 */
export function vercelUpsertPlan(i: {
  name: string;
  existing: Array<{ id?: string; key?: string; target?: string[] | string }> | null | undefined;
  envTarget?: VercelEnvTarget;
}): UpsertPlan {
  const name = String(i?.name ?? '').trim();
  const want = i?.envTarget ?? 'production';
  if (i?.existing == null) {
    // **못 읽은 것을 "없다"로 읽지 않는다.** 없다고 보고 CREATE하면
    // 같은 이름이 둘이 되고, 어느 쪽이 쓰이는지 아무도 모른다.
    return { action: 'SKIP', envId: null,
      reason: '기존 환경변수 목록을 읽지 못했습니다 — 없다는 뜻이 아니므로 새로 만들지 않습니다' };
  }
  const rows = Array.isArray(i.existing) ? i.existing : [];
  const hit = rows.find(r => {
    if (String(r?.key ?? '') !== name) return false;
    const t = r?.target;
    const list = Array.isArray(t) ? t : (t ? [String(t)] : []);
    return list.includes(want);
  });
  if (!hit) {
    return { action: 'CREATE', envId: null, reason: `${want}에 ${name}이(가) 없습니다` };
  }
  const id = String(hit.id ?? '');
  if (!id) {
    return { action: 'SKIP', envId: null,
      reason: `${name}은(는) 있는데 id를 읽지 못했습니다 — 무엇을 고칠지 모르는 채로 쓰지 않습니다` };
  }
  return { action: 'UPDATE', envId: id, reason: `${want}의 ${name}을(를) 고칩니다` };
}

/**
 * 환경변수만 바꾸면 **돌고 있는 배포는 옛 값 그대로다.**
 *
 * Vercel은 빌드 시점에 환경변수를 굽는다. 그래서 밀어 넣은 뒤 재배포를
 * 하지 않으면, 지문을 확인해도 옛 값이 나오고 사람은 "밀어 넣기가
 * 실패했다"고 읽는다. 실제로는 성공했고 반영이 안 된 것뿐이다.
 */
export function vercelRedeployRequest(i: {
  target: VercelTarget;
  /** 어느 배포를 다시 굽는가 */
  deploymentId: string;
}): VercelRequest {
  assertTarget(i.target);
  const id = String(i?.deploymentId ?? '').trim();
  if (!id) throw new Error('재배포할 배포 id가 없습니다');
  return {
    path: `/v13/deployments${q(i.target)}`,
    method: 'POST',
    body: JSON.stringify({ deploymentId: id, meta: { action: 'traigo-secret-sync' } }),
  };
}
