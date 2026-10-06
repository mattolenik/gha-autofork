import { AutopatchError } from './errors.js';
import type { Git } from './git.js';
import type { Logger } from './log.js';

export interface PublishContext {
  /** Git bound to the fork checkout (has the `origin` remote). */
  git: Git;
  branch: string;
  /** Sha the branch had when planning started; the push lease. */
  leaseSha: string;
  runId: string;
  runAttempt?: string;
  upstreamSha?: string;
  checkpointSha?: string | null;
  token?: string | undefined;
  dryRun: boolean;
  log: Logger;
}

export const TEMP_BRANCH_PREFIX = 'autopatch/';
export const BACKUP_PREFIX = 'refs/autopatch/backup/';
export const checkpointRef = (branch: string): string => `refs/autopatch/upstream/${branch}`;

export async function fetchCheckpoint(git: Git, branch: string): Promise<string | undefined> {
  const ref = checkpointRef(branch);
  const remote = await git.lines(['ls-remote', 'origin', ref]);
  const sha = remote[0]?.split('\t')[0];
  if (sha) await git.run(['fetch', '--no-tags', 'origin', `+${ref}:${ref}`]);
  return sha;
}

export function tempBranchName(runId: string, attempt: string): string {
  return `${TEMP_BRANCH_PREFIX}${runId}-${attempt}`;
}

export function backupRefName(branch: string, runId: string, now = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${BACKUP_PREFIX}${d}-${runId}/${branch}`;
}

async function authed(ctx: PublishContext): Promise<Git> {
  return ctx.git.authenticated(ctx.token);
}

/** Push the rebased result to the temporary branch so a human can rescue it. */
export async function pushTempBranch(ctx: PublishContext, headSha: string, tempBranch: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.log.info(`dry run: would push ${headSha.slice(0, 12)} to ${tempBranch}`);
    return;
  }
  const git = await authed(ctx);
  await runPush(git, ['push', '--force', '--no-verify', 'origin', `${headSha}:refs/heads/${tempBranch}`]);
  ctx.log.info(`pushed ${headSha.slice(0, 12)} to ${tempBranch}`);
}

export interface PublishResult {
  backupRef: string;
  pushed: boolean;
  prunedBackups: string[];
  warnings?: string[];
}

/** Back up the old tip, force-push the branch with a lease, delete the temp branch, prune old backups. */
export async function publishBranch(ctx: PublishContext, headSha: string, tempBranch: string, keepBackups: number): Promise<PublishResult> {
  const backupRef = backupRefName(ctx.branch, ctx.runAttempt ? `${ctx.runId}-${ctx.runAttempt}` : ctx.runId);
  if (ctx.dryRun) {
    ctx.log.info(`dry run: would back up ${ctx.leaseSha.slice(0, 12)} to ${backupRef} and force-push ${headSha.slice(0, 12)} to ${ctx.branch}`);
    return { backupRef, pushed: false, prunedBackups: [] };
  }
  const git = await authed(ctx);

  const checkpoint = checkpointRef(ctx.branch);
  const leases = [`--force-with-lease=refs/heads/${ctx.branch}:${ctx.leaseSha}`, `--force-with-lease=${backupRef}:`];
  const refs = [`${ctx.leaseSha}:${backupRef}`, `${headSha}:refs/heads/${ctx.branch}`];
  if (ctx.upstreamSha) {
    leases.push(`--force-with-lease=${checkpoint}:${ctx.checkpointSha ?? ''}`);
    refs.push(`${ctx.upstreamSha}:${checkpoint}`);
  }
  await runPush(git, ['push', '--atomic', '--no-verify', ...leases, 'origin', ...refs]);
  ctx.log.info(`backed up ${ctx.branch}@${ctx.leaseSha.slice(0, 12)} to ${backupRef}`);

  ctx.log.info(`force-pushed ${ctx.branch}: ${ctx.leaseSha.slice(0, 12)} → ${headSha.slice(0, 12)}`);

  const result: PublishResult = { backupRef, pushed: true, prunedBackups: [], warnings: [] };
  try {
    const del = await git.run(['push', '--no-verify', 'origin', '--delete', `refs/heads/${tempBranch}`], { allowFailure: true });
    if (del.code !== 0) result.warnings!.push(`could not delete temporary branch ${tempBranch}: ${del.stderr.trim()}`);
    result.prunedBackups = await pruneBackups(git, ctx.branch, keepBackups, ctx.log);
  } catch (e) {
    result.warnings!.push(`published successfully; cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const warning of result.warnings!) ctx.log.warning(warning);
  return result;
}

export async function listBackups(git: Git, branch: string): Promise<string[]> {
  const lines = await git.lines(['ls-remote', 'origin', `${BACKUP_PREFIX}*/${branch}`]);
  return lines.map((l) => l.split('\t')[1] as string)
    .filter(ref => ref.slice(BACKUP_PREFIX.length).split('/').slice(1).join('/') === branch)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Reconcile an earlier attempt whose atomic push succeeded but whose job did not finish. */
export async function findPublishedCandidate(git: Git, branch: string, runId: string, original: string, head: string, upstream: string): Promise<string | undefined> {
  const lines = await git.lines(['ls-remote', 'origin', `refs/heads/${branch}`, checkpointRef(branch), `${BACKUP_PREFIX}*/${branch}`]);
  const refs = new Map(lines.map(line => { const [sha, ref] = line.split('\t'); return [ref!, sha!]; }));
  if (refs.get(`refs/heads/${branch}`) !== head || refs.get(checkpointRef(branch)) !== upstream) return undefined;
  return [...refs].find(([ref, sha]) => {
    if (sha !== original || !ref.startsWith(BACKUP_PREFIX)) return false;
    const [stamp = '', ...parts] = ref.slice(BACKUP_PREFIX.length).split('/');
    const prefix = `${runId}-`;
    return parts.join('/') === branch && /^\d{8}-/.test(stamp) && stamp.slice(9).startsWith(prefix) && /^\d+$/.test(stamp.slice(9 + prefix.length));
  })?.[0];
}

async function pruneBackups(git: Git, branch: string, keep: number, log: Logger): Promise<string[]> {
  const refs = await listBackups(git, branch);
  const excess = refs.slice(0, Math.max(0, refs.length - keep));
  if (excess.length === 0) return [];
  const r = await git.run(['push', '--no-verify', 'origin', '--delete', ...excess], { allowFailure: true });
  if (r.code !== 0) {
    log.warning(`could not prune old backups: ${r.stderr.trim()}`);
    return [];
  }
  log.info(`pruned ${excess.length} old backup ref(s)`);
  return excess;
}

/** Temporary branches left behind by other runs. Never deleted automatically. */
export async function listLeftoverBranches(git: Git, exclude: string): Promise<string[]> {
  const lines = await git.lines(['ls-remote', '--heads', 'origin', `refs/heads/${TEMP_BRANCH_PREFIX}*`]);
  return lines
    .map((l) => (l.split('\t')[1] as string).replace(/^refs\/heads\//, ''))
    .filter((b) => b !== exclude)
    .sort();
}

async function runPush(git: Git, args: string[]): Promise<void> {
  const r = await git.run(args, { allowFailure: true });
  if (r.code === 0) return;
  throw classifyPushError(args, r.stderr, r.stdout);
}

/** Map git push failures to actionable messages. */
export function classifyPushError(args: string[], err: string, out = ''): AutopatchError {
  if (/without `?workflow`? scope|workflows? permission|refusing to allow .* workflow/i.test(err)) {
    return new AutopatchError(
      'FAILED_PUBLISH',
      'GitHub refused the push because it changes files under .github/workflows. The token needs the "Workflows" permission (fine-grained PAT: Workflows read/write; GitHub App: permission-workflows: write). The default GITHUB_TOKEN can never push workflow files.',
      [err.trim()],
    );
  }
  if (/stale info|force-with-lease/i.test(err)) {
    return new AutopatchError(
      'FAILED_PUBLISH',
      'the branch moved on GitHub while this run was working, so the force-push was refused to avoid clobbering those commits. The rebased result is on the temporary branch; rerun the workflow.',
      [err.trim()],
    );
  }
  if (/protected branch|rule violations|GH006|GH013/i.test(err)) {
    return new AutopatchError(
      'FAILED_PUBLISH',
      'a branch protection rule or ruleset blocked the force-push. Allow force pushes for the token owner (add it as a bypass actor) or disable the rule.',
      [err.trim()],
    );
  }
  return new AutopatchError('FAILED_PUBLISH', `git ${args.join(' ')} failed: ${err.trim() || out.trim()}`);
}
