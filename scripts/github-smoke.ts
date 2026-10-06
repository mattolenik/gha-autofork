import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { Git, authExtraHeader } from '../src/git.js';
import { silentLogger } from '../src/log.js';
import { checkpointRef, fetchCheckpoint, listBackups, publishBranch, pushTempBranch } from '../src/publish.js';

const repository = process.env.SMOKE_REPOSITORY ?? '';
const token = process.env.SMOKE_TOKEN ?? '';
if (!/^[\w.-]+\/autopatch-smoke-[\w.-]+$/.test(repository) || !token) throw new Error('set SMOKE_REPOSITORY to owner/autopatch-smoke-<name> and SMOKE_TOKEN');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch-github-smoke-'));
const url = `https://github.com/${repository}.git`;
const id = `${Date.now()}`;
const branch = `autopatch-smoke/${id}`;
const temp = `autopatch/${id}-1`;
const git = new Git(root).withConfig(authExtraHeader(token, url));
try {
  await git.run(['init', '-q']);
  await git.ensureRemote('origin', url);
  await git.run(['commit', '--allow-empty', '-qm', 'smoke: base']);
  const old = await git.revParse('HEAD');
  await git.run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
  await fs.writeFile(path.join(root, '.github/workflows/autopatch-smoke.yml'), 'name: smoke\non: workflow_dispatch\njobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n');
  await git.run(['add', '--', '.github/workflows/autopatch-smoke.yml']);
  await git.run(['commit', '-qm', 'smoke: workflows permission']);
  const head = await git.revParse('HEAD');
  const ctx = { git, branch, leaseSha: old, upstreamSha: old, checkpointSha: null, runId: id, dryRun: false, log: silentLogger };
  await pushTempBranch(ctx, head, temp);
  const published = await publishBranch(ctx, head, temp, 2);
  assert.equal(published.pushed, true);
  assert.equal(await fetchCheckpoint(git, branch), old);
  assert.equal((await git.out(['ls-remote', 'origin', `refs/heads/${branch}`])).split('\t')[0], head);
  await git.run(['clone', '--no-checkout', '--single-branch', '--branch', branch, url, path.join(root, 'read-clone')]);
  await assert.rejects(publishBranch({ ...ctx, runId: `${id}-stale`, checkpointSha: old }, old, temp, 2), /branch moved/);
  console.log('GitHub smoke passed: authenticated reads, workflow-file push, atomic backup/checkpoint update, and stale lease rejection.');
} finally {
  const backups = await listBackups(git, branch).catch(() => []);
  for (const ref of [`refs/heads/${branch}`, `refs/heads/${temp}`, checkpointRef(branch), ...backups]) {
    await git.run(['push', 'origin', '--delete', ref], { allowFailure: true });
  }
  await fs.rm(root, { recursive: true, force: true });
}
