import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createBackend, backendEnv } from './agents/index.js';
import { AgentRunner } from './agents/runner.js';
import type { AgentBackend } from './agents/types.js';
import { Budget } from './budget.js';
import { writeCandidate } from './candidate.js';
import { runConsensus } from './consensus.js';
import { buildChildEnv } from './env.js';
import { AutoforkError, type FailureState } from './errors.js';
import { runGates } from './gates.js';
import { Git, repoUrl, authExtraHeader } from './git.js';
import type { Inputs } from './inputs.js';
import type { IssuesApi } from './issue.js';
import type { Logger } from './log.js';
import { computePlan, type RebasePlan } from './plan.js';
import { fetchCheckpoint, tempBranchName } from './publish.js';
import { runRebase, type PatchRecord, type RebaseOutcome } from './rebase.js';
import { saveRecovery } from './recovery.js';
import { assertCandidate } from './state.js';
import { writeResults, type RunReport } from './report.js';
import { makeWorker } from './worker.js';

export interface RunEnv {
  runId: string;
  runAttempt: string;
  /** Directory actions/checkout populated; used when it is a checkout of the fork. */
  workspace: string;
  runnerTemp: string;
  serverUrl: string;
  runUrl?: string | undefined;
}

export interface RunDeps {
  log: Logger;
  issues?: IssuesApi | null;
  /** Override backend construction (tests inject the fake with an inline script). */
  createBackend?: (name: Inputs['worker']['backend']) => AgentBackend;
}

export function normalizeRepoUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+)$/.exec(s);
  if (m) return `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}`;
  return path.resolve(s.replace(/^file:\/\//, ''));
}

export async function run(inputs: Inputs, env: RunEnv, deps: RunDeps): Promise<RunReport> {
  const { log } = deps;
  const startedAt = new Date().toISOString();
  const base = path.join(env.runnerTemp, 'autofork');
  const resultsDir = path.join(base, 'results');
  const holdDir = path.join(base, 'hold');
  const wtDir = path.join(base, 'wt');
  await fs.rm(base, { recursive: true, force: true });
  await fs.mkdir(resultsDir, { recursive: true });

  const report: RunReport = {
    state: 'FAILED_PLAN',
    reason: '',
    repository: inputs.repository,
    upstream: inputs.upstream,
    runId: env.runId,
    startedAt,
    finishedAt: startedAt,
    plan: null,
    outcome: null,
    consensus: null,
    gates: null,
    publish: null,
    tempBranch: null,
    headSha: null,
    leftoverBranches: [],
    costUsd: 0,
    agentCalls: 0,
    notes: [],
    error: null,
  };
  const budget = new Budget(inputs.maxCostUsd);
  let git: Git | null = null;
  let wt: Git | null = null;
  let workPlan: RebasePlan | null = null;
  let progress: PatchRecord[] = [];
  let currentPatch: string | null = null;

  const finish = async (state: RunReport['state'], reason: string): Promise<RunReport> => {
    report.state = state;
    report.reason = reason;
    report.finishedAt = new Date().toISOString();
    report.costUsd = budget.spentUsd;
    report.agentCalls = budget.calls;
    report.unpricedCalls = budget.unpricedCalls;
    await writeResults(resultsDir, report, report.consensus?.gates.rangeDiff ?? report.gates?.rangeDiff ?? null);
    return report;
  };

  const fail = async (state: FailureState, message: string, details: string[] = []): Promise<RunReport> => {
    report.error = { message, details };
    log.warning(`${state}: ${message}`);
    for (const d of details.slice(0, 20)) log.info(`  ${d}`);
    if (wt && workPlan && state !== 'FAILED_TAMPERED') {
      await saveRecovery(wt, workPlan, path.join(resultsDir, 'recovery'), progress, currentPatch)
        .catch(e => report.notes.push(`could not update recovery checkpoint: ${String(e)}`));
      report.recoveryDir = path.join(resultsDir, 'recovery');
    }
    return finish(state, message);
  };

  try {
    // 1. Fork checkout
    await new Git(base).requireSupportedVersion();
    const forkUrl = inputs.forkRemoteUrl ?? `${env.serverUrl}/${inputs.repository}.git`;
    const ws = new Git(env.workspace);
    const wsOrigin = await ws.remoteUrl('origin');
    if (wsOrigin && normalizeRepoUrl(wsOrigin) === normalizeRepoUrl(forkUrl)) {
      git = ws;
      log.info(`using the checkout in ${env.workspace}`);
    } else {
      const cloneDir = path.join(base, 'fork');
      log.info(`cloning ${inputs.repository} into ${cloneDir}`);
      const cloner = forkUrl.startsWith('https://') ? new Git(base).withConfig(authExtraHeader(inputs.token, forkUrl)) : new Git(base);
      await fs.mkdir(base, { recursive: true });
      await cloner.run(['clone', '--quiet', '--no-tags', forkUrl, cloneDir]);
      git = new Git(cloneDir);
    }
    git = await git.authenticated(inputs.token);
    if (await git.isShallow()) {
      log.info('unshallowing the checkout');
      await git.run(['fetch', '--unshallow', '--no-tags', 'origin']);
    }

    // 2. Branches and upstream
    await git.ensureRemote('upstream', repoUrl(inputs.upstream, env.serverUrl));
    const upstreamGit = await git.authenticated(inputs.upstreamToken, 'upstream');
    const branch = inputs.branch ?? await git.remoteDefaultBranch('origin');
    const upstreamBranch = inputs.upstreamBranch ?? await upstreamGit.remoteDefaultBranch('upstream');
    if (!branch || !upstreamBranch) throw new AutoforkError('FAILED_PLAN', 'could not discover default branches; check read credentials or specify branch and upstream_branch');
    for (const name of [branch, upstreamBranch]) await git.run(['check-ref-format', '--branch', name]);
    await git.run(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    log.info(`fetching upstream ${inputs.upstream} (${upstreamBranch})`);
    await upstreamGit.run(['fetch', '--no-tags', 'upstream', `+refs/heads/${upstreamBranch}:refs/remotes/upstream/${upstreamBranch}`]);

    // 3. Plan
    const checkpointSha = await fetchCheckpoint(git, branch);
    let planned = await computePlan(git, { branch, upstreamBranch, branchRev: `refs/remotes/origin/${branch}`, maxPatches: inputs.maxPatches,
      checkpointSha, initialBase: inputs.initialBase });
    // Explicit initialization is useful even when upstream has not moved yet.
    if (planned.kind === 'nothing_to_do' && !checkpointSha && inputs.initialBase) {
      const upstreamSha = await git.revParse(`refs/remotes/upstream/${upstreamBranch}`);
      planned = { ...planned, kind: 'rebase', upstreamRef: `refs/remotes/upstream/${upstreamBranch}`, upstreamSha,
        base: upstreamSha, expectedSurvivors: planned.patches.length, upstreamCommits: 0, workflowPaths: [] };
    }
    report.plan = planned;

    if (planned.kind === 'nothing_to_do') {
      report.headSha = planned.branchSha;
      return await finish('NOTHING_TO_DO', `upstream ${upstreamBranch} has not moved since the last rebase; ${planned.patches.length} patch(es) in place`);
    }
    const plan: RebasePlan = planned.kind === 'rebase' ? planned : { ...planned, kind: 'rebase', base: planned.branchSha,
      patches: [], expectedSurvivors: 0, upstreamCommits: await git.revListCount(`${planned.branchSha}..${planned.upstreamSha}`), workflowPaths: [] };
    workPlan = plan;
    const independent = !!inputs.reviewer && (inputs.reviewer.backend !== inputs.worker.backend || inputs.worker.backend === 'fake');
    // Nothing to replay (no patches, or upstream has not moved): git alone produces the result and no agent judgement is involved.
    const deterministic = plan.patches.length === 0 || plan.upstreamCommits === 0;
    const autoEligible = (independent || deterministic) && !!inputs.verifyCommand && !!(checkpointSha || inputs.initialBase);
    if (!autoEligible) report.notes.push('automatic publishing requires independent review, verify_command, and an existing upstream checkpoint or explicit initial_base; candidate will be staged');

    log.info(`${plan.patches.length} patch(es) to rebase over ${plan.upstreamCommits} new upstream commit(s); ${plan.patches.filter((p) => p.absorbed).length} already upstream`);
    if (plan.workflowPaths.length) log.info(`workflow files involved (token needs Workflows permission): ${plan.workflowPaths.join(', ')}`);

    // 4. Worktree on the temporary branch
    report.tempBranch = tempBranchName(env.runId, env.runAttempt);
    // Agent-facing Git objects never carry transport credentials in their argv/environment.
    wt = await new Git(git.cwd).worktreeAdd(wtDir, planned.kind === 'fast_forward' ? plan.upstreamSha : plan.branchSha);
    await wt.run(['switch', '-q', '-C', report.tempBranch]);

    const timeoutMs = inputs.agentTimeoutMinutes * 60_000;
    const exportCandidate = async (outcome: RebaseOutcome, approval: 'approved' | 'contested') => {
      report.artifactDir = path.join(resultsDir, 'candidate');
      report.artifactDigest = await writeCandidate(wt!, report.artifactDir, plan, outcome, {
        runId: env.runId, runAttempt: env.runAttempt, repository: inputs.repository, upstream: inputs.upstream,
        checkpointSha: checkpointSha ?? null, kind: planned.kind === 'fast_forward' ? 'fast_forward' : 'rebase',
        autoEligible: approval === 'approved' && autoEligible, verifyCommand: inputs.verifyCommand ?? null, approval,
      });
    };
    if (deterministic) {
      // Patchless: the result is upstream itself. No upstream movement: the result is the existing series, unchanged.
      const outcome: RebaseOutcome = plan.patches.length === 0
        ? { headSha: plan.upstreamSha, records: [], conflictsResolved: 0, mapping: new Map() }
        : { headSha: plan.branchSha, conflictsResolved: 0, mapping: new Map(plan.patches.map((p) => [p.sha, p.sha])),
            records: plan.patches.map((p) => ({ sha: p.sha, subject: p.subject, result: 'applied', newSha: p.sha, conflicts: [], report: null, extraPaths: [] })) };
      const what = plan.patches.length === 0 ? 'patchless' : 'unchanged';
      report.outcome = outcome;
      report.headSha = outcome.headSha;
      report.gates = await runGates({ git: wt, plan, expectedCount: outcome.mapping.size, verifyCommand: inputs.verifyCommand,
        verifyTimeoutMs: timeoutMs, env: buildChildEnv(), log, sandbox: inputs.sandbox ?? false });
      if (!report.gates.ok) return await fail('FAILED_GATE', `${what} candidate failed verification`, report.gates.failures);
      await assertCandidate(wt, report.gates.candidate);
      await exportCandidate(outcome, 'approved');
      return await finish('PREPARED', `${what} candidate passed deterministic gates; no agents needed`);
    }

    // 5. Agents
    const makeBackend = deps.createBackend ?? ((name: Inputs['worker']['backend']) => createBackend(name, inputs, log));
    const workerBackend = makeBackend(inputs.worker.backend);
    const installedBackends = [workerBackend];
    const checkCapabilities = (backend: AgentBackend) => {
      if (inputs.requireHardLimits && (!backend.capabilities?.budgetLimit || !backend.capabilities.turnLimit)) {
        throw new AutoforkError('FAILED_PLAN', `${backend.name} cannot enforce dollar and turn limits; require_hard_limits is incompatible with this backend`);
      }
    };
    checkCapabilities(workerBackend);
    await workerBackend.ensureInstalled(inputs.installClis);
    const runnerOpts = { budget, maxTurns: inputs.maxTurns, timeoutMs, transcriptsDir: path.join(resultsDir, 'transcripts'), log };
    const worker = new AgentRunner({ ...runnerOpts, backend: workerBackend, model: inputs.worker.model, role: 'worker', env: buildChildEnv(backendEnv(inputs.worker.backend, inputs)) });
    let reviewer: AgentRunner | null = null;
    if (inputs.reviewer) {
      const reviewerBackend = inputs.reviewer.backend === inputs.worker.backend ? workerBackend : makeBackend(inputs.reviewer.backend);
      checkCapabilities(reviewerBackend);
      if (reviewerBackend !== workerBackend) await reviewerBackend.ensureInstalled(inputs.installClis);
      if (!installedBackends.includes(reviewerBackend)) installedBackends.push(reviewerBackend);
      reviewer = new AgentRunner({ ...runnerOpts, backend: reviewerBackend, model: inputs.reviewer.model, role: 'reviewer', env: buildChildEnv(backendEnv(inputs.reviewer.backend, inputs)) });
    } else {
      report.notes.push('no reviewer configured: only the worker self-check gated this rebase');
    }
    report.backendVersions = {};
    for (const backend of installedBackends) {
      report.backendVersions[backend.name] = backend.version ?? 'scripted';
    }
    for (const backend of installedBackends) {
      if (!backend.capabilities?.costReporting) {
        report.notes.push(`${backend.name} does not report dollars; its wall-clock timeout is enforced and total cost is incomplete`);
      }
    }

    // 6. Rebase
    const onProgress = async (records: PatchRecord[], active: string | null) => {
      progress = records;
      currentPatch = active;
      if (active !== null) {
        report.recoveryDir = path.join(resultsDir, 'recovery');
        await saveRecovery(wt!, plan, report.recoveryDir, records, active);
      }
      await fs.writeFile(path.join(resultsDir, 'progress.json'), JSON.stringify({ plan, records, currentPatch: active }, null, 2));
    };
    const outcome = await log.group('rebase', () => runRebase({ git: wt!, plan, worker: makeWorker(worker, plan, wtDir), holdDir, log, onProgress }));
    report.outcome = outcome;
    report.headSha = outcome.headSha;

    // 7. Gates + consensus
    const gatesFn = () =>
      runGates({
        git: wt!,
        plan,
        expectedCount: outcome.mapping.size,
        verifyCommand: inputs.verifyCommand,
        verifyTimeoutMs: timeoutMs,
        env: buildChildEnv(),
        log,
        sandbox: inputs.sandbox ?? false,
      });
    let reviewHead = outcome.headSha;
    const consensus = await log.group('review', () =>
      runConsensus({ git: wt!, plan, outcome, worker, reviewer, maxRounds: inputs.maxRounds, runGates: gatesFn, log,
        onProgress: async (rounds, gates) => {
          report.gates = gates;
          await fs.writeFile(path.join(resultsDir, 'review-progress.json'), JSON.stringify({ rounds, gates }, null, 2));
          progress = outcome.records;
          currentPatch = null;
          if (outcome.headSha !== reviewHead) {
            report.recoveryDir = path.join(resultsDir, 'recovery');
            await saveRecovery(wt!, plan, report.recoveryDir, progress, null);
            reviewHead = outcome.headSha;
          }
        } }),
    );
    report.consensus = consensus;
    report.gates = consensus.gates;
    report.headSha = consensus.headSha;
    report.notes.push(...consensus.notes);

    if (consensus.state !== 'APPROVED') {
      if (consensus.state === 'CONTESTED' && consensus.gates.ok) {
        await assertCandidate(wt, consensus.gates.candidate);
        await exportCandidate(outcome, 'contested');
      }
      return await fail(consensus.state === 'CONTESTED' ? 'FAILED_CONTESTED' : 'FAILED_GATE', consensus.reason, consensus.gates.failures);
    }

    // 8. Export an immutable candidate. This process never publishes refs or issues.
    await assertCandidate(wt, consensus.gates.candidate);
    await exportCandidate(outcome, 'approved');
    return await finish('PREPARED', `${consensus.reason}; immutable candidate exported for isolated verification`);
  } catch (err) {
    if (err instanceof AutoforkError) return await fail(err.state, err.message, err.details);
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return await fail(report.outcome ? 'FAILED_GATE' : report.plan ? 'FAILED_REBASE' : 'FAILED_PLAN', `unexpected error: ${message}`);
  } finally {
    if (git && wt) await git.worktreeRemove(wtDir).catch(() => undefined);
  }
}
