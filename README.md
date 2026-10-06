# gha-autopatch

Keep a personal fork as **upstream + your patch series**. Git replays the patches, an agent resolves
conflicts, and an independent agent reviews the result. Verification and publishing run in separate jobs.

The supported automatic-publishing entrypoint is the
[reusable workflow](.github/workflows/autopatch.yml). The JavaScript action exposes the individual phases.

## Setup

1. Enable Actions on your fork and allow the publishing actor to force-push the maintained branch.
2. Create `AUTOPATCH_TOKEN`: a PAT or App installation token scoped to the fork with Contents,
   Workflows, and Issues write. This credential is passed only to publishing and failure reporting.
3. Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the providers you select.
4. Commit [examples/fork-workflow.yml](examples/fork-workflow.yml) as a fork patch. Set upstream, models,
   and a meaningful `verify_command`. Pin the reusable workflow and its action dependency to reviewed
   releases/SHAs before production use.
5. Fetch upstream locally and inspect `git merge-base upstream/main main`. Supply that SHA as
   `initial_base` in the first manual run. Start with `dry_run: true`, inspect the artifacts, then run
   with `dry_run: false` to initialize the checkpoint and publish.

```yaml
permissions:
  contents: read
  actions: read
jobs:
  sync:
    uses: mattolenik/gha-autopatch/.github/workflows/autopatch.yml@v1
    with:
      upstream: OWNER/REPO
      worker: claude:claude-opus-5-5
      reviewer: codex:gpt-6.1-sol
      verify_command: npm ci && npm test
      publish: auto
      # First publication only: initial_base: <inspected merge-base SHA>
    secrets:
      token: ${{ secrets.AUTOPATCH_TOKEN }}
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

The maintained repository defaults to the caller. To drive another fork, set `repository` and supply a
separate **read-only** `read_token` secret. A private upstream can use the separate read-only
`upstream_token` secret. Checkout does not persist credentials; authenticated Git operations scope the
authorization header to the appropriate repository URL, including fetch and branch discovery.

## Pipeline and guarantees

1. **Prepare** — plan from remote refs, reject non-linear or unrelated history, rebase in a worktree,
   resolve conflicts, run gates and the bounded consensus loop. Export a Git bundle and manifest.
   This job has read credentials and provider keys, but no publishing credential.
2. **Verify** — import the digest-bound candidate into a fresh checkout and run the configured
   verification again. This job has neither provider keys nor the publishing credential.
3. **Publish** — import Git objects into a bare repository, validate the candidate and verification
   digests, run identity, ancestry and patch-accounting checks, then update refs. This job never checks
   out or executes repository code.
4. **Report** — a separate credentialed job opens/updates the failure issue if preparation or
   verification fails. Results and recovery checkpoints are retained as artifacts.

Approval is bound to a commit **and tree SHA**. Agent calls are checked for metadata/index tampering;
read-only calls and verification may not alter tracked source or leave untracked files. Ignored build
outputs such as dependencies are permitted. Any candidate change invalidates its previous approval.

Automatic publication requires all of:

- an independent reviewer (different backend from the worker);
- a configured, passing verification command;
- an existing upstream checkpoint or an explicit `initial_base`;
- structurally and semantically valid consensus, with no major/blocker issues and every worker skip
  explicitly approved by an unambiguous patch reference.

Otherwise the verified candidate is **staged** on a temporary branch. The default `publish` value is
`stage`. Fast-forwards follow the same policy and verification pipeline. `dry_run` makes no remote ref
or issue changes.

Publication atomically creates an immutable old-tip backup, updates the maintained branch using its
explicit planning-time lease, and advances `refs/autopatch/upstream/<branch>`. Servers must support
atomic pushes. Cleanup failures after that transaction are warnings, not failed publications.

The upstream checkpoint detects non-fast-forward upstream rewrites. Inspect such a rewrite manually;
if you deliberately reinitialize, remove the old checkpoint ref yourself and supply an inspected new
`initial_base`. A first run without an explicit base can prepare/stage a candidate but cannot publish
automatically. An unchanged fork returns `NOTHING_TO_DO` without initializing a checkpoint.

## Action phases and inputs

**Migration:** the old single-step invocation performed publication. The action now defaults to
`phase: prepare` and only exports artifacts. Use the reusable workflow, or wire the phases into separate
jobs with trusted job outputs and immutable artifact IDs. Never give prepare/verify the publishing key.

| Input | Default | Purpose |
|---|---|---|
| `phase` | `prepare` | `prepare`, `verify`, `publish`, or `report` |
| `upstream` | required | `owner/repo` or repository URL |
| `repository` | caller | Fork to maintain |
| `branch` / `upstream_branch` | remote defaults | Maintained and upstream branches |
| `token` | required | Read credential in prepare/verify; write credential in publish/report |
| `upstream_token` | empty | Separate read credential for a private upstream |
| `initial_base` | empty | Explicit first-run merge-base SHA |
| `worker` / `reviewer` | worker required for prepare | `claude:model` or `codex:model`; reviewer optional |
| `verify_command` | empty | Verification command from trusted workflow configuration |
| `publish` | `stage` | `auto` or `stage`; eligibility still applies |
| `dry_run` | `false` | Do not update remote refs or issues |
| `max_rounds` | `3` | Consensus rounds |
| `max_patches` | `200` | Planning limit |
| `max_cost_usd` | `10` | Reported-cost budget; see backend limitations below |
| `max_turns` | `60` | Claude turn limit; unavailable in Codex |
| `agent_timeout_minutes` | `30` | Each agent invocation and verification command |
| `keep_backups` | `10` | Backups retained per branch |
| `install_clis` | `true` | Install missing pinned CLIs |
| `sandbox` | `true` | Linux bubblewrap required; disable only for trusted local testing |
| `require_hard_limits` | `false` | Reject backends without turn/dollar enforcement |
| `anthropic_api_key` / `openai_api_key` | empty | Provider API keys; prepare only |
| `artifact_dir` / `candidate_digest` | empty | Candidate artifact and prepare-job manifest digest |
| `verification_dir` / `verification_digest` | empty | Verification artifact and verify-job digest |
| `results_digest` | empty | Failed-job results digest for the report phase |

The reusable workflow exposes the common orchestration inputs; advanced limits can be configured when
calling the phase actions directly in separate jobs.

Outputs: `state`, `branch_sha`, `backup_ref`, `temp_branch`, `results_dir`, `results_digest`,
`artifact_dir`, and `artifact_digest`. States include `PREPARED`, `VERIFIED`, `STAGED`, `APPROVED`,
`FAST_FORWARDED`, `NOTHING_TO_DO`, and `FAILED_*` codes. Preparation's temporary branch is local; it is
not a remote rescue branch. A dry-run SHA describes the candidate rather than a remote update.

Candidate manifests include the original/upstream/base SHAs, ordered patch accounting, tree SHA, bundle
digest, run identity, and publication eligibility. Verification commands come from workflow inputs,
never from executable instructions in an artifact. Digests must come from producing-job outputs;
hashing an arbitrary downloaded artifact yourself does not establish its provenance.

## Agent isolation and limits

Linux hosted runners need `bubblewrap` (installed by the reusable workflow). Agent processes have a
separate process namespace, hidden runner home/IPC directories, read-only Git metadata, and only their
worktree and disposable CLI state writable. Reviewer worktrees are mounted read-only. Verification
uses a separate sandbox with no provider key. CLI repository-instruction discovery is disabled;
conflict-time quarantine preserves explicitly conflicted instruction files. These files remain
available as untrusted data during review.

The CLI process needs network access to its provider. Codex additionally disables network access in
its workspace tool sandbox; Claude uses file tools and a Git-command allowlist. Network restrictions
are defense in depth, not a substitute for the separate publishing job. Repository code can still
make network requests during verification. Staged-branch pushes can trigger the fork's other workflows;
configure their branch filters and credentials accordingly.

Pinned versions: **Claude Code 2.1.288**, **Codex CLI 0.160.0**. Existing binaries must match these
versions; versions are recorded in results. API-key authentication is supported, not subscription OAuth.

Claude supports turn and per-call dollar limits. The orchestrator stops before another call when its
known budget is exhausted. Codex supports neither limit and does not report dollars: its calls appear
as `unpricedCalls`, and reported total spend is explicitly incomplete. Wall-clock timeouts apply to
both backends. Set `require_hard_limits: true` to reject unsupported backends. Even supported CLI dollar
limits are provider-reported controls, not a guarantee about final billing.

## Recovery

Failed preparation does not publish an incomplete branch. Download the prepare-results artifact;
`recovery/` contains a history bundle, index entries, worktree files (including binary/symlink data),
rebase metadata, and pending patches. Restore it using this repository's trusted recovery tool:

```sh
npm ci
npx tsx scripts/recover.ts /path/to/results/recovery /path/to/new-rescue-directory
cd /path/to/new-rescue-directory
git status
# Resolve the current conflict, stage exact paths, then continue (or skip an intentionally dropped patch).
git rebase --continue
```

The tool refuses to overwrite an existing directory and does not run the rebase or repository scripts.
Inspect the whole patch series and rerun verification before manually promoting a recovered result.
Checkpoints are updated at rebase stops, after resolutions, and during review. A force-killed process
can require replaying work after the last completed checkpoint; artifact upload also requires the runner
to remain available. Reports distinguish incomplete rebases from completed but contested candidates.

## Development

Use Node 24+ and Git 2.45+ (the rebase engine requires `--empty=stop`). Linux sandbox tests also
require bubblewrap. When testing inside Podman, nested namespaces need
`--security-opt seccomp=unconfined --security-opt unmask=ALL`; mount the source read-only and install
dependencies into the container's own filesystem.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Tests use real local Git repositories and scripted agents. Git ignores user/system configuration and
automatic maintenance, making fixture copies reproducible. Linux CI additionally tests the real
bubblewrap boundary and the bundled three-phase action. macOS skips only the Linux sandbox test.

The manually dispatched [integration workflow](.github/workflows/integration.yml) checks pinned CLI
versions, optionally makes small billed model calls, and optionally exercises authenticated GitHub
operations against an initialized disposable `owner/autopatch-smoke-*` repository. Supply
`AUTOPATCH_SMOKE_TOKEN` scoped only to that repository. It creates and removes run-specific test refs.

Scope remains linear patch series on a maintained branch: no release/tag synchronization or submodule
verification. See [docs/DESIGN.md](docs/DESIGN.md) for state transitions and trust boundaries.
