import * as path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FakeBackend } from '../src/agents/fake.js';
import { silentLogger } from '../src/log.js';
import { gitState } from '../src/state.js';
import { saveRecovery } from '../src/recovery.js';
import { run } from '../src/run.js';
import { prepare } from '../test/harness.js';
import { advanceUpstream, createFixture } from '../test/fixtures/repos.js';

const fx = await createFixture();
async function measure(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return Math.round(performance.now() - start);
}
try {
  await advanceUpstream(fx, { 'new.txt': 'new\n' }, 'upstream');
  const harness = await prepare(fx, {});
  const outcome = await harness.run();
  await harness.wt.layout();
  const stateMs = await measure(() => gitState(harness.wt));
  const destination = path.join(fx.root, 'checkpoint');
  const checkpointMs = await measure(() => saveRecovery(harness.wt, harness.plan, destination, outcome.records, null));
  const unchangedCheckpointMs = await measure(() => saveRecovery(harness.wt, harness.plan, destination, outcome.records, null));
  const prepareMs = await measure(async () => {
    const result = await run({ repository: 'owner/fork', upstream: fx.upstreamBare, upstreamBranch: 'main', branch: 'main', token: 'dummy',
      worker: { backend: 'fake', model: '' }, reviewer: { backend: 'fake', model: '' }, initialBase: fx.base,
      maxRounds: 3, maxPatches: 200, maxCostUsd: 10, maxTurns: 10, agentTimeoutMinutes: 1, keepBackups: 10,
      verifyCommand: 'true', publish: 'auto', installClis: false, dryRun: true, sandbox: false,
      forkRemoteUrl: fx.originBare, anthropicApiKey: undefined, openaiApiKey: undefined, fakeScript: undefined },
    { workspace: fx.fork.cwd, runnerTemp: path.join(fx.root, 'runner'), runId: 'benchmark', runAttempt: '1', serverUrl: 'https://github.com' },
    { log: silentLogger, createBackend: () => new FakeBackend(undefined, {}) });
    assert.equal(result.state, 'PREPARED', result.reason);
  });
  console.log(JSON.stringify({ gitStateMs: stateMs, checkpointMs, unchangedCheckpointMs, zeroConflictPrepareMs: prepareMs }, null, 2));
} finally { await fx.cleanup(); }
