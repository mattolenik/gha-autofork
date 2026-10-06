import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AutopatchError } from './errors.js';
import type { Git } from './git.js';

export interface CandidateIdentity {
  headSha: string;
  treeSha: string;
}

export async function candidateIdentity(git: Git): Promise<CandidateIdentity> {
  return { headSha: await git.revParse('HEAD'), treeSha: await git.tree() };
}

async function hashPath(p: string): Promise<string | null> {
  const st = await fs.lstat(p).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink()) return `link:${await fs.readlink(p)}`;
  if (st.isDirectory()) {
    const entries = await fs.readdir(p);
    return JSON.stringify(await Promise.all(entries.sort().map(async n => [n, await hashPath(path.join(p, n))])));
  }
  return createHash('sha256').update(await fs.readFile(p)).digest('hex');
}

/** Logical index entries avoid false alarms caused by Git's stat-cache refreshes. */
export async function gitState(git: Git): Promise<string> {
  const common = await git.commonDir();
  const metadata = ['HEAD', 'REBASE_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
  return JSON.stringify({
    head: await git.out(['rev-parse', 'HEAD']),
    refs: await git.out(['for-each-ref', '--format=%(refname) %(objectname)']),
    index: (await git.run(['ls-files', '--stage', '-v', '-z'])).stdout,
    metadata: await Promise.all(metadata.map(async n => [n, await hashPath(await git.gitPath(n))])),
    config: await hashPath(path.join(common, 'config')),
    worktreeConfig: await hashPath(await git.gitPath('config.worktree')),
    gitFile: (await fs.lstat(path.join(git.cwd, '.git'))).isDirectory() ? null : await hashPath(path.join(git.cwd, '.git')),
  });
}

/** Every external call has an explicit mutation contract, including failed calls. */
export async function guardGit<T>(git: Git, mode: 'edit' | 'readonly', label: string, call: () => Promise<T>): Promise<T> {
  const before = await gitState(git);
  const beforeDiff = mode === 'readonly' ? (await git.run(['diff', '--binary', '--no-ext-diff', '--no-textconv'])).stdout : null;
  const beforeStatus = mode === 'readonly' ? await git.statusPorcelain() : null;
  try {
    return await call();
  } finally {
    try {
      if (await gitState(git) !== before) throw new AutopatchError('FAILED_TAMPERED', `${label} changed Git metadata or the index`);
      if (mode === 'readonly' && (JSON.stringify(await git.statusPorcelain()) !== JSON.stringify(beforeStatus) ||
        (await git.run(['diff', '--binary', '--no-ext-diff', '--no-textconv'])).stdout !== beforeDiff)) {
        throw new AutopatchError('FAILED_TAMPERED', `${label} changed the worktree during a read-only operation`);
      }
    } catch (e) {
      if (e instanceof AutopatchError) throw e;
      throw new AutopatchError('FAILED_TAMPERED', `${label} left Git state unreadable`, [e instanceof Error ? e.message : String(e)]);
    }
  }
}

export async function assertCandidate(git: Git, expected: CandidateIdentity): Promise<void> {
  const current = await candidateIdentity(git);
  if (current.headSha !== expected.headSha || current.treeSha !== expected.treeSha || (await git.statusPorcelain()).length) {
    throw new AutopatchError('FAILED_TAMPERED', 'candidate changed after verification or approval');
  }
}

/** Reject traversal, directories, and symlink ancestors; leaf symlinks are Git data. */
export async function validateFilePath(root: string, rel: string): Promise<void> {
  if (!rel || path.isAbsolute(rel) || rel.includes('\0') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new AutopatchError('FAILED_AGENT', `invalid file path: ${JSON.stringify(rel)}`);
  }
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const st = await fs.lstat(path.join(root, ...parts.slice(0, i))).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (st && (i < parts.length ? !st.isDirectory() : st.isDirectory())) {
      throw new AutopatchError('FAILED_AGENT', `file path traverses a symlink or names a directory: ${JSON.stringify(rel)}`);
    }
  }
}
