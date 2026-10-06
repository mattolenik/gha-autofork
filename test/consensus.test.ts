import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../src/agents/fake.js';
import { AgentRunner } from '../src/agents/runner.js';
import { runConsensus, type ConsensusResult } from '../src/consensus.js';
import { buildChildEnv } from '../src/env.js';
import { runGates } from '../src/gates.js';
import { silentLogger } from '../src/log.js';
import type { RebaseOutcome } from '../src/rebase.js';
import { advanceUpstream, createFixture, readFile, type Fixture } from './fixtures/repos.js';
import { prepare, type Harness } from './harness.js';

let fx: Fixture;
afterEach(async () => {
  await fx?.cleanup();
});

const UPSTREAM_GREET = ['export function greet(name) {', "  return 'hello, ' + name + '!';", '}', '', 'export const VERSION = 2;', ''].join('\n');
const RESOLVED_GREET = ['export function greet(name) {', "  return 'HELLO, ' + name.toUpperCase() + '!';", '}', '', 'export const VERSION = 2;', ''].join('\n');

interface Setup {
  h: Harness;
  outcome: RebaseOutcome;
  run(opts?: { maxRounds?: number; verifyCommand?: string; reviewer?: boolean }): Promise<ConsensusResult>;
}

async function setup(script: FakeScript, upstreamFiles: Record<string, string | null> = { 'src/lib.js': UPSTREAM_GREET }): Promise<Setup> {
  await advanceUpstream(fx, upstreamFiles, 'upstream: change');
  const h = await prepare(fx, { resolve: { '*': { files: { 'src/lib.js': RESOLVED_GREET } } }, ...script });
  const outcome = await h.run();
  const reviewer = new AgentRunner({
    backend: h.backend,
    model: '',
    role: 'reviewer',
    budget: h.budget,
    maxTurns: 10,
    timeoutMs: 60_000,
    env: {},
    transcriptsDir: path.join(fx.root, 'transcripts'),
    log: silentLogger,
  });
  return {
    h,
    outcome,
    run: (opts = {}) =>
      runConsensus({
        git: h.wt,
        plan: h.plan,
        outcome,
        worker: h.runner,
        reviewer: opts.reviewer === false ? null : reviewer,
        maxRounds: opts.maxRounds ?? 3,
        log: silentLogger,
        runGates: () =>
          runGates({
            git: h.wt,
            plan: h.plan,
            expectedCount: outcome.mapping.size,
            env: buildChildEnv(),
            log: silentLogger,
            verifyCommand: opts.verifyCommand,
          }),
      }),
  };
}

const calls = (h: Harness) => h.backend.calls.map((c) => c.schemaName);

describe('runConsensus', () => {
  it('lets the worker correct a bad target and remove a stray file without losing its intended edit', async () => {
    fx = await createFixture();
    const issue = { id: 'I1', severity: 'major' as const, patch: null, file: 'NOTES.fork.md', description: 'fix notes', suggested_fix: null };
    const s = await setup({ review: [{ verdict: 'reject', issues: [issue] }, { verdict: 'approve' }], respond: [
      { files: { 'NOTES.fork.md': 'fixed notes\n' }, hook: 'echo scratch > scratch.txt', responses: [{ issue_id: 'I1', action: 'fixed', explanation: 'fixed', target_patch: 'not-a-sha' }] },
      { files_changed: ['NOTES.fork.md'], hook: 'rm scratch.txt', responses: [{ issue_id: 'I1', action: 'fixed', explanation: 'corrected report', target_patch: fx.patchShas[1]! }] },
    ] });
    const result = await s.run();
    expect(result.state).toBe('APPROVED');
    expect(calls(s.h).filter(c => c === 'respond')).toHaveLength(2);
    expect(s.h.backend.calls.find(c => c.meta.attempt === '2' && c.schemaName === 'respond')!.prompt).toContain('unreported worktree changes: scratch.txt');
    expect(await readFile(s.h.wtDir, 'NOTES.fork.md')).toBe('fixed notes\n');
    expect(await s.h.wt.statusPorcelain()).toEqual([]);
  });

  it('keeps unresolved reporting mistakes unapproved after bounded correction attempts', async () => {
    fx = await createFixture();
    const s = await setup({ review: [{ verdict: 'reject', summary: 'fix this', issues: [{ id: 'I1', severity: 'major', patch: null, file: null, description: 'fix', suggested_fix: null }] }],
      respond: [{ files: { 'NOTES.fork.md': 'pending edit\n' }, responses: [{ issue_id: 'I1', action: 'fixed', explanation: 'bad report', target_patch: 'bad' }] }] });
    const result = await s.run();
    expect(result.state).toBe('GATE_FAILED');
    expect(result.reason).toContain('reporting problems');
    expect(calls(s.h).filter(c => c === 'respond')).toHaveLength(2);
    expect(await readFile(s.h.wtDir, 'NOTES.fork.md')).toBe('pending edit\n');
  });

  it('approves in round one when worker and reviewer agree', async () => {
    fx = await createFixture();
    const s = await setup({});
    const r = await s.run();
    expect(r.state).toBe('APPROVED');
    expect(r.rounds).toHaveLength(1);
    expect(calls(s.h)).toEqual(['resolve', 'selfcheck', 'review']);
    const review = s.h.backend.calls[2]!.prompt;
    expect(review).toContain('range-diff');
    expect(review).toContain('fork: greet shouts');
    expect(review).toContain('Worker considers the rebase complete');
  });

  it('works in single-agent mode without a reviewer', async () => {
    fx = await createFixture();
    const s = await setup({});
    const r = await s.run({ reviewer: false });
    expect(r.state).toBe('APPROVED');
    expect(calls(s.h)).toEqual(['resolve', 'selfcheck']);
    expect(r.reason).toMatch(/no reviewer configured/);
  });

  it('folds a reviewer-requested fix into the targeted patch and re-reviews', async () => {
    fx = await createFixture();
    const FIXED = RESOLVED_GREET.replace('HELLO, ', 'HELLO, dear ');
    const s = await setup({
      review: [
        { verdict: 'reject', summary: 'greeting lost the honorific', issues: [{ id: 'I1', severity: 'blocker', patch: null, file: 'src/lib.js', description: 'add dear', suggested_fix: null }] },
        { verdict: 'approve', summary: 'fixed' },
      ],
      respond: [{ verdict: 'approve', files: { 'src/lib.js': FIXED }, responses: [{ issue_id: 'I1', action: 'fixed', explanation: 'added', target_patch: '' }] }],
    });
    // target the first patch by its original sha
    s.h.backend.calls.length = 0;
    const script = (s.h.backend as unknown as { script: FakeScript }).script;
    script.respond![0]!.responses![0]!.target_patch = fx.patchShas[0]!.slice(0, 10);
    const r = await s.run();
    expect(r.state).toBe('APPROVED');
    expect(r.rounds).toHaveLength(2);
    expect(calls(s.h)).toEqual(['selfcheck', 'review', 'respond', 'selfcheck', 'review']);
    expect(await readFile(s.h.wtDir, 'src/lib.js')).toBe(FIXED);
    // still three patches, same messages, fix landed in patch 1
    expect(await s.h.wt.revListCount(`${s.h.plan.upstreamSha}..HEAD`)).toBe(3);
    const first = s.outcome.mapping.get(fx.patchShas[0]!)!;
    expect(await s.h.wt.out(['show', '--format=%s', '-s', first])).toBe('fork: greet shouts');
    expect((await s.h.wt.run(['show', `${first}:src/lib.js`])).stdout).toBe(FIXED);
    expect(r.gates.ok).toBe(true);
    expect(s.h.backend.calls[4]!.prompt).toContain('Previous rounds');
    expect(s.h.backend.calls[4]!.prompt).toContain('[I1] fixed: added');
  });

  it('stops early when the reviewer repeats the same issues and the worker only rebuts', async () => {
    fx = await createFixture();
    const issue = { id: 'I1', severity: 'major' as const, patch: null, file: null, description: 'style', suggested_fix: null };
    const s = await setup({
      review: [{ verdict: 'reject', summary: 'nope', issues: [issue] }],
      respond: [{ verdict: 'approve', responses: [{ issue_id: 'I1', action: 'rebutted', explanation: 'intentional', target_patch: null }] }],
    });
    const r = await s.run({ maxRounds: 5 });
    expect(r.state).toBe('CONTESTED');
    expect(r.rounds).toHaveLength(2);
    expect(r.reason).toMatch(/no progress/);
  });

  it('is contested when rounds run out', async () => {
    fx = await createFixture();
    const s = await setup({
      review: [
        { verdict: 'reject', summary: 'a', issues: [{ id: 'A', severity: 'blocker', patch: null, file: null, description: 'a', suggested_fix: null }] },
        { verdict: 'reject', summary: 'b', issues: [{ id: 'B', severity: 'blocker', patch: null, file: null, description: 'b', suggested_fix: null }] },
        { verdict: 'reject', summary: 'c', issues: [{ id: 'C', severity: 'blocker', patch: null, file: null, description: 'c', suggested_fix: null }] },
      ],
      respond: [{ verdict: 'approve', files: { 'NOTES.fork.md': 'edited once\n' } }, { verdict: 'approve', files: { 'NOTES.fork.md': 'edited twice\n' } }],
    });
    const r = await s.run({ maxRounds: 3 });
    expect(r.state).toBe('CONTESTED');
    expect(r.rounds).toHaveLength(3);
    expect(r.reason).toMatch(/no consensus after 3/);
    expect(r.rounds[2]!.response).toBeNull();
  });

  it('treats minor-only rejections as approvals', async () => {
    fx = await createFixture();
    const s = await setup({
      review: [{ verdict: 'reject', summary: 'nits', issues: [{ id: 'N1', severity: 'minor', patch: null, file: null, description: 'nit', suggested_fix: null }] }],
    });
    const r = await s.run();
    expect(r.state).toBe('APPROVED');
    expect(r.notes.join('\n')).toMatch(/only minor issues/);
  });

  it('feeds verify failures to the worker as gate issues and approves once fixed', async () => {
    fx = await createFixture();
    const s = await setup({
      respond: [{ verdict: 'approve', files: { 'NOTES.fork.md': 'Personal notes for this fork.\nMARKER\n' }, responses: [] }],
    });
    const r = await s.run({ verifyCommand: 'grep -q MARKER NOTES.fork.md' });
    expect(r.state).toBe('APPROVED');
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[0]!.syntheticIssues[0]!.id).toBe('gate-1-1');
    expect(r.rounds[0]!.selfCheck).toBeNull();
    expect(calls(s.h)).toEqual(['resolve', 'respond', 'selfcheck', 'review']);
    expect(s.h.backend.calls[1]!.prompt).toContain('verify command failed');
    // folded into the patch that last touched NOTES.fork.md (patch 2), count unchanged
    const second = s.outcome.mapping.get(fx.patchShas[1]!)!;
    expect(await s.h.wt.out(['show', `${second}:NOTES.fork.md`])).toContain('MARKER');
    expect(await s.h.wt.revListCount(`${s.h.plan.upstreamSha}..HEAD`)).toBe(3);
  });

  it('reports GATE_FAILED when the worker cannot make verification pass', async () => {
    fx = await createFixture();
    const s = await setup({ respond: [{ verdict: 'approve', files: { 'NOTES.fork.md': 'still wrong\n' } }, { verdict: 'approve', files: { 'NOTES.fork.md': 'still wrong 2\n' } }] });
    const r = await s.run({ verifyCommand: 'false', maxRounds: 2 });
    expect(r.state).toBe('GATE_FAILED');
    expect(r.reason).toMatch(/gates still failing/);
  });

  it('requires the reviewer to approve every skipped patch', async () => {
    fx = await createFixture();
    await advanceUpstream(fx, { 'src/util.js': null }, 'upstream: remove util');
    const h = await prepare(fx, {
      resolve: { '*': { status: 'skip_patch', files: { 'src/util.js': { action: 'delete' } } } },
      review: [{ verdict: 'approve', summary: 'forgot the skip' }, { verdict: 'approve', summary: 'ok', skips_approved: [{ patch: fx.patchShas[2]!.slice(0, 8), approved: true, reason: 'upstream removed the file' }] }],
      respond: [{ verdict: 'approve', responses: [{ issue_id: 'x', action: 'rebutted', explanation: 'the file is gone upstream', target_patch: null }] }],
    });
    const outcome = await h.run();
    const reviewer = new AgentRunner({ backend: h.backend, model: '', role: 'reviewer', budget: h.budget, maxTurns: 5, timeoutMs: 60_000, env: {}, transcriptsDir: null, log: silentLogger });
    const r = await runConsensus({
      git: h.wt,
      plan: h.plan,
      outcome,
      worker: h.runner,
      reviewer,
      maxRounds: 3,
      log: silentLogger,
      runGates: () => runGates({ git: h.wt, plan: h.plan, expectedCount: outcome.mapping.size, env: buildChildEnv(), log: silentLogger }),
    });
    expect(r.state).toBe('APPROVED');
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[0]!.syntheticIssues[0]!.id).toBe(`skip-${fx.patchShas[2]!.slice(0, 7)}`);
    expect(r.rounds[0]!.verdict!.verdict).toBe('approve');
  });

  it('rejects a read-only reviewer that leaves changes behind', async () => {
    fx = await createFixture();
    const s = await setup({ review: [{ hook: 'echo junk > junk.txt && echo more >> README.md' }] });
    await expect(s.run()).rejects.toMatchObject({ state: 'FAILED_TAMPERED' });
  });

  it('folds reported edits into the last patch when targeting conflicts', async () => {
    fx = await createFixture();
    const CLAMP_FIX = ['export function clamp(v, lo, hi) {', '  v = Number(v);', '  return Math.min(hi, Math.max(lo, v)); // fixed', '}', ''].join('\n');
    const s = await setup({
      review: [
        { verdict: 'reject', summary: 'clamp', issues: [{ id: 'I1', severity: 'blocker', patch: null, file: 'src/util.js', description: 'comment it', suggested_fix: null }] },
        { verdict: 'approve', summary: 'ok' },
      ],
      respond: [
        {
          verdict: 'approve',
          files: { 'src/util.js': CLAMP_FIX },
          responses: [{ issue_id: 'I1', action: 'fixed', explanation: 'done', target_patch: fx.patchShas[0]!.slice(0, 8) }],
        },
      ],
    });
    const r = await s.run();
    expect(r.state).toBe('APPROVED');
    expect(r.rounds[0]!.foldWarnings.join('\n')).toMatch(/folded all changes into the last patch/);
    const last = s.outcome.mapping.get(fx.patchShas[2]!)!;
    expect((await s.h.wt.run(['show', `${last}:src/util.js`])).stdout).toBe(CLAMP_FIX);
    expect(await s.h.wt.revListCount(`${s.h.plan.upstreamSha}..HEAD`)).toBe(3);
  });
});
