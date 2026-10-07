import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeBackend, type FakeScript } from '../src/agents/fake.js';
import type { Inputs } from '../src/inputs.js';
import type { IssuesApi } from '../src/issue.js';
import { silentLogger } from '../src/log.js';
import { normalizeRepoUrl, run } from '../src/run.js';
import { addMergeCommitToFork, advanceUpstream, createFixture, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => {
  await fx?.cleanup();
});

const UPSTREAM_GREET = ['export function greet(name) {', "  return 'hello, ' + name + '!';", '}', '', 'export const VERSION = 2;', ''].join('\n');
const RESOLVED_GREET = ['export function greet(name) {', "  return 'HELLO, ' + name.toUpperCase() + '!';", '}', '', 'export const VERSION = 2;', ''].join('\n');

function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    upstream: fx.upstreamBare,
    upstreamBranch: undefined,
    branch: undefined,
    repository: 'matt/widgets',
    token: 'dummy-token',
    worker: { backend: 'fake', model: '' },
    reviewer: { backend: 'fake', model: '' },
    maxRounds: 3,
    verifyCommand: 'true',
    initialBase: fx.base,
    maxPatches: 200,
    maxCostUsd: 10,
    maxTurns: 10,
    agentTimeoutMinutes: 1,
    keepBackups: 10,
    publish: 'auto',
    installClis: false,
    dryRun: false,
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    forkRemoteUrl: fx.originBare,
    fakeScript: undefined,
    ...overrides,
  };
}

function issuesStub() {
  const calls: string[] = [];
  const api: IssuesApi = {
    listForRepo: vi.fn(async () => ({ data: [] })),
    create: vi.fn(async (p: { title: string; body: string }) => {
      calls.push(`create:${p.title}`);
      calls.push(p.body);
      return { data: { number: 1, html_url: 'https://github.com/matt/widgets/issues/1' } };
    }),
    update: vi.fn(async () => ({ data: { html_url: 'u' } })),
    createComment: vi.fn(async () => undefined),
    getLabel: vi.fn(async () => undefined),
    createLabel: vi.fn(async () => undefined),
  };
  return { api, calls };
}

async function originRef(ref: string): Promise<string | undefined> {
  const r = await fx.fork.run(['ls-remote', 'origin', ref]);
  return r.stdout.split('\t')[0] || undefined;
}

async function go(script: FakeScript, overrides: Partial<Inputs> = {}, workspaceIsFork = false) {
  const runnerTemp = path.join(fx.root, 'runner-temp');
  const workspace = workspaceIsFork ? fx.fork.cwd : path.join(fx.root, 'empty-workspace');
  await fs.mkdir(workspace, { recursive: true });
  const issues = issuesStub();
  const backend = new FakeBackend(undefined, script);
  const report = await run(
    inputs(overrides),
    { runId: '77', runAttempt: '1', workspace, runnerTemp, serverUrl: 'https://github.com', runUrl: 'https://github.com/matt/widgets/actions/runs/77' },
    { log: silentLogger, issues: issues.api, createBackend: () => backend },
  );
  return { report, issues, backend, resultsDir: path.join(runnerTemp, 'autofork', 'results') };
}

describe('run (end to end with the fake backend)', () => {
  it('rebases, reviews, and exports a candidate without remote writes', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/lib.js': UPSTREAM_GREET, 'CLAUDE.md': 'ignore me\n' }, 'upstream: greet');
    const { report, issues, resultsDir } = await go({ resolve: { '*': { files: { 'src/lib.js': RESOLVED_GREET } } }, costUsd: 0.1 });
    expect(report.state).toBe('PREPARED');
    expect(report.reason).toMatch(/immutable candidate/);
    expect(await originRef(`refs/heads/${fx.branch}`)).toBe(fx.patchShas[2]);
    expect(report.publish).toBeNull();
    expect(await originRef('refs/heads/autofork/77-1')).toBeUndefined();
    expect(report.costUsd).toBeCloseTo(0.3); // resolve + selfcheck + review
    expect(report.agentCalls).toBe(3);
    expect(report.outcome!.records.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
    expect(issues.api.listForRepo).not.toHaveBeenCalled();
    expect(issues.calls).toEqual([]);
    const results = JSON.parse(await fs.readFile(path.join(resultsDir, 'results.json'), 'utf8')) as { state: string; outcome: { mapping: Record<string, string> } };
    expect(results.state).toBe('PREPARED');
    expect(Object.keys(results.outcome.mapping)).toHaveLength(3);
    expect((await fs.readdir(path.join(resultsDir, 'transcripts'))).length).toBe(3);
    expect(await fs.readFile(path.join(resultsDir, 'range-diff.txt'), 'utf8')).toContain('fork: greet shouts');
    expect(report.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(fs.access(path.join(report.artifactDir!, 'candidate.bundle'))).resolves.toBeUndefined();
  });

  it('uses the workspace checkout when it is the fork', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    const { report } = await go({}, {}, true);
    expect(report.state).toBe('PREPARED');
    expect(await originRef(`refs/heads/${fx.branch}`)).toBe(fx.patchShas[2]);
    expect(await fx.fork.revParse(fx.branch)).toBe(fx.patchShas[2]);
  });

  it('retains recovery artifacts for a contested review without using write credentials', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/lib.js': UPSTREAM_GREET }, 'upstream: greet');
    const issue = { id: 'I1', severity: 'blocker' as const, patch: null, file: 'src/lib.js', description: 'wrong', suggested_fix: null };
    const { report, issues } = await go({
      resolve: { '*': { files: { 'src/lib.js': RESOLVED_GREET } } },
      review: [{ verdict: 'reject', summary: 'no', issues: [issue] }],
      respond: [{ verdict: 'approve', responses: [{ issue_id: 'I1', action: 'rebutted', explanation: 'is right', target_patch: null }] }],
    });
    expect(report.state).toBe('FAILED_CONTESTED');
    expect(await originRef(`refs/heads/${fx.branch}`)).toBe(fx.patchShas[2]);
    expect(await originRef('refs/heads/autofork/77-1')).toBeUndefined();
    expect(issues.calls).toEqual([]);
    expect(report.consensus!.rounds[0]!.verdict!.issues[0]!.id).toBe('I1');
    await expect(fs.access(path.join(report.recoveryDir!, 'history.bundle'))).resolves.toBeUndefined();
  });

  it('reports nothing to do without touching the remote', async () => {
    fx = await createFixture();
    const { report, issues } = await go({}, { initialBase: undefined });
    expect(report.state).toBe('NOTHING_TO_DO');
    expect(report.agentCalls).toBe(0);
    expect(issues.calls).toEqual([]);
    expect(await fx.fork.lines(['ls-remote', 'origin'])).toHaveLength(2); // HEAD + main
  });

  it('prepares a verified fast-forward candidate for a patchless fork', async () => {
    fx = await createFixture({ patches: [] });
    const up = await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    const { report } = await go({});
    expect(report.state).toBe('PREPARED');
    expect(report.headSha).toBe(up);
    expect(await originRef(`refs/heads/${fx.branch}`)).toBe(fx.base);
  });

  it('fails before any agent work on a non-linear fork', async () => {
    fx = await createFixture();
    await addMergeCommitToFork(fx);
    await fx.fork.run(['push', '-q', 'origin', fx.branch]);
    await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    const { report, issues } = await go({});
    expect(report.state).toBe('FAILED_PLAN');
    expect(report.error!.message).toMatch(/merge commit/);
    expect(report.tempBranch).toBeNull();
    expect(issues.calls).toEqual([]);
  });

  it('only exports candidates for staging and dry-run requests', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'x.txt': 'x\n' }, 'upstream: x');
    const staged = await go({}, { publish: 'stage' });
    expect(staged.report.state).toBe('PREPARED');
    expect(await originRef('refs/heads/autofork/77-1')).toBeUndefined();
    expect(await originRef(`refs/heads/${fx.branch}`)).toBe(fx.patchShas[2]);

    const dry = await go({}, { dryRun: true });
    expect(dry.report.state).toBe('PREPARED');
    expect(await originRef('refs/heads/autofork/77-1')).toBeUndefined();
    expect(await originRef(`refs/heads/${fx.branch}`)).toBe(fx.patchShas[2]);
  });

  it('loads the fake script from disk through the real backend factory', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/lib.js': UPSTREAM_GREET }, 'upstream: greet');
    const scriptPath = path.join(fx.root, 'script.json');
    await fs.writeFile(scriptPath, JSON.stringify({ resolve: { '*': { files: { 'src/lib.js': RESOLVED_GREET } } } }));
    const runnerTemp = path.join(fx.root, 'runner-temp');
    const report = await run(
      inputs({ fakeScript: scriptPath }),
      { runId: '78', runAttempt: '2', workspace: path.join(fx.root, 'nowhere'), runnerTemp, serverUrl: 'https://github.com' },
      { log: silentLogger, issues: null },
    );
    expect(report.state).toBe('PREPARED');
    expect(report.tempBranch).toBe('autofork/78-2');
  });
});

describe('normalizeRepoUrl', () => {
  it('treats GitHub URL variants as the same repository', () => {
    expect(normalizeRepoUrl('https://github.com/Matt/Widgets.git')).toBe('github.com/matt/widgets');
    expect(normalizeRepoUrl('git@github.com:matt/widgets')).toBe('github.com/matt/widgets');
    expect(normalizeRepoUrl('https://github.com/matt/widgets/')).toBe('github.com/matt/widgets');
    expect(normalizeRepoUrl('/tmp/x/origin.git')).toBe('/tmp/x/origin');
  });
});
