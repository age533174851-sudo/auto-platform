/**
 * Last-moment check before a GitHub auto-merge. The API is injected so tests
 * cannot contact GitHub or merge real pull requests.
 *
 * This reduces TOCTOU exposure; GitHub's merge `sha` condition guards only
 * the PR head, NOT the base tip or the auto-merge label. Branch protection
 * is required for a server-enforced base/CI policy.
 */
export interface MergeRecheckInput {
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  mergeableState: string;
}
export interface MergeApiResult {
  ok: boolean;
  status: number;
  body?: any;
}
export type MergeApi = (path: string, init?: { method?: string; body?: string }) => Promise<MergeApiResult>;
export type MergeAttempt =
  | { attempted: false; reason: string }
  | { attempted: true; response: MergeApiResult };

export async function attemptMergeAfterRecheck(
  api: MergeApi, expected: MergeRecheckInput,
): Promise<MergeAttempt> {
  const block = (reason: string): MergeAttempt => ({ attempted: false, reason });
  if (!/^[\w.-]+\/[\w.-]+$/.test(expected.repo)
      || !Number.isSafeInteger(expected.number) || expected.number <= 0
      || !expected.headSha || !expected.baseSha || expected.baseRef !== 'main') {
    return block('invalid expected PR/base identity');
  }

  let detail: MergeApiResult;
  try { detail = await api(`/repos/${expected.repo}/pulls/${expected.number}`); }
  catch { return block('PR re-read failed'); }
  const pr = detail?.body;
  if (!detail?.ok || !pr || pr.number !== expected.number
      || pr.state !== 'open' || pr.merged !== false || pr.draft !== false
      || !Array.isArray(pr.labels)
      || !pr.labels.some((l: any) => l?.name === 'auto-merge')) {
    return block('PR changed, closed, draft, or auto-merge label removed');
  }
  if (pr.head?.sha !== expected.headSha
      || pr.base?.ref !== expected.baseRef
      || pr.base?.sha !== expected.baseSha
      || pr.mergeable !== true
      || (pr.mergeable_state || 'unknown') !== expected.mergeableState) {
    return block('PR head/base or mergeability changed');
  }

  // PR detail and branch-tip reads are independent: a stale PR detail must
  // not disguise a newly advanced main branch.
  let branch: MergeApiResult;
  try {
    branch = await api(`/repos/${expected.repo}/branches/${encodeURIComponent(expected.baseRef)}`);
  } catch { return block('base branch re-read failed'); }
  if (!branch?.ok || branch.body?.commit?.sha !== expected.baseSha) {
    return block('base branch tip changed or cannot be verified');
  }

  // A race remains after this GET. The `sha` option protects HEAD only.
  // Never treat this as an atomic replacement for branch protection.
  try {
    const response = await api(`/repos/${expected.repo}/pulls/${expected.number}/merge`, {
      method: 'PUT', body: JSON.stringify({ merge_method: 'squash', sha: expected.headSha }),
    });
    return { attempted: true, response };
  } catch {
    return { attempted: true, response: { ok: false, status: 0,
      body: { message: 'merge request failed' } } };
  }
}
