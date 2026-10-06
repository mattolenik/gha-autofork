import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Git } from './git.js';
import type { RebasePlan } from './plan.js';
import type { PatchRecord } from './rebase.js';
import { validateFilePath } from './state.js';

interface RecoveryFile { path: string; mode: number; blob: string | null; link: string | null }
interface Recovery {
  version: 1;
  original: string;
  upstream: string;
  head: string;
  currentPatch: string | null;
  records: PatchRecord[];
  pending: string[];
  index: string;
  rebase: Record<string, string>;
  files: RecoveryFile[];
}

/** A checkpoint is promoted only after its bundle, index, and files are durable. */
export async function saveRecovery(git: Git, plan: RebasePlan, destination: string, records: PatchRecord[], currentPatch: string | null): Promise<void> {
  const next = `${destination}.next`;
  await fs.rm(next, { recursive: true, force: true });
  await fs.mkdir(path.join(next, 'files'), { recursive: true });
  const head = await git.revParse('HEAD');
  const refs = { original: plan.branchSha, upstream: plan.upstreamSha, partial: head };
  for (const [name, sha] of Object.entries(refs)) await git.run(['update-ref', `refs/autopatch/recovery/${name}`, sha]);
  await git.run(['bundle', 'create', path.join(next, 'history.bundle'), ...Object.keys(refs).map(n => `refs/autopatch/recovery/${n}`)]);
  const files: RecoveryFile[] = [];
  for (const rel of new Set(await git.paths(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))) {
    await validateFilePath(git.cwd, rel);
    const abs = path.join(git.cwd, rel);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) continue;
    const file: RecoveryFile = { path: rel, mode: st.mode & 0o777, blob: null, link: null };
    if (st.isSymbolicLink()) file.link = await fs.readlink(abs);
    else if (st.isFile()) {
      file.blob = createHash('sha256').update(rel).digest('hex');
      await fs.copyFile(abs, path.join(next, 'files', file.blob));
    } else continue;
    files.push(file);
  }
  const rebase: Record<string, string> = {};
  const rebaseDir = await git.gitPath('rebase-merge');
  for (const name of await fs.readdir(rebaseDir).catch(() => [] as string[])) {
    const abs = path.join(rebaseDir, name);
    if ((await fs.lstat(abs)).isFile()) rebase[name] = await fs.readFile(abs, 'utf8');
  }
  const todo = (rebase['git-rebase-todo'] ?? '').split('\n').map(line => /^pick ([0-9a-f]+)/.exec(line)?.[1]).filter((s): s is string => !!s);
  const pending = Object.keys(rebase).length
    ? plan.patches.filter(p => p.sha === currentPatch || todo.some(ref => p.sha.startsWith(ref))).map(p => p.sha)
    : head === plan.branchSha ? plan.patches.map(p => p.sha) : [];
  const recovery: Recovery = { version: 1, original: plan.branchSha, upstream: plan.upstreamSha, head, currentPatch,
    records, pending,
    index: (await git.run(['ls-files', '--stage', '-z'])).stdout, rebase, files };
  await fs.writeFile(path.join(next, 'recovery.json'), JSON.stringify(recovery, null, 2));
  await fs.rm(`${destination}.previous`, { recursive: true, force: true });
  await fs.rename(destination, `${destination}.previous`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  await fs.rename(next, destination);
  await fs.rm(`${destination}.previous`, { recursive: true, force: true });
}

/** Restore locally without running repository hooks, scripts, or rebase commands. */
export async function restoreRecovery(source: string, destination: string): Promise<void> {
  const r = JSON.parse(await fs.readFile(path.join(source, 'recovery.json'), 'utf8')) as Recovery;
  if (r.version !== 1 || ![r.original, r.upstream, r.head].every(s => /^[0-9a-f]{40}$/.test(s))) throw new Error('invalid recovery checkpoint');
  await fs.mkdir(destination); // refuse to overwrite an existing directory
  const git = new Git(destination);
  await git.run(['init', '-q']);
  await git.run(['fetch', path.resolve(source, 'history.bundle'), '+refs/autopatch/recovery/*:refs/autopatch/recovery/*']);
  for (const [name, sha] of [['original', r.original], ['upstream', r.upstream], ['partial', r.head]]) {
    if (await git.revParse(`refs/autopatch/recovery/${name}`) !== sha) throw new Error('recovery bundle does not match checkpoint');
  }
  await git.run(['checkout', '-q', '--detach', r.head]);
  for (const rel of await git.paths(['ls-files', '-z'])) {
    await validateFilePath(destination, rel);
    await fs.rm(path.join(destination, rel), { force: true });
  }
  for (const file of r.files) {
    await validateFilePath(destination, file.path);
    const abs = path.join(destination, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (file.link !== null) await fs.symlink(file.link, abs);
    else {
      if (!file.blob || !/^[0-9a-f]{64}$/.test(file.blob)) throw new Error('invalid recovery blob');
      const blob = path.join(source, 'files', file.blob);
      if (!(await fs.lstat(blob)).isFile()) throw new Error('recovery blob must be a regular file');
      await fs.copyFile(blob, abs);
      await fs.chmod(abs, file.mode & 0o777);
    }
  }
  for (const entry of r.index.split('\0').filter(Boolean)) {
    const match = /^\d+ [0-9a-f]{40} [0-3]\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('invalid recovery index');
    await validateFilePath(destination, match[1]!);
  }
  await git.run(['read-tree', '--empty']);
  await git.run(['update-index', '-z', '--index-info'], { input: r.index });
  await git.run(['update-ref', 'refs/heads/autopatch-rescue', r.original]);
  if (Object.keys(r.rebase).length) {
    const dir = await git.gitPath('rebase-merge');
    await fs.mkdir(dir);
    for (const [name, content] of Object.entries(r.rebase)) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name.includes('..')) throw new Error('invalid rebase metadata filename');
      if (name === 'git-rebase-todo' && content.split('\n').some(line => line.trim() && !/^(#|pick |drop )/.test(line))) {
        throw new Error('recovery todo contains unsupported commands');
      }
      await fs.writeFile(path.join(dir, name), name === 'head-name' ? 'refs/heads/autopatch-rescue\n' : content);
    }
    if (r.currentPatch) {
      if (!/^[0-9a-f]{40}$/.test(r.currentPatch)) throw new Error('invalid current patch');
      await git.run(['update-ref', 'REBASE_HEAD', r.currentPatch]);
    }
  } else {
    await git.run(['update-ref', 'refs/heads/autopatch-rescue', r.head]);
    await git.run(['symbolic-ref', 'HEAD', 'refs/heads/autopatch-rescue']);
  }
}
