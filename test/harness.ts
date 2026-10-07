import * as path from 'node:path';
import { FakeBackend, type FakeScript } from '../src/agents/fake.js';
import { AgentRunner } from '../src/agents/runner.js';
import { Budget } from '../src/budget.js';
import type { Git } from '../src/git.js';
import { silentLogger } from '../src/log.js';
import { computePlan, type RebasePlan } from '../src/plan.js';
import { runRebase, type RebaseOutcome } from '../src/rebase.js';
import { makeWorker } from '../src/worker.js';
import { fetchUpstream, type Fixture } from './fixtures/repos.js';

export interface Harness {
  plan: RebasePlan;
  wt: Git;
  wtDir: string;
  backend: FakeBackend;
  budget: Budget;
  runner: AgentRunner;
  run(): Promise<RebaseOutcome>;
}

export async function prepare(fx: Fixture, script: FakeScript, opts: { maxCostUsd?: number } = {}): Promise<Harness> {
  await fetchUpstream(fx);
  const plan = await computePlan(fx.fork, { branch: fx.branch, upstreamBranch: fx.branch, maxPatches: 200 });
  if (plan.kind !== 'rebase') throw new Error(`expected a rebase plan, got ${plan.kind}`);
  const wtDir = path.join(fx.root, 'wt');
  const wt = await fx.fork.worktreeAdd(wtDir, plan.branchSha);
  await wt.run(['switch', '-q', '-c', 'autofork/test']);
  const backend = new FakeBackend(undefined, script);
  const budget = new Budget(opts.maxCostUsd ?? 100);
  const runner = new AgentRunner({
    backend,
    model: '',
    role: 'worker',
    budget,
    maxTurns: 10,
    timeoutMs: 60_000,
    env: {},
    transcriptsDir: path.join(fx.root, 'transcripts'),
    log: silentLogger,
  });
  const worker = makeWorker(runner, plan, wtDir);
  return {
    plan,
    wt,
    wtDir,
    backend,
    budget,
    runner,
    run: () => runRebase({ git: wt, plan, worker, holdDir: path.join(fx.root, 'hold'), log: silentLogger }),
  };
}
