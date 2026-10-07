import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { AutoforkError } from './errors.js';
import { Git } from './git.js';
import type { RebasePlan } from './plan.js';
import type { RebaseOutcome } from './rebase.js';
import { assertCandidate, candidateIdentity } from './state.js';
import { fetchBasis, fileDigest, importIncrementalBundle, writeIncrementalBundle } from './bundle.js';
export { fileDigest } from './bundle.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const candidateSchema = z.object({
  version: z.literal(2), runId: z.string(), runAttempt: z.string(), repository: z.string(), upstream: z.string(),
  branch: z.string(), upstreamBranch: z.string(), originalSha: sha, upstreamSha: sha, baseSha: sha,
  checkpointSha: sha.nullable(), headSha: sha, treeSha: sha, bundleDigest: digest.nullable(),
  approval: z.enum(['approved', 'contested']),
  kind: z.enum(['rebase', 'fast_forward']), autoEligible: z.boolean(), verifyCommand: z.string().nullable(),
  patches: z.array(z.object({ original: sha, current: sha.nullable(), result: z.enum(['applied', 'absorbed', 'became_empty', 'skipped']) }).strict()).max(10000),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;

export const verificationSchema = z.object({
  version: z.literal(1), runId: z.string(), runAttempt: z.string(), candidateDigest: digest,
  headSha: sha, treeSha: sha, verifyCommand: z.string().nullable(), passed: z.literal(true),
}).strict();

export async function readBoundJson(file: string, expected: string): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new AutoforkError('FAILED_GATE', 'the producing job must supply the artifact SHA-256 digest');
  if ((await fs.lstat(file)).size > 5 * 1024 * 1024) throw new Error('artifact manifest is too large');
  if (await fileDigest(file) !== expected) throw new AutoforkError('FAILED_TAMPERED', 'artifact digest differs from the producing job output');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

export async function writeCandidate(git: Git, directory: string, plan: RebasePlan, outcome: RebaseOutcome,
  metadata: Pick<Candidate, 'runId' | 'runAttempt' | 'repository' | 'upstream' | 'checkpointSha' | 'kind' | 'autoEligible' | 'verifyCommand' | 'approval'>): Promise<string> {
  const identity = await candidateIdentity(git);
  await assertCandidate(git, { headSha: outcome.headSha, treeSha: identity.treeSha });
  await fs.mkdir(directory, { recursive: true });
  const refs = { 'refs/autofork/candidate/upstream': plan.upstreamSha, 'refs/autofork/candidate/head': identity.headSha };
  const bundle = path.join(directory, 'candidate.bundle');
  const bundleDigest = await writeIncrementalBundle(git, bundle, plan.branchSha, refs);
  const candidate = candidateSchema.parse({ version: 2, ...metadata, ...identity,
    branch: plan.branch, upstreamBranch: plan.upstreamBranch, originalSha: plan.branchSha, upstreamSha: plan.upstreamSha, baseSha: plan.base,
    bundleDigest, patches: outcome.records.map(r => ({ original: r.sha, current: r.newSha, result: r.result })) });
  const file = path.join(directory, 'candidate.json');
  await fs.writeFile(file, JSON.stringify(candidate, null, 2));
  return fileDigest(file);
}

/** Only explicit, digest-bound refs enter a fresh repository; publisher never checks out source. */
export async function importCandidate(directory: string, expectedDigest: string, destination: string,
  options: { source: string; token?: string; bare?: boolean; checkContext?: (candidate: Candidate) => void }): Promise<{ git: Git; candidate: Candidate; plan: RebasePlan }> {
  const candidate = candidateSchema.parse(await readBoundJson(path.join(directory, 'candidate.json'), expectedDigest));
  options.checkContext?.(candidate);
  const bundle = path.resolve(directory, 'candidate.bundle');
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length) throw new Error('candidate import requires an empty directory');
  let git = new Git(destination);
  await git.run(['init', '-q', ...(options.bare ? ['--bare'] : [])]);
  for (const branch of [candidate.branch, candidate.upstreamBranch]) await git.run(['check-ref-format', '--branch', branch]);
  git = await fetchBasis(git, options.source, candidate.originalSha, options.token);
  const refs = { 'refs/autofork/candidate/upstream': candidate.upstreamSha, 'refs/autofork/candidate/head': candidate.headSha };
  await importIncrementalBundle(git, bundle, candidate.bundleDigest, candidate.originalSha, refs);
  if (await git.tree(candidate.headSha) !== candidate.treeSha || !(await git.isAncestor(candidate.upstreamSha, candidate.headSha))) {
    throw new AutoforkError('FAILED_GATE', 'candidate tree or upstream ancestry is invalid');
  }
  const bases = await git.mergeBases(candidate.originalSha, candidate.upstreamSha);
  if (bases.length !== 1 || bases[0] !== candidate.baseSha) throw new AutoforkError('FAILED_GATE', 'candidate has an invalid original merge base');
  if (candidate.checkpointSha && !(await git.isAncestor(candidate.checkpointSha, candidate.upstreamSha))) throw new AutoforkError('FAILED_PLAN', 'upstream rewrote its checkpoint');
  const originals = await git.lines(['rev-list', '--reverse', `${candidate.baseSha}..${candidate.originalSha}`]);
  const survivors = candidate.patches.filter(p => p.result === 'applied');
  const actual = await git.lines(['rev-list', '--reverse', `${candidate.upstreamSha}..${candidate.headSha}`]);
  if (JSON.stringify(originals) !== JSON.stringify(candidate.patches.map(p => p.original)) ||
    JSON.stringify(actual) !== JSON.stringify(survivors.map(p => p.current)) || candidate.patches.some(p => (p.current !== null) !== survivors.includes(p))) {
    throw new AutoforkError('FAILED_GATE', 'candidate patch accounting or ordering is invalid');
  }
  for (const range of [`${candidate.baseSha}..${candidate.originalSha}`, `${candidate.upstreamSha}..${candidate.headSha}`]) {
    if ((await git.lines(['rev-list', '--merges', range])).length) throw new AutoforkError('FAILED_GATE', 'candidate patch series contains merges');
  }
  if (!options.bare) await git.run(['checkout', '-q', '--detach', candidate.headSha]);
  const descriptions = await git.lines(['log', '--reverse', '--format=%H%x1f%an%x1f%s', `${candidate.baseSha}..${candidate.originalSha}`]);
  const patches = descriptions.map((line, i) => {
    const [sha = '', author = '', ...subject] = line.split('\x1f');
    return { sha, author, subject: subject.join('\x1f'), absorbed: candidate.patches[i]!.result === 'absorbed' };
  });
  const plan: RebasePlan = { kind: 'rebase', branch: candidate.branch, upstreamBranch: candidate.upstreamBranch,
    upstreamRef: 'refs/autofork/candidate/upstream', branchSha: candidate.originalSha, upstreamSha: candidate.upstreamSha, base: candidate.baseSha,
    patches, expectedSurvivors: survivors.length, upstreamCommits: await git.revListCount(`${candidate.baseSha}..${candidate.upstreamSha}`), workflowPaths: [] };
  return { git, candidate, plan };
}
