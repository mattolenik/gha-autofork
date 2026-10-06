import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchBasis, fileDigest, importIncrementalBundle, writeIncrementalBundle } from './bundle.js';
import { Git } from './git.js';
import type { RebasePlan } from './plan.js';
import type { PatchRecord } from './rebase.js';
import { validateFilePath } from './state.js';

interface RecoveryFile { path: string; mode: number; blob: string | null; link: string | null; deleted: boolean }
interface Recovery {
  version: 2;
  original: string;
  upstream: string;
  head: string;
  indexCommit: string;
  bundleDigest: string | null;
  signature: string;
  currentPatch: string | null;
  records: PatchRecord[];
  pending: string[];
  /** Index entries for changed paths only; clean entries come from HEAD. */
  index: string;
  rebase: Record<string, string>;
  files: RecoveryFile[];
}

/** Save only the delta from HEAD and history not already reachable from the original fork tip. */
export async function saveRecovery(git: Git, plan: RebasePlan, destination: string, records: PatchRecord[], currentPatch: string | null): Promise<void> {
  const head = await git.revParse('HEAD');
  const dirty = (await git.statusPorcelain()).map(entry => entry.slice(3)).sort();
  const files: RecoveryFile[] = [];
  let index = '';
  for (let offset = 0; offset < dirty.length; offset += 256) {
    index += (await git.run(['ls-files', '--stage', '-z', '--', ...dirty.slice(offset, offset + 256)])).stdout;
  }
  for (const rel of dirty) {
    await validateFilePath(git.cwd, rel);
    const abs = path.join(git.cwd, rel);
    const st = await fs.lstat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    files.push({ path: rel, mode: st ? st.mode & 0o777 : 0, deleted: !st,
      link: st?.isSymbolicLink() ? await fs.readlink(abs) : null,
      blob: st?.isFile() ? await fileDigest(abs) : null });
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
  const content = { original: plan.branchSha, upstream: plan.upstreamSha, head, currentPatch, records, pending, index, rebase, files };
  const signature = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const previous = await fs.readFile(path.join(destination, 'recovery.json'), 'utf8').catch(() => 'null');
  if ((JSON.parse(previous) as Recovery | null)?.signature === signature) return;

  const next = `${destination}.next`;
  await fs.rm(next, { recursive: true, force: true });
  await fs.mkdir(path.join(next, 'files'), { recursive: true });
  for (const file of files) if (file.blob) await fs.copyFile(path.join(git.cwd, file.path), path.join(next, 'files', file.blob));

  // Staged resolutions may contain blobs unreachable from any commit. Keep them reachable via a
  // separate carrier commit without changing the candidate or collapsing staged/unstaged changes.
  const blobs = new Set(index.split('\0').filter(Boolean).map(entry => entry.split(' ')[1]!));
  let indexCommit = head;
  if (blobs.size) {
    const tree = await git.out(['mktree', '-z'], { input: [...blobs].sort().map(sha => `100644 blob ${sha}\t${sha}\0`).join('') });
    indexCommit = await git.out(['commit-tree', tree, '-p', head], { input: 'autopatch recovery index\n' });
  }
  const refs = { 'refs/autopatch/recovery/upstream': plan.upstreamSha, 'refs/autopatch/recovery/partial': head, 'refs/autopatch/recovery/index': indexCommit };
  const bundleDigest = await writeIncrementalBundle(git, path.join(next, 'history.bundle'), plan.branchSha, refs);
  const recovery: Recovery = { version: 2, ...content, indexCommit, bundleDigest, signature };
  await fs.writeFile(path.join(next, 'recovery.json'), JSON.stringify(recovery, null, 2));
  await fs.rm(`${destination}.previous`, { recursive: true, force: true });
  await fs.rename(destination, `${destination}.previous`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  await fs.rename(next, destination);
  await fs.rm(`${destination}.previous`, { recursive: true, force: true });
}

/** Restore from a caller-selected repository containing the original tip, without running scripts. */
export async function restoreRecovery(source: string, destination: string, basisSource: string, token?: string): Promise<void> {
  const r = JSON.parse(await fs.readFile(path.join(source, 'recovery.json'), 'utf8')) as Recovery;
  if (r.version !== 2 || ![r.original, r.upstream, r.head, r.indexCommit].every(s => /^[0-9a-f]{40}$/.test(s))) throw new Error('invalid recovery checkpoint');
  await fs.mkdir(destination);
  let git = new Git(destination);
  await git.run(['init', '-q']);
  git = await fetchBasis(git, basisSource, r.original, token);
  await importIncrementalBundle(git, path.resolve(source, 'history.bundle'), r.bundleDigest, r.original,
    { 'refs/autopatch/recovery/upstream': r.upstream, 'refs/autopatch/recovery/partial': r.head, 'refs/autopatch/recovery/index': r.indexCommit });
  await git.run(['checkout', '-q', '--detach', r.head]);
  for (const file of r.files) {
    await validateFilePath(destination, file.path);
    await fs.rm(path.join(destination, file.path), { force: true });
  }
  for (const file of r.files) {
    if (file.deleted) continue;
    await validateFilePath(destination, file.path);
    const abs = path.join(destination, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (file.link !== null) await fs.symlink(file.link, abs);
    else {
      if (!file.blob || !/^[0-9a-f]{64}$/.test(file.blob)) throw new Error('invalid recovery blob');
      const blob = path.join(source, 'files', file.blob);
      if (await fileDigest(blob) !== file.blob) throw new Error('recovery file checksum mismatch');
      await fs.copyFile(blob, abs);
      await fs.chmod(abs, file.mode & 0o777);
    }
  }
  const changed = new Set(r.files.map(file => file.path));
  for (const entry of r.index.split('\0').filter(Boolean)) {
    const match = /^\d+ [0-9a-f]{40} [0-3]\t([\s\S]+)$/.exec(entry);
    if (!match || !changed.has(match[1]!)) throw new Error('invalid recovery index');
    await validateFilePath(destination, match[1]!);
  }
  const removals = r.files.map(file => `0 ${'0'.repeat(40)}\t${file.path}\0`).join('');
  if (removals || r.index) await git.run(['update-index', '-z', '--index-info'], { input: removals + r.index });
  await git.run(['update-ref', 'refs/heads/autopatch-rescue', r.original]);
  if (Object.keys(r.rebase).length) {
    const dir = await git.gitPath('rebase-merge');
    await fs.mkdir(dir);
    for (const [name, content] of Object.entries(r.rebase)) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name.includes('..')) throw new Error('invalid rebase metadata filename');
      if (name === 'git-rebase-todo' && content.split('\n').some(line => line.trim() && !/^(#|pick |drop )/.test(line))) throw new Error('recovery todo contains unsupported commands');
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
