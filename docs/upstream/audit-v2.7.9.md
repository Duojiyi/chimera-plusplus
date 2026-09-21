# v2.7.9 audit record

All reviews below use two independent reviewers. Reviewers receive the same
fixed snapshot, do not read each other's findings, and do not edit the code.
Static review is not a claim of absence of bugs or a substitute for cloud tests.

| Round | Snapshot (base `2c48ec01`) | Reviewer A | Reviewer B | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `169657a3` | Sartre | Boyle | Mirror validation used a different repository from the application; MiniMax-only system-message reordering affected other providers. Both corrected. Portable validation also made a mandatory release gate. |
| 2 | `598b6427` | Beauvoir | Lagrange | A found a missing test import and incomplete cleanup of implicit OpenAI takeover URLs; B found no actionable issue. Both reviews completed after an intermediate progress report; the intermediate incomplete reports are not counted as passing audits. |
| 3 | `defccbb5` (increment from `598b6427`) | Singer | Banach | A identified obsolete production wrappers; B identified a mismatch between the validated package and the bundled package pin. Corrected in `652688e5`, together with round-2 findings. Packaging now uses the upstream engine rather than raw ZIP extraction. |
| 4 | `652688e5` (increment from `874e1733`) | Wegener | Gauss | Both independently reported no actionable findings in the remediation and its integration. Hosted compilation and real package validation still required. |
| 5 | `5e82aa85` (cloud corrections) | Wegener | Gauss | Both found that the shutdown fixture did not exercise owned Live restoration. Replaced the unchanged backup fixture with a distinct proxy-owned Live configuration. The Clippy simplification and schema fixture fixes had no remaining findings. |
| 6 | `1d30851b` (round-5 correction) | Wegener | Gauss | Both independently reported no remaining actionable findings. The test now proves restoration, backup deletion, and per-app settings preservation with the server already stopped; active-listener shutdown remains outside this fixture. |

## Cloud validation follow-up

Cloud Clippy exposed one nonminimal boolean expression; cloud tests exposed
outdated schema/provider-field fixtures and a missing Live file. Corrections
through `5e82aa85` passed all four CI jobs in run `35636074341`, and native
x64/ARM64 package validation in run `35636074352`. Round 5 then strengthened
the restoration fixture rather than relying on that passing result. The final
main commit must pass the same gates again before tagging.

## Local validation before cloud compilation

- Frontend: 113 test files / 884 tests passed with two workers.
- Type checking, frontend formatting, renderer build and bundle budgets passed.
- npm audit reported no known vulnerabilities.
- Release safety tests: 23 passed after round-3 remediation; workflow PowerShell syntax and actionlint also passed.
- Version consistency: 2.7.9; committed-secret and repository-reference checks passed.
- Locked Cargo metadata and Rust formatting checked without compiling Rust.
- No local Rust build, test, check, Clippy or Tauri compilation was performed.

## Release requirements

The exact release commit must be on main with all required frontend and three
platform backend jobs successful. Native x64 and ARM64 portable validation must
also pass for that same main commit. A tag must not bypass these requirements.
Real account/provider API and desktop UI end-to-end flows remain separate manual
verification; static review and fixture tests do not establish those outcomes.
