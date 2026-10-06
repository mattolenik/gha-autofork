# Design: immutable candidates and isolated publication

The fork is modeled as upstream plus a short linear series of personal patches. Git performs the
rebase; agents resolve conflicts and review intent. Commit messages and authorship survive, and
review fixes are folded into a surviving patch. A conflicted fixup may fall back to the final patch;
that change in ownership is recorded for the next review.

## Why GitHub runners rather than hosted sandboxes

GitHub-hosted runners already provide disposable VMs, Git, build tools, artifact transport, scheduling,
and a job deadline. A weekly fork sync therefore needs no additional cloud account, persistent service,
SDK, or secret-distribution system. Provider-neutral CLI processes also permit cross-vendor review;
provider-specific managed agents would constrain that choice. Hosted sandboxes become attractive for
long-lived state, workloads beyond the runner deadline, or organizational requirements for another
execution environment. They are not required to isolate publishing: separate Actions jobs plus an OS
sandbox provide that boundary here. Runner availability is convenience, not proof that same-user
subprocesses are isolated; that is why the original single-job design was replaced.

## Rebase mechanics and accounting

During a rebase the sides are swapped: **ours / HEAD** is new upstream plus patches already replayed;
**theirs** is the fork patch currently being applied. Every resolution prompt states this. `zdiff3`
markers add the old common base. The index, including stages 1/2/3, detects content, add/add,
modify/delete and binary conflicts; marker scanning is only an additional check.

Patch accounting is `count(upstream..candidate) = n - absorbed - became_empty - skipped`. These are
disjoint outcomes for original patches: `git cherry` identifies absorbed patch IDs, `--empty=stop`
records patches that become empty, and worker-requested skips require an explicit reviewer decision.
Never use `-X ours` or `-X theirs`, which can silently discard one side. Rerere is disabled until a
tested pre-resolution policy exists; Git cannot silently pre-fill conflicts from a runner's cache.

## Trust boundaries

The reusable workflow separates credentials and execution:

| Job | Inputs | Executable work | Credentials |
|---|---|---|---|
| Prepare | Trusted workflow config, fork/upstream refs | Git, pinned agents, sandboxed verification | Repository read access, provider keys |
| Verify | Digest-bound candidate, trusted verify command | Fresh checkout and sandboxed verification | Read access only |
| Publish | Candidate + verification digests from job outputs | Bare Git object inspection and ref transactions | Publishing PAT/App token |
| Report | Failed-job results bound to its output digest | Issue API calls | Issue-writing token |

Publish never checks out or executes the candidate. Provider keys and publishing credentials are not
shared between jobs. Bubblewrap additionally gives agents/verification separate process namespaces,
hides runner homes and IPC, and mounts Git metadata read-only. A worker can edit its worktree; a
reviewer cannot. The orchestrator and its artifacts live outside writable sandbox mounts.

The CLI itself needs provider networking. Codex restricts its tool sandbox's network; Claude limits
tools. Environment scrubbing, instruction-discovery suppression, and conflict-time quarantine are
additional defenses. A prompt, a command-name allowlist, or a Git fingerprint alone is not an OS
security boundary. `sandbox=false` is for trusted local testing.

## Candidate identity and provenance

Every candidate identifies:

- workflow run ID and attempt, repository, branch, and upstream;
- original fork SHA, upstream SHA, merge base, previous upstream checkpoint;
- candidate commit SHA and tree SHA;
- ordered original patches and their current SHAs or drop outcomes;
- verification command identity and automatic-publication eligibility;
- SHA-256 of an incremental bundle with allowlisted upstream/head refs, or null when no new objects exist;
- explicit approved/contested status, which independently forbids auto-promotion of contested results.

The prepare job emits a SHA-256 manifest digest as a job output. Verify consumes the artifact by its
immutable Actions artifact ID, checks its digest and bundle contents, imports into a new repository,
checks accounting/ancestry, and runs the trusted command. Its manifest binds the result to the same
candidate and run; its digest is another job output. Publish requires both trusted outputs, imports
only the allowlisted refs into a fresh bare repository, and repeats object-level checks. Bundles exclude
objects reachable from the original fork tip; each importer first fetches that exact basis from the
trusted configured fork URL, requesting blob filtering. Basis URLs never come from artifacts.

Artifact contents cannot choose a different destination repository, maintained branch, run, or shell
command. Recomputing a digest on arbitrary input is not authentication; the workflow's producing-job
outputs and artifact IDs establish provenance. Run ID remains binding, while attempt is audit metadata:
failed verify/publish jobs can reuse successful earlier attempts without repeating model work. Publishing
reconciles an earlier successful transaction by matching the candidate, checkpoint, and same-run backup.

## Mutation contracts

Before and after external calls, guard logical index entries, refs, HEAD/rebase pseudorefs, sequencer
contents, and repository configuration. Editing workers may change files, but cannot stage or alter
history. Read-only calls may change neither source nor Git state. Guards run even when calls throw.
Worktree/common-directory paths are resolved once; filesystem metadata/ref snapshots plus a single
logical-index query replace repeated Git path-discovery processes. Read-only calls additionally compare
status and the contents of dirty paths. Packed refs, stash logs and .git indirection remain covered.

Conflict resolution stages only literal, validated reported files. NUL-delimited Git output preserves
Unicode, whitespace, newline and quoted filenames. Traversal, metadata paths, directory reports and
symlink ancestors are rejected. Leaf symlinks are data and are not followed for marker scans.

Verification must leave tracked source/index/history unchanged. Ignored dependency/build outputs are
allowed. Approval records include the exact commit/tree that passed gates, and are checked again
after reviews and before export/publication. Every review fix runs gates again.

Gates reject an active rebase, unmerged paths, dirty state, invalid ancestry, commit-count mismatch,
markers, failed patch comparison, and failed/timed-out verification. Empty series are represented by
an explicit original-patch comparison rather than ignoring a failed range-diff invocation.

## Consensus

1. Run gates. Failures become blocking repair requests.
2. Worker performs a read-only self-check with no outstanding concerns.
3. Reviewer examines the patch comparison and configured verification log.
4. Approval requires no blocker/major findings and explicit approval of every worker skip.
5. Patch references must be nonempty, unique hexadecimal prefixes of at least seven characters.
   Duplicate or ambiguous skip decisions are invalid. An unexplained rejection remains a rejection.
6. Worker edits or rebuts. Invalid skip references become blocking reviewer feedback. Invalid fixup
   targets, multiple explicit targets, or unreported files receive a bounded worker correction attempt
   with the edits preserved. Persistently invalid reports remain unapproved and recoverable. Valid edits
   fold into one named patch or, when no target is supplied, a patch selected by file history.
7. Stop at the round limit or when normalized issues persist without candidate changes.

Provider diversity improves review independence; it does not prove semantic correctness. Meaningful
project verification remains necessary. The `fake` backend is exclusively a test fixture mechanism.

## State transitions and publication policy

| Condition | Prepare | Verify | Publish |
|---|---|---|---|
| Upstream unchanged | NOTHING_TO_DO, unless initialization was explicitly requested | skipped, or normal initialization verification | skipped, or atomic checkpoint initialization |
| Linear rebase or patchless fast-forward | PREPARED after gates/consensus | VERIFIED for exact candidate | STAGED or APPROVED/FAST_FORWARDED |
| Missing independent review, verification, or initialization | Candidate may be prepared | Structural gates still apply | STAGED |
| `publish=stage` | Same preparation | Same verification | Temporary ref only |
| `dry_run=true` | Same preparation | Same verification | No remote ref or issue changes |
| Gate, agent, tampering, or consensus failure | FAILED_* + available recovery artifacts | skipped or FAILED_* | skipped |
| Complete, gate-passing but contested candidate | FAILED_CONTESTED + candidate artifact | skipped | rescue branch only, regardless of publish=auto |
| Candidate/verification provenance mismatch | — | FAILED_TAMPERED | FAILED_TAMPERED |
| Concurrent maintained-branch/checkpoint update | — | — | FAILED_PUBLISH, lease protects refs |
| Cleanup error after successful transaction | — | — | Successful state with warnings |

Automatic publication of a patch series requires independent review, verification, and an initialized upstream anchor.
`publish` defaults to `auto`; staging is an explicit choice or the fallback when eligibility is missing.
The first publication requires an explicit inspected `initial_base`; subsequent runs use
`refs/autopatch/upstream/<branch>`. The anchor must be an ancestor of both fork and upstream. A rewritten
upstream fails planning instead of reclassifying deleted upstream commits as personal patches.
An explicit first initialization may run even if upstream has not moved; like a patchless
fast-forward it involves no agent judgement, so only gates and verification run. A genuinely patchless
fast-forward requires no agent installation or calls; it uses deterministic gates and verification,
still respecting staging, initialization, leases and backups.

Publish pushes the verified temporary branch, then uses one atomic transaction with explicit leases
to create the immutable backup, update the maintained branch, and advance the upstream checkpoint.
Backup names include date, run ID, and attempt. Atomic-push support is required. Cleanup after the
transaction cannot turn a successful branch update into a failed publication.

Staging does not advance the checkpoint. Staged branches can trigger other workflows: their branch
filters and credential policies are part of the consuming repository's configuration.

## Recovery and interruption

Preparation never pushes. Gate-passing contested candidates export a stage-only manifest; the credentialed
publisher retains them on a rescue branch and the reporting job links it. Issue reporting returns
REPORTED, preserving the source failure state without generating another failed job.

Portable checkpoints contain only dirty/conflicted paths, changed index stages, sequencer state, current
patch and pending patches. Their bundle excludes original-tip history and includes a separate carrier
commit for otherwise unreachable staged blobs. Restoring fetches the original tip from an explicitly
selected repository, checks out the partial HEAD, and overlays these deltas. Checkpoints are promoted
only after the next snapshot is complete. Identical snapshots are reused; clean initial/final rebases and
no-edit review rounds do not repack history. Stops, resolutions, actual review fixes and failures save
checkpoints. Tampering retains the last safe checkpoint.

The recovery tool reconstructs a new local worktree/index without running hooks or continuing the
rebase. Partial-rebase reports do not offer a direct force-push recipe. Completed contested candidates
must still be repaired, reviewed, and verified before promotion. Abrupt runner loss may lose work
after the last completed checkpoint or prevent artifact upload.

## Backend contracts and testing

CLI versions default to the tested pins and can be selected using claude_version/codex_version inputs,
including preinstalled binaries with install_clis=false. Nonzero exits are failures even when JSON looks valid.
Claude provides reported dollar/turn controls; Codex does not, so its spend is explicitly unpriced.
Known-budget exhaustion blocks subsequent calls. `require_hard_limits` rejects unsupported backends;
process-group wall-clock timeouts apply to all invocations.

Claude uses `--bare -p`, `--output-format json`, `--json-schema`, `--system-prompt`, `dontAsk`,
`--no-session-persistence`, and `--strict-mcp-config`. Editing tools are Read/Edit/Write/Grep/Glob plus
an allowlist of Git subcommands; reviewers use `--restricted` with Read/Grep/Glob. Codex uses
`exec --json --output-schema --output-last-message --ephemeral --ignore-user-config --ignore-rules`,
`project_doc_max_bytes=0`, `approval_policy=never`, and workspace-write/read-only tool sandboxes with
workspace network disabled. Its system instructions are prepended because the tested CLI has no
supported system-prompt flag. Both CLIs run inside the outer OS sandbox.

The sandbox masks `/run` but restores `/run/systemd/resolve` read-only so Ubuntu resolver symlinks work.
Hosted-runner CI checks both the actual bubblewrap/AppArmor interaction and DNS to the provider hosts.
Network and bundle Git commands use the job deadline rather than a blanket five-minute timeout.

Tests exercise real Git repositories, semantic verdict validation, mutation attempts at phase
boundaries, interrupted recovery, artifact mismatches, publication faults, and staging/dry-run policy.
Git fixture processes ignore user/system configuration and automatic maintenance. Linux CI verifies
the actual OS sandbox; a bundled-action job exercises phase plumbing. Opt-in integration tests cover
pinned real CLIs and authenticated GitHub transport, workflow permissions, custom refs and leases.

Remaining scope limits: no merge-maintained forks, release/tag handling, submodule verification, or
persistent rerere cache. Arbitrary build output may contain sensitive repository content; artifact
retention/access follows the consuming repository's policy.
