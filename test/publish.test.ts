import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import {
  backupRefName,
  classifyPushError,
  listBackups,
  listLeftoverBranches,
  publishBranch,
  pushTempBranch,
  tempBranchName,
  type PublishContext,
} from '../src/publish.js';
import { advanceUpstream, commitFiles, createFixture, fetchUpstream, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => {
  await fx?.cleanup();
});

function ctx(overrides: Partial<PublishContext> = {}): PublishContext {
  return { git: fx.fork, branch: fx.branch, leaseSha: fx.patchShas[2]!, runId: '123', dryRun: false, log: silentLogger, ...overrides };
}

async function originSha(ref: string): Promise<string | undefined> {
  const r = await fx.fork.run(['ls-remote', 'origin', ref]);
  return r.stdout.split('\t')[0] || undefined;
}

describe('publish', () => {
  it('names temp branches and backup refs', () => {
    expect(tempBranchName('42', '1')).toBe('autopatch/42-1');
    expect(backupRefName('main', '42', new Date('2026-10-05T12:00:00Z'))).toBe('refs/autopatch/backup/20261005-42/main');
  });

  it('pushes the temp branch, backs up, force-pushes with a lease, and cleans up', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    await fetchUpstream(fx);
    // pretend we rebased: a new commit on top of upstream in the fork checkout
    await fx.fork.run(['checkout', '-q', '--detach', `upstream/${fx.branch}`]);
    const head = await commitFiles(fx.fork, { 'NOTES.fork.md': 'rebased\n' }, 'fork: rebased');
    const temp = tempBranchName('123', '1');

    await pushTempBranch(ctx(), head, temp);
    expect(await originSha(`refs/heads/${temp}`)).toBe(head);

    const result = await publishBranch(ctx(), head, temp, 10);
    expect(result.pushed).toBe(true);
    expect(await originSha(`refs/heads/${fx.branch}`)).toBe(head);
    expect(await originSha(result.backupRef)).toBe(fx.patchShas[2]);
    expect(await originSha(`refs/heads/${temp}`)).toBeUndefined();
    expect(await listBackups(fx.fork, fx.branch)).toEqual([result.backupRef]);
  });

  it('refuses to publish when the branch moved on the remote', async () => {
    fx = await createFixture();
    const head = await commitFiles(fx.fork, { 'a.txt': 'a\n' }, 'fork: local');
    // someone else pushes to origin first
    await fx.upstreamWork.run(['fetch', '-q', fx.originBare, `refs/heads/${fx.branch}:refs/heads/other`]);
    await fx.upstreamWork.run(['checkout', '-q', 'other']);
    await commitFiles(fx.upstreamWork, { 'b.txt': 'b\n' }, 'someone else');
    await fx.upstreamWork.run(['push', '-q', fx.originBare, `other:${fx.branch}`]);

    await expect(publishBranch(ctx(), head, 'autopatch/123-1', 10)).rejects.toMatchObject({ state: 'FAILED_PUBLISH', message: expect.stringMatching(/branch moved/) });
    // The atomic transaction creates no backup when the branch lease fails.
    expect(await originSha(`refs/heads/${fx.branch}`)).not.toBe(head);
    expect(await listBackups(fx.fork, fx.branch)).toEqual([]);
  });

  it('prunes old backups beyond keep_backups', async () => {
    fx = await createFixture();
    for (const d of ['20260101', '20260108', '20260115']) {
      await fx.fork.run(['push', '-q', 'origin', `${fx.base}:refs/autopatch/backup/${d}-1/${fx.branch}`]);
    }
    const head = await commitFiles(fx.fork, { 'a.txt': 'a\n' }, 'fork: local');
    const result = await publishBranch(ctx(), head, 'autopatch/123-1', 2);
    expect(result.prunedBackups).toEqual([`refs/autopatch/backup/20260101-1/${fx.branch}`, `refs/autopatch/backup/20260108-1/${fx.branch}`]);
    expect(await listBackups(fx.fork, fx.branch)).toEqual([`refs/autopatch/backup/20260115-1/${fx.branch}`, result.backupRef]);
  });

  it('does nothing in dry run', async () => {
    fx = await createFixture();
    const head = await commitFiles(fx.fork, { 'a.txt': 'a\n' }, 'fork: local');
    await pushTempBranch(ctx({ dryRun: true }), head, 'autopatch/123-1');
    const r = await publishBranch(ctx({ dryRun: true }), head, 'autopatch/123-1', 10);
    expect(r.pushed).toBe(false);
    expect(await originSha(`refs/heads/${fx.branch}`)).toBe(fx.patchShas[2]);
    expect(await originSha('refs/heads/autopatch/123-1')).toBeUndefined();
  });

  it('lists leftover temp branches from other runs', async () => {
    fx = await createFixture();
    await fx.fork.run(['push', '-q', 'origin', `${fx.base}:refs/heads/autopatch/1-1`, `${fx.base}:refs/heads/autopatch/2-1`, `${fx.base}:refs/heads/feature`]);
    expect(await listLeftoverBranches(fx.fork, 'autopatch/2-1')).toEqual(['autopatch/1-1']);
  });

  it('maps push errors to actionable messages', () => {
    const wf = classifyPushError(['push'], '! [remote rejected] HEAD -> main (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)');
    expect(wf.message).toMatch(/Workflows.*permission/);
    const lease = classifyPushError(['push'], '! [rejected] abc -> main (stale info)');
    expect(lease.message).toMatch(/branch moved/);
    const prot = classifyPushError(['push'], 'remote: error: GH006: Protected branch update failed');
    expect(prot.message).toMatch(/protection rule/);
    const other = classifyPushError(['push', 'x'], 'fatal: could not read from remote');
    expect(other.message).toMatch(/git push x failed/);
    expect(other.state).toBe('FAILED_PUBLISH');
  });
});
