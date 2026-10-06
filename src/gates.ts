import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Git } from './git.js';
import type { Logger } from './log.js';
import type { RebasePlan } from './plan.js';
import { hasConflictMarkers } from './rebase.js';
import { candidateIdentity, guardGit, validateFilePath, type CandidateIdentity } from './state.js';
import { sandboxCommand } from './sandbox.js';

export interface VerifyResult {
  command: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last part of combined stdout/stderr. */
  outputTail: string;
}

export interface GateResult {
  candidate: CandidateIdentity;
  ok: boolean;
  failures: string[];
  rangeDiff: string;
  changedFiles: string[];
  verify: VerifyResult | null;
}

export interface GateOptions {
  git: Git;
  plan: RebasePlan;
  /** Number of commits expected on top of upstream. */
  expectedCount: number;
  verifyCommand?: string | undefined;
  verifyTimeoutMs?: number;
  /** Environment for the verify command (already scrubbed). */
  env: Record<string, string>;
  log: Logger;
  tailChars?: number;
  sandbox?: boolean;
}

export async function runGates(o: GateOptions): Promise<GateResult> {
  const { git, plan } = o;
  const failures: string[] = [];
  const candidate = await candidateIdentity(git);
  const head = candidate.headSha;

  // REBASE_HEAD can linger after a rebase that ended with --skip, so check the state directories.
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      await fs.access(await git.gitPath(dir));
      failures.push('a rebase is still in progress');
      break;
    } catch {
      /* not in progress */
    }
  }
  const unmerged = await git.unmergedPaths();
  if (unmerged.size > 0) failures.push(`unmerged paths remain: ${[...unmerged.keys()].join(', ')}`);
  const status = await git.statusPorcelain();
  if (status.length > 0) failures.push(`worktree is not clean: ${status.slice(0, 10).join('; ')}`);

  if (!(await git.isAncestor(plan.upstreamSha, head))) failures.push(`HEAD does not descend from upstream ${plan.upstreamSha.slice(0, 12)}`);

  const count = await git.revListCount(`${plan.upstreamSha}..${head}`);
  if (count !== o.expectedCount) failures.push(`expected ${o.expectedCount} commits on top of upstream, found ${count}`);

  const changedFiles = await git.paths(['diff', '--name-only', '-z', plan.upstreamSha, head]);
  for (const rel of changedFiles) {
    await validateFilePath(git.cwd, rel);
    const abs = path.join(git.cwd, rel);
    try {
      await fs.access(abs);
    } catch {
      continue; // deleted file
    }
    if (await hasConflictMarkers(abs)) failures.push(`conflict markers in ${rel}`);
  }

  const comparison = (
    // Patches rewritten during conflict resolution can differ a lot from their originals; a high creation
    // factor makes range-diff pair them instead of showing a deletion and an addition.
    await git.run(count === 0 || plan.patches.length === 0
      ? ['log', '--reverse', '--format=fuller', '-p', '--no-color', `${plan.base}..${plan.branchSha}`]
      : ['range-diff', '--no-color', '--creation-factor=100', `${plan.base}..${plan.branchSha}`, `${plan.upstreamSha}..${head}`], {
      allowFailure: true,
    })
  );
  if (comparison.code !== 0) failures.push(`range-diff failed: ${comparison.stderr.trim()}`);
  const rangeDiff = plan.patches.length === 0 ? 'Patchless fast-forward: no fork patches to replay or drop.'
    : count === 0 ? `No surviving patches. Original patches (all dropped):\n${comparison.stdout}` : comparison.stdout;

  let verify: VerifyResult | null = null;
  if (o.verifyCommand && failures.length === 0) {
    verify = await guardGit(git, 'readonly', 'verify command', () =>
      runVerify(o.verifyCommand!, git.cwd, o.env, o.verifyTimeoutMs ?? 30 * 60_000, o.tailChars ?? 20_000, o.sandbox));
    if (verify.timedOut) failures.push(`verify command timed out after ${Math.round(verify.durationMs / 1000)}s`);
    else if (verify.code !== 0) failures.push(`verify command failed with exit code ${verify.code}`);
    o.log.info(`verify "${o.verifyCommand}": ${verify.timedOut ? 'timed out' : `exit ${verify.code}`} in ${(verify.durationMs / 1000).toFixed(1)}s`);
  }

  return { candidate, ok: failures.length === 0, failures, rangeDiff, changedFiles, verify };
}

export async function runVerify(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, tailChars: number, sandbox = false): Promise<VerifyResult> {
  const launch = sandbox ? await sandboxCommand('sh', ['-c', command], cwd, 'edit', env) : { bin: 'sh', args: ['-c', command], env };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    let size = 0;
    const child = spawn(launch.bin, launch.args, { cwd, env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const push = (b: Buffer) => {
      chunks.push(b);
      size += b.length;
      while (size > tailChars * 4 && chunks.length > 1) size -= (chunks.shift() as Buffer).length;
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString('utf8');
      resolve({
        command,
        code,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: out.length > tailChars ? `…${out.slice(out.length - tailChars)}` : out,
      });
    });
  });
}
