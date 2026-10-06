import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createBackend, backendEnv } from './agents/index.js';
import { AgentRunner } from './agents/runner.js';
import type { AgentBackend } from './agents/types.js';
import { Budget } from './budget.js';
import { runConsensus } from './consensus.js';
import { buildChildEnv } from './env.js';
import { AutopatchError, type FailureState } from './errors.js';
import { runGates } from './gates.js';
import { Git, repoUrl, authExtraHeader } from './git.js';
import type { Inputs } from './inputs.js';
import { closeFailureIssue, upsertFailureIssue, type IssuesApi } from './issue.js';
import type { Logger } from './log.js';
import { computePlan, resolveBranches } from './plan.js';
import { fastForward, listLeftoverBranches, publishBranch, pushTempBranch, tempBranchName, type PublishContext } from './publish.js';
import { runRebase } from './rebase.js';
import { renderSummary, writeResults, type RunReport } from './report.js';
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
  const base = path.join(env.runnerTemp, 'autopatch');
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
  const [owner, repo] = inputs.repository.split('/') as [string, string];
  const budget = new Budget(inputs.maxCostUsd);
  let git: Git | null = null;
  let wt: Git | null = null;
  let publishCtx: PublishContext | null = null;

  const finish = async (state: RunReport['state'], reason: string): Promise<RunReport> => {
    report.state = state;
    report.reason = reason;
    report.finishedAt = new Date().toISOString();
    report.costUsd = budget.spentUsd;
    report.agentCalls = budget.calls;
    await writeResults(resultsDir, report, report.consensus?.gates.rangeDiff ?? report.gates?.rangeDiff ?? null);
    return report;
  };

  const fail = async (state: FailureState, message: string, details: string[] = []): Promise<RunReport> => {
    report.error = { message, details };
    log.warning(`${state}: ${message}`);
    for (const d of details.slice(0, 20)) log.info(`  ${d}`);
    if (wt && publishCtx && report.tempBranch) {
      try {
        const head = await wt.revParse('HEAD');
        if (head !== report.plan?.branchSha) {
          await pushTempBranch(publishCtx, head, report.tempBranch);
          report.headSha = head;
          report.notes.push(`partial result pushed to ${report.tempBranch} for rescue`);
        } else {
          report.tempBranch = null;
        }
      } catch (e) {
        report.notes.push(`could not push the temporary branch: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (git && report.tempBranch) report.leftoverBranches = await listLeftoverBranches(git, report.tempBranch).catch(() => []);
    const result = await finish(state, message);
    if (deps.issues && !inputs.dryRun) {
      try {
        const url = await upsertFailureIssue(deps.issues, owner, repo, report.plan?.branch ?? inputs.branch ?? 'default branch', renderSummary(report, { forIssue: true, runUrl: env.runUrl }), log);
        report.notes.push(`issue: ${url}`);
        await writeResults(resultsDir, report, null);
      } catch (e) {
        log.warning(`could not create or update the failure issue: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  };

  try {
    // 1. Fork checkout
    const forkUrl = inputs.forkRemoteUrl ?? `${env.serverUrl}/${inputs.repository}.git`;
    const ws = new Git(env.workspace);
    const wsOrigin = await ws.remoteUrl('origin');
    if (wsOrigin && normalizeRepoUrl(wsOrigin) === normalizeRepoUrl(forkUrl)) {
      git = ws;
      log.info(`using the checkout in ${env.workspace}`);
    } else {
      const cloneDir = path.join(base, 'fork');
      log.info(`cloning ${inputs.repository} into ${cloneDir}`);
      const cloner = /^https:\/\/github\.com\//.test(forkUrl) ? new Git(base).withConfig(authExtraHeader(inputs.token)) : new Git(base);
      await fs.mkdir(base, { recursive: true });
      await cloner.run(['clone', '--quiet', '--no-tags', forkUrl, cloneDir]);
      git = new Git(cloneDir);
    }
    if (await git.isShallow()) {
      log.info('unshallowing the checkout');
      await git.run(['fetch', '--unshallow', '--no-tags', 'origin']);
    }

    // 2. Branches and upstream
    await git.ensureRemote('upstream', repoUrl(inputs.upstream));
    const { branch, upstreamBranch } = await resolveBranches(git, { branch: inputs.branch, upstreamBranch: inputs.upstreamBranch });
    await git.run(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    log.info(`fetching upstream ${inputs.upstream} (${upstreamBranch})`);
    await git.run(['fetch', '--no-tags', '--prune', 'upstream', '+refs/heads/*:refs/remotes/upstream/*']);

    // 3. Plan
    const plan = await computePlan(git, { branch, upstreamBranch, branchRev: `refs/remotes/origin/${branch}`, maxPatches: inputs.maxPatches });
    report.plan = plan;
    publishCtx = { git, branch, leaseSha: plan.branchSha, runId: env.runId, token: inputs.token, dryRun: inputs.dryRun, log };

    if (plan.kind === 'nothing_to_do') {
      return await finish('NOTHING_TO_DO', `upstream ${upstreamBranch} has not moved since the last rebase; ${plan.patches.length} patch(es) in place`);
    }
    if (plan.kind === 'fast_forward') {
      await fastForward(publishCtx, plan.upstreamSha);
      report.headSha = plan.upstreamSha;
      return await finish('FAST_FORWARDED', `fork carries no patches; fast-forwarded ${branch} to upstream ${plan.upstreamSha.slice(0, 12)}${inputs.dryRun ? ' (dry run: not pushed)' : ''}`);
    }

    log.info(`${plan.patches.length} patch(es) to rebase over ${plan.upstreamCommits} new upstream commit(s); ${plan.patches.filter((p) => p.absorbed).length} already upstream`);
    if (plan.workflowPaths.length) log.info(`workflow files involved (token needs Workflows permission): ${plan.workflowPaths.join(', ')}`);

    // 4. Worktree on the temporary branch
    report.tempBranch = tempBranchName(env.runId, env.runAttempt);
    wt = await git.worktreeAdd(wtDir, plan.branchSha);
    await wt.run(['switch', '-q', '-C', report.tempBranch]);

    // 5. Agents
    const makeBackend = deps.createBackend ?? ((name: Inputs['worker']['backend']) => createBackend(name, inputs, log));
    const workerBackend = makeBackend(inputs.worker.backend);
    await workerBackend.ensureInstalled(inputs.installClis);
    const timeoutMs = inputs.agentTimeoutMinutes * 60_000;
    const runnerOpts = { budget, maxTurns: inputs.maxTurns, timeoutMs, transcriptsDir: path.join(resultsDir, 'transcripts'), log };
    const worker = new AgentRunner({ ...runnerOpts, backend: workerBackend, model: inputs.worker.model, role: 'worker', env: buildChildEnv(backendEnv(inputs.worker.backend, inputs)) });
    let reviewer: AgentRunner | null = null;
    if (inputs.reviewer) {
      const reviewerBackend = inputs.reviewer.backend === inputs.worker.backend ? workerBackend : makeBackend(inputs.reviewer.backend);
      await reviewerBackend.ensureInstalled(inputs.installClis);
      reviewer = new AgentRunner({ ...runnerOpts, backend: reviewerBackend, model: inputs.reviewer.model, role: 'reviewer', env: buildChildEnv(backendEnv(inputs.reviewer.backend, inputs)) });
    } else {
      report.notes.push('no reviewer configured: only the worker self-check gated this rebase');
    }

    // 6. Rebase
    const outcome = await log.group('rebase', () => runRebase({ git: wt!, plan, worker: makeWorker(worker, plan, wtDir), holdDir, log }));
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
      });
    const consensus = await log.group('review', () =>
      runConsensus({ git: wt!, plan, outcome, worker, reviewer, maxRounds: inputs.maxRounds, runGates: gatesFn, holdDir, log }),
    );
    report.consensus = consensus;
    report.gates = consensus.gates;
    report.headSha = consensus.headSha;
    report.notes.push(...consensus.notes);

    if (consensus.state !== 'APPROVED') {
      return await fail(consensus.state === 'CONTESTED' ? 'FAILED_CONTESTED' : 'FAILED_GATE', consensus.reason, consensus.gates.failures);
    }

    // 8. Publish
    await pushTempBranch(publishCtx, consensus.headSha, report.tempBranch);
    report.leftoverBranches = await listLeftoverBranches(git, report.tempBranch).catch(() => []);
    if (inputs.publish === 'stage') {
      return await finish('STAGED', `${consensus.reason}; result left on ${report.tempBranch} (publish=stage)`);
    }
    report.publish = await publishBranch(publishCtx, consensus.headSha, report.tempBranch, inputs.keepBackups);
    if (deps.issues && !inputs.dryRun) {
      await closeFailureIssue(deps.issues, owner, repo, branch, `Resolved: run ${env.runUrl ?? env.runId} rebased \`${branch}\` onto upstream ${plan.upstreamSha.slice(0, 12)}.`, log).catch((e: unknown) =>
        log.warning(`could not close the failure issue: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return await finish(
      'APPROVED',
      `${consensus.reason}; ${inputs.dryRun ? 'dry run: nothing pushed' : `${branch} force-pushed to ${consensus.headSha.slice(0, 12)} (old tip backed up as ${report.publish.backupRef})`}`,
    );
  } catch (err) {
    if (err instanceof AutopatchError) return await fail(err.state, err.message, err.details);
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return await fail(report.outcome ? 'FAILED_GATE' : report.plan ? 'FAILED_REBASE' : 'FAILED_PLAN', `unexpected error: ${message}`);
  } finally {
    if (git && wt) await git.worktreeRemove(wtDir).catch(() => undefined);
  }
}
