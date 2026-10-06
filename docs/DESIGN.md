# gha-autopatch design

gha-autopatch is a GitHub Action that keeps a personal fork of an open-source project rebased on top of
upstream. The fork's default branch is treated as `upstream + P1..Pn`: a short series of personal patches
on top of upstream's default branch. Once a week the action fetches upstream, replays the patch series
onto the new upstream tip, lets AI agents resolve whatever git cannot, has a second agent from a different
provider review the result until both agree, and force-pushes the rebased branch with a backup of the old
tip.

Scope is the default branch only. There is no tag, release, or merge handling.

## Why a rebase bot and not a merge bot

A merge-maintained fork accumulates merge commits and the patch set becomes impossible to read off the
history. A rebase-maintained fork always reads as "upstream, then my changes", `git range-diff` shows
exactly how each patch had to change, and dropping or upstreaming a patch is a one-commit edit. The cost is
that the default branch is force-pushed on every sync, which is acceptable for a fork whose only
consumer is its owner.

## Where the agents run

Everything runs inside one GitHub Actions job on a hosted runner. The runner is already a disposable
VM with git, build tools, network, and a six-hour job limit. Nothing has to be running beforehand.

Alternatives were evaluated and rejected for v1:

- Hosted sandboxes (E2B, Daytona, Modal, Vercel Sandbox, Cloudflare Sandbox, Fly Machines) cost well
  under a dollar a month for this load but add another account, an SDK, and secret plumbing with no
  benefit for a weekly job that finishes in under an hour.
- Anthropic Managed Agents and Claude Code Routines are Claude-only, so they cannot host a Claude-vs-Codex
  reviewer pair.
- Codex cloud has no API-key headless path, and the Copilot cloud agent cannot run arbitrary git commands.

A hosted sandbox becomes worth it only for runs longer than six hours, for state that must persist
between runs, or for organizations that forbid LLM keys in Actions secrets.

The real cost is LLM tokens, roughly $0.50 to $5 per run with frontier models. Runner minutes are free
for public repositories and inside the free allowance for private ones.

## Design principles

1. **Git does the rebase. Agents resolve only what git cannot, then review.** `git rebase --onto` is
   deterministic. The worker agent is invoked per conflicted commit and asked to edit files. Agents never
   run write-capable git commands. The orchestrator owns staging, `--continue`, `--skip`, and fixup
   commits, so there is one code path for every backend and the agent cannot corrupt rebase state.
2. **Never lose history.** The old branch tip is saved under `refs/autopatch/backup/<date>-<run>/<branch>`
   before every force-push. The rebased work is pushed to a temporary branch first so a human can rescue
   it if anything goes wrong.
3. **Deterministic gates outrank agent opinion.** The rebase must finish, the index must have no unmerged
   entries, changed files must have no conflict markers, patch accounting must balance, `git range-diff`
   must be producible, and the user's verify command must pass. Agents cannot approve past a failing gate.
4. **The runner is the sandbox; the job is single.** Agent and verify subprocesses receive an allowlisted
   environment: `PATH`, `HOME`, `TMPDIR`, `TERM`, `LANG`, `CI=1`, and the one LLM key the backend needs.
   They never see `INPUT_*`, `GITHUB_TOKEN`, or `ACTIONS_*` variables.
5. **Stateless and convergent.** There is no state file. Everything is derived from refs. An interrupted
   run leaves the default branch untouched and the next run re-plans from scratch.
6. **Upstream content is untrusted.** Repository instruction files are moved out of the worktree around
   every agent call, each CLI is told to ignore project configuration, agents get read-only git
   allowlists and no network tools, and agents work in a detached worktree rather than the orchestrator's
   checkout.

## Pipeline

```
schedule (weekly, odd minute) or workflow_dispatch
single job, concurrency group per repository

1. checkout   fetch-depth 0, persist-credentials false; unshallow if needed;
              add upstream remote; fetch upstream heads only (no tags)
2. plan       resolve both default branches; record origin/<branch> sha as the push lease
              base = merge-base(upstream, branch)
              fail early on: more than one merge-base, merge commits in base..branch,
                             more than max_patches commits, unrelated histories
              n == 0            → fast-forward branch to upstream and exit
              upstream == base  → nothing to do, exit 0
              absorbed = patches already present upstream (git cherry)
3. rebase     in a detached worktree under RUNNER_TEMP, branch autopatch/<run>
              git rebase --onto upstream base --empty=stop (+ hardened -c config)
              on each stop:
                unmerged paths      → classify (content, modify/delete, add/add, binary)
                                    → quarantine instruction files → worker resolves by editing files
                                    → restore → fingerprint check → stage reported paths only
                                    → empty index? skip (only with skip_patch) : continue
                no unmerged, empty  → patch became empty → skip and record
              gates: no unmerged, no markers, count == n − absorbed − empty − skipped,
                     ancestor(upstream, HEAD), range-diff, verify_command
4. consensus  worker self-check (read-only) → reviewer verdict (other provider, read-only)
              both agree and every skip approved → APPROVED
              otherwise worker responds (fix or rebut); fixes are folded into the owning
              patch with commit --fixup + autosquash; gates rerun; next round
              stops: max_rounds, no progress, budget, timeout, agent error, tampering
5. stage      push temp branch (rescue point); upload transcripts, reports, range-diff
6. publish    backup ref → push --force-with-lease → delete temp branch → prune old backups
7. failure    keep temp branch; create or update an issue labeled autopatch with the
              reviewer's objections, the conflict list, skipped patches, and rescue commands
```

## Rebase mechanics

**Sides are swapped during a rebase.** `ours`/`HEAD` is upstream plus the patches already replayed;
`theirs` is the patch being applied. Every prompt states this explicitly.

**Patch accounting replaces a raw commit count.** Three things legitimately reduce the number of commits
that land:

- A patch was absorbed upstream. `git cherry` marks these before the rebase starts, and git drops them
  automatically.
- A patch became empty after replay. `--empty=stop` halts the rebase so the orchestrator can record it
  and skip it, instead of git silently dropping it.
- The worker decided a patch no longer applies and returned `skip_patch` with a rationale. The reviewer
  must approve every such skip.

The gate is therefore `count(upstream..HEAD) == n − absorbed − became_empty − skipped`.

**Conflicts are detected from the index, not by grepping for markers.** `git ls-files -u` lists
unmerged paths and their stages, which also catches modify/delete, add/add, and binary conflicts where no
marker text exists. Marker grep runs only as a final check on changed files, together with
`git diff --cached --check`. Markdown tables legitimately contain `=======`, so the whole tree is never
grepped.

**Staging is explicit.** The orchestrator stages only the paths the worker reported. A stray file left in
the worktree fails the run rather than landing silently inside a patch. `git add -A` is never used.

**Review edits are folded into the owning patch.** When the worker fixes something during a review round
it names the patch the change belongs to. The orchestrator commits the change with `--fixup` and runs a
non-interactive `rebase --autosquash`, so the history is still `upstream + P1..Pn` with the original
messages and the patch count unchanged.

**Never `-X ours` or `-X theirs`.** These silently resolve conflicts by discarding one side. No strategy
option passthrough exists in v1.

**Agent tampering is detected.** Before and after each agent call the orchestrator fingerprints `HEAD`,
`REBASE_HEAD`, the rebase state directory, all refs, and the stash list. Any difference fails the run.

## Consensus protocol

The worker (provider A) and the reviewer (provider B) are different CLIs, ideally different vendors.

1. After the gates pass, the worker performs a read-only self-check over the range-diff and the verify
   log and states whether it considers the rebase complete.
2. The reviewer, read-only and from the other provider, receives the range-diff, the diff against
   upstream, the per-patch table, the worker's reports, the verify output, and prior rounds. It returns
   `approve` or `reject` with structured issues and an explicit decision on every skipped patch.
3. Consensus is the worker saying complete and the reviewer saying approve in the same round with every
   skip approved. Minor-only rejections are normalized to approvals with notes.
4. Otherwise the worker responds to each issue: fix it (edit files, name the target patch) or rebut it.
   Fixes are folded in, gates rerun, and the next round begins with the rebuttals visible to the
   reviewer.
5. The loop ends at `max_rounds`, or early when the reviewer repeats the same issue set with no file
   changes in between. A contested result is never published.

All verdicts are structured JSON produced through the CLI's schema flag and validated with zod. Prose is
never parsed for a decision.

## Agent backends

An `AgentBackend` runs a prompt in a working directory and returns structured output, text, and cost.
Two backends ship in v1:

- **Claude Code**: `claude --bare -p` with `--output-format json --json-schema`, `--permission-mode
  dontAsk`, our own `--system-prompt`, a tool list limited to file tools plus read-only git subcommands,
  `--strict-mcp-config`, and no session persistence. The reviewer runs with `--restricted` and no Bash.
  `--bare` skips `CLAUDE.md`, hooks, plugins, MCP servers, and the keychain, so authentication is
  `ANTHROPIC_API_KEY` only.
- **Codex CLI**: `codex exec --json --output-schema` with `--ephemeral --ignore-user-config
  --ignore-rules`, `project_doc_max_bytes=0` to disable `AGENTS.md` loading, `approval_policy=never`,
  network disabled in the workspace sandbox, and `--sandbox workspace-write` for the worker or
  `read-only` for the reviewer. `CODEX_HOME` points at a temporary directory.

A `fake` backend applies scripted resolutions and verdicts so the entire pipeline is tested in CI
against real git repositories without any LLM calls.

The interface leaves room for more backends later. OpenCode would be the natural choice for providers
other than Anthropic and OpenAI.

## Security

- **Token scope.** Publishing needs a fine-grained PAT or GitHub App token with Contents write, Workflows
  write, and Issues write. The default `GITHUB_TOKEN` cannot push changes under `.github/workflows/`,
  which the rebased tree carries on most runs, and its pushes do not trigger other workflows.
- **Token never touches disk.** The example workflow uses `persist-credentials: false`, and the
  orchestrator authenticates each push with a per-command `http.extraheader` config value.
- **Environment scrubbing.** Child processes get an explicit allowlisted environment. `INPUT_*`,
  `GITHUB_TOKEN`, and `ACTIONS_*` are never passed through.
- **Instruction-file quarantine.** `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot instructions,
  `.claude/`, `.codex/`, `.agents/`, `.mcp.json`, and OpenCode config are moved out of the worktree
  before every agent call and restored afterwards, before staging.
- **Read-only git for agents.** Bash is limited to `git diff|show|log|blame|grep|ls-files|status`.
  No network tools. The verify command runs under the orchestrator with a scrubbed environment.
- **Residual risk.** The verify command and any tests execute upstream code on the runner. Use
  low-limit API keys and consider an egress allowlist such as `step-security/harden-runner`.

## Failure handling and idempotency

- The default branch is only ever updated in the publish step, with `--force-with-lease` against the sha
  observed at plan time. If someone pushed during the run the push is rejected and the run fails
  cleanly.
- Every failed or contested run keeps its temporary branch and opens or updates an issue labeled
  `autopatch` with rescue commands. Leftover branches from earlier runs are listed, never deleted
  automatically.
- Backups are pruned beyond `keep_backups`, default ten.
- A concurrency group per repository serializes scheduled and manual runs.

## Known gaps in v1

- No tag or release handling.
- No persistence of `rerere` resolutions across runs.
- The agent job and the publish step share one job, so isolation of the GitHub token relies on
  environment scrubbing and tool allowlists rather than job boundaries. A two-job split handing the
  result over as a `git bundle` artifact is the planned hardening step.
