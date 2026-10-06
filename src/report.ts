import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ConsensusResult } from './consensus.js';
import type { State } from './errors.js';
import type { GateResult } from './gates.js';
import type { Plan } from './plan.js';
import type { PublishResult } from './publish.js';
import type { RebaseOutcome } from './rebase.js';

export interface RunReport {
  state: State;
  reason: string;
  repository: string;
  upstream: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  plan: Plan | null;
  outcome: RebaseOutcome | null;
  consensus: ConsensusResult | null;
  gates: GateResult | null;
  publish: PublishResult | null;
  tempBranch: string | null;
  tempBranchRemote?: boolean;
  headSha: string | null;
  leftoverBranches: string[];
  costUsd: number;
  agentCalls: number;
  notes: string[];
  error: { message: string; details: string[] } | null;
  unpricedCalls?: number;
  recoveryDir?: string;
  artifactDir?: string;
  artifactDigest?: string;
  backendVersions?: Record<string, string>;
}

export async function writeResults(dir: string, report: RunReport, rangeDiff: string | null): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'results.json');
  await fs.writeFile(
    file,
    JSON.stringify(report, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v), 2),
  );
  if (rangeDiff) await fs.writeFile(path.join(dir, 'range-diff.txt'), rangeDiff);
  return file;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : '—';
}

function fence(text: string, lang = ''): string {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

/** Markdown used for the job summary and, with rescue commands, the failure issue. */
export function renderSummary(r: RunReport, opts: { forIssue: boolean; runUrl?: string | undefined } = { forIssue: false }): string {
  const lines: string[] = [];
  const ok = !r.state.startsWith('FAILED_');
  lines.push(`## autopatch: ${ok ? '✅' : '❌'} ${r.state}`);
  lines.push('');
  lines.push(r.reason);
  if (opts.runUrl) lines.push('', `Run: ${opts.runUrl}`);
  lines.push('');

  const plan = r.plan;
  if (plan) {
    lines.push('| | |', '|---|---|');
    lines.push(`| fork branch | \`${plan.branch}\` @ ${short(plan.branchSha)} |`);
    if (plan.kind === 'rebase' || plan.kind === 'fast_forward') lines.push(`| upstream | \`${r.upstream}\` \`${plan.upstreamBranch}\` @ ${short(plan.upstreamSha)} |`);
    if (plan.kind === 'rebase') {
      lines.push(`| old base | ${short(plan.base)} (${plan.upstreamCommits} new upstream commits) |`);
      lines.push(`| patches | ${plan.patches.length} (${plan.expectedSurvivors} expected to survive) |`);
      if (plan.workflowPaths.length) lines.push(`| workflow files touched | ${plan.workflowPaths.map((p) => `\`${p}\``).join(', ')} |`);
    }
    if (r.headSha) lines.push(`| result | ${short(r.headSha)} |`);
    if (r.tempBranch) lines.push(`| temporary branch | \`${r.tempBranch}\`${r.publish?.pushed ? ' (deleted)' : r.tempBranchRemote ? '' : ' (local only)'} |`);
    if (r.publish?.backupRef) lines.push(`| backup of old tip | \`${r.publish.backupRef}\` |`);
    lines.push(`| agent calls / cost | ${r.agentCalls} / $${r.costUsd.toFixed(2)} |`);
    if (r.unpricedCalls) lines.push(`| unpriced calls | ${r.unpricedCalls} (cost above is incomplete) |`);
    lines.push('');
  }

  if (r.outcome) {
    lines.push('### Patches', '', '| # | original | now | result | subject |', '|---|---|---|---|---|');
    r.outcome.records.forEach((rec, i) => {
      let result: string = rec.result;
      if (rec.result === 'applied' && rec.conflicts.length) result = `applied, ${rec.conflicts.length} conflict(s) resolved`;
      if (rec.result === 'skipped') result = `skipped: ${rec.report?.summary ?? ''}`;
      lines.push(`| ${i + 1} | ${short(rec.sha)} | ${short(rec.newSha)} | ${result} | ${rec.subject} |`);
    });
    lines.push('');
  }

  if (r.consensus) {
    lines.push('### Review rounds', '');
    for (const round of r.consensus.rounds) {
      const parts: string[] = [`**Round ${round.round}**`];
      if (round.syntheticIssues.length) parts.push(`gates: ${round.syntheticIssues.map((i) => i.description.split('\n')[0]).join('; ')}`);
      if (round.selfCheck) parts.push(`worker self-check: ${round.selfCheck.complete ? 'complete' : 'not complete'} — ${round.selfCheck.summary}`);
      if (round.verdict) parts.push(`reviewer: ${round.verdict.verdict} — ${round.verdict.summary}`);
      for (const i of round.verdict?.issues ?? []) parts.push(`  - [${i.id}] ${i.severity}: ${i.description}${i.file ? ` (\`${i.file}\`)` : ''}`);
      if (round.response) parts.push(`worker: ${round.response.verdict} — ${round.response.summary}${round.response.files_changed.length ? ` (changed ${round.response.files_changed.join(', ')})` : ''}`);
      for (const w of round.foldWarnings) parts.push(`  - note: ${w}`);
      lines.push(parts.join('<br>'), '');
    }
  }

  const gates = r.consensus?.gates ?? r.gates;
  if (gates) {
    lines.push('### Gates', '');
    lines.push(gates.ok ? 'All deterministic gates passed.' : `Failed: ${gates.failures.join('; ')}`);
    if (gates.verify) {
      lines.push('', `Verify \`${gates.verify.command}\`: ${gates.verify.timedOut ? 'timed out' : `exit ${gates.verify.code}`}`);
      if (gates.verify.code !== 0 || gates.verify.timedOut) lines.push('', fence(gates.verify.outputTail.slice(-4000)));
    }
    lines.push('');
  }

  if (r.error) {
    lines.push('### Error', '', r.error.message);
    if (r.error.details.length) lines.push('', fence(r.error.details.join('\n').slice(0, 6000)));
    lines.push('');
  }

  for (const n of r.notes) lines.push(`- ${n}`);
  if (r.notes.length) lines.push('');

  if (r.leftoverBranches.length) {
    lines.push('### Leftover branches from earlier runs', '', ...r.leftoverBranches.map((b) => `- \`${b}\``), '', 'These are never deleted automatically. Delete them once you no longer need them.', '');
  }

  if (r.recoveryDir && !r.tempBranchRemote) {
    lines.push(r.outcome ? '### Recover a completed candidate' : '### Resume an incomplete rebase', '', 'Download the results artifact and restore its recovery checkpoint with the trusted recovery tool:', '',
      fence('npx tsx scripts/recover.ts /path/to/results/recovery /path/to/new-rescue-directory', 'sh'), '',
      'The checkpoint includes the original history, completed resolutions, index, and pending rebase commands. Inspect git status and continue the rebase. A partial branch must not be promoted to the default branch.');
  }
  if (opts.forIssue && r.plan && r.tempBranch && r.outcome && r.tempBranchRemote) {
    const branch = r.plan.branch;
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    lines.push('### How to finish by hand', '');
    lines.push('The rebased result (as far as it got) is on the temporary branch. To inspect and finish it locally:', '');
    lines.push(
      fence(
        [
          `git fetch origin ${quote(r.tempBranch)} ${quote(branch)}`,
          `git checkout -b autopatch-rescue ${quote(`origin/${r.tempBranch}`)}`,
          `git range-diff ${r.plan.kind === 'rebase' ? `${short(r.plan.base)}..origin/${branch} ${short(r.plan.upstreamSha)}..HEAD` : ''}`,
          '# fix things, then:',
          `git push ${quote(`--force-with-lease=${branch}:${r.plan.branchSha}`)} origin ${quote(`HEAD:${branch}`)}`,
          `git push origin --delete ${quote(r.tempBranch)}`,
        ].join('\n'),
        'sh',
      ),
    );
    lines.push('', `Or discard it with \`git push origin --delete ${r.tempBranch}\` and let the next scheduled run try again. Close this issue when done.`);
  }
  return lines.join('\n');
}
