import type { AgentRunner } from './agents/runner.js';
import { AutopatchError } from './errors.js';
import { foldChanges } from './fixup.js';
import type { GateResult } from './gates.js';
import type { Git } from './git.js';
import type { Logger } from './log.js';
import type { RebasePlan } from './plan.js';
import { quarantine } from './quarantine.js';
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

  const readOnlyCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    const q = await quarantine(git.cwd, o.holdDir);
    try {
      return await fn();
    } finally {
      await q.restore();
      const dirty = await git.statusPorcelain();
      if (dirty.length > 0) {
        notes.push(`a read-only agent call left the worktree dirty (${dirty.length} path(s)); reset`);
        log.warning(notes[notes.length - 1] as string);
        await git.run(['checkout', '-q', '--', '.']);
        await git.run(['clean', '-fdq']);
      }
    }
  };

  for (let round = 1; round <= o.maxRounds; round++) {
    const entry: RoundHistory = { round, selfCheck: null, verdict: null, syntheticIssues: [], response: null, foldWarnings: [] };
    history.push(entry);
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
        if (verdict.verdict === 'reject' && blocking(verdict.issues).length === 0) {
          notes.push(`round ${round}: reviewer rejected with only minor issues; treated as approval`);
          verdict.verdict = 'approve';
        }
        entry.verdict = verdict;
        log.info(`round ${round}: reviewer ${verdict.verdict} — ${verdict.summary}`);
        issues = blocking(verdict.issues);
        for (const rec of skipped) {
          const decision = verdict.skips_approved.find((s) => rec.sha.startsWith(s.patch.trim().toLowerCase()) || s.patch.trim().toLowerCase().startsWith(rec.sha.slice(0, 7)));
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

      const selfOk = entry.selfCheck.complete;
      const reviewOk = !o.reviewer || (entry.verdict?.verdict === 'approve' && entry.syntheticIssues.length === 0);
      if (selfOk && reviewOk) {
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

    const ids = issues.map((i) => i.id).sort().join(',');
    if (previousIssueIds !== null && ids === previousIssueIds && !previousChangedFiles) {
      const reason = `no progress: the same issues (${ids}) remain after a round with no file changes`;
      log.warning(reason);
      return { state: gates.ok ? 'CONTESTED' : 'GATE_FAILED', rounds: history, gates, headSha: await git.revParse('HEAD'), notes, reason };
    }
    previousIssueIds = ids;

    if (round === o.maxRounds) break;

    const ctx = await context(entry.selfCheck);
    const q = await quarantine(git.cwd, o.holdDir);
    const headBefore = await git.revParse('HEAD');
    let response;
    try {
      response = await o.worker.structured({
        schemaName: 'respond',
        system: respondSystemPrompt(),
        user: respondUserPrompt(ctx, issues),
        cwd: git.cwd,
        mode: 'edit',
        meta: { round: String(round), issueIds: ids },
      });
    } finally {
      await q.restore();
    }
    if ((await git.revParse('HEAD')) !== headBefore || (await git.tryRevParse('REBASE_HEAD')) !== undefined && (await git.run(['rev-parse', '--git-path', 'rebase-merge'])).stdout.trim() === '') {
      throw new AutopatchError('FAILED_TAMPERED', 'worker changed git history while responding to review (it must only edit files)');
    }
    entry.response = response;
    log.info(`round ${round}: worker responded (${response.verdict}) — ${response.summary}; ${response.files_changed.length} file(s) changed`);

    const dirty = await git.statusPorcelain();
    const changedSet = new Set(response.files_changed);
    const unreported = dirty.map((l) => l.slice(3)).filter((p) => !changedSet.has(p));
    if (unreported.length > 0) {
      notes.push(`round ${round}: worker changed unreported files, discarded: ${unreported.join(', ')}`);
      log.warning(notes[notes.length - 1] as string);
      await git.run(['checkout', '-q', '--', ...unreported], { allowFailure: true });
      await git.run(['clean', '-fdq', '--', ...unreported], { allowFailure: true });
    }

    previousChangedFiles = false;
    if (response.files_changed.length > 0) {
      const targets = new Set(response.responses.map((r) => r.target_patch).filter((t): t is string => !!t));
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
  }

  const reason = gates.ok
    ? `no consensus after ${o.maxRounds} round(s)`
    : `deterministic gates still failing after ${o.maxRounds} round(s): ${gates.failures.join('; ')}`;
  log.warning(reason);
  return { state: gates.ok ? 'CONTESTED' : 'GATE_FAILED', rounds: history, gates, headSha: await git.revParse('HEAD'), notes, reason };
}
