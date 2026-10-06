import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeCandidate, importCandidate } from '../src/candidate.js';
import { defaultGitTimeout, Git } from '../src/git.js';
import { saveRecovery, restoreRecovery } from '../src/recovery.js';
import { guardGit, gitState } from '../src/state.js';
import { prepare } from './harness.js';
import { advanceUpstream, createFixture, UPSTREAM_INITIAL, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => { await fx?.cleanup(); });

describe('bounded orchestration overhead', () => {
  it('uses one Git subprocess for each warm metadata snapshot and detects packed-ref edits', async () => {
    fx = await createFixture();
    await fx.fork.run(['pack-refs', '--all']);
    await fx.fork.layout();
    const spy = vi.spyOn(fx.fork, 'run');
    await gitState(fx.fork);
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(guardGit(fx.fork, 'edit', 'worker', async () => {
      await fs.appendFile(path.join(await fx.fork.commonDir(), 'packed-refs'), `\n${fx.base} refs/heads/injected\n`);
    })).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
  });

  it('bundles deltas rather than a large unchanged base', async () => {
    fx = await createFixture({ upstreamInitial: { ...UPSTREAM_INITIAL, 'large.dat': randomBytes(512 * 1024).toString('base64') } });
    await advanceUpstream(fx, { 'new.txt': 'new\n' }, 'upstream');
    const h = await prepare(fx, {});
    const outcome = await h.run();
    const dir = path.join(fx.root, 'candidate');
    const digest = await writeCandidate(h.wt, dir, h.plan, outcome, { runId: '1', runAttempt: '1', repository: 'o/r', upstream: 'o/up',
      checkpointSha: null, kind: 'rebase', autoEligible: true, verifyCommand: null, approval: 'approved' });
    expect((await fs.stat(path.join(dir, 'candidate.bundle'))).size).toBeLessThan(64 * 1024);
    const imported = await importCandidate(dir, digest, path.join(fx.root, 'imported'), { source: fx.originBare });
    expect(await imported.git.tree()).toBe(await h.wt.tree());
    expect(await fs.readFile(path.join(imported.git.cwd, 'large.dat'), 'utf8')).toBe(await fs.readFile(path.join(h.wtDir, 'large.dat'), 'utf8'));
  });

  it('also detects ref changes in a reftable repository', async () => {
    fx = await createFixture();
    const directory = path.join(fx.root, 'reftable');
    await fs.mkdir(directory);
    const git = new Git(directory);
    await git.run(['init', '-q', '--initial-branch=main', '--ref-format=reftable']);
    await git.run(['commit', '--allow-empty', '-qm', 'base']);
    await expect(guardGit(git, 'edit', 'worker', async () => {
      await git.run(['update-ref', 'refs/heads/rogue', 'HEAD']);
    })).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
  });

  it('checkpoints only dirty paths and restores distinct staged and unstaged content', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/lib.js': 'upstream greeting\n' }, 'upstream');
    const h = await prepare(fx, {});
    expect((await h.wt.run(['rebase', h.plan.upstreamSha, '--empty=stop'], { allowFailure: true })).code).not.toBe(0);
    await fs.writeFile(path.join(h.wtDir, 'src/lib.js'), 'staged resolution\n');
    await fs.writeFile(path.join(h.wtDir, 'new.bin'), Buffer.from([0, 1, 2, 3]));
    await h.wt.run(['add', '--', 'src/lib.js', 'new.bin']);
    await fs.appendFile(path.join(h.wtDir, 'src/lib.js'), 'unstaged addition\n');
    await fs.writeFile(path.join(h.wtDir, 'scratch.txt'), 'untracked\n');
    const dest = path.join(fx.root, 'recovery');
    await saveRecovery(h.wt, h.plan, dest, [], fx.patchShas[0]!);
    const metadata = JSON.parse(await fs.readFile(path.join(dest, 'recovery.json'), 'utf8')) as { files: { path: string }[]; index: string };
    expect(metadata.files.map(f => f.path).sort()).toEqual(['new.bin', 'scratch.txt', 'src/lib.js']);
    expect(metadata.index).not.toContain('README.md');
    const spy = vi.spyOn(h.wt, 'run');
    await saveRecovery(h.wt, h.plan, dest, [], fx.patchShas[0]!);
    expect(spy.mock.calls.some(([args]) => args[0] === 'bundle')).toBe(false);
    const restored = path.join(fx.root, 'restored');
    await restoreRecovery(dest, restored, fx.originBare);
    const git = new Git(restored);
    expect(await git.out(['show', ':src/lib.js'])).toBe('staged resolution');
    expect(await fs.readFile(path.join(restored, 'src/lib.js'), 'utf8')).toBe('staged resolution\nunstaged addition\n');
    expect(await fs.readFile(path.join(restored, 'new.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(await fs.readFile(path.join(restored, 'README.md'), 'utf8')).toContain('widgets');
    await git.run(['fsck', '--no-reflogs']);
  });

  it('leaves network and bundle operations to the job deadline', () => {
    for (const command of ['clone', 'fetch', 'push', 'bundle']) expect(defaultGitTimeout([command])).toBe(0);
    expect(defaultGitTimeout(['status'])).toBe(300000);
  });
});
