# 2.8.4 Release Audit

Date: 2026-10-11. Reference comparison: [October upstream matrix](../upstream/sync-matrix-2026-10.md).

## Method

Two independent first-pass source reviews covered provider persistence/activation,
configuration safety, async UI lifecycles, streaming/protocol handling, usage accounting,
native runtime paths and release safeguards. Reviewers did not receive each other's
first-pass findings. Fixes were subsequently reviewed across assignments. This is
independent source review, not exhaustive proof or blind user testing.

## Fixes

- ChimeraHub-only creation presets and prefilled URL; existing providers retained.
- Unified Oh My Pi layout and searchable multi-select model discovery.
- Custom discovery headers and stale-request invalidation across provider editors.
- Invalid Grok raw configuration remains visible and blocks submission.
- Save-and-apply activates inactive direct routes; failed updates compensate database
  records and selection state. Files without write receipts are not restored blindly:
  changed files are preserved and an explicit rollback conflict is reported. Partial
  native writes can require manual reconciliation. Pi CAS and Claude Desktop receipts
  retain their own conflict protection.
- Bounded SSE frames, propagated upstream business errors, corrected cache-write
  accounting, one-hour cache pricing and Codex session import deduplication.
- Stable visible MSIX main-window checks, WindowsApps path rejection, custom CODEX_HOME
  protection for fallback launches and skin injection before side effects.
- Selective theme-engine update; no portable directory-layout migration.

## Local Evidence

- Final full frontend snapshot: 153 files, 1,484 tests passed. The affected Grok
  two-file suite also passed all 12 tests.
- TypeScript, frontend format, renderer build and bundle budgets passed.
- Release/repository guard suites: 62 tests passed. Upstream theme tests: 19 passed.
- Version, references, presets, single writer and backend architecture checks passed.
- Rust formatting checked. Rust compilation, Clippy and tests are delegated to remote
  CI, following the project's no-local-Rust-build rule.

## CI Feedback

The first remote run caught an archive-dedup query referencing a column absent from
the archive table, plus test-fixture assumptions about default provider metadata and
macOS temporary-path symlinks. These failures blocked tagging. Follow-up fixes must
pass a new complete run on their exact source commit, not reuse the earlier green
frontend or portable jobs as release approval. The archive table now preserves token
semantics through an idempotent compatibility-column upgrade. Existing receipts with
missing semantics remain unknown (-1), never treated as legacy for relaxed matching.
The original failing SQL was replayed successfully with SQLite before resubmission.

## Release Conditions And Limits

Do not publish until the exact main-branch commit passes frontend and three-OS backend
CI plus both native portable-validation architectures. The tag-triggered release
workflow independently rechecks evidence before packaging/publication. Local checks
alone do not constitute release approval.

Dependency audit retains the existing documented build-only `braces` advisory exception
(GHSA-vfj7-8cjw-p6xm); the reviewed registry has no patched version. This is not a claim
of zero dependency vulnerabilities. No real gateway/billing credentials or live user
sessions were used for smoke tests. No local Rust build or cache deletion was performed.

Cache TTL subsets are not newly persisted: historical costs are not rewritten and later
repricing cannot reconstruct previously unrecorded one-hour cache details. The original
six screenshots were unavailable in the resumed review context; source/tests must not
be described as direct inspection of those images.
