import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileDigest, importCandidate, readBoundJson, verificationSchema, type Candidate } from './candidate.js';
import { buildChildEnv } from './env.js';
import { AutopatchError } from './errors.js';
import { runGates } from './gates.js';
import type { Inputs } from './inputs.js';
import { closeFailureIssue, upsertFailureIssue } from './issue.js';
import { fetchCheckpoint, listLeftoverBranches, publishBranch, pushTempBranch, tempBranchName } from './publish.js';
import { renderSummary, writeResults, type RunReport } from './report.js';
import type { RunDeps, RunEnv } from './run.js';
import { assertCandidate } from './state.js';

function checkContext(candidate: Candidate, inputs: Inputs, env: RunEnv): void {
  if (candidate.runId !== env.runId || candidate.runAttempt !== env.runAttempt || candidate.repository !== inputs.repository ||
    candidate.upstream !== inputs.upstream || (inputs.branch && candidate.branch !== inputs.branch) ||
    (inputs.upstreamBranch && candidate.upstreamBranch !== inputs.upstreamBranch) || candidate.verifyCommand !== (inputs.verifyCommand ?? null)) {
    throw new AutopatchError('FAILED_TAMPERED', 'candidate does not match this run, repository, branch, upstream, or verification command');
  }
}

/** Verification executes source without a publishing key. Publication only inspects Git objects. */
export async function runPhase(inputs: Inputs, env: RunEnv, deps: RunDeps): Promise<RunReport> {
  const { log } = deps;
  const phase = inputs.phase;
  if (phase !== 'verify' && phase !== 'publish' && phase !== 'report') throw new Error('runPhase requires verify, publish, or report');
  const base = path.join(env.runnerTemp, `autopatch-${phase}`);
  await fs.rm(base, { recursive: true, force: true });
  const resultsDir = path.join(base, 'results');
  await fs.mkdir(resultsDir, { recursive: true });
  const now = new Date().toISOString();
  if (phase === 'report') {
    if (!inputs.artifactDir || !inputs.resultsDigest) throw new Error('report requires artifact_dir and results_digest from the failed job');
    const failed = await readBoundJson(path.join(inputs.artifactDir, 'results.json'), inputs.resultsDigest) as RunReport;
    if (failed.repository !== inputs.repository || failed.upstream !== inputs.upstream || failed.runId !== env.runId || !failed.state.startsWith('FAILED_')) {
      throw new AutopatchError('FAILED_TAMPERED', 'failure report does not match this run');
    }
    if (deps.issues && !inputs.dryRun) {
      const [owner, repo] = inputs.repository.split('/') as [string, string];
      const url = await upsertFailureIssue(deps.issues, owner, repo, inputs.branch ?? failed.plan?.branch ?? 'default branch',
        renderSummary(failed, { forIssue: true, runUrl: env.runUrl }), log);
      failed.notes.push(`issue: ${url}`);
    }
    await writeResults(resultsDir, failed, null);
    return failed;
  }
  const report: RunReport = { state: 'FAILED_GATE', reason: '', repository: inputs.repository, upstream: inputs.upstream,
    runId: env.runId, startedAt: now, finishedAt: now, plan: null, outcome: null, consensus: null, gates: null,
    publish: null, tempBranch: null, headSha: null, leftoverBranches: [], costUsd: 0, agentCalls: 0, notes: [], error: null };
  try {
    if (!inputs.artifactDir || !inputs.candidateDigest) throw new AutopatchError('FAILED_PLAN', 'artifact_dir and candidate_digest from the prepare job are required');
    const { git, candidate, plan } = await importCandidate(inputs.artifactDir, inputs.candidateDigest, path.join(base, 'repo'), phase === 'publish');
    checkContext(candidate, inputs, env);
    report.plan = candidate.kind === 'fast_forward' ? { kind: 'fast_forward', branch: candidate.branch, branchSha: candidate.originalSha,
      upstreamBranch: candidate.upstreamBranch, upstreamRef: plan.upstreamRef, upstreamSha: candidate.upstreamSha } : plan;
    report.headSha = candidate.headSha;
    report.outcome = { headSha: candidate.headSha, conflictsResolved: 0,
      mapping: new Map(candidate.patches.filter(p => p.current !== null).map(p => [p.original, p.current!])),
      records: candidate.patches.map((p, i) => ({ sha: p.original, subject: plan.patches[i]!.subject, result: p.result,
        newSha: p.current, conflicts: [], report: null, extraPaths: [] })) };

    if (phase === 'verify') {
      const gates = await runGates({ git, plan, expectedCount: report.outcome.mapping.size, verifyCommand: inputs.verifyCommand,
        verifyTimeoutMs: inputs.agentTimeoutMinutes * 60_000, env: buildChildEnv(), log, sandbox: inputs.sandbox ?? false });
      report.gates = gates;
      if (!gates.ok) throw new AutopatchError('FAILED_GATE', 'isolated verification failed', gates.failures);
      await assertCandidate(git, candidate);
      report.artifactDir = path.join(resultsDir, 'verification');
      await fs.mkdir(report.artifactDir);
      const file = path.join(report.artifactDir, 'verification.json');
      await fs.writeFile(file, JSON.stringify(verificationSchema.parse({ version: 1, runId: env.runId, runAttempt: env.runAttempt,
        candidateDigest: inputs.candidateDigest, headSha: candidate.headSha, treeSha: candidate.treeSha,
        verifyCommand: inputs.verifyCommand ?? null, passed: true }), null, 2));
      report.artifactDigest = await fileDigest(file);
      report.state = 'VERIFIED';
      report.reason = 'the exact candidate passed verification on a fresh checkout';
    } else {
      if (!inputs.verificationDir || !inputs.verificationDigest) throw new AutopatchError('FAILED_PLAN', 'verification_dir and verification_digest from the verification job are required');
      const verification = verificationSchema.parse(await readBoundJson(path.join(inputs.verificationDir, 'verification.json'), inputs.verificationDigest));
      if (verification.candidateDigest !== inputs.candidateDigest || verification.runId !== env.runId || verification.runAttempt !== env.runAttempt ||
        verification.headSha !== candidate.headSha || verification.treeSha !== candidate.treeSha || verification.verifyCommand !== (inputs.verifyCommand ?? null)) {
        throw new AutopatchError('FAILED_TAMPERED', 'verification belongs to a different candidate, run, or command');
      }
      await git.ensureRemote('origin', inputs.forkRemoteUrl ?? `${env.serverUrl}/${inputs.repository}.git`);
      const remote = await git.authenticated(inputs.token);
      const branch = inputs.branch ?? await remote.remoteDefaultBranch('origin');
      if (branch !== candidate.branch) throw new AutopatchError('FAILED_PLAN', 'candidate branch differs from the maintained branch');
      const checkpointSha = await fetchCheckpoint(remote, branch);
      if ((checkpointSha ?? null) !== candidate.checkpointSha) throw new AutopatchError('FAILED_PUBLISH', 'upstream checkpoint changed since planning');
      const ctx = { git: remote, branch, leaseSha: candidate.originalSha, upstreamSha: candidate.upstreamSha,
        checkpointSha: checkpointSha ?? null, runId: env.runId, runAttempt: env.runAttempt, token: inputs.token, dryRun: inputs.dryRun, log };
      report.tempBranch = tempBranchName(env.runId, env.runAttempt);
      await pushTempBranch(ctx, candidate.headSha, report.tempBranch);
      report.tempBranchRemote = !inputs.dryRun;
      report.leftoverBranches = await listLeftoverBranches(remote, report.tempBranch).catch(() => []);
      if (inputs.publish === 'stage' || !candidate.autoEligible) {
        report.state = 'STAGED';
        report.reason = `${inputs.dryRun ? 'dry run: would stage' : 'staged'} verified candidate on ${report.tempBranch}; default branch was not updated`;
      } else {
        report.publish = await publishBranch(ctx, candidate.headSha, report.tempBranch, inputs.keepBackups);
        report.notes.push(...(report.publish.warnings ?? []));
        report.state = candidate.kind === 'fast_forward' ? 'FAST_FORWARDED' : 'APPROVED';
        report.reason = inputs.dryRun ? 'dry run: verified candidate was not pushed' : `published verified candidate ${candidate.headSha}`;
        if (deps.issues && !inputs.dryRun) {
          const [owner, repo] = inputs.repository.split('/') as [string, string];
          await closeFailureIssue(deps.issues, owner, repo, branch, report.reason, log).catch(e => report.notes.push(`issue cleanup failed: ${String(e)}`));
        }
      }
    }
  } catch (e) {
    report.state = e instanceof AutopatchError ? e.state : phase === 'publish' ? 'FAILED_PUBLISH' : 'FAILED_GATE';
    report.reason = e instanceof Error ? e.message : String(e);
    report.error = { message: report.reason, details: e instanceof AutopatchError ? e.details : [] };
    if (phase === 'publish' && deps.issues && !inputs.dryRun) {
      const [owner, repo] = inputs.repository.split('/') as [string, string];
      await upsertFailureIssue(deps.issues, owner, repo, report.plan?.branch ?? inputs.branch ?? 'default branch', renderSummary(report, { forIssue: true }), log)
        .catch(err => report.notes.push(`issue reporting failed: ${String(err)}`));
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeResults(resultsDir, report, report.gates?.rangeDiff ?? null);
  return report;
}
