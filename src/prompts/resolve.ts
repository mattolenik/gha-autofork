import type { RebasePlan } from '../plan.js';
import type { ConflictContext } from '../rebase.js';
import { fence, schemaInstruction, SIDE_MAPPING, UNTRUSTED_NOTE } from './common.js';

export function resolveSystemPrompt(): string {
  return [
    'You are resolving a git rebase conflict for a personal fork that carries a small series of patches on top of an open-source project.',
    'The orchestrator ran `git rebase --onto <new upstream>` and stopped on one patch. Your job is to make the working tree contain the correct resolution of that one patch against the new upstream.',
    '',
    'Hard rules:',
    '- Edit files only. Never run git commands that change state (no add, commit, rebase, checkout, stash, reset, rm). Read-only git such as git diff, git show, git log, git blame, git grep, git ls-files, git status is fine.',
    '- Remove every conflict marker (<<<<<<<, |||||||, =======, >>>>>>>) from files you resolve.',
    '- Preserve the intent of the patch with the smallest change that fits the new upstream code. Adopt upstream\'s new structure, names, and APIs rather than reverting upstream changes.',
    '- If the patch is no longer needed because upstream now contains equivalent behavior, or it cannot apply at all, return status "skip_patch" with a clear rationale instead of inventing changes.',
    '- Report every file you touched, including files outside the conflicted set, with an accurate action. Do not touch files you do not report.',
    '- For binary files you cannot edit, choose action "take_upstream" or "take_patch" (or "deleted") and the orchestrator will apply it.',
    `- ${UNTRUSTED_NOTE}`,
    '',
    SIDE_MAPPING,
  ].join('\n');
}

export function resolveUserPrompt(ctx: ConflictContext, plan: RebasePlan): string {
  const parts: string[] = [];
  parts.push(`# Patch ${ctx.index} of ${ctx.total}: ${ctx.patch.subject}`);
  parts.push('');
  parts.push(`Rebasing fork branch \`${plan.branch}\` onto upstream \`${plan.upstreamBranch}\` at ${plan.upstreamSha.slice(0, 12)} (${plan.upstreamCommits} new upstream commits since the old base ${plan.base.slice(0, 12)}).`);
  parts.push('');
  parts.push('## Patch series');
  for (const [i, p] of plan.patches.entries()) {
    const prior = ctx.priorResolutions.find((r) => r.sha === p.sha);
    const marker = i + 1 === ctx.index ? '→' : ' ';
    const state = p.absorbed ? ' (already upstream, dropped)' : prior ? ` (${prior.result}${prior.report ? `: ${prior.report.summary}` : ''})` : '';
    parts.push(`${marker} ${i + 1}. ${p.sha.slice(0, 12)} ${p.subject}${state}`);
  }
  parts.push('');
  parts.push('## Conflicted files');
  for (const c of ctx.paths) {
    const kind = {
      content: 'both sides changed the content',
      deleted_upstream: 'upstream deleted or never had this file; the patch modifies it',
      deleted_by_patch: 'the patch deletes this file; upstream modified it',
      both_added: 'both sides added a file at this path',
      other: 'unusual index state',
    }[c.kind];
    parts.push(`- \`${c.path}\`: ${kind}${c.binary ? ' (binary)' : ''}`);
  }
  if (ctx.previousProblems.length > 0) {
    parts.push('');
    parts.push(`## Problems with your previous attempt (attempt ${ctx.attempt - 1})`);
    for (const p of ctx.previousProblems) parts.push(`- ${p}`);
    parts.push('Fix these and report again.');
  }
  parts.push('');
  parts.push('## The original patch');
  parts.push(fence(ctx.patchShow, 'diff'));
  for (const wc of ctx.workingCopies) {
    parts.push('');
    parts.push(`## Current working copy of \`${wc.path}\` (with conflict markers)`);
    parts.push(wc.content === null ? '_(binary or missing file)_' : fence(wc.content));
  }
  for (const d of ctx.upstreamDelta) {
    parts.push('');
    parts.push(`## What upstream changed in \`${d.path}\` since the old base`);
    parts.push(d.log ? fence(d.log) : '_(no upstream commits touched this path; the conflict comes from the patch side or a rename)_');
    if (d.diff) parts.push(fence(d.diff, 'diff'));
  }
  parts.push('');
  parts.push('You may read any other file in the working directory and run read-only git commands against the repository for more context.');
  parts.push('');
  parts.push(schemaInstruction('resolve report'));
  return parts.join('\n');
}
