import { describe, expect, it, vi } from 'vitest';
import { closeFailureIssue, issueTitle, upsertFailureIssue, type IssuesApi } from '../src/issue.js';
import { silentLogger } from '../src/log.js';
import { renderSummary, type RunReport } from '../src/report.js';

function stubApi(existing: { number: number; title: string }[] = []): IssuesApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listForRepo: vi.fn(async () => ({ data: existing })),
    create: vi.fn(async () => {
      calls.push('create');
      return { data: { number: 7, html_url: 'https://github.com/o/r/issues/7' } };
    }),
    update: vi.fn(async (p: { issue_number: number; state?: string }) => {
      calls.push(`update:${p.issue_number}:${p.state ?? 'body'}`);
      return { data: { html_url: `https://github.com/o/r/issues/${p.issue_number}` } };
    }),
    createComment: vi.fn(async (p: { issue_number: number }) => {
      calls.push(`comment:${p.issue_number}`);
    }),
    getLabel: vi.fn(async () => {
      throw new Error('404');
    }),
    createLabel: vi.fn(async () => {
      calls.push('label');
    }),
  };
}

describe('issues', () => {
  it('creates a labeled issue when none is open', async () => {
    const api = stubApi();
    const url = await upsertFailureIssue(api, 'o', 'r', 'main', 'body', silentLogger);
    expect(url).toBe('https://github.com/o/r/issues/7');
    expect(api.calls).toEqual(['label', 'create']);
  });

  it('updates the open issue and comments', async () => {
    const api = stubApi([{ number: 3, title: issueTitle('main') }, { number: 4, title: 'unrelated' }]);
    const url = await upsertFailureIssue(api, 'o', 'r', 'main', 'body', silentLogger);
    expect(url).toBe('https://github.com/o/r/issues/3');
    expect(api.calls).toEqual(['label', 'update:3:body', 'comment:3']);
  });

  it('closes the open issue after success and is a no-op otherwise', async () => {
    const api = stubApi([{ number: 3, title: issueTitle('main') }]);
    await closeFailureIssue(api, 'o', 'r', 'main', 'fixed', silentLogger);
    expect(api.calls).toEqual(['comment:3', 'update:3:closed']);
    const none = stubApi();
    await closeFailureIssue(none, 'o', 'r', 'main', 'fixed', silentLogger);
    expect(none.calls).toEqual([]);
  });
});

describe('renderSummary', () => {
  const base: RunReport = {
    state: 'FAILED_CONTESTED',
    reason: 'no consensus after 3 round(s)',
    repository: 'matt/widgets',
    upstream: 'acme/widgets',
    runId: '99',
    startedAt: 't',
    finishedAt: 't',
    plan: {
      kind: 'rebase',
      branch: 'main',
      upstreamBranch: 'main',
      upstreamRef: 'refs/remotes/upstream/main',
      branchSha: 'a'.repeat(40),
      upstreamSha: 'b'.repeat(40),
      base: 'c'.repeat(40),
      patches: [{ sha: 'd'.repeat(40), subject: 'fork: thing', author: 'me', absorbed: false }],
      expectedSurvivors: 1,
      upstreamCommits: 5,
      workflowPaths: ['.github/workflows/ci.yml'],
    },
    outcome: {
      headSha: 'e'.repeat(40),
      conflictsResolved: 1,
      mapping: new Map([['d'.repeat(40), 'e'.repeat(40)]]),
      records: [
        {
          sha: 'd'.repeat(40),
          subject: 'fork: thing',
          result: 'applied',
          newSha: 'e'.repeat(40),
          conflicts: [{ path: 'x.js', kind: 'content', binary: false, stages: [1, 2, 3] }],
          report: null,
          extraPaths: [],
        },
      ],
    },
    consensus: {
      state: 'CONTESTED',
      reason: 'no consensus after 3 round(s)',
      headSha: 'e'.repeat(40),
      notes: [],
      gates: { candidate: { headSha: 'e'.repeat(40), treeSha: 'f'.repeat(40) }, ok: true, failures: [], rangeDiff: '', changedFiles: [], verify: { command: 'npm test', code: 0, timedOut: false, durationMs: 1000, outputTail: 'ok' } },
      rounds: [
        {
          round: 1,
          selfCheck: { complete: true, concerns: [], summary: 'fine' },
          verdict: { verdict: 'reject', summary: 'nope', issues: [{ id: 'I1', severity: 'blocker', patch: null, file: 'x.js', description: 'wrong', suggested_fix: null }], skips_approved: [], checked: { range_diff: true, verify_log: true, commands_run: [] } },
          syntheticIssues: [],
          response: { verdict: 'approve', responses: [], files_changed: [], summary: 'disagree' },
          foldWarnings: [],
        },
      ],
    },
    gates: null,
    publish: null,
    tempBranch: 'autofork/99-1',
    tempBranchRemote: true,
    headSha: 'e'.repeat(40),
    leftoverBranches: ['autofork/42-1'],
    costUsd: 1.5,
    agentCalls: 4,
    notes: ['a note'],
    error: null,
  };

  it('renders the summary with rescue instructions for issues', () => {
    const md = renderSummary(base, { forIssue: true, runUrl: 'https://example/run' });
    expect(md).toContain('❌ FAILED_CONTESTED');
    expect(md).toContain('| patches | 1 (1 expected to survive) |');
    expect(md).toContain('workflow files touched');
    expect(md).toContain('applied, 1 conflict(s) resolved');
    expect(md).toContain('[I1] blocker: wrong');
    expect(md).toContain('How to finish by hand');
    expect(md).toContain("git checkout -b autofork-rescue 'origin/autofork/99-1'");
    expect(md).toContain(`--force-with-lease=main:${'a'.repeat(40)}`);
    expect(md).toContain('autofork/42-1');
    expect(md).toContain('https://example/run');
  });

  it('omits rescue instructions in the job summary', () => {
    const md = renderSummary({ ...base, state: 'APPROVED', reason: 'agreed' }, { forIssue: false });
    expect(md).toContain('✅ APPROVED');
    expect(md).not.toContain('How to finish by hand');
  });
});
