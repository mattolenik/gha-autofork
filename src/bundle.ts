import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { AutoforkError } from './errors.js';
import type { Git } from './git.js';

export async function fileDigest(file: string): Promise<string> {
  if (!(await fs.lstat(file)).isFile()) throw new Error(`artifact must be a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function updateRefs(git: Git, refs: Record<string, string>): Promise<void> {
  for (const [ref, sha] of Object.entries(refs)) {
    if (!/^refs\/autofork\/[\w/-]+$/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid artifact ref');
  }
  await git.run(['update-ref', '--stdin'], { input: Object.entries(refs).map(([ref, sha]) => `update ${ref} ${sha}\n`).join('') });
}

/** Export only objects not already reachable from the original fork tip. */
export async function writeIncrementalBundle(git: Git, file: string, basis: string, refs: Record<string, string>): Promise<string | null> {
  await updateRefs(git, refs);
  const count = Number(await git.out(['rev-list', '--count', ...Object.values(refs), `^${basis}`]));
  if (count === 0) {
    await fs.rm(file, { force: true });
    return null;
  }
  await git.run(['bundle', 'create', file, ...Object.keys(refs), `^${basis}`]);
  return fileDigest(file);
}

/** The source URL is trusted configuration, never a URL taken from an artifact. */
export async function fetchBasis(git: Git, source: string, basis: string, token?: string): Promise<Git> {
  if (!/^[0-9a-f]{40}$/.test(basis)) throw new Error('invalid bundle basis');
  await git.ensureRemote('origin', source);
  const remote = await git.authenticated(token);
  const result = await remote.run(['fetch', '--no-tags', '--filter=blob:none', 'origin', `${basis}:refs/autofork/basis`], { allowFailure: true });
  if (result.code !== 0) throw new AutoforkError('FAILED_PLAN', 'could not fetch the original fork tip required by the incremental artifact; use a repository or backup that still contains it', [result.stderr.trim()]);
  return remote;
}

export async function importIncrementalBundle(git: Git, file: string, digest: string | null, basis: string, refs: Record<string, string>): Promise<void> {
  if (digest === null) {
    for (const sha of Object.values(refs)) if (!(await git.isAncestor(sha, basis))) throw new AutoforkError('FAILED_TAMPERED', 'missing incremental history');
  } else {
    if (await fileDigest(file) !== digest) throw new AutoforkError('FAILED_TAMPERED', 'bundle digest mismatch');
    const lines = await git.lines(['bundle', 'list-heads', file]);
    const seen = new Set<string>();
    for (const line of lines) {
      const [sha, ref] = line.split(' ');
      if (!ref || refs[ref] !== sha || seen.has(ref)) throw new AutoforkError('FAILED_TAMPERED', 'unexpected refs in incremental bundle');
      seen.add(ref);
    }
    if (!seen.size) throw new AutoforkError('FAILED_TAMPERED', 'incremental bundle has no refs');
    await git.run(['bundle', 'verify', file]);
    await git.run(['fetch', '--no-tags', file, ...[...seen].map(ref => `${ref}:${ref}`)]);
  }
  await updateRefs(git, refs);
}
