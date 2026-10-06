import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../src/agents/fake.js';
import { CodexBackend } from '../src/agents/codex.js';
import { fileDigest } from '../src/candidate.js';
import type { Inputs } from '../src/inputs.js';
import { silentLogger } from '../src/log.js';
import { runPhase } from '../src/phases.js';
import { checkpointRef, publishBranch } from '../src/publish.js';
import { run, type RunEnv } from '../src/run.js';
import { advanceUpstream, commitFiles, createFixture, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => { await fx?.cleanup(); });
const log = silentLogger;
function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return { phase: 'prepare', repository: 'owner/fork', upstream: fx.upstreamBare, token: 'dummy', branch: 'main', upstreamBranch: 'main',
    worker: { backend: 'fake', model: '' }, reviewer: { backend: 'fake', model: '' }, initialBase: fx.base,
    maxRounds: 1, maxPatches: 200, maxCostUsd: 10, maxTurns: 10, agentTimeoutMinutes: 1, keepBackups: 10,
    verifyCommand: 'true', publish: 'auto', installClis: false, dryRun: false, sandbox: false,
    forkRemoteUrl: fx.originBare, anthropicApiKey: undefined, openaiApiKey: undefined, fakeScript: undefined, ...overrides };
}
function env(): RunEnv { return { workspace: fx.fork.cwd, runnerTemp: path.join(fx.root, 'runner'), runId: '123', runAttempt: '1', serverUrl: 'https://github.com' }; }
const originSha = async () => (await fx.fork.out(['ls-remote', 'origin', 'refs/heads/main'])).split('\t')[0];

async function prepareCandidate(overrides: Partial<Inputs> = {}) {
  await advanceUpstream(fx, { 'upstream.txt': 'new\n' }, 'upstream');
  const i = inputs(overrides);
  const prepared = await run(i, env(), { log, createBackend: () => new FakeBackend(undefined, {}) });
  expect(prepared.state, prepared.reason).toBe('PREPARED');
  const next = { ...i, artifactDir: prepared.artifactDir!, candidateDigest: prepared.artifactDigest! };
  return { prepared, next };
}

describe('isolated phases', () => {
  it.each([false, true])('prepares, verifies, and atomically publishes (patchless=%s)', async patchless => {
    fx = await createFixture(patchless ? { patches: [] } : {});
    const old = await originSha();
    const { prepared, next } = await prepareCandidate({ sandbox: process.platform === 'linux' });
    expect(await originSha()).toBe(old);
    if (patchless) expect(prepared.agentCalls).toBe(0);
    const verified = await runPhase({ ...next, phase: 'verify' }, env(), { log });
    expect(verified.state, verified.reason).toBe('VERIFIED');
    expect(await originSha()).toBe(old);
    const published = await runPhase({ ...next, phase: 'publish', verificationDir: verified.artifactDir!, verificationDigest: verified.artifactDigest! }, env(), { log });
    expect(published.state, published.reason).toBe(patchless ? 'FAST_FORWARDED' : 'APPROVED');
    expect(await originSha()).toBe(prepared.headSha);
    expect(await fx.fork.out(['ls-remote', 'origin', published.publish!.backupRef])).toContain(old);
    expect(await fx.fork.out(['ls-remote', 'origin', checkpointRef('main')])).toContain(prepared.plan!.kind === 'nothing_to_do' ? '' : prepared.plan!.upstreamSha);
    // Publisher imported objects into a bare repo; it never checked out source.
    await expect(fs.access(path.join(env().runnerTemp, 'autopatch-publish/repo/README.md'))).rejects.toThrow();
  });

  it('initializes an unchanged fork without bundling its existing history', async () => {
    fx = await createFixture();
    const prepared = await run(inputs(), env(), { log, createBackend: () => new FakeBackend(undefined, {}) });
    expect(prepared.state, prepared.reason).toBe('PREPARED');
    expect(prepared.agentCalls).toBe(0); // nothing to replay, so no agent judgement is needed
    expect(prepared.outcome!.records.map((r) => r.newSha)).toEqual(fx.patchShas);
    const manifest = JSON.parse(await fs.readFile(path.join(prepared.artifactDir!, 'candidate.json'), 'utf8')) as { bundleDigest: string | null };
    expect(manifest.bundleDigest).toBeNull();
    const next = { ...inputs(), artifactDir: prepared.artifactDir!, candidateDigest: prepared.artifactDigest! };
    const verified = await runPhase({ ...next, phase: 'verify' }, env(), { log });
    expect(verified.state, verified.reason).toBe('VERIFIED');
    const published = await runPhase({ ...next, phase: 'publish', verificationDir: verified.artifactDir!, verificationDigest: verified.artifactDigest! }, env(), { log });
    expect(published.state, published.reason).toBe('APPROVED');
    expect(await originSha()).toBe(fx.patchShas[2]);
    expect(await fx.fork.out(['ls-remote', 'origin', checkpointRef('main')])).toContain(fx.base);
  });

  it('reuses trusted artifacts across attempts and recognizes an already-completed atomic publication', async () => {
    fx = await createFixture({ patches: [] });
    const { next } = await prepareCandidate({ reviewer: undefined });
    const verified = await runPhase({ ...next, phase: 'verify' }, { ...env(), runAttempt: '2' }, { log });
    expect(verified.state, verified.reason).toBe('VERIFIED');
    const publishInputs = { ...next, phase: 'publish' as const, verificationDir: verified.artifactDir!, verificationDigest: verified.artifactDigest! };
    const first = await runPhase(publishInputs, { ...env(), runAttempt: '3' }, { log });
    expect(first.state, first.reason).toBe('FAST_FORWARDED');
    const refs = await fx.fork.out(['ls-remote', 'origin']);
    const retried = await runPhase(publishInputs, { ...env(), runAttempt: '4' }, { log });
    expect(retried.state, retried.reason).toBe('FAST_FORWARDED');
    expect(retried.reason).toContain('already published');
    expect(retried.publish!.backupRef).toBe(first.publish!.backupRef);
    expect(await fx.fork.out(['ls-remote', 'origin'])).toBe(refs);
    const otherRun = await runPhase(publishInputs, { ...env(), runId: 'another-run' }, { log });
    expect(otherRun.state).toBe('FAILED_TAMPERED');
  });

  it('stages completed contested candidates even when publish=auto is requested', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'upstream.txt': 'new\n' }, 'upstream');
    const failed = await run(inputs(), env(), { log, createBackend: () => new FakeBackend(undefined, { review: [{ verdict: 'reject', summary: 'needs attention' }] }) });
    expect(failed.state).toBe('FAILED_CONTESTED');
    const staged = await runPhase({ ...inputs(), phase: 'publish', artifactDir: failed.artifactDir!, candidateDigest: failed.artifactDigest! }, env(), { log });
    expect(staged.state, staged.reason).toBe('STAGED');
    expect(staged.reason).toContain('contested rescue');
    expect(await originSha()).toBe(fx.patchShas[2]);
    expect(await fx.fork.out(['ls-remote', 'origin', `refs/heads/${staged.tempBranch}`])).toContain(failed.headSha!);
    expect(await fx.fork.out(['ls-remote', 'origin', checkpointRef('main')])).toBe('');
  });

  it.each([{ publish: 'stage' as const }, { verifyCommand: undefined }, { reviewer: undefined }, { initialBase: undefined }])('stages when policy requires it: %j', async overrides => {
    fx = await createFixture();
    const old = await originSha();
    const { next } = await prepareCandidate(overrides);
    const verified = await runPhase({ ...next, phase: 'verify' }, env(), { log });
    const published = await runPhase({ ...next, phase: 'publish', verificationDir: verified.artifactDir!, verificationDigest: verified.artifactDigest! }, env(), { log });
    expect(published.state, published.reason).toBe('STAGED');
    expect(await originSha()).toBe(old);
    expect(await fx.fork.out(['ls-remote', 'origin', checkpointRef('main')])).toBe('');
  });

  it('dry-run changes no remote refs through all three phases', async () => {
    fx = await createFixture();
    const old = await fx.fork.out(['ls-remote', 'origin']);
    const { next } = await prepareCandidate({ dryRun: true });
    const verified = await runPhase({ ...next, phase: 'verify' }, env(), { log });
    const result = await runPhase({ ...next, phase: 'publish', verificationDir: verified.artifactDir!, verificationDigest: verified.artifactDigest! }, env(), { log });
    expect(result.state, result.reason).toBe('APPROVED');
    expect(await fx.fork.out(['ls-remote', 'origin'])).toBe(old);
  });

  it('rejects a changed candidate manifest and a changed bundle', async () => {
    fx = await createFixture();
    const { next } = await prepareCandidate();
    const manifest = path.join(next.artifactDir, 'candidate.json');
    const original = await fs.readFile(manifest);
    await fs.appendFile(manifest, '\n');
    expect((await runPhase({ ...next, phase: 'verify' }, env(), { log })).state).toBe('FAILED_TAMPERED');
    await fs.writeFile(manifest, original);
    await fs.appendFile(path.join(next.artifactDir, 'candidate.bundle'), 'tamper');
    expect((await runPhase({ ...next, phase: 'verify' }, env(), { log })).state).toBe('FAILED_TAMPERED');
  });

  it('rejects a verification artifact from another candidate, even with its own digest', async () => {
    fx = await createFixture();
    const { next } = await prepareCandidate();
    const verified = await runPhase({ ...next, phase: 'verify' }, env(), { log });
    expect(verified.state, verified.reason).toBe('VERIFIED');
    const file = path.join(verified.artifactDir!, 'verification.json');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    json.headSha = fx.base;
    await fs.writeFile(file, JSON.stringify(json));
    const result = await runPhase({ ...next, phase: 'publish', verificationDir: verified.artifactDir!, verificationDigest: await fileDigest(file) }, env(), { log });
    expect(result.state).toBe('FAILED_TAMPERED');
  });

  it('rejects failed isolated verification and never produces a verification artifact', async () => {
    fx = await createFixture({ patches: [] });
    const { next } = await prepareCandidate();
    // Simulate a flaky external check: the exact same command is trusted in each phase.
    const file = path.join(next.artifactDir, 'candidate.json');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    json.verifyCommand = 'false';
    await fs.writeFile(file, JSON.stringify(json));
    const result = await runPhase({ ...next, phase: 'verify', verifyCommand: 'false', candidateDigest: await fileDigest(file) }, env(), { log });
    expect(result.state).toBe('FAILED_GATE');
    expect(result.artifactDigest).toBeUndefined();
  });

  it('records success when backup enumeration fails after publication', async () => {
    fx = await createFixture();
    const old = await fx.fork.revParse('HEAD');
    const head = await commitFiles(fx.fork, { 'new.txt': 'new\n' }, 'new');
    const original = fx.fork.lines.bind(fx.fork);
    fx.fork.lines = async (args, options) => {
      if (args[0] === 'ls-remote' && args[2]?.startsWith('refs/autopatch/backup/')) throw new Error('listing failed');
      return original(args, options);
    };
    const result = await publishBranch({ git: fx.fork, branch: 'main', leaseSha: old, runId: 'cleanup', dryRun: false, log }, head, 'autopatch/temp', 10);
    expect(result.pushed).toBe(true);
    expect(result.warnings!.join('\n')).toContain('listing failed');
    expect(await originSha()).toBe(head);
  });

  it('fails before calling a backend whose hard limits are unsupported', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'upstream.txt': 'new\n' }, 'upstream');
    const report = await run(inputs({ worker: { backend: 'codex', model: 'test' }, requireHardLimits: true }), env(),
      { log, createBackend: () => new CodexBackend({ log, bin: 'must-not-be-invoked' }) });
    expect(report.state).toBe('FAILED_PLAN');
    expect(report.reason).toContain('cannot enforce dollar and turn limits');
    expect(report.agentCalls).toBe(0);
  });

  it('files a digest-bound failure report in a separate phase without suggesting promotion of an unpublished branch', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'upstream.txt': 'new\n' }, 'upstream');
    const failed = await run(inputs(), env(), { log, createBackend: () => new FakeBackend(undefined, { review: [{ verdict: 'reject', summary: 'cannot approve' }] }) });
    expect(failed.state).toBe('FAILED_CONTESTED');
    const dir = path.join(env().runnerTemp, 'autopatch/results');
    const bodies: string[] = [];
    const reported = await runPhase(inputs({ phase: 'report', artifactDir: dir, resultsDigest: await fileDigest(path.join(dir, 'results.json')) }), env(), { log, issues: {
      listForRepo: async () => ({ data: [] }), getLabel: async () => undefined, createLabel: async () => undefined,
      create: async p => { bodies.push(p.body); return { data: { number: 1, html_url: 'https://example/issue' } }; },
      update: async () => ({ data: { html_url: 'https://example/issue' } }), createComment: async () => undefined,
    } });
    expect(reported.notes).toContain('issue: https://example/issue');
    expect(reported.state).toBe('REPORTED');
    expect(reported.reportedFailureState).toBe('FAILED_CONTESTED');
    expect(bodies[0]).toContain('Recover a completed candidate');
    expect(bodies[0]).not.toContain('git push --force-with-lease');
    expect(await originSha()).toBe(fx.patchShas[2]);
  });
});
