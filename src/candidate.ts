import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { AutopatchError } from './errors.js';
import { Git } from './git.js';
import type { RebasePlan } from './plan.js';
import type { RebaseOutcome } from './rebase.js';
import { assertCandidate, candidateIdentity } from './state.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const candidateSchema = z.object({
  version: z.literal(1), runId: z.string(), runAttempt: z.string(), repository: z.string(), upstream: z.string(),
  branch: z.string(), upstreamBranch: z.string(), originalSha: sha, upstreamSha: sha, baseSha: sha,
  checkpointSha: sha.nullable(), headSha: sha, treeSha: sha, bundleDigest: digest,
  kind: z.enum(['rebase', 'fast_forward']), autoEligible: z.boolean(), verifyCommand: z.string().nullable(),
  patches: z.array(z.object({ original: sha, current: sha.nullable(), result: z.enum(['applied', 'rerere', 'absorbed', 'became_empty', 'skipped']) }).strict()).max(10000),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;

export const verificationSchema = z.object({
  version: z.literal(1), runId: z.string(), runAttempt: z.string(), candidateDigest: digest,
  headSha: sha, treeSha: sha, verifyCommand: z.string().nullable(), passed: z.literal(true),
}).strict();

export async function fileDigest(file: string): Promise<string> {
  if (!(await fs.lstat(file)).isFile()) throw new Error(`artifact must be a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readBoundJson(file: string, expected: string): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new AutopatchError('FAILED_GATE', 'the producing job must supply the artifact SHA-256 digest');
  if ((await fs.lstat(file)).size > 5 * 1024 * 1024) throw new Error('artifact manifest is too large');
  if (await fileDigest(file) !== expected) throw new AutopatchError('FAILED_TAMPERED', 'artifact digest differs from the producing job output');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

export async function writeCandidate(git: Git, directory: string, plan: RebasePlan, outcome: RebaseOutcome,
  metadata: Pick<Candidate, 'runId' | 'runAttempt' | 'repository' | 'upstream' | 'checkpointSha' | 'kind' | 'autoEligible' | 'verifyCommand'>): Promise<string> {
  const identity = await candidateIdentity(git);
  await assertCandidate(git, { headSha: outcome.headSha, treeSha: identity.treeSha });
  await fs.mkdir(directory, { recursive: true });
  const refs = { original: plan.branchSha, upstream: plan.upstreamSha, base: plan.base, head: identity.headSha };
  for (const [name, value] of Object.entries(refs)) await git.run(['update-ref', `refs/autopatch/candidate/${name}`, value]);
  const bundle = path.join(directory, 'candidate.bundle');
  await git.run(['bundle', 'create', bundle, ...Object.keys(refs).map(n => `refs/autopatch/candidate/${n}`)]);
  const candidate = candidateSchema.parse({ version: 1, ...metadata, ...identity,
    branch: plan.branch, upstreamBranch: plan.upstreamBranch, originalSha: plan.branchSha, upstreamSha: plan.upstreamSha, baseSha: plan.base,
    bundleDigest: await fileDigest(bundle), patches: outcome.records.map(r => ({ original: r.sha, current: r.newSha, result: r.result })) });
  const file = path.join(directory, 'candidate.json');
  await fs.writeFile(file, JSON.stringify(candidate, null, 2));
  return fileDigest(file);
}

/** Only explicit, digest-bound refs enter a fresh repository; publisher never checks out source. */
export async function importCandidate(directory: string, expectedDigest: string, destination: string, bare = false): Promise<{ git: Git; candidate: Candidate; plan: RebasePlan }> {
  const candidate = candidateSchema.parse(await readBoundJson(path.join(directory, 'candidate.json'), expectedDigest));
  const bundle = path.resolve(directory, 'candidate.bundle');
  if (await fileDigest(bundle) !== candidate.bundleDigest) throw new AutopatchError('FAILED_TAMPERED', 'candidate bundle digest mismatch');
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length) throw new Error('candidate import requires an empty directory');
  const git = new Git(destination);
  await git.run(['init', '-q', ...(bare ? ['--bare'] : [])]);
  for (const branch of [candidate.branch, candidate.upstreamBranch]) await git.run(['check-ref-format', '--branch', branch]);
  const refs = { original: candidate.originalSha, upstream: candidate.upstreamSha, base: candidate.baseSha, head: candidate.headSha };
  const expectedHeads = Object.entries(refs).map(([name, value]) => `${value} refs/autopatch/candidate/${name}`).sort();
  const heads = (await git.lines(['bundle', 'list-heads', bundle])).sort();
  if (JSON.stringify(heads) !== JSON.stringify(expectedHeads)) throw new AutopatchError('FAILED_TAMPERED', 'unexpected refs in candidate bundle');
  await git.run(['bundle', 'verify', bundle]);
  await git.run(['fetch', '--no-tags', bundle, ...Object.keys(refs).map(n => `refs/autopatch/candidate/${n}:refs/autopatch/candidate/${n}`)]);
  if (await git.tree(candidate.headSha) !== candidate.treeSha || !(await git.isAncestor(candidate.upstreamSha, candidate.headSha))) {
    throw new AutopatchError('FAILED_GATE', 'candidate tree or upstream ancestry is invalid');
  }
  const bases = await git.mergeBases(candidate.originalSha, candidate.upstreamSha);
  if (bases.length !== 1 || bases[0] !== candidate.baseSha) throw new AutopatchError('FAILED_GATE', 'candidate has an invalid original merge base');
  if (candidate.checkpointSha && !(await git.isAncestor(candidate.checkpointSha, candidate.upstreamSha))) throw new AutopatchError('FAILED_PLAN', 'upstream rewrote its checkpoint');
  const originals = await git.lines(['rev-list', '--reverse', `${candidate.baseSha}..${candidate.originalSha}`]);
  const survivors = candidate.patches.filter(p => p.result === 'applied' || p.result === 'rerere');
  const actual = await git.lines(['rev-list', '--reverse', `${candidate.upstreamSha}..${candidate.headSha}`]);
  if (JSON.stringify(originals) !== JSON.stringify(candidate.patches.map(p => p.original)) ||
    JSON.stringify(actual) !== JSON.stringify(survivors.map(p => p.current)) || candidate.patches.some(p => (p.current !== null) !== survivors.includes(p))) {
    throw new AutopatchError('FAILED_GATE', 'candidate patch accounting or ordering is invalid');
  }
  for (const range of [`${candidate.baseSha}..${candidate.originalSha}`, `${candidate.upstreamSha}..${candidate.headSha}`]) {
    if ((await git.lines(['rev-list', '--merges', range])).length) throw new AutopatchError('FAILED_GATE', 'candidate patch series contains merges');
  }
  if (!bare) await git.run(['checkout', '-q', '--detach', candidate.headSha]);
  const patches = await Promise.all(candidate.patches.map(async p => ({ sha: p.original,
    subject: await git.out(['show', '-s', '--format=%s', p.original]), author: await git.out(['show', '-s', '--format=%an', p.original]), absorbed: p.result === 'absorbed' })));
  const plan: RebasePlan = { kind: 'rebase', branch: candidate.branch, upstreamBranch: candidate.upstreamBranch,
    upstreamRef: 'refs/autopatch/candidate/upstream', branchSha: candidate.originalSha, upstreamSha: candidate.upstreamSha, base: candidate.baseSha,
    patches, expectedSurvivors: survivors.length, upstreamCommits: await git.revListCount(`${candidate.baseSha}..${candidate.upstreamSha}`), workflowPaths: [] };
  return { git, candidate, plan };
}
