# Chimera++ 2.7.9 upstream integration

## Pinned review sources (2026-09-22)

| Upstream | Latest stable reviewed | Additional reviewed head |
| --- | --- | --- |
| [Codex App Manager](https://github.com/Wangnov/Codex-App-Manager) | v0.5.8, peeled commit `296721f429e7359ad6618fdc897412fe6fe4c29b` | Stable only |
| [CC Switch](https://github.com/farion1231/cc-switch) | v3.20.3, `d695a2d77fd9081eafd3e9eedcbf2a97b3410928` | `37d0476097754636493ce836faf1a60f2121e340` |
| [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) | v1.3.0 | `b1ed92e5e` |

Post-release changes below are selected fixes, not a claim that an unreleased
upstream branch is a stable release. Existing functionality is retained rather
than replaced wholesale. This document records scope; validation results are
recorded separately once the implementation snapshot is frozen.

## App Manager

- Direct Windows/theme engines and the runtime workspace use the same v0.5.8
  commit. Runtime dependency bridge: `ac846589c9bb3b60cbaec3f7d26287c55afdc493`.
- Use the upstream statically linked native portable launcher (x64/ARM64), bundled
  CLI environment, launcher regeneration, and BlockMap logical-path extraction.
- Remove the local post-extraction percent-decoding workaround. Missing bundled
  CLI payload validation remains in the upstream staging path before replacement.
- Keep Chimera++ CODEX_HOME and existing renderer integration. Standard MSIX
  installation must not silently downgrade to portable mode after an error.
- No official EXE/ASAR patching, global environment rewriting, or artificial
  package registration. Directly launching the unpackaged application executable
  is not equivalent to launching through LaunchCodex.exe.

## CC Switch and CodexPlusPlus

| Area | Selected changes / evidence | Integration boundary |
| --- | --- | --- |
| Chat bridge | CC `5e0f3442`, `b78192e8`, `d8065cc6`: commentary/tool-call merging, empty reasoning chunks, mid-conversation system messages | Preserve message order and tool boundaries |
| Kimi | CC `db41d701`; CPP `c5ab8a1f`: ref siblings and adaptive thinking | Provider-specific; not global schema rewriting |
| Images | CC `17be9092`, `e724270d`, `e0982799`: image routes, endpoint derivation and cache usage | JSON requests; multipart is not a newly supported interface |
| Responses | CC `872ec775`, `6e4b0e6e`, `12296aeb`: parallel calls, minimum output tokens, safe UTF-8 truncation | Preserve existing authentication and request limits |
| xAI | Request sanitation series; post-stable `c6286e14`, `bd247a4a` | Native xAI endpoint only; no Grok product expansion |
| Config | CC `99f9dd2`, `e0c2fd2`, `b5f9fd0`: implicit OpenAI provider, child metadata, modalities | Preserve user configuration and explicit choices |
| Semantic merge | CPP `cd1eba23`, `6b84ae03`, `93686cd3` | Existing recursive merge/catalog lifecycle retained with regressions |
| Local settings | CPP post-stable `494b12a8`, `28aff069`, `0dd16a31`, `de2c6f62` | Literal catalog paths, local sandbox/features, max context import |
| Usage import | File size plus nanosecond timestamp, legacy cursor and incomplete-tail handling | Additive nullable schema column; preserve existing statistics |
| Model discovery | CC post-stable `f49c7d68`: Zhipu models/slug response | Keep OpenAI data/id compatibility and security limits |
| Presets | CC post-stable `48e572cc`, `e06ff90f`: Kimi Responses, Qwen3.8, MiniMax/BaiLing endpoints, DeepSeek modalities | Refresh existing presets, not saved user providers |

Existing Responses item-ID normalization (CPP `e9572792`) and structured array
tool-image output (CPP `d9873214`) are retained rather than duplicated.

## Deliberate exclusions

- No unrelated multi-application, Pi, Grok, remote-control or browser product
  surfaces, sponsorship expansion, or new injection subsystem.
- New upstream providers without a local counterpart are not automatically added;
  AICodeWith endpoint corrections do not apply to an absent preset.
- Do not force every user-authored wire_api to Responses: explicit Chat-compatible
  providers still require the existing bridge.
- Do not import unrelated database migrations or overwrite local provider/auth
  semantics merely to mirror upstream file structure.
- This is selective source integration, not an assertion of complete behavioral
  equivalence to all three upstream applications. Real provider accounts and GUI
  installation flows require separate end-to-end verification.
