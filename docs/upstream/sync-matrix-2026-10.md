# Chimera++ October 2026 upstream review

Reviewed on 2026-10-10. This is selective integration, not wholesale replacement
of upstream applications. Published releases and selected post-release fixes are
kept distinct. Review results describe source evidence, not real-account or
installer smoke testing.

## Sources

| Reference | Latest stable reviewed | Local integration decision |
| --- | --- | --- |
| [Codex App Manager](https://github.com/Wangnov/Codex-App-Manager/releases/tag/v0.5.16) | v0.5.16, `31bd3f23f74d6e263cbeb86cb210f8fe64e281d4` | Upgrade only theme engine; preserve Windows engine v0.5.8 and runtime bridge pins |
| [CC Switch](https://github.com/farion1231/cc-switch/releases/tag/v4.0.7) | v4.0.7 | Cache usage/pricing and model discovery fixes |
| [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v1.7.5) | v1.7.5 | Review config preservation, protocol safety, process identity and updater applicability |
| [Codex-X](https://github.com/yynxxxxx/Codex-X/releases/tag/v0.3.26) | v0.3.26, `19222f9cc92e3111e47f2a6bbc7db6ed2cc9c462` | Compare actual files against adapted-source pin `8f018fddd3ee1a68464e4df8765eb370ede0c76f` |

## Applied Fixes

- CC Switch cache-zero fallback: choose a valid nonzero cached-token candidate
  instead of allowing an explicit zero to hide the compatible fallback counter.
- CC Switch #7653/#7652: Claude 1-hour cache writes are a subset of total writes,
  priced at 1.6 times the 5-minute rate, without double counting.
- CC Switch #7635/#7634: import Codex rollout `cache_write_input_tokens` through
  cumulative deltas, replay signatures and legacy-proxy deduplication.
- Selected CC Switch post-release commits `315aeda7cf` and `74b1a98c99`: model
  discovery forwards validated provider headers. Header/endpoint/credential
  changes invalidate stale results and stale completion notifications.
- App Manager #362: MSIX installation and diagnostics additionally require a
  stable visible main window; native startup dialogs do not count as success.
  Preserve the local policy of no silent standard-to-portable fallback.
- App Manager #427: reject WindowsApps path components on any volume, preserving
  the existing symlink/junction/reparse-point protections.
- App Manager #423: pin the theme engine to v0.5.16 for active/visible-page
  detection. Keep the install/runtime dependencies pinned to avoid unrelated
  portable-layout migration. Upstream theme JS regression suites: 19 passing.

## Already Covered Or Not Shared

- CC Switch compressed Codex rollouts: existing bounded `.jsonl.zst` readers and
  duplicate identity handling remain in place.
- CodexPlusPlus Gemini thought signatures and opaque Responses reasoning already
  have dedicated local transport helpers. Its custom macOS update-helper signing
  and legacy two-app DMG migration are not this application's Tauri updater.
- CodexPlusPlus config-preservation review led to a local Grok fix: malformed raw
  TOML can no longer be silently replaced with a rebuilt config. Structured edits
  preserve the invalid draft; submission is blocked until syntax and semantic validation pass.
- Codex-X compare reports diverged history. Actual two-endpoint blob/text checks,
  not merge-base commit counts, show no new changes in adapted CAS, official auth,
  quota, managed prompts, archive safety, note validation and context-preset
  source modules. Its historical-provider alias repair engine was not copied
  here. New updater fallback channels are not adopted over signed Tauri updates.

## Boundaries

- Only Chimera remains selectable as a new-route preset. Existing user routes and
  legacy metadata are preserved; no automatic rewrite of saved credentials.
- Portable users should launch through `LaunchCodex.exe` or Chimera. This release
  does not promise direct launching of the original payload executable or migrate
  the old flat portable directory layout.
- Standalone shortcuts do not read Chimera-specific CODEX_HOME overrides; launch
  from Chimera when using an override. No global environment changes are made.
- Cache TTL detail is not persisted in a new database column. New known-price
  records use corrected costs; historical costs are not automatically rewritten,
  and later repricing cannot recover a previously unrecorded 1-hour subset.
- No Rust compilation is performed locally under project instructions. Native
  checks and tests are release gates on CI, not presumed successful from fmt.
- No credentials were used to probe real billing gateways or modify accounts.
