import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseInputs, readRawInputs } from './inputs.js';
import type { IssuesApi } from './issue.js';
import { coreLogger } from './log.js';
import { renderSummary } from './report.js';
import { run } from './run.js';

async function main(): Promise<void> {
  const inputs = parseInputs(readRawInputs());
  core.setSecret(inputs.token);
  core.setSecret(Buffer.from(`x-access-token:${inputs.token}`).toString('base64'));
  if (inputs.anthropicApiKey) core.setSecret(inputs.anthropicApiKey);
  if (inputs.openaiApiKey) core.setSecret(inputs.openaiApiKey);

  const env = {
    runId: process.env.GITHUB_RUN_ID ?? String(Date.now()),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    runnerTemp: process.env.RUNNER_TEMP ?? '/tmp',
    serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
  };
  const issues = github.getOctokit(inputs.token).rest.issues as unknown as IssuesApi;

  const report = await run(inputs, env, { log: coreLogger, issues });

  core.setOutput('state', report.state);
  core.setOutput('branch_sha', report.headSha ?? '');
  core.setOutput('backup_ref', report.publish?.backupRef ?? '');
  core.setOutput('temp_branch', report.publish?.pushed ? '' : (report.tempBranch ?? ''));
  core.setOutput('results_dir', `${env.runnerTemp}/autopatch/results`);
  await core.summary.addRaw(renderSummary(report, { forIssue: false, runUrl: env.runUrl })).write();

  if (report.state.startsWith('FAILED_')) core.setFailed(`${report.state}: ${report.reason}`);
  else core.info(`${report.state}: ${report.reason}`);
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
