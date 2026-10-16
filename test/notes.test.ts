import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeScript } from '../src/agents/fake.js';
import { Git } from '../src/git.js';
import type { Inputs } from '../src/inputs.js';
import { silentLogger } from '../src/log.js';
import { applyNotice, NOTES_SUBJECT, parseForkNotes, renderForkNotes } from '../src/notes.js';
import { runPhase } from '../src/phases.js';
import { run, type RunEnv } from '../src/run.js';
import { absorbPatchUpstream, advanceUpstream, commitFiles, createFixture, type Fixture } from './fixtures/repos.js';

let fx: Fixture;
afterEach(async () => { await fx?.cleanup(); });
const log = silentLogger;
function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return { phase: 'prepare', repository: 'owner/fork', upstream: 'acme/widgets', token: 'dummy', branch: 'main', upstreamBranch: 'main',
    worker: { backend: 'fake', model: '' }, reviewer: { backend: 'fake', model: '' }, initialBase: fx.base,
    maxRounds: 1, maxPatches: 200, maxCostUsd: 10, maxTurns: 10, agentTimeoutMinutes: 1, keepBackups: 10,
    verifyCommand: 'true', publish: 'auto', installClis: false, dryRun: false, sandbox: false, forkNotes: true,
    forkRemoteUrl: fx.originBare, anthropicApiKey: undefined, openaiApiKey: undefined, fakeScript: undefined, ...overrides };
}
function env(runId: string): RunEnv { return { workspace: fx.fork.cwd, runnerTemp: path.join(fx.root, 'runner'), runId, runAttempt: '1', serverUrl: 'https://github.com' }; }

/** prepare → verify → publish with the fake agents; returns the published branch contents. */
async function cycle(runId: string, script: FakeScript = {}) {
  const i = { ...inputs(), upstream: fx.upstreamBare };
  const prepared = await run(i, env(runId), { log, createBackend: () => new FakeBackend(undefined, script) });
  expect(prepared.state, prepared.reason).toBe('PREPARED');
  const next = { ...i, artifactDir: prepared.artifactDir!, candidateDigest: prepared.artifactDigest! };
  const verified = await runPhase({ ...next, phase: 'verify' }, env(runId), { log });
  expect(verified.state, verified.reason).toBe('VERIFIED');
  const published = await runPhase({ ...next, phase: 'publish', verificationDir: verified.artifactDir!, verificationDigest: verified.artifactDigest! }, env(runId), { log });
  expect(published.state, published.reason).toBe('APPROVED');
  const origin = new Git(fx.originBare);
  const main = await origin.revParse('refs/heads/main');
  expect(main).toBe(prepared.headSha);
  const candidate = JSON.parse(await fs.readFile(path.join(prepared.artifactDir!, 'candidate.json'), 'utf8')) as { notesSha: string | null };
  return { prepared, candidate, main, subject: await origin.out(['log', '-1', '--format=%s', main]),
    forkMd: await origin.out(['show', `${main}:FORK.md`]), readme: await origin.out(['show', `${main}:README.md`]) };
}

describe('fork notes', () => {
  it('inserts the README notice under the H1 once and replaces it afterwards', () => {
    const first = applyNotice('# widgets\n\nA library.\n', '<!-- autofork:fork-notice:start -->\n> one\n<!-- autofork:fork-notice:end -->');
    expect(first).toBe('# widgets\n\n<!-- autofork:fork-notice:start -->\n> one\n<!-- autofork:fork-notice:end -->\n\nA library.\n');
    const second = applyNotice(first, '<!-- autofork:fork-notice:start -->\n> two\n<!-- autofork:fork-notice:end -->');
    expect(second).toBe('# widgets\n\n<!-- autofork:fork-notice:start -->\n> two\n<!-- autofork:fork-notice:end -->\n\nA library.\n');
    expect(applyNotice('no heading\n', 'N')).toBe('N\n\nno heading\n');
  });

  it('round-trips entries, README bullets, and the workflow section through FORK.md', () => {
    const entries = [{ subject: 'feat: a', summary: 'Does a.\n\nTwice.', readme: '**A.** Short.' }, { subject: 'ci: b', summary: 'Pipelines.', readme: null }];
    const text = renderForkNotes({ fork: '[o/f](u)', upstream: '[o/u](u)', upstreamBranch: 'main', shas: ['1'.repeat(40), '2'.repeat(40)], entries, workflow: 'make it' });
    const parsed = parseForkNotes(text);
    expect([...parsed.entries.values()]).toEqual(entries);
    expect(parsed.workflow).toBe('make it');
    // A hand-written file without markers is understood too.
    expect(parseForkNotes('# Fork notes\n\n## Commits\n\n### `abc12345` fix: x\n\nHand text.\n\n## Workflow\n\nrun make\n')).toEqual({
      entries: new Map([['fix: x', { subject: 'fix: x', summary: 'Hand text.', readme: null }]]), workflow: 'run make' });
    // Other H2 sections between the commits and the workflow are not swallowed into the last summary.
    expect(parseForkNotes('## Commits\n\n### `abc12345` fix: x\n\nHand text.\n\n## Automation\n\nbot stuff\n\n## Workflow\n\nrun make\n').entries.get('fix: x')!.summary).toBe('Hand text.');
  });

  it('generates, carries over, and regenerates notes across rebases', async () => {
    fx = await createFixture();
    // Bootstrap case: the fork already carries a hand-written FORK.md with a workflow section.
    await commitFiles(fx.fork, { 'FORK.md': '# Fork notes\n\n## Commits\n\n### `00000000` fork: greet shouts\n\nHand-written: greetings are loud.\n\n## Workflow\n\nrun `make`\n' }, 'docs: hand-written fork notes');
    await fx.fork.run(['push', '-q', 'origin', 'main']);
    await advanceUpstream(fx, { 'upstream.txt': 'one\n' }, 'upstream one');

    const first = await cycle('1');
    expect(first.subject).toBe(NOTES_SUBJECT);
    expect(first.candidate.notesSha).toBe(first.main);
    expect(first.prepared.agentCalls).toBe(3); // self-check, review, one summary call for all new commits
    expect(first.forkMd).toContain('This is [owner/fork](https://github.com/owner/fork), a fork of [');
    expect(first.forkMd.match(/^### `[0-9a-f]{8}` /gm)).toHaveLength(4);
    expect(first.forkMd).toContain('Hand-written: greetings are loud.'); // carried over by subject
    expect(first.forkMd).toContain('fake summary of fork: add local notes');
    expect(first.forkMd).toContain('<!-- autofork:workflow:start -->\nrun `make`\n<!-- autofork:workflow:end -->');
    expect(first.readme.startsWith('# widgets\n\n<!-- autofork:fork-notice:start -->\n> **Fork notice.**')).toBe(true);
    expect(first.readme).toContain('> - **fork: add local notes.** scripted');
    expect(first.readme).toContain('[FORK.md](FORK.md). Everything below is the upstream README.');
    expect(first.readme).toContain('A library of widgets.');

    // Upstream absorbs one patch and edits the README right under the H1; the notes commit must not conflict.
    await absorbPatchUpstream(fx, first.prepared.outcome!.mapping.get(fx.patchShas[1]!)!);
    await advanceUpstream(fx, { 'README.md': '# widgets\n\nNow with upstream flair.\n\nA library of widgets.\n' }, 'upstream readme');
    const second = await cycle('2', { notes: { 'fork: add local notes': { summary: 'MUST NOT APPEAR: entries are carried over, not rewritten' } } });
    expect(second.prepared.plan).toMatchObject({ kind: 'rebase', notesSha: first.main });
    expect(second.prepared.plan!.kind === 'rebase' && second.prepared.plan!.patches.map(p => p.subject)).not.toContain(NOTES_SUBJECT);
    expect(second.forkMd.match(/^### `[0-9a-f]{8}` /gm)).toHaveLength(3); // absorbed patch dropped
    expect(second.forkMd).not.toContain('fork: add local notes');
    expect(second.forkMd).not.toContain('MUST NOT APPEAR');
    expect(second.forkMd).toContain('Hand-written: greetings are loud.');
    expect(second.readme.match(/autofork:fork-notice:start/g)).toHaveLength(1);
    expect(second.readme).toContain('Now with upstream flair.');
    expect(second.readme.indexOf('fork-notice:end')).toBeLessThan(second.readme.indexOf('Now with upstream flair.'));
  });

  it('initializes an unchanged fork with agent-free notes and keeps them when nothing moves', async () => {
    fx = await createFixture();
    const first = await cycle('1');
    expect(first.prepared.agentCalls).toBe(0);
    expect(first.subject).toBe(NOTES_SUBJECT);
    expect(await new Git(fx.originBare).revParse(`${first.main}^`)).toBe(fx.patchShas[2]);
    expect(first.forkMd).toContain('### `' + fx.patchShas[0]!.slice(0, 8) + '` fork: greet shouts\n<!-- readme: Greet shouts -->\n\nfork: greet shouts');
    const again = await run({ ...inputs(), upstream: fx.upstreamBare }, env('2'), { log, createBackend: () => new FakeBackend(undefined, {}) });
    expect(again.state, again.reason).toBe('NOTHING_TO_DO');
  });
});
