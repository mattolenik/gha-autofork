import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../src/agents/fake.js';
import { Git } from '../src/git.js';
import type { Inputs } from '../src/inputs.js';
import { silentLogger } from '../src/log.js';
import { restoreRecovery } from '../src/recovery.js';
import { renderSummary } from '../src/report.js';
import { run } from '../src/run.js';
import { advanceUpstream, createFixture, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => { await fx?.cleanup(); });
const upLib = 'export function greet(name) { return "upstream " + name; }\n';
const upUtil = 'export const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));\n';
const fixedLib = 'export function greet(name) { return "UPSTREAM " + name.toUpperCase(); }\n';
const fixedUtil = 'export const clamp = (v, lo, hi) => Math.max(lo, Math.min(Number(v), hi));\n';

function inputs(): Inputs {
  return { phase: 'prepare', repository: 'owner/fork', upstream: fx.upstreamBare, token: 'dummy', branch: 'main', upstreamBranch: 'main',
    worker: { backend: 'fake', model: '' }, reviewer: undefined, maxRounds: 1, maxPatches: 200, maxCostUsd: 10, maxTurns: 10,
    agentTimeoutMinutes: 1, keepBackups: 10, verifyCommand: undefined, publish: 'stage', installClis: false, dryRun: false,
    forkRemoteUrl: fx.originBare, anthropicApiKey: undefined, openaiApiKey: undefined, fakeScript: undefined };
}

describe('portable recovery checkpoints', () => {
  it.each([0, 1, 2])('resumes a failure at patch %i and retains the entire series', async index => {
    fx = await createFixture();
    const upstreamFiles = [{ 'src/lib.js': upLib }, { 'NOTES.fork.md': 'upstream notes\n' }, { 'src/util.js': upUtil }][index]!;
    const replacements = [{ 'src/lib.js': fixedLib }, { 'NOTES.fork.md': 'combined notes\n' }, { 'src/util.js': fixedUtil }][index]!;
    const upstream = await advanceUpstream(fx, upstreamFiles, 'upstream');
    const report = await run(inputs(), { workspace: fx.fork.cwd, runnerTemp: path.join(fx.root, 'runner'), runId: '123', runAttempt: '1', serverUrl: 'https://github.com' },
      { log: silentLogger, createBackend: () => new FakeBackend(undefined, {}) });
    expect(report.state, report.reason).toBe('FAILED_REBASE');
    const summary = renderSummary(report, { forIssue: true });
    expect(summary).toContain('Resume an incomplete rebase');
    expect(summary).not.toContain('git push --force-with-lease');
    const checkpoint = JSON.parse(await fs.readFile(path.join(report.recoveryDir!, 'recovery.json'), 'utf8')) as { pending: string[] };
    expect(checkpoint.pending).toEqual(fx.patchShas.slice(index));
    const destination = path.join(fx.root, 'rescued');
    await restoreRecovery(report.recoveryDir!, destination, fx.originBare);
    const git = new Git(destination);
    expect(await git.revParse('REBASE_HEAD')).toBe(fx.patchShas[index]);
    for (const [file, content] of Object.entries(replacements)) {
      await fs.writeFile(path.join(destination, file), content!);
      await git.run(['add', '--', file]);
    }
    await git.run(['rebase', '--continue']);
    expect(await git.revListCount(`${upstream}..HEAD`)).toBe(3);
    expect(await git.statusPorcelain()).toEqual([]);
    expect(await git.out(['log', '--format=%s', `${upstream}..HEAD`])).toContain('fork: greet shouts');
  });

  it('preserves an earlier resolution when a later conflict fails', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/lib.js': upLib, 'src/util.js': upUtil }, 'upstream');
    const report = await run(inputs(), { workspace: fx.fork.cwd, runnerTemp: path.join(fx.root, 'runner'), runId: '123', runAttempt: '1', serverUrl: 'https://github.com' },
      { log: silentLogger, createBackend: () => new FakeBackend(undefined, { resolve: { 'fork: greet shouts': { files: { 'src/lib.js': fixedLib } } } }) });
    expect(report.state, report.reason).toBe('FAILED_REBASE');
    const destination = path.join(fx.root, 'rescued');
    await restoreRecovery(report.recoveryDir!, destination, fx.originBare);
    expect(await fs.readFile(path.join(destination, 'src/lib.js'), 'utf8')).toBe(fixedLib);
    expect(await new Git(destination).revParse('REBASE_HEAD')).toBe(fx.patchShas[2]);
  });
});
