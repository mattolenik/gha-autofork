import type { Git } from './git.js';
import type { Logger } from './log.js';
import type { RebasePlan } from './plan.js';
import type { RebaseOutcome } from './rebase.js';

export interface FoldOptions {
  git: Git;
  plan: RebasePlan;
  outcome: RebaseOutcome;
  /** Paths the worker changed (modified, created, or deleted). */
  files: string[];
  /** Patch the worker named, as an original or current sha (full or abbreviated), or null. */
  targetPatch: string | null;
  log: Logger;
}

export interface FoldResult {
  /** Original sha → current sha after folding. */
  mapping: Map<string, string>;
  headSha: string;
  /** Which current patch each file was folded into. */
  folded: { path: string; into: string }[];
  warnings: string[];
}

/** Resolve a patch reference (original/new sha, abbreviated) to the current sha, or undefined. */
export function resolvePatchRef(ref: string, mapping: Map<string, string>): string | undefined {
  const r = ref.trim().toLowerCase();
  if (!r) return undefined;
  for (const [orig, cur] of mapping) {
    if (orig.startsWith(r) || cur.startsWith(r)) return cur;
  }
  return undefined;
}

/**
 * Fold worktree changes into the patch series as fixups so the history stays `upstream + P1..Pn`.
 * Each file goes to the named patch, else to the last patch that touched it, else to the last patch.
 * If the autosquash rebase conflicts (a later patch touches the same lines), everything is folded into
 * the last patch instead, which always applies cleanly.
 */
export async function foldChanges(o: FoldOptions): Promise<FoldResult> {
  const { git, plan, outcome, log } = o;
  const warnings: string[] = [];
  const current = [...outcome.mapping.values()];
  const last = current[current.length - 1];
  if (!last) throw new Error('cannot fold changes: no surviving patches');
  const head = await git.revParse('HEAD');

  const named = o.targetPatch ? resolvePatchRef(o.targetPatch, outcome.mapping) : undefined;
  if (o.targetPatch && !named) warnings.push(`target patch "${o.targetPatch}" not found in the series; choosing by file history`);

  const groups = new Map<string, string[]>();
  const folded: { path: string; into: string }[] = [];
  for (const file of o.files) {
    let into = named;
    if (!into) {
      const touched = await git.out(['log', '-1', '--format=%H', `${plan.upstreamSha}..HEAD`, '--', file]);
      into = touched && current.includes(touched) ? touched : last;
    }
    groups.set(into, [...(groups.get(into) ?? []), file]);
    folded.push({ path: file, into });
  }

  for (const [into, files] of groups) {
    await git.run(['add', '-A', '--', ...files]);
    if (await git.indexIsEmpty()) {
      warnings.push(`no changes to fold for ${files.join(', ')}`);
      continue;
    }
    await git.run(['commit', '-q', '--no-verify', `--fixup=${into}`]);
  }

  const status = await git.statusPorcelain();
  if (status.length > 0) {
    await git.run(['reset', '-q', '--hard', head]);
    throw new Error(`worktree has unreported changes after staging the reported files: ${status.join('; ')}`);
  }

  const afterFixups = await git.revParse('HEAD');
  if (afterFixups === head) {
    return { mapping: outcome.mapping, headSha: head, folded: [], warnings };
  }

  const squash = await git.run(['rebase', '-i', '--autosquash', '--no-verify', '--no-update-refs', plan.upstreamSha], { allowFailure: true });
  if (squash.code !== 0) {
    await git.run(['rebase', '--abort'], { allowFailure: true });
    await git.run(['reset', '-q', '--hard', afterFixups]);
    // Collapse all fixup commits into the last patch instead.
    await git.run(['reset', '-q', '--soft', head]);
    await git.run(['commit', '-q', '--no-verify', `--fixup=${last}`]);
    const retry = await git.run(['rebase', '-i', '--autosquash', '--no-verify', '--no-update-refs', plan.upstreamSha], { allowFailure: true });
    if (retry.code !== 0) {
      await git.run(['rebase', '--abort'], { allowFailure: true });
      await git.run(['reset', '-q', '--hard', head]);
      throw new Error(`could not fold changes even into the last patch: ${retry.stderr.trim()}`);
    }
    warnings.push(`folding into the targeted patch(es) conflicted with later patches; folded all changes into the last patch "${plan.patches.find((p) => outcome.mapping.get(p.sha) === last)?.subject ?? last.slice(0, 12)}" instead`);
    for (const f of folded) f.into = last;
    log.warning(warnings[warnings.length - 1] as string);
  }

  const survivors = [...outcome.mapping.keys()];
  const newShas = await git.lines(['rev-list', '--reverse', `${plan.upstreamSha}..HEAD`]);
  if (newShas.length !== survivors.length) {
    await git.run(['reset', '-q', '--hard', head]);
    throw new Error(`folding changed the patch count from ${survivors.length} to ${newShas.length}`);
  }
  const mapping = new Map<string, string>();
  survivors.forEach((orig, i) => mapping.set(orig, newShas[i] as string));
  // Remap "into" to the post-squash shas.
  const oldToNew = new Map(current.map((c, i) => [c, newShas[i] as string]));
  for (const f of folded) f.into = oldToNew.get(f.into) ?? f.into;
  return { mapping, headSha: await git.revParse('HEAD'), folded, warnings };
}
