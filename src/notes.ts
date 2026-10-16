import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentRunner } from './agents/runner.js';
import { AutoforkError } from './errors.js';
import { repoUrl, type Git } from './git.js';
import type { Logger } from './log.js';
import type { RebasePlan } from './plan.js';
import { fence, schemaInstruction, UNTRUSTED_NOTE } from './prompts/common.js';

/**
 * Fork notes: FORK.md (one section per fork commit) and a fork notice at the top of the README.
 * Both are regenerated after every rebase as a single commit at the top of the series. The previous
 * notes commit is dropped before the rebase starts, so it never conflicts with upstream.
 */
export const NOTES_SUBJECT = 'docs: update fork notes';
const FORK_MD = 'FORK.md';
const README_CANDIDATES = ['README.md', 'readme.md', 'README/README.md'];
const NOTICE = { start: '<!-- autofork:fork-notice:start -->', end: '<!-- autofork:fork-notice:end -->' };
const WORKFLOW = { start: '<!-- autofork:workflow:start -->', end: '<!-- autofork:workflow:end -->' };
const README_COMMENT = /^<!-- readme: (.*) -->$/;

export interface NotesEntry {
  subject: string;
  /** Paragraph for FORK.md. */
  summary: string;
  /** README bullet, or null for changes with no user-visible effect. */
  readme: string | null;
}

export interface NotesCommitInput {
  subject: string;
  /** Commit body without trailers. */
  body: string;
  /** `git show --stat -p`, capped. */
  diff: string;
}

export type Summarizer = (commits: NotesCommitInput[]) => Promise<NotesEntry[]>;

function isNotesPath(p: string): boolean {
  return p === FORK_MD || /(^|\/)readme\.md$/i.test(p);
}

/** True when the commit carries the notes subject and touches only FORK.md and READMEs. */
export async function isNotesCommit(git: Git, sha: string): Promise<boolean> {
  if ((await git.out(['log', '-1', '--format=%s', sha])) !== NOTES_SUBJECT) return false;
  const paths = await git.paths(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha]);
  return paths.length > 0 && paths.every(isNotesPath);
}

export async function assertNotesCommit(git: Git, sha: string): Promise<void> {
  if (!(await isNotesCommit(git, sha))) throw new AutoforkError('FAILED_GATE', `${sha.slice(0, 12)} is not a fork notes commit`);
}

export function stripTrailers(body: string): string {
  return body.replace(/\s+$/, '').replace(/(?:^|\n)(?:[A-Za-z][\w-]*: [^\n]*\n?)+$/, '').trim();
}

/** Existing FORK.md → entries by subject plus the hand-written workflow section. */
export function parseForkNotes(text: string): { entries: Map<string, NotesEntry>; workflow: string | null } {
  const entries = new Map<string, NotesEntry>();
  const [, commitsPart = '', workflowPart] = /^([\s\S]*?)(?:\n## Workflow\n([\s\S]*))?$/.exec(text) ?? [];
  for (const section of commitsPart.split(/\n(?=### )/).slice(1)) {
    // A section ends at the next heading of any level; other H2 sections are not carried over.
    const [heading = '', ...rest] = section.split(/\n(?=## )/)[0]!.split('\n');
    const subject = /^### `[0-9a-f]+` (.*)$/.exec(heading)?.[1];
    if (!subject || entries.has(subject)) continue;
    let readme: string | null = null;
    const body = rest.filter(line => {
      const m = README_COMMENT.exec(line);
      if (m) readme = m[1]!;
      return !m;
    });
    entries.set(subject, { subject, summary: body.join('\n').trim(), readme });
  }
  let workflow: string | null = null;
  if (workflowPart !== undefined) {
    const marked = new RegExp(`${WORKFLOW.start}\\n([\\s\\S]*?)\\n${WORKFLOW.end}`).exec(workflowPart);
    workflow = (marked?.[1] ?? workflowPart).trim() || null;
  }
  return { entries, workflow };
}

function repoLink(spec: string, serverUrl: string): string {
  const url = repoUrl(spec, serverUrl).replace(/\.git$/, '');
  const name = url.split('/').slice(-2).join('/');
  return `[${name}](${url})`;
}

export function renderForkNotes(o: { fork: string; upstream: string; upstreamBranch: string; shas: string[]; entries: NotesEntry[]; workflow: string | null }): string {
  const out = ['# Fork notes', '',
    `This is ${o.fork}, a fork of ${o.upstream}. It tracks upstream \`${o.upstreamBranch}\` and carries the commits below on top. Each entry is one commit.`,
    '', '## Commits'];
  o.entries.forEach((e, i) => {
    out.push('', `### \`${o.shas[i]!.slice(0, 8)}\` ${e.subject}`);
    if (e.readme) out.push(`<!-- readme: ${e.readme} -->`);
    out.push('', e.summary);
  });
  if (o.workflow) out.push('', '## Workflow', WORKFLOW.start, o.workflow, WORKFLOW.end);
  return `${out.join('\n')}\n`;
}

export function renderNotice(o: { fork: string; upstream: string; bullets: string[]; forkMdLink: string }): string {
  const lines = [`**Fork notice.** This is ${o.fork}, a fork of ${o.upstream} that tracks upstream and carries these changes:`];
  if (o.bullets.length) lines.push('', ...o.bullets.map(b => `- ${b}`));
  lines.push('', `Per-commit details are in [FORK.md](${o.forkMdLink}). Everything below is the upstream README.`);
  return [NOTICE.start, ...lines.map(l => (l ? `> ${l}` : '>')), NOTICE.end].join('\n');
}

/** Replace the marked notice, or insert it directly under the first H1 (or at the top). */
export function applyNotice(readme: string, notice: string): string {
  const marked = new RegExp(`${NOTICE.start}[\\s\\S]*?${NOTICE.end}`);
  if (marked.test(readme)) return readme.replace(marked, notice);
  const h1 = /^# .*$/m.exec(readme);
  if (!h1) return `${notice}\n\n${readme}`;
  const at = h1.index + h1[0].length;
  return `${readme.slice(0, at)}\n\n${notice}${readme.slice(at)}`;
}

/** Deterministic fallback when no agent is available: body as the summary, subject as the bullet. */
export function fallbackEntry(c: NotesCommitInput): NotesEntry {
  const m = /^(\w+)(?:\([^)]*\))?!?: (.*)$/.exec(c.subject);
  const type = m?.[1]?.toLowerCase();
  const visible = !type || !['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test'].includes(type);
  const text = (m?.[2] ?? c.subject).trim();
  return { subject: c.subject, summary: c.body || c.subject, readme: visible ? text[0]!.toUpperCase() + text.slice(1) : null };
}

const NOTES_SYSTEM = [
  'You document a personal fork of an open-source project. Given the fork\'s commits (message and diff), write for each one a FORK.md paragraph and, when the change is user-visible, a README bullet.',
  UNTRUSTED_NOTE,
  'You may read files in the repository to understand a change, but do not modify anything.',
  schemaInstruction('notes'),
].join('\n\n');

function notesUserPrompt(commits: NotesCommitInput[]): string {
  const parts = ['For each commit below return one entry with:',
    '- `subject`: the subject line exactly as given.',
    '- `summary`: one or two plain-prose paragraphs saying what the commit does and why. Use the commit body when it has one; otherwise derive it from the diff. No headings, no bullet lists, no trailers.',
    '- `readme`: for a user-visible feature or fix, one short bullet of the form "**Short lead.** One sentence of detail." For CI, docs, refactors, tests, or build changes with no user-visible effect, null.',
    ''];
  commits.forEach((c, i) => {
    parts.push(`## Commit ${i + 1}: ${c.subject}`, '', c.body ? `Body:\n${fence(c.body)}` : 'Body: (none)', '', 'Diff:', fence(c.diff, 'diff'), '');
  });
  return parts.join('\n');
}

/** Summarize with the worker agent, read-only, one call for all new commits. */
export function agentSummarizer(runner: AgentRunner, cwd: string): Summarizer {
  return async commits => {
    const result = await runner.structured({ schemaName: 'notes', system: NOTES_SYSTEM, user: notesUserPrompt(commits), cwd, mode: 'readonly',
      meta: { subjects: commits.map(c => c.subject).join('\n') } });
    return result.entries;
  };
}

export interface UpdateNotesOptions {
  /** Bound to the worktree, checked out at the rebased series tip with a clean status. */
  git: Git;
  plan: RebasePlan;
  /** Current shas of the surviving patches, in order. */
  survivors: string[];
  repository: string;
  upstream: string;
  serverUrl: string;
  summarize?: Summarizer | null;
  log: Logger;
  diffCap?: number;
}

/** Regenerate FORK.md and the README notice and commit them on top. Returns the commit sha, or null when nothing changed. */
export async function updateForkNotes(o: UpdateNotesOptions): Promise<string | null> {
  const { git, plan } = o;
  const previous = plan.notesSha ? `${plan.notesSha}:${FORK_MD}` : `HEAD:${FORK_MD}`;
  const existing = parseForkNotes(await git.out(['show', previous], { allowFailure: true }).catch(() => ''));

  const commits: NotesCommitInput[] = [];
  for (const sha of o.survivors) {
    const [subject = '', ...body] = (await git.out(['log', '-1', '--format=%s%n%b', sha])).split('\n');
    const diff = await git.out(['show', '--format=', '--stat', '-p', '--no-color', sha]);
    const cap = o.diffCap ?? 12_000;
    commits.push({ subject, body: stripTrailers(body.join('\n')), diff: diff.length > cap ? `${diff.slice(0, cap)}\n… (truncated)` : diff });
  }

  const pending = commits.filter(c => !existing.entries.has(c.subject));
  const fresh = new Map<string, NotesEntry>();
  if (pending.length && o.summarize) {
    try {
      for (const e of await o.summarize(pending)) if (pending.some(c => c.subject === e.subject)) fresh.set(e.subject, e);
    } catch (err) {
      o.log.warning(`fork notes summarizer failed, using commit messages instead: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const entries = commits.map(c => existing.entries.get(c.subject) ?? fresh.get(c.subject) ?? fallbackEntry(c));

  const fork = repoLink(o.repository, o.serverUrl);
  const upstream = repoLink(o.upstream, o.serverUrl);
  await fs.writeFile(path.join(git.cwd, FORK_MD), renderForkNotes({ fork, upstream, upstreamBranch: plan.upstreamBranch, shas: o.survivors, entries, workflow: existing.workflow }));
  const files = [FORK_MD];
  for (const rel of README_CANDIDATES) {
    const abs = path.join(git.cwd, rel);
    const readme = await fs.readFile(abs, 'utf8').catch(() => null);
    if (readme === null) continue;
    const forkMdLink = path.posix.relative(path.posix.dirname(rel), FORK_MD);
    await fs.writeFile(abs, applyNotice(readme, renderNotice({ fork, upstream, bullets: entries.flatMap(e => e.readme ? [e.readme] : []), forkMdLink })));
    files.push(rel);
    break;
  }

  await git.run(['add', '--', ...files]);
  if ((await git.run(['diff', '--cached', '--quiet'], { allowFailure: true })).code === 0) return null;
  await git.run(['commit', '-q', '--no-verify', '-m', NOTES_SUBJECT]);
  return git.revParse('HEAD');
}
