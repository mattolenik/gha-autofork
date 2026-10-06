import { AutopatchError } from './errors.js';
import type { Git } from './git.js';

export interface Patch {
  sha: string;
  subject: string;
  author: string;
  /** Already present upstream by patch-id; git will drop it during the rebase. */
  absorbed: boolean;
}

export interface RebasePlan {
  kind: 'rebase';
  /** Resolved fork branch name. */
  branch: string;
  /** Resolved upstream branch name. */
  upstreamBranch: string;
  /** Fully qualified upstream tracking ref, e.g. refs/remotes/upstream/main. */
  upstreamRef: string;
  /** Sha the fork branch pointed at when planning started; used as the push lease. */
  branchSha: string;
  upstreamSha: string;
  base: string;
  patches: Patch[];
  /** Patches not already upstream, i.e. the ones that must survive the rebase. */
  expectedSurvivors: number;
  /** New upstream commits since base. */
  upstreamCommits: number;
  /** Paths under .github/workflows changed by the patches or by upstream since base. */
  workflowPaths: string[];
}

export interface NothingToDoPlan {
  kind: 'nothing_to_do';
  branch: string;
  upstreamBranch: string;
  branchSha: string;
  patches: Patch[];
}

export interface FastForwardPlan {
  kind: 'fast_forward';
  branch: string;
  upstreamBranch: string;
  upstreamRef: string;
  branchSha: string;
  upstreamSha: string;
}

export type Plan = RebasePlan | NothingToDoPlan | FastForwardPlan;

export interface PlanOptions {
  /** Local branch name of the fork checkout. */
  branch: string;
  /** Upstream branch name. */
  upstreamBranch: string;
  /** Revision to plan from; defaults to the local branch name. The action passes refs/remotes/origin/<branch>. */
  branchRev?: string;
  /** Remote name for upstream, default "upstream". */
  upstreamRemote?: string;
  maxPatches: number;
}

export interface ResolveBranchesOptions {
  branch?: string | undefined;
  upstreamBranch?: string | undefined;
  originRemote?: string;
  upstreamRemote?: string;
}

/** Resolve branch names from inputs or the remotes' symbolic HEADs. */
export async function resolveBranches(
  git: Git,
  opts: ResolveBranchesOptions,
): Promise<{ branch: string; upstreamBranch: string }> {
  const origin = opts.originRemote ?? 'origin';
  const upstream = opts.upstreamRemote ?? 'upstream';
  const branch = opts.branch ?? (await git.remoteDefaultBranch(origin));
  if (!branch) {
    throw new AutopatchError('FAILED_PLAN', `could not determine the default branch of remote "${origin}"; set the branch input`);
  }
  const upstreamBranch = opts.upstreamBranch ?? (await git.remoteDefaultBranch(upstream));
  if (!upstreamBranch) {
    throw new AutopatchError(
      'FAILED_PLAN',
      `could not determine the default branch of remote "${upstream}"; set the upstream_branch input`,
    );
  }
  return { branch, upstreamBranch };
}

async function listPatches(git: Git, base: string, head: string): Promise<Omit<Patch, 'absorbed'>[]> {
  const sep = '\u001f';
  const lines = await git.lines(['log', '--reverse', `--format=%H${sep}%an${sep}%s`, `${base}..${head}`]);
  return lines.map((l) => {
    const [sha = '', author = '', ...rest] = l.split(sep);
    return { sha, author, subject: rest.join(sep) };
  });
}

/** Commits in base..head whose patch-id already exists in base..upstream. */
export async function absorbedPatches(git: Git, upstream: string, head: string, base: string): Promise<Set<string>> {
  const absorbed = new Set<string>();
  for (const line of await git.lines(['cherry', upstream, head, base])) {
    const m = /^([-+]) ([0-9a-f]{40})/.exec(line);
    if (m && m[1] === '-') absorbed.add(m[2] as string);
  }
  return absorbed;
}

export async function computePlan(git: Git, opts: PlanOptions): Promise<Plan> {
  const upstreamRemote = opts.upstreamRemote ?? 'upstream';
  const upstreamRef = `refs/remotes/${upstreamRemote}/${opts.upstreamBranch}`;
  const branchSha = await git.tryRevParse(opts.branchRev ?? opts.branch);
  if (!branchSha) {
    throw new AutopatchError('FAILED_PLAN', `branch "${opts.branchRev ?? opts.branch}" does not exist in the fork checkout`);
  }
  const upstreamSha = await git.tryRevParse(upstreamRef);
  if (!upstreamSha) {
    throw new AutopatchError(
      'FAILED_PLAN',
      `upstream branch "${opts.upstreamBranch}" was not fetched (expected ${upstreamRef}); check the upstream and upstream_branch inputs`,
    );
  }

  const bases = await git.mergeBases(upstreamSha, branchSha);
  if (bases.length === 0) {
    throw new AutopatchError(
      'FAILED_PLAN',
      `"${opts.branch}" and ${upstreamRemote}/${opts.upstreamBranch} have unrelated histories; is this really a fork of ${upstreamRemote}?`,
    );
  }
  if (bases.length > 1) {
    throw new AutopatchError(
      'FAILED_PLAN',
      `"${opts.branch}" and ${upstreamRemote}/${opts.upstreamBranch} have ${bases.length} merge bases (criss-cross history); linearize the fork branch by hand once, then rerun`,
      bases,
    );
  }
  const base = bases[0] as string;

  const merges = await git.lines(['rev-list', '--merges', '--format=%h %s', '--no-commit-header', `${base}..${branchSha}`]);
  if (merges.length > 0) {
    throw new AutopatchError(
      'FAILED_PLAN',
      `"${opts.branch}" contains ${merges.length} merge commit(s) on top of upstream; autopatch needs a linear patch series. Rebase once by hand: git rebase --onto ${upstreamRemote}/${opts.upstreamBranch} ${base.slice(0, 12)} ${opts.branch}`,
      merges,
    );
  }

  const rawPatches = await listPatches(git, base, branchSha);
  if (rawPatches.length > opts.maxPatches) {
    throw new AutopatchError(
      'FAILED_PLAN',
      `"${opts.branch}" carries ${rawPatches.length} commits over upstream, above max_patches=${opts.maxPatches}; is upstream_branch correct?`,
    );
  }

  const common = { branch: opts.branch, upstreamBranch: opts.upstreamBranch, branchSha };

  if (rawPatches.length === 0) {
    if (upstreamSha === branchSha) {
      return { kind: 'nothing_to_do', ...common, patches: [] };
    }
    return { kind: 'fast_forward', ...common, upstreamRef, upstreamSha };
  }

  if (upstreamSha === base) {
    return { kind: 'nothing_to_do', ...common, patches: rawPatches.map((p) => ({ ...p, absorbed: false })) };
  }

  const absorbed = await absorbedPatches(git, upstreamSha, branchSha, base);
  const patches: Patch[] = rawPatches.map((p) => ({ ...p, absorbed: absorbed.has(p.sha) }));
  const expectedSurvivors = patches.filter((p) => !p.absorbed).length;
  const upstreamCommits = await git.revListCount(`${base}..${upstreamSha}`);

  const workflowPaths = Array.from(
    new Set([
      ...(await git.lines(['diff', '--name-only', base, branchSha, '--', '.github/workflows'])),
      ...(await git.lines(['diff', '--name-only', base, upstreamSha, '--', '.github/workflows'])),
    ]),
  ).sort();

  return {
    kind: 'rebase',
    ...common,
    upstreamRef,
    upstreamSha,
    base,
    patches,
    expectedSurvivors,
    upstreamCommits,
    workflowPaths,
  };
}
