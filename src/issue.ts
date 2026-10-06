import type { Logger } from './log.js';

/** Minimal Octokit surface used here, so tests can pass a stub. */
export interface IssuesApi {
  listForRepo(params: { owner: string; repo: string; state: 'open'; labels: string; per_page: number }): Promise<{ data: { number: number; title: string }[] }>;
  create(params: { owner: string; repo: string; title: string; body: string; labels: string[] }): Promise<{ data: { number: number; html_url: string } }>;
  update(params: { owner: string; repo: string; issue_number: number; body?: string; state?: 'open' | 'closed'; state_reason?: 'completed' }): Promise<{ data: { html_url: string } }>;
  createComment(params: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
  getLabel(params: { owner: string; repo: string; name: string }): Promise<unknown>;
  createLabel(params: { owner: string; repo: string; name: string; color: string; description: string }): Promise<unknown>;
}

export const ISSUE_LABEL = 'autopatch';

export function issueTitle(branch: string): string {
  return `autopatch: rebase of ${branch} needs attention`;
}

async function ensureLabel(api: IssuesApi, owner: string, repo: string): Promise<void> {
  try {
    await api.getLabel({ owner, repo, name: ISSUE_LABEL });
  } catch {
    await api.createLabel({ owner, repo, name: ISSUE_LABEL, color: '7057ff', description: 'Opened by the autopatch action when a rebase needs a human' }).catch(() => undefined);
  }
}

async function findOpen(api: IssuesApi, owner: string, repo: string, title: string): Promise<number | undefined> {
  const { data } = await api.listForRepo({ owner, repo, state: 'open', labels: ISSUE_LABEL, per_page: 50 });
  return data.find((i) => i.title === title)?.number;
}

/** Create the failure issue, or update the body of the open one. Returns its URL. */
export async function upsertFailureIssue(api: IssuesApi, owner: string, repo: string, branch: string, body: string, log: Logger): Promise<string> {
  await ensureLabel(api, owner, repo);
  const title = issueTitle(branch);
  const existing = await findOpen(api, owner, repo, title);
  if (existing) {
    const { data } = await api.update({ owner, repo, issue_number: existing, body });
    await api.createComment({ owner, repo, issue_number: existing, body: 'A new autopatch run failed; the issue body was updated with the latest details.' });
    log.info(`updated issue #${existing}`);
    return data.html_url;
  }
  const { data } = await api.create({ owner, repo, title, body, labels: [ISSUE_LABEL] });
  log.info(`opened issue #${data.number}`);
  return data.html_url;
}

/** Close the open failure issue after a successful publish. */
export async function closeFailureIssue(api: IssuesApi, owner: string, repo: string, branch: string, comment: string, log: Logger): Promise<void> {
  const existing = await findOpen(api, owner, repo, issueTitle(branch));
  if (!existing) return;
  await api.createComment({ owner, repo, issue_number: existing, body: comment });
  await api.update({ owner, repo, issue_number: existing, state: 'closed', state_reason: 'completed' });
  log.info(`closed issue #${existing}`);
}
