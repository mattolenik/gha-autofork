import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agents/runner.js';
import type { FakeScript } from '../src/agents/fake.js';
import { Budget } from '../src/budget.js';
import { runConsensus } from '../src/consensus.js';
import { buildChildEnv } from '../src/env.js';
import { runGates } from '../src/gates.js';
import { silentLogger } from '../src/log.js';
import { computePlan } from '../src/plan.js';
import { quarantine } from '../src/quarantine.js';
import { validateFilePath } from '../src/state.js';
import { prepare } from './harness.js';
import { advanceUpstream, commitFiles, createFixture, fetchUpstream, UPSTREAM_INITIAL, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => { await fx?.cleanup(); });
const up = "export function greet(name) {\n  return 'upstream ' + name;\n}\n\nexport const VERSION = 2;\n";
const fixed = "export function greet(name) {\n  return 'UPSTREAM ' + name.toUpperCase();\n}\n\nexport const VERSION = 2;\n";

async function review(script: FakeScript, verifyCommand?: string, maxRounds = 1) {
  await advanceUpstream(fx, { 'upstream.txt': 'new\n' }, 'upstream');
  const h = await prepare(fx, script);
  const outcome = await h.run();
  const reviewer = new AgentRunner({ backend: h.backend, model: '', role: 'reviewer', budget: h.budget,
    maxTurns: 10, timeoutMs: 60000, env: {}, transcriptsDir: null, log: silentLogger });
  return runConsensus({ git: h.wt, plan: h.plan, outcome, worker: h.runner, reviewer, maxRounds,
    holdDir: path.join(fx.root, 'hold'), log: silentLogger,
    runGates: () => runGates({ git: h.wt, plan: h.plan, expectedCount: outcome.mapping.size, env: buildChildEnv(), log: silentLogger, verifyCommand }) });
}

describe('approval invariants', () => {
  it.each(['git reset --hard HEAD~1', 'echo injected > injected.txt && git add injected.txt', 'git update-ref refs/heads/rogue HEAD'])('rejects reviewer mutation: %s', async hook => {
    fx = await createFixture();
    await expect(review({ review: [{ hook }] })).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
  });

  it.each([
    'git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false commit --allow-empty -qm injected',
    'echo changed >> README.md',
  ])('rejects verification side effects: %s', async verifyCommand => {
    fx = await createFixture();
    await expect(review({}, verifyCommand)).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
  });

  it('blocks contradictory approvals and omitted required review checks', async () => {
    fx = await createFixture();
    const result = await review({ review: [{ verdict: 'approve', issues: [{ id: 'B', severity: 'blocker',
      patch: null, file: null, description: 'unsafe', suggested_fix: null }], checked: { range_diff: false, verify_log: false, commands_run: [] } }] }, 'true');
    expect(result.state).toBe('CONTESTED');
    expect(result.rounds[0]!.syntheticIssues[0]!.id).toBe('review-checks');
  });

  it('does not turn an unexplained rejection into approval', async () => {
    fx = await createFixture();
    expect((await review({ review: [{ verdict: 'reject', issues: [], summary: 'could not review' }] })).state).toBe('CONTESTED');
  });

  it('rejects empty and duplicate skip references', async () => {
    fx = await createFixture();
    await expect(review({ review: [{ skips_approved: [{ patch: '', approved: true, reason: 'empty' }] }] })).rejects.toMatchObject({ state: 'FAILED_AGENT' });
  });

  it('detects no progress despite changing issue IDs', async () => {
    fx = await createFixture();
    const issue = { severity: 'major' as const, patch: null, file: null, description: 'same objection', suggested_fix: null };
    const result = await review({ review: [{ verdict: 'reject', issues: [{ ...issue, id: 'A' }] }, { verdict: 'reject', issues: [{ ...issue, id: 'B' }] }] }, undefined, 4);
    expect(result.state).toBe('CONTESTED');
    expect(result.rounds).toHaveLength(2);
  });

  it.each(['echo unreported > rogue.txt && git add rogue.txt', 'echo "# changed" >> "$(git rev-parse --git-path rebase-merge/git-rebase-todo)"', 'printf broken > .git'])('rejects conflict-worker metadata changes: %s', async hook => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/lib.js': up }, 'upstream');
    const h = await prepare(fx, { resolve: { '*': { files: { 'src/lib.js': fixed }, hook } } });
    await expect(h.run()).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
  });
});

describe('paths and upstream history', () => {
  it('refuses to restore quarantined files through a replaced symlink ancestor', async () => {
    fx = await createFixture();
    const directory = path.join(fx.fork.cwd, '.github');
    const outside = path.join(fx.root, 'outside');
    await fs.mkdir(directory);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(directory, 'copilot-instructions.md'), 'original');
    await fs.writeFile(path.join(outside, 'copilot-instructions.md'), 'preserve');
    const q = await quarantine(fx.fork.cwd, path.join(fx.root, 'hold'));
    await fs.rm(directory, { recursive: true });
    await fs.symlink(outside, directory);
    await expect(q.restore()).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
    expect(await fs.readFile(path.join(outside, 'copilot-instructions.md'), 'utf8')).toBe('preserve');
  });
  it('checks markers in Unicode and newline-containing filenames', async () => {
    fx = await createFixture({ patches: [{ message: 'markers', files: { 'caf\u00e9.txt': '<<<<<<< HEAD\nx\n', 'a\nb.txt': '>>>>>>> patch\n' } }] });
    await advanceUpstream(fx, { 'upstream.txt': 'new\n' }, 'upstream');
    const h = await prepare(fx, {});
    await h.run();
    const gates = await runGates({ git: h.wt, plan: h.plan, expectedCount: 1, env: buildChildEnv(), log: silentLogger });
    expect(gates.failures).toContain('conflict markers in caf\u00e9.txt');
    expect(gates.failures).toContain('conflict markers in a\nb.txt');
  });

  it('preserves a resolution inside a quarantined instruction directory', async () => {
    fx = await createFixture({ upstreamInitial: { ...UPSTREAM_INITIAL, '.claude/settings.json': '{"value":"base"}\n' },
      patches: [{ message: 'settings', files: { '.claude/settings.json': '{"value":"fork"}\n' } }] });
    await advanceUpstream(fx, { '.claude/settings.json': '{"value":"upstream"}\n' }, 'upstream');
    const h = await prepare(fx, { resolve: { '*': { files: { '.claude/settings.json': '{"value":"combined"}\n' } } } });
    await h.run();
    expect(await fs.readFile(path.join(h.wtDir, '.claude/settings.json'), 'utf8')).toContain('combined');
  });

  it('rejects traversal, directory reports, and symlink ancestors while accepting literal filenames', async () => {
    fx = await createFixture();
    await fs.symlink(fx.upstreamWork.cwd, path.join(fx.fork.cwd, 'outside'));
    for (const rel of ['../x', '.', 'src', 'outside/x', '.git/config']) await expect(validateFilePath(fx.fork.cwd, rel)).rejects.toThrow();
    await expect(validateFilePath(fx.fork.cwd, 'a..b.txt')).resolves.toBeUndefined();
  });

  it('rejects an upstream rewrite against its stored checkpoint', async () => {
    fx = await createFixture();
    await fx.upstreamWork.run(['reset', '--hard', `${fx.base}^`]);
    await commitFiles(fx.upstreamWork, { 'rewrite.txt': 'new\n' }, 'rewrite');
    await fx.upstreamWork.run(['push', '--force', 'origin', 'main']);
    await fetchUpstream(fx);
    await expect(computePlan(fx.fork, { branch: 'main', upstreamBranch: 'main', maxPatches: 200, checkpointSha: fx.base })).rejects.toMatchObject({ state: 'FAILED_PLAN' });
  });
});

describe('backend failure contracts', () => {
  it('rejects nonzero exit with otherwise valid structured output', async () => {
    const runner = new AgentRunner({ backend: { name: 'broken', ensureInstalled: async () => {}, run: async () => ({
      exitCode: 1, structured: { complete: true, concerns: [], summary: 'looks valid' }, text: '', raw: 'failed', costUsd: 0, turns: 1,
    }) }, model: '', role: 'worker', budget: new Budget(10), maxTurns: 1, timeoutMs: 1000, env: {}, transcriptsDir: null, log: silentLogger });
    await expect(runner.structured({ schemaName: 'selfcheck', system: '', user: '', mode: 'readonly', cwd: process.cwd() })).rejects.toMatchObject({ state: 'FAILED_AGENT' });
  });

  it('does not launch another call when the known budget is exhausted', () => {
    const budget = new Budget(1);
    budget.record(1);
    expect(() => budget.assertAvailable()).toThrow(/exhausted/);
    const unpriced = new Budget(1);
    unpriced.record(null);
    expect(unpriced.unpricedCalls).toBe(1);
  });
});
