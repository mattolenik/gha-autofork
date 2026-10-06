import { AutopatchError } from './errors.js';
import { authExtraHeader, type Git } from './git.js';
import type { Logger } from './log.js';

export interface PublishContext {
  /** Git bound to the fork checkout (has the `origin` remote). */
  git: Git;
  branch: string;
  /** Sha the branch had when planning started; the push lease. */
  leaseSha: string;
  runId: string;
  token?: string | undefined;
  dryRun: boolean;
  log: Logger;
}

export const TEMP_BRANCH_PREFIX = 'autopatch/';
export const BACKUP_PREFIX = 'refs/autopatch/backup/';

export function tempBranchName(runId: string, attempt: string): string {
  return `${TEMP_BRANCH_PREFIX}${runId}-${attempt}`;
}

export function backupRefName(branch: string, runId: string, now = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${BACKUP_PREFIX}${d}-${runId}/${branch}`;
}

async function authed(ctx: PublishContext): Promise<Git> {
  const url = (await ctx.git.remoteUrl('origin')) ?? '';
  if (ctx.token && /^https:\/\/github\.com\//.test(url)) return ctx.git.withConfig(authExtraHeader(ctx.token));
  return ctx.git;
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
}

/** Back up the old tip, force-push the branch with a lease, delete the temp branch, prune old backups. */
export async function publishBranch(ctx: PublishContext, headSha: string, tempBranch: string, keepBackups: number): Promise<PublishResult> {
  const backupRef = backupRefName(ctx.branch, ctx.runId);
  if (ctx.dryRun) {
    ctx.log.info(`dry run: would back up ${ctx.leaseSha.slice(0, 12)} to ${backupRef} and force-push ${headSha.slice(0, 12)} to ${ctx.branch}`);
    return { backupRef, pushed: false, prunedBackups: [] };
  }
  const git = await authed(ctx);

  await runPush(git, ['push', '--no-verify', 'origin', `${ctx.leaseSha}:${backupRef}`]);
  ctx.log.info(`backed up ${ctx.branch}@${ctx.leaseSha.slice(0, 12)} to ${backupRef}`);

  await runPush(git, ['push', '--no-verify', `--force-with-lease=refs/heads/${ctx.branch}:${ctx.leaseSha}`, 'origin', `${headSha}:refs/heads/${ctx.branch}`]);
  ctx.log.info(`force-pushed ${ctx.branch}: ${ctx.leaseSha.slice(0, 12)} → ${headSha.slice(0, 12)}`);

  const del = await git.run(['push', '--no-verify', 'origin', '--delete', `refs/heads/${tempBranch}`], { allowFailure: true });
  if (del.code !== 0) ctx.log.warning(`could not delete temporary branch ${tempBranch}: ${del.stderr.trim()}`);

  const prunedBackups = await pruneBackups(git, ctx.branch, keepBackups, ctx.log);
  return { backupRef, pushed: true, prunedBackups };
}

export async function listBackups(git: Git, branch: string): Promise<string[]> {
  const lines = await git.lines(['ls-remote', 'origin', `${BACKUP_PREFIX}*/${branch}`]);
  return lines.map((l) => l.split('\t')[1] as string).sort();
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
  if (/stale info|force-with-lease|rejected/i.test(err)) {
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

/** Fast-forward the branch to upstream when the fork carries no patches. */
export async function fastForward(ctx: PublishContext, upstreamSha: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.log.info(`dry run: would fast-forward ${ctx.branch} ${ctx.leaseSha.slice(0, 12)} → ${upstreamSha.slice(0, 12)}`);
    return;
  }
  const git = await authed(ctx);
  await runPush(git, ['push', '--no-verify', `--force-with-lease=refs/heads/${ctx.branch}:${ctx.leaseSha}`, 'origin', `${upstreamSha}:refs/heads/${ctx.branch}`]);
  ctx.log.info(`fast-forwarded ${ctx.branch} to ${upstreamSha.slice(0, 12)}`);
}
