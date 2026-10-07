import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AutoforkError } from './errors.js';
import type { Git } from './git.js';
import type { Logger } from './log.js';
import type { Patch, RebasePlan } from './plan.js';
import { quarantine } from './quarantine.js';
import type { ResolveReport } from './schemas.js';
import { guardGit, validateFilePath } from './state.js';

export type ConflictKind = 'content' | 'deleted_upstream' | 'deleted_by_patch' | 'both_added' | 'other';

export interface ConflictPath {
  path: string;
  kind: ConflictKind;
  binary: boolean;
  /** Index stages present: 1 base, 2 ours (upstream side), 3 theirs (patch side). */
  stages: number[];
}

export interface UpstreamDelta {
  path: string;
  log: string;
  diff: string;
}

export interface ConflictContext {
  patch: Patch;
  /** 1-based position in the full series. */
  index: number;
  total: number;
  paths: ConflictPath[];
  /** `git show` of the original patch, capped. */
  patchShow: string;
  /** Current worktree content (with zdiff3 markers) of conflicted text files, capped. */
  workingCopies: { path: string; content: string | null }[];
  upstreamDelta: UpstreamDelta[];
  priorResolutions: PatchRecord[];
  attempt: number;
  /** Problems found with the previous attempt, if any. */
  previousProblems: string[];
}

export interface Worker {
  resolve(ctx: ConflictContext): Promise<ResolveReport>;
}

export type PatchResult = 'applied' | 'absorbed' | 'became_empty' | 'skipped';

export interface PatchRecord {
  sha: string;
  subject: string;
  result: PatchResult;
  newSha: string | null;
  conflicts: ConflictPath[];
  report: ResolveReport | null;
  /** Paths staged beyond the conflicted set. */
  extraPaths: string[];
}

export interface RebaseOutcome {
  headSha: string;
  records: PatchRecord[];
  conflictsResolved: number;
  /** Original sha → new sha for every surviving patch. */
  mapping: Map<string, string>;
}

export interface RebaseOptions {
  /** Git bound to the worktree, checked out on the temporary branch at the fork tip. */
  git: Git;
  plan: RebasePlan;
  worker: Worker;
  /** Directory instruction files are moved to during agent calls. */
  holdDir: string;
  log: Logger;
  maxAttemptsPerConflict?: number;
  /** Character caps for prompt material. */
  caps?: { patchShow?: number; file?: number; diff?: number };
  onProgress?: (records: PatchRecord[], currentPatch: string | null) => Promise<void>;
}

/** Config that makes the rebase deterministic regardless of user or runner configuration. */
export const REBASE_CONFIG: Record<string, string> = {
  'rebase.autoSquash': 'false',
  'rebase.updateRefs': 'false',
  'rebase.autoStash': 'false',
  'rebase.missingCommitsCheck': 'ignore',
  'merge.conflictStyle': 'zdiff3',
  'rerere.enabled': 'false',
  'rerere.autoUpdate': 'false',
  'core.editor': 'true',
  'sequence.editor': 'true',
};

export const MARKER_RE = /^(<{7}|={7}|>{7}|\|{7})( |$)/m;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isBinaryFile(abs: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(abs)).isFile()) return false;
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(8000);
      const { bytesRead } = await fh.read(buf, 0, 8000, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export async function hasConflictMarkers(abs: string): Promise<boolean> {
  const st = await fs.lstat(abs);
  if (!st.isFile()) return false;
  if (await isBinaryFile(abs)) return false;
  const content = await fs.readFile(abs, 'utf8');
  return MARKER_RE.test(content);
}

function classify(stages: Set<1 | 2 | 3>): ConflictKind {
  const has = (n: 1 | 2 | 3) => stages.has(n);
  if (has(1) && has(2) && has(3)) return 'content';
  if (has(1) && !has(2) && has(3)) return 'deleted_upstream';
  if (has(1) && has(2) && !has(3)) return 'deleted_by_patch';
  if (!has(1) && has(2) && has(3)) return 'both_added';
  return 'other';
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

export async function runRebase(o: RebaseOptions): Promise<RebaseOutcome> {
  const git = o.git.withConfig(REBASE_CONFIG);
  const { plan, log } = o;
  const caps = { patchShow: 40_000, file: 30_000, diff: 30_000, ...o.caps };
  const maxAttempts = o.maxAttemptsPerConflict ?? 2;
  const records = new Map<string, PatchRecord>();
  const total = plan.patches.length;
  let conflictsResolved = 0;

  const record = (patch: Patch, partial: Partial<PatchRecord> & { result: PatchResult }): PatchRecord => {
    const rec: PatchRecord = {
      sha: patch.sha,
      subject: patch.subject,
      newSha: null,
      conflicts: [],
      report: null,
      extraPaths: [],
      ...partial,
    };
    records.set(patch.sha, rec);
    return rec;
  };

  for (const p of plan.patches) if (p.absorbed) record(p, { result: 'absorbed' });

  log.info(`rebasing ${total} patch(es) onto ${plan.upstreamSha.slice(0, 12)} (base ${plan.base.slice(0, 12)}, ${plan.upstreamCommits} new upstream commits)`);
  // `git rebase <upstream>` replays merge-base..HEAD (= base..HEAD) onto upstream and drops patches that
  // are already cherry-picks of upstream commits. `--onto X base` would compare against base instead.
  let r = await git.run(
    ['rebase', plan.upstreamSha, '--empty=stop', '--no-autostash', '--no-verify', '--no-update-refs', '--no-autosquash'],
    { allowFailure: true },
  );

  while (r.code !== 0) {
    const inRebase = await exists(await git.gitPath('rebase-merge'));
    if (!inRebase) {
      throw new AutoforkError('FAILED_REBASE', `git rebase failed outside of a conflict: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const rebaseHead = await git.tryRevParse('REBASE_HEAD');
    await o.onProgress?.([...records.values()], rebaseHead ?? null);
    const patch = plan.patches.find((p) => p.sha === rebaseHead);
    if (!patch) {
      throw new AutoforkError('FAILED_REBASE', `rebase stopped on unknown commit ${rebaseHead ?? '(none)'}`);
    }
    const index = plan.patches.indexOf(patch) + 1;
    const unmerged = await git.unmergedPaths();

    if (unmerged.size === 0) {
      if (await git.indexIsEmpty()) {
        log.info(`patch ${index}/${total} "${patch.subject}" became empty on the new base; skipping`);
        record(patch, { result: 'became_empty' });
        await o.onProgress?.([...records.values()], patch.sha);
        r = await git.run(['rebase', '--skip'], { allowFailure: true });
        continue;
      }
      throw new AutoforkError('FAILED_REBASE', `rebase stopped on "${patch.subject}" with staged changes but no conflicts: ${r.stderr.trim()}`);
    }

    // Every unmerged index entry needs an explicit resolution, including binary/rename conflicts.
    const conflictPaths: ConflictPath[] = [];
    for (const [p, stages] of unmerged) {
      await validateFilePath(git.cwd, p);
      conflictPaths.push({
        path: p,
        kind: classify(stages),
        binary: await isBinaryFile(path.join(git.cwd, p)),
        stages: [...stages].sort(),
      });
    }

    log.info(`patch ${index}/${total} "${patch.subject}" conflicts in ${conflictPaths.length} file(s): ${conflictPaths.map((c) => `${c.path} [${c.kind}${c.binary ? ', binary' : ''}]`).join(', ')}`);
    const ctx: ConflictContext = {
      patch,
      index,
      total,
      paths: conflictPaths,
      patchShow: cap(await git.out(['show', '--format=fuller', '--stat', '-p', '--no-color', rebaseHead as string]), caps.patchShow),
      workingCopies: [],
      upstreamDelta: [],
      priorResolutions: [...records.values()].filter((rec) => rec.report !== null),
      attempt: 1,
      previousProblems: [],
    };
    for (const c of conflictPaths) {
      await validateFilePath(git.cwd, c.path);
      const abs = path.join(git.cwd, c.path);
      ctx.workingCopies.push({
        path: c.path,
        content: c.binary || !(await exists(abs)) || (await fs.lstat(abs)).isSymbolicLink() ? null : cap(await fs.readFile(abs, 'utf8'), caps.file),
      });
      ctx.upstreamDelta.push({
        path: c.path,
        log: await git.out(['log', '--oneline', '--no-color', `${plan.base}..${plan.upstreamSha}`, '--', c.path]),
        diff: cap(await git.out(['diff', '--no-color', plan.base, plan.upstreamSha, '--', c.path]), caps.diff),
      });
    }

    let report: ResolveReport | null = null;
    let extraPaths: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      ctx.attempt = attempt;
      report = await guardGit(git, 'edit', 'conflict worker', async () => {
        const q = await quarantine(git.cwd, o.holdDir, conflictPaths.map((c) => c.path));
        try { return await o.worker.resolve(ctx); } finally { await q.restore(); }
      });
      if (report.status === 'need_help') {
        throw new AutoforkError('FAILED_REBASE', `worker could not resolve "${patch.subject}": ${report.summary}`, report.risks);
      }
      const applied = await applyReport(git, report, conflictPaths);
      extraPaths = applied.extraPaths;
      if (applied.problems.length === 0) break;
      log.warning(`resolution of "${patch.subject}" attempt ${attempt} has problems: ${applied.problems.join('; ')}`);
      if (attempt === maxAttempts) {
        throw new AutoforkError('FAILED_REBASE', `worker could not produce a clean resolution for "${patch.subject}" after ${maxAttempts} attempts`, applied.problems);
      }
      ctx.previousProblems = applied.problems;
    }
    if (!report) throw new AutoforkError('FAILED_REBASE', 'unreachable: no report');

    if (report.status === 'skip_patch') {
      log.info(`patch ${index}/${total} "${patch.subject}" skipped by worker: ${report.summary}`);
      record(patch, { result: 'skipped', conflicts: conflictPaths, report, extraPaths });
      await o.onProgress?.([...records.values()], patch.sha);
      r = await git.run(['rebase', '--skip'], { allowFailure: true });
      continue;
    }
    conflictsResolved += 1;
    record(patch, { result: 'applied', conflicts: conflictPaths, report, extraPaths });
    await o.onProgress?.([...records.values()], patch.sha);
    r = await git.run(['rebase', '--continue'], { allowFailure: true });
  }

  const headSha = await git.revParse('HEAD');
  const survivors = plan.patches.filter((p) => {
    const rec = records.get(p.sha);
    return !rec || rec.result === 'applied';
  });
  const newShas = await git.lines(['rev-list', '--reverse', `${plan.upstreamSha}..${headSha}`]);
  if (newShas.length !== survivors.length) {
    const summary = plan.patches.map((p) => `${p.sha.slice(0, 12)} ${records.get(p.sha)?.result ?? 'applied'} ${p.subject}`);
    throw new AutoforkError(
      'FAILED_GATE',
      `patch accounting mismatch: expected ${survivors.length} commits on top of upstream but found ${newShas.length}`,
      summary,
    );
  }
  const mapping = new Map<string, string>();
  survivors.forEach((p, i) => {
    const newSha = newShas[i] as string;
    mapping.set(p.sha, newSha);
    const rec = records.get(p.sha) ?? record(p, { result: 'applied' });
    rec.newSha = newSha;
  });
  const ordered = plan.patches.map((p) => records.get(p.sha) as PatchRecord);
  await o.onProgress?.(ordered, null);
  log.info(`rebase complete: ${newShas.length} patch(es) on ${plan.upstreamSha.slice(0, 12)}, ${conflictsResolved} conflict(s) resolved`);
  return { headSha, records: ordered, conflictsResolved, mapping };
}

interface ApplyResult {
  problems: string[];
  extraPaths: string[];
}

/**
 * Turn the worker's report into index state. Stages only reported paths, checks markers, and verifies
 * that nothing unreported was left behind.
 */
export async function applyReport(git: Git, report: ResolveReport, conflicts: ConflictPath[]): Promise<ApplyResult> {
  const problems: string[] = [];
  const conflictMap = new Map(conflicts.map((c) => [c.path, c]));
  const reported = new Map(report.files.map((f) => [f.path, f]));

  for (const c of conflicts) {
    if (!reported.has(c.path)) problems.push(`conflicted file not addressed in the report: ${c.path}`);
  }

  const extraPaths: string[] = [];
  for (const f of report.files) {
    await validateFilePath(git.cwd, f.path);
    const abs = path.join(git.cwd, f.path);
    const c = conflictMap.get(f.path);
    if (!c) extraPaths.push(f.path);
    switch (f.action) {
      case 'deleted':
        await git.run(['rm', '-q', '--force', '--ignore-unmatch', '--', f.path], { allowFailure: true });
        if (await exists(abs)) await fs.rm(abs, { force: true });
        await git.run(['add', '-u', '--', f.path], { allowFailure: true });
        break;
      case 'take_upstream':
      case 'take_patch': {
        if (!c) {
          problems.push(`${f.action} only applies to conflicted files: ${f.path}`);
          break;
        }
        const stage = f.action === 'take_upstream' ? 2 : 3;
        if (!c.stages.includes(stage)) {
          await git.run(['rm', '-q', '--force', '--', f.path]);
        } else {
          await git.run(['checkout', f.action === 'take_upstream' ? '--ours' : '--theirs', '--', f.path]);
          await git.run(['add', '--', f.path]);
        }
        break;
      }
      case 'edited':
      case 'created': {
        if (!(await exists(abs))) {
          problems.push(`reported as ${f.action} but missing from the worktree: ${f.path}`);
          break;
        }
        if (await hasConflictMarkers(abs)) {
          problems.push(`conflict markers remain in ${f.path}`);
          break;
        }
        await git.run(['add', '--', f.path]);
        break;
      }
    }
  }

  const stillUnmerged = await git.unmergedPaths();
  for (const p of stillUnmerged.keys()) {
    if (!problems.some((x) => x.includes(p))) problems.push(`still unmerged: ${p}`);
  }

  const status = await git.statusPorcelain();
  const unreported: string[] = [];
  for (const line of status) {
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    if (xy === '??' || xy[1] !== ' ') unreported.push(`${xy.trim()} ${p}`);
  }
  if (unreported.length > 0) {
    problems.push(`unreported changes in the worktree (report every file you touch, or do not touch it): ${unreported.join(', ')}`);
  }

  if (problems.length === 0 && report.status === 'resolved' && (await git.indexIsEmpty())) {
    problems.push('the resolution leaves nothing to commit; if this patch no longer applies return status "skip_patch" with a rationale');
  }

  return { problems, extraPaths };
}
