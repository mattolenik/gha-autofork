# Design: immutable candidates and isolated publication

The fork is modeled as upstream plus a short linear series of personal patches. Git performs the
rebase; agents resolve conflicts and review intent. Commit messages and authorship survive, and
review fixes are folded into a surviving patch. A conflicted fixup may fall back to the final patch;
that change in ownership is recorded for the next review.

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
- SHA-256 of a Git bundle containing only four explicit candidate refs.

The prepare job emits a SHA-256 manifest digest as a job output. Verify consumes the artifact by its
immutable Actions artifact ID, checks its digest and bundle contents, imports into a new repository,
checks accounting/ancestry, and runs the trusted command. Its manifest binds the result to the same
candidate and run; its digest is another job output. Publish requires both trusted outputs, imports
only the allowlisted refs into a fresh bare repository, and repeats object-level checks.

Artifact contents cannot choose a different destination repository, maintained branch, run, or shell
command. Recomputing a digest on arbitrary input is not authentication; the workflow's producing-job
outputs and artifact IDs establish provenance. Rerun all dependent jobs together after a new run attempt.

## Mutation contracts

Before and after external calls, guard logical index entries, refs, HEAD/rebase pseudorefs, sequencer
contents, and repository configuration. Editing workers may change files, but cannot stage or alter
history. Read-only calls may change neither source nor Git state. Guards run even when calls throw.

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
6. Worker edits or rebuts. Unreported edits fail; edits are folded into one explicitly named patch or,
   when no target is supplied, selected by file history. Invalid/multiple explicit targets fail.
7. Stop at the round limit or when normalized issues persist without candidate changes.

Provider diversity improves review independence; it does not prove semantic correctness. Meaningful
project verification remains necessary. The `fake` backend is exclusively a test fixture mechanism.

## State transitions and publication policy

| Condition | Prepare | Verify | Publish |
|---|---|---|---|
| Upstream unchanged | NOTHING_TO_DO, current SHA | skipped | skipped |
| Linear rebase or patchless fast-forward | PREPARED after gates/consensus | VERIFIED for exact candidate | STAGED or APPROVED/FAST_FORWARDED |
| Missing independent review, verification, or initialization | Candidate may be prepared | Structural gates still apply | STAGED |
| `publish=stage` | Same preparation | Same verification | Temporary ref only |
| `dry_run=true` | Same preparation | Same verification | No remote ref or issue changes |
| Gate, agent, tampering, or consensus failure | FAILED_* + available recovery artifacts | skipped or FAILED_* | skipped |
| Candidate/verification provenance mismatch | — | FAILED_TAMPERED | FAILED_TAMPERED |
| Concurrent maintained-branch/checkpoint update | — | — | FAILED_PUBLISH, lease protects refs |
| Cleanup error after successful transaction | — | — | Successful state with warnings |

Automatic publication requires independent review, verification, and an initialized upstream anchor.
The first publication requires an explicit inspected `initial_base`; subsequent runs use
`refs/autopatch/upstream/<branch>`. The anchor must be an ancestor of both fork and upstream. A rewritten
upstream fails planning instead of reclassifying deleted upstream commits as personal patches.

Publish pushes the verified temporary branch, then uses one atomic transaction with explicit leases
to create the immutable backup, update the maintained branch, and advance the upstream checkpoint.
Backup names include date, run ID, and attempt. Atomic-push support is required. Cleanup after the
transaction cannot turn a successful branch update into a failed publication.

Staging does not advance the checkpoint. Staged branches can trigger other workflows: their branch
filters and credential policies are part of the consuming repository's configuration.

## Recovery and interruption

Preparation does not push incomplete or contested results. It writes portable checkpoints containing
the original/upstream/partial history bundle, index stages, worktree files, sequencer state, current
patch and pending patches. Checkpoints are promoted only after the next snapshot is complete, retaining
the previous snapshot during replacement. Rebase stops, completed resolutions, and review progress
update artifacts. Failures retain the last safe checkpoint; tampering does not overwrite it.

The recovery tool reconstructs a new local worktree/index without running hooks or continuing the
rebase. Partial-rebase reports do not offer a direct force-push recipe. Completed contested candidates
must still be repaired, reviewed, and verified before promotion. Abrupt runner loss may lose work
after the last completed checkpoint or prevent artifact upload.

## Backend contracts and testing

CLIs are pinned and checked at startup. Nonzero exits are failures even when JSON looks valid.
Claude provides reported dollar/turn controls; Codex does not, so its spend is explicitly unpriced.
Known-budget exhaustion blocks subsequent calls. `require_hard_limits` rejects unsupported backends;
process-group wall-clock timeouts apply to all invocations.

Tests exercise real Git repositories, semantic verdict validation, mutation attempts at phase
boundaries, interrupted recovery, artifact mismatches, publication faults, and staging/dry-run policy.
Git fixture processes ignore user/system configuration and automatic maintenance. Linux CI verifies
the actual OS sandbox; a bundled-action job exercises phase plumbing. Opt-in integration tests cover
pinned real CLIs and authenticated GitHub transport, workflow permissions, custom refs and leases.

Remaining scope limits: no merge-maintained forks, release/tag handling, submodule verification, or
persistent rerere cache. Arbitrary build output may contain sensitive repository content; artifact
retention/access follows the consuming repository's policy.
