import type { AgentRunner } from './agents/runner.js';
import { AutopatchError } from './errors.js';
import { foldChanges, resolvePatchRef } from './fixup.js';
import type { GateResult } from './gates.js';
import type { Git } from './git.js';
import type { Logger } from './log.js';
import type { RebasePlan } from './plan.js';
import { assertCandidate, guardGit, validateFilePath } from './state.js';
import type { RebaseOutcome } from './rebase.js';
import {
  respondSystemPrompt,
  respondUserPrompt,
  reviewSystemPrompt,
  reviewUserPrompt,
  selfCheckSystemPrompt,
  selfCheckUserPrompt,
  type ReviewContext,
  type RoundHistory,
} from './prompts/review.js';
import type { ReviewVerdict } from './schemas.js';

export type ConsensusState = 'APPROVED' | 'CONTESTED' | 'GATE_FAILED';

export interface ConsensusResult {
  state: ConsensusState;
  rounds: RoundHistory[];
  gates: GateResult;
  headSha: string;
  notes: string[];
  /** Why the loop stopped, for the summary and the failure issue. */
  reason: string;
}

export interface ConsensusOptions {
  git: Git;
  plan: RebasePlan;
  outcome: RebaseOutcome;
  worker: AgentRunner;
  reviewer: AgentRunner | null;
  maxRounds: number;
  /** Runs the deterministic gates against the current HEAD. */
  runGates: () => Promise<GateResult>;
  holdDir: string;
  log: Logger;
  caps?: { diff?: number };
  onProgress?: (rounds: RoundHistory[], gates: GateResult) => Promise<void>;
}

type Issue = ReviewVerdict['issues'][number];

function blocking(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.severity !== 'minor');
}

/**
 * Worker self-check → reviewer verdict → (worker responds, fold, rerun gates) until both agree, the
 * rounds run out, or no progress is being made. Gate failures are fed to the worker as blocker issues.
 */
export async function runConsensus(o: ConsensusOptions): Promise<ConsensusResult> {
  const { git, plan, outcome, log } = o;
  const notes: string[] = [];
  const history: RoundHistory[] = [];
  const diffCap = o.caps?.diff ?? 60_000;
  let gates = await o.runGates();
  let previousIssueIds: string | null = null;
  let previousChangedFiles = true;

  const skipped = outcome.records.filter((r) => r.result === 'skipped');

  const context = async (selfCheck: RoundHistory['selfCheck']): Promise<ReviewContext> => {
    const diff = await git.out(['diff', '--no-color', `${plan.upstreamSha}..HEAD`]);
    return {
      plan,
      outcome,
      gates,
      history,
      selfCheck,
      fullDiff: diff.length > diffCap ? `${diff.slice(0, diffCap)}\n… [truncated ${diff.length - diffCap} characters]` : diff,
      diffStat: await git.out(['diff', '--no-color', '--stat', `${plan.upstreamSha}..HEAD`]),
    };
  };

  const readOnlyCall = <T>(fn: () => Promise<T>): Promise<T> => guardGit(git, 'readonly', 'read-only agent', fn);

  for (let round = 1; round <= o.maxRounds; round++) {
    const entry: RoundHistory = { round, selfCheck: null, verdict: null, syntheticIssues: [], response: null, foldWarnings: [] };
    history.push(entry);
    await o.onProgress?.(history, gates);
    let issues: Issue[] = [];

    if (!gates.ok) {
      log.info(`round ${round}: deterministic gates failed (${gates.failures.join('; ')})`);
      entry.syntheticIssues = gates.failures.map((f, i) => ({
        id: `gate-${round}-${i + 1}`,
        severity: 'blocker' as const,
        patch: null,
        file: null,
        description: f + (gates.verify && f.startsWith('verify') ? `\nVerify output (tail):\n${gates.verify.outputTail}` : ''),
        suggested_fix: null,
      }));
      issues = entry.syntheticIssues;
    } else {
      const ctx = await context(null);
      entry.selfCheck = await readOnlyCall(() =>
        o.worker.structured({ schemaName: 'selfcheck', system: selfCheckSystemPrompt(), user: selfCheckUserPrompt(ctx), cwd: git.cwd, mode: 'readonly' }),
      );
      log.info(`round ${round}: worker self-check ${entry.selfCheck.complete ? 'complete' : 'NOT complete'} — ${entry.selfCheck.summary}`);

      if (o.reviewer) {
        const rctx = await context(entry.selfCheck);
        const verdict = await readOnlyCall(() =>
          o.reviewer!.structured({ schemaName: 'review', system: reviewSystemPrompt(), user: reviewUserPrompt(rctx), cwd: git.cwd, mode: 'readonly' }),
        );
        if (verdict.verdict === 'reject' && verdict.issues.length > 0 && blocking(verdict.issues).length === 0) {
          notes.push(`round ${round}: reviewer rejected with only minor issues; treated as approval`);
          verdict.verdict = 'approve';
        }
        entry.verdict = verdict;
        log.info(`round ${round}: reviewer ${verdict.verdict} — ${verdict.summary}`);
        issues = blocking(verdict.issues);
        if (!verdict.checked.range_diff || (gates.verify && !verdict.checked.verify_log)) {
          entry.syntheticIssues.push({ id: 'review-checks', severity: 'blocker', patch: null, file: null,
            description: 'reviewer did not check the patch comparison and configured verification log', suggested_fix: null });
        }
        const decisions = new Map<string, ReviewVerdict['skips_approved'][number]>();
        const skippedMapping = new Map(skipped.map(r => [r.sha, r.sha]));
        for (const decision of verdict.skips_approved) {
          const sha = resolvePatchRef(decision.patch, skippedMapping);
          if (!sha || decisions.has(sha)) throw new AutopatchError('FAILED_AGENT', `invalid, ambiguous, or duplicate skip approval: ${JSON.stringify(decision.patch)}`);
          decisions.set(sha, decision);
        }
        for (const rec of skipped) {
          const decision = decisions.get(rec.sha);
          if (!decision || !decision.approved) {
            entry.syntheticIssues.push({
              id: `skip-${rec.sha.slice(0, 7)}`,
              severity: 'blocker',
              patch: rec.sha,
              file: null,
              description: decision
                ? `reviewer did not approve skipping patch "${rec.subject}": ${decision.reason}`
                : `reviewer did not decide whether skipping patch "${rec.subject}" is acceptable (skips_approved missing)`,
              suggested_fix: null,
            });
          }
        }
        issues = [...issues, ...entry.syntheticIssues];
      }

      const selfOk = entry.selfCheck.complete && entry.selfCheck.concerns.length === 0;
      const reviewOk = !o.reviewer || (entry.verdict?.verdict === 'approve' && issues.length === 0);
      if (selfOk && reviewOk) {
        await assertCandidate(git, gates.candidate);
        await o.onProgress?.(history, gates);
        const reason = o.reviewer ? `worker and reviewer agreed in round ${round}` : `worker self-check passed in round ${round} (no reviewer configured)`;
        log.info(reason);
        return { state: 'APPROVED', rounds: history, gates, headSha: await git.revParse('HEAD'), notes, reason };
      }
      if (!selfOk) {
        entry.selfCheck.concerns.forEach((c, i) =>
          issues.push({ id: `self-${round}-${i + 1}`, severity: 'major', patch: c.patch, file: c.file, description: `(raised by your own self-check) ${c.description}`, suggested_fix: null }),
        );
        if (issues.length === 0) {
          issues.push({ id: `self-${round}`, severity: 'major', patch: null, file: null, description: `(your own self-check) ${entry.selfCheck.summary}`, suggested_fix: null });
        }
      }
    }

    if (issues.length === 0) issues.push({ id: 'review-rejected', severity: 'major', patch: null, file: null,
      description: entry.verdict?.summary ?? 'review has not approved this candidate', suggested_fix: null });
    const ids = issues.map((i) => i.id).sort().join(',');
    const signature = JSON.stringify(issues.map(i => [i.severity, i.patch, i.file, i.description.replace(/\s+/g, ' ').trim()]).sort());
    if (previousIssueIds !== null && signature === previousIssueIds && !previousChangedFiles) {
      const reason = `no progress: the same issues (${ids}) remain after a round with no file changes`;
      log.warning(reason);
      return { state: gates.ok ? 'CONTESTED' : 'GATE_FAILED', rounds: history, gates, headSha: await git.revParse('HEAD'), notes, reason };
    }
    previousIssueIds = signature;

    if (round === o.maxRounds) break;

    const ctx = await context(entry.selfCheck);
    const response = await guardGit(git, 'edit', 'review worker', () => o.worker.structured({
        schemaName: 'respond',
        system: respondSystemPrompt(),
        user: respondUserPrompt(ctx, issues),
        cwd: git.cwd,
        mode: 'edit',
        meta: { round: String(round), issueIds: ids },
      }));
    entry.response = response;
    log.info(`round ${round}: worker responded (${response.verdict}) — ${response.summary}; ${response.files_changed.length} file(s) changed`);

    const dirty = await git.statusPorcelain();
    const changedSet = new Set(response.files_changed);
    for (const file of changedSet) await validateFilePath(git.cwd, file);
    const unreported = dirty.map((l) => l.slice(3)).filter((p) => !changedSet.has(p));
    if (unreported.length > 0) {
      throw new AutopatchError('FAILED_TAMPERED', 'review worker changed unreported files', unreported);
    }

    previousChangedFiles = false;
    if (response.files_changed.length > 0) {
      const targets = new Set(response.responses.map((r) => r.target_patch).filter((t): t is string => !!t));
      for (const target of targets) if (!resolvePatchRef(target, outcome.mapping)) throw new AutopatchError('FAILED_AGENT', `invalid fixup target: ${target}`);
      if (targets.size > 1) throw new AutopatchError('FAILED_AGENT', 'review fixes must target one patch per round; split multi-patch fixes across rounds');
      const fold = await foldChanges({
        git,
        plan,
        outcome,
        files: response.files_changed,
        targetPatch: targets.size === 1 ? [...targets][0]! : null,
        log,
      }).catch((e: unknown) => {
        throw new AutopatchError('FAILED_GATE', `could not fold the worker's review fixes into the patch series: ${e instanceof Error ? e.message : String(e)}`);
      });
      entry.foldWarnings = fold.warnings;
      outcome.mapping = fold.mapping;
      outcome.headSha = fold.headSha;
      for (const rec of outcome.records) if (rec.newSha) rec.newSha = fold.mapping.get(rec.sha) ?? rec.newSha;
      previousChangedFiles = fold.folded.length > 0;
      gates = await o.runGates();
    }
    await o.onProgress?.(history, gates);
  }

  const reason = gates.ok
    ? `no consensus after ${o.maxRounds} round(s)`
    : `deterministic gates still failing after ${o.maxRounds} round(s): ${gates.failures.join('; ')}`;
  log.warning(reason);
  return { state: gates.ok ? 'CONTESTED' : 'GATE_FAILED', rounds: history, gates, headSha: await git.revParse('HEAD'), notes, reason };
}
