# Chimera runtime crates (AGPL-3.0-only)

`chimera-domain`, `chimera-platform` and `chimera-runtime` implement the managed
Codex runtime (install, update, rollback, health, ownership). They are licensed
under the GNU Affero General Public License v3.0 only: see [LICENSE](LICENSE) and
[NOTICE](NOTICE). The rest of this repository is MIT-licensed; see
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) for how the two combine in a
distributed binary.

## Provenance

The sources were imported from commit `ac846589c9bb3b60cbaec3f7d26287c55afdc493` of
https://github.com/Duojiyi/chimera-plusplus (the `v2-task-10-owned-mirror` branch),
where they were previously consumed as pinned git dependencies. Only the
`Cargo.toml` manifests were changed: workspace inheritance was replaced by explicit
values, and `chimera-runtime` now pins the same Codex App Manager engine revision as
the application.

## Keeping the engine in one version

`chimera-runtime/Cargo.toml` and `../Cargo.toml` pin `codex-win-engine` to the same
`rev`. Change both together, otherwise the build links two copies of the engine and
the install manager runs on a different engine than the rest of the application.
