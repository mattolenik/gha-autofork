import { afterEach, describe, expect, it } from 'vitest';
import { AutopatchError } from '../src/errors.js';
import { computePlan, resolveBranches } from '../src/plan.js';
import {
  absorbPatchUpstream,
  addMergeCommitToFork,
  advanceUpstream,
  createFixture,
  fetchUpstream,
  makeCrissCross,
  type Fixture,
} from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => {
  await fx?.cleanup();
});

async function fail(p: Promise<unknown>): Promise<AutopatchError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AutopatchError) return e;
    throw e;
  }
  throw new Error('expected an AutopatchError');
}

describe('resolveBranches', () => {
  it('detects both default branches from the remotes', async () => {
    fx = await createFixture({ branch: 'trunk' });
    const r = await resolveBranches(fx.fork, {});
    expect(r).toEqual({ branch: 'trunk', upstreamBranch: 'trunk' });
  });

  it('prefers explicit inputs', async () => {
    fx = await createFixture();
    const r = await resolveBranches(fx.fork, { branch: 'main', upstreamBranch: 'develop' });
    expect(r).toEqual({ branch: 'main', upstreamBranch: 'develop' });
  });
});

describe('computePlan', () => {
  const opts = { branch: 'main', upstreamBranch: 'main', maxPatches: 200 };

  it('reports nothing to do when upstream has not moved', async () => {
    fx = await createFixture();
    const plan = await computePlan(fx.fork, opts);
    expect(plan.kind).toBe('nothing_to_do');
    if (plan.kind !== 'nothing_to_do') return;
    expect(plan.patches).toHaveLength(3);
  });

  it('plans a rebase with the patch series when upstream moved', async () => {
    fx = await createFixture();
    const up = await advanceUpstream(fx, { 'src/new.js': 'export const x = 1;\n' }, 'upstream: add new.js');
    await fetchUpstream(fx);
    const plan = await computePlan(fx.fork, opts);
    expect(plan.kind).toBe('rebase');
    if (plan.kind !== 'rebase') return;
    expect(plan.base).toBe(fx.base);
    expect(plan.upstreamSha).toBe(up);
    expect(plan.branchSha).toBe(fx.patchShas[2]);
    expect(plan.patches.map((p) => p.sha)).toEqual(fx.patchShas);
    expect(plan.patches.map((p) => p.subject)).toEqual(['fork: greet shouts', 'fork: add local notes', 'fork: clamp accepts strings']);
    expect(plan.patches.every((p) => !p.absorbed)).toBe(true);
    expect(plan.expectedSurvivors).toBe(3);
    expect(plan.upstreamCommits).toBe(1);
    expect(plan.workflowPaths).toEqual([]);
  });

  it('marks patches already applied upstream as absorbed', async () => {
    fx = await createFixture();
    await absorbPatchUpstream(fx, fx.patchShas[1] as string);
    await fetchUpstream(fx);
    const plan = await computePlan(fx.fork, opts);
    expect(plan.kind).toBe('rebase');
    if (plan.kind !== 'rebase') return;
    expect(plan.patches.map((p) => p.absorbed)).toEqual([false, true, false]);
    expect(plan.expectedSurvivors).toBe(2);
  });

  it('flags workflow files touched by patches or upstream', async () => {
    fx = await createFixture({
      patches: [{ message: 'fork: add autopatch workflow', files: { '.github/workflows/autopatch.yml': 'on: schedule\n' } }],
    });
    await advanceUpstream(fx, { '.github/workflows/ci.yml': 'on: push\n' }, 'upstream: ci');
    await fetchUpstream(fx);
    const plan = await computePlan(fx.fork, opts);
    expect(plan.kind).toBe('rebase');
    if (plan.kind !== 'rebase') return;
    expect(plan.workflowPaths).toEqual(['.github/workflows/autopatch.yml', '.github/workflows/ci.yml']);
  });

  it('fast-forwards when the fork carries no patches', async () => {
    fx = await createFixture({ patches: [] });
    const up = await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    await fetchUpstream(fx);
    const plan = await computePlan(fx.fork, opts);
    expect(plan.kind).toBe('fast_forward');
    if (plan.kind !== 'fast_forward') return;
    expect(plan.upstreamSha).toBe(up);
    expect(plan.branchSha).toBe(fx.base);
  });

  it('reports nothing to do when fork equals upstream', async () => {
    fx = await createFixture({ patches: [] });
    const plan = await computePlan(fx.fork, opts);
    expect(plan.kind).toBe('nothing_to_do');
  });

  it('fails on merge commits in the series', async () => {
    fx = await createFixture();
    await addMergeCommitToFork(fx);
    await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    await fetchUpstream(fx);
    const err = await fail(computePlan(fx.fork, opts));
    expect(err.state).toBe('FAILED_PLAN');
    expect(err.message).toMatch(/merge commit/);
    expect(err.message).toMatch(/git rebase --onto upstream\/main/);
    expect(err.details).toHaveLength(1);
  });

  it('fails on criss-cross merge bases', async () => {
    fx = await createFixture({ patches: [] });
    await makeCrissCross(fx);
    const err = await fail(computePlan(fx.fork, opts));
    expect(err.state).toBe('FAILED_PLAN');
    expect(err.message).toMatch(/2 merge bases/);
  });

  it('fails on unrelated histories', async () => {
    fx = await createFixture();
    const u = fx.upstreamWork;
    await u.run(['checkout', '-q', '--orphan', 'rewrite']);
    await u.run(['rm', '-rfq', '.']);
    await u.run(['commit', '-q', '--allow-empty', '-m', 'history rewritten']);
    await u.run(['push', '-q', '--force', 'origin', 'rewrite:main']);
    await fetchUpstream(fx);
    const err = await fail(computePlan(fx.fork, opts));
    expect(err.message).toMatch(/unrelated histories/);
  });

  it('fails when the series exceeds max_patches', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    await fetchUpstream(fx);
    const err = await fail(computePlan(fx.fork, { ...opts, maxPatches: 2 }));
    expect(err.message).toMatch(/3 commits over upstream, above max_patches=2/);
  });

  it('fails clearly when the upstream branch was not fetched', async () => {
    fx = await createFixture();
    const err = await fail(computePlan(fx.fork, { ...opts, upstreamBranch: 'develop' }));
    expect(err.message).toMatch(/was not fetched/);
  });
});
