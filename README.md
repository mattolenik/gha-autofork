# gha-autopatch

A GitHub Action that keeps a personal fork rebased on top of upstream.

Your fork's default branch is treated as **upstream + a short series of your own patches**. On a
schedule the action fetches upstream, replays your patches onto the new upstream tip, uses an AI agent
to resolve only the conflicts git cannot, has a second agent from a different provider review and
challenge the result until both agree, and force-pushes the rebased branch with a backup of the old tip.

The history stays readable (`git log upstream/main..main` is exactly your patches), upstreaming or
dropping a patch is a one-commit edit, and you never merge.

Scope: the default branch only. No tags, releases, or merges.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture and the reasoning behind it.

## How a run works

1. **Plan.** Fetch upstream, find the merge base, list your patches. Fail early if the fork history
   is not a linear series over an upstream commit. Patches already merged upstream are noted.
2. **Rebase.** `git rebase` onto the new upstream in a detached worktree. Clean patches apply without
   any AI involvement. On each conflict the **worker** agent edits files only; the orchestrator stages
   exactly the files it reports, rejects leftover conflict markers or stray files, and continues.
3. **Gates.** No unmerged paths, no markers, patch count balances (absorbed, emptied, and skipped
   patches accounted for), `git range-diff` produced, your `verify_command` passes.
4. **Consensus.** The worker self-checks its result. The **reviewer** (other provider, read-only) gets
   the range-diff, the diff, the verify log, and the worker's reports, and returns a structured verdict.
   Disagreements go back to the worker, which fixes or rebuts. Fixes are folded into the owning patch
   so the history is still `upstream + patches`. The loop ends when both agree, on no progress, or at
   `max_rounds`. A contested result is never published.
5. **Publish.** Save the old tip under `refs/autopatch/backup/<date>-<run>/<branch>`, force-push with
   `--force-with-lease`, delete the temporary branch.
6. **Failure.** The temporary branch is kept and an issue labeled `autopatch` is opened or updated with
   the reviewer's objections, the conflict list, and the commands to finish by hand.

## Setup

1. **Create a token.** A fine-grained PAT (or a GitHub App installation token) scoped to the fork with
   **Contents: read/write, Workflows: read/write, Issues: read/write**. The default `GITHUB_TOKEN`
   cannot push files under `.github/workflows/`, which the rebased tree carries on most runs, and its
   pushes do not trigger your other workflows. Add it to the fork as the secret `AUTOPATCH_TOKEN`.
2. **Add provider keys** as secrets: `ANTHROPIC_API_KEY` for the `claude` backend, `OPENAI_API_KEY`
   for the `codex` backend. Subscription OAuth tokens are not supported; the agents run in bare,
   non-interactive modes that accept API keys only.
3. **Allow force pushes.** If the fork has a ruleset or branch protection blocking force pushes, add the
   token owner as a bypass actor.
4. **Enable Actions** in the fork (forks have them disabled by default), then commit
   [examples/fork-workflow.yml](examples/fork-workflow.yml) as `.github/workflows/autopatch.yml`. The
   workflow file is simply one of your patches.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
    persist-credentials: false   # keep the token out of .git/config
- uses: mattolenik/gha-autopatch@v1
  with:
    upstream: OWNER/REPO
    token: ${{ secrets.AUTOPATCH_TOKEN }}
    worker: claude:claude-opus-5-5
    reviewer: codex:gpt-6.1-sol
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    verify_command: npm ci && npm test
```

Run it once with `dry_run: true` from the Actions tab to see the plan, transcripts, and range-diff as
artifacts before letting it push.

## Inputs

| input | default | description |
|---|---|---|
| `upstream` | required | Upstream repository, `owner/repo` or URL |
| `upstream_branch` | upstream's default | Branch to rebase onto |
| `branch` | fork's default | Branch to maintain |
| `repository` | current repo | Fork to maintain, for driving a fork from another repository |
| `token` | required | PAT or App token with Contents, Workflows, Issues write |
| `worker` | required | `backend:model`, backend is `claude` or `codex` |
| `reviewer` | none | `backend:model`; use the other provider. Empty disables independent review |
| `max_rounds` | `3` | Review rounds before the result is treated as contested |
| `verify_command` | none | Shell command run after the rebase and after every review fix |
| `max_patches` | `200` | Fail if the fork carries more patches than this |
| `max_cost_usd` | `10` | Abort when reported agent spend exceeds this |
| `max_turns` | `60` | Agent turns per invocation |
| `agent_timeout_minutes` | `30` | Wall-clock limit per agent invocation and for the verify command |
| `keep_backups` | `10` | Backup refs to keep |
| `publish` | `auto` | `stage` pushes the temporary branch and stops instead of force-pushing |
| `install_clis` | `true` | Install missing agent CLIs on the runner |
| `dry_run` | `false` | Do everything except push |
| `anthropic_api_key` / `openai_api_key` | | Provider keys |

Outputs: `state`, `branch_sha`, `backup_ref`, `temp_branch`, `results_dir`. `state` is one of
`APPROVED`, `NOTHING_TO_DO`, `FAST_FORWARDED`, `STAGED`, or `FAILED_PLAN`, `FAILED_REBASE`,
`FAILED_GATE`, `FAILED_CONTESTED`, `FAILED_BUDGET`, `FAILED_TIMEOUT`, `FAILED_AGENT`,
`FAILED_TAMPERED`, `FAILED_PUBLISH`.

`results_dir` contains `results.json`, `range-diff.txt`, and a transcript of every agent call. Upload it
as an artifact (the example workflow does).

## Models

Any model id the CLI accepts works. At the time of writing: `claude:claude-opus-5-5` or
`claude:claude-sonnet-5` for Claude Code; for Codex, run `codex` locally to list current model ids
(Astra, GPT-6.1 Sol, GPT-6 Luna). Use different providers for the worker and reviewer; a review from
the same model family is less independent.

## Security

Upstream code is untrusted input to the agents. The action:

- runs agents in a detached worktree, never in the orchestrator's checkout, with `--bare` (Claude) and
  `--ignore-rules`, `project_doc_max_bytes=0` (Codex) so repository instruction files are not read;
- moves `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.cursorrules` and similar out of the worktree
  around every agent call;
- gives agents file tools plus read-only git only (`diff`, `show`, `log`, `blame`, `grep`, `ls-files`,
  `status`), no network tools, and runs Codex with sandbox network access disabled;
- passes agents and the verify command an allowlisted environment, never `GITHUB_TOKEN`, `INPUT_*` or
  `ACTIONS_*`, and authenticates pushes per command so the token never lands in `.git/config`;
- fingerprints git state around every agent call and fails the run if an agent touched history.

Residual risk: your verify command runs upstream code on the runner with no provider key in its
environment but with network access. Use low-limit API keys and consider `step-security/harden-runner`
with an egress allowlist (see the example workflow).

## When it fails

The temporary branch `autopatch/<run>-<attempt>` stays on the fork and an issue labeled `autopatch`
explains what the reviewer objected to and how to finish by hand:

```sh
git fetch origin autopatch/<run>-<attempt> main
git checkout -b autopatch-rescue origin/autopatch/<run>-<attempt>
git range-diff <old-base>..origin/main <upstream>..HEAD
# fix things, then
git push --force-with-lease=main:<old-sha> origin HEAD:main
git push origin --delete autopatch/<run>-<attempt>
```

Leftover branches from earlier runs are listed in the summary and never deleted automatically. Old
backups beyond `keep_backups` are pruned. Scheduled workflows in public repositories are disabled by
GitHub after 60 days without repository activity; the weekly push normally keeps it alive, and
`workflow_dispatch` is always available.

## What has been verified against the real CLIs

Checked locally with Claude Code 2.1.288 and Codex CLI 0.160.0 (argument parsing only; no live model
calls were made from CI):

- Both CLIs accept the exact argument sets the adapters build. Codex's only complaint was about
  `model_instructions`, which is not a recognized key in 0.160, so the system prompt is now carried at
  the top of the prompt instead (project `AGENTS.md` discovery is disabled, so it is the only instruction
  text the model sees).
- With an invalid `ANTHROPIC_API_KEY`, Claude Code retries the 401 ten times with exponential backoff,
  roughly ten minutes, before giving up. A bad key therefore costs one `agent_timeout_minutes` window,
  not an instant failure. Check keys with a `dry_run` first.
- Still to confirm on a live run: whether `--tools Read,Edit,Write,Grep,Glob,Bash` adds Grep/Glob/Write
  under `--bare` (its default set is Bash, Read, Edit, which is sufficient for the worker either way), and
  that Codex's `workspace-write` sandbox blocks writes to `.git` (the design does not depend on it; the
  orchestrator owns all git state changes regardless).

## Known gaps

- Default branch only; no tag or release handling.
- Two backends, Claude Code and Codex CLI. The adapter interface is small; OpenCode would be the natural
  third backend for other providers.
- Agent and publish run in one job, so token isolation relies on environment scrubbing and tool
  allowlists rather than job boundaries. A two-job split handing the result over as a `git bundle`
  artifact is the planned hardening step.
- `rerere` resolutions are not cached between runs.

## Development

```sh
npm ci
npm test            # vitest; builds real git repositories in temp dirs, no LLM calls
npm run typecheck
npm run build       # bundles dist/index.js (committed; CI checks it is current)
```

`worker: fake` with a `fake_script` JSON file drives the whole pipeline with scripted resolutions and
verdicts; see `test/e2e/*.json` and the `e2e-fake` job in `.github/workflows/ci.yml`.
