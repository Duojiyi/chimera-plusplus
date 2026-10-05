# Third-Party Notices

## Components licensed under AGPL-3.0-only

Chimera++ links three crates from this project's own repository: `chimera-runtime`,
`chimera-platform` and `chimera-domain`, pinned to commit
`ac846589c9bb3b60cbaec3f7d26287c55afdc493` of
https://github.com/Duojiyi/chimera-plusplus. Their workspace declares
`AGPL-3.0-only`; the `LICENSE`, `NOTICE` and `THIRD_PARTY_SOURCES.md` files at that
commit state the terms and the provenance of the code.

Because the application links these crates, a distributed Chimera++ binary is a combined
work that is provided under the GNU Affero General Public License v3.0 only. The complete
corresponding source of every release is published at
https://github.com/Duojiyi/chimera-plusplus at the release tag. Chimera++'s own code
outside these crates remains available under the MIT License ([LICENSE](LICENSE)); MIT
code may be combined into an AGPL-3.0 work.

This section states the licensing facts of the linked components. It is not legal advice.

## MIT-licensed components

Chimera++ 2.0 reuses selected components from the following MIT-licensed projects.
The original license terms and copyright notices are retained below.

## CC Switch

Source: https://github.com/farion1231/cc-switch

Copyright (c) 2025 Jason Young

Licensed under the MIT License. The full license text is in [LICENSE](LICENSE).

## Codex App Manager

Source: https://github.com/Wangnov/Codex-App-Manager

Copyright (c) 2026 Wangnov

Licensed under the MIT License. The Windows runtime detection and installation engine is
used through pinned source dependencies. The full license text is available from the
upstream repository.

## Codex App Mirror

Source: https://github.com/Wangnov/codex-app-mirror

Copyright (c) 2026 Wangnov

Licensed under the MIT License. Chimera++ maintains an independent fork at
https://github.com/Duojiyi/codex-app-mirror for release distribution.

## Codex-X

Source: https://github.com/yynxxxxx/Codex-X

Copyright (c) 2026 yynxxxxx

Licensed under the MIT License. The compare-and-swap file primitives, the Codex login-type
classifier, the account display-metadata validators and the official quota lookup are
adapted from it; adapted files carry an attribution header. The full license text is
available from the upstream repository.

### Codex-X note validation (v2.8.0)

The trimmed 1,000 Unicode-character notes rule in `src-tauri/src/database/dao/notes.rs`
is adapted from `apps/desktop/src-tauri/src/skills_mcp/mod.rs` at commit
`8f018fddd3ee1a68464e4df8765eb370ede0c76f`.

```text
MIT License

Copyright (c) 2026 yynxxxxx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Codex diagnostics provider validation rules in `src-tauri/src/config_health.rs` are
adapted from Codex-X `apps/desktop/src-tauri/src/config_health.rs` at
`8f018fddd3ee1a68464e4df8765eb370ede0c76f`, under the same MIT license above.
The repair engine is not copied; reads use Chimera++ resource limits.

Managed-block bounds validation in `src-tauri/src/managed_prompts.rs` is adapted
from Codex-X `apps/desktop/src-tauri/src/prompts/managed_agents.rs` at the same
`8f018fddd3ee1a68464e4df8765eb370ede0c76f` revision (MIT, license above). Chimera
markers, byte-preserving projection and legacy hash migration are local changes.

### Codex-X 1M context preset (v2.8.0)

The 1M context switch (`src/utils/codexContextWindow.ts`) adapts the preset and the
turn-off rule of `update_codex_context_window_inner` in Codex-X
`apps/desktop/src-tauri/src/context_config.rs` at
`8f018fddd3ee1a68464e4df8765eb370ede0c76f`: a 1,000,000-token window with a
900,000-token auto-compact limit, where turning the switch off only removes
values equal to the preset. It is rewritten as a minimal text edit of the root
keys so comments and key order survive. MIT license reproduced above.

### Codex-X bundled prompt examples (v2.8.0)

The six Markdown files in `src/config/prompt-templates/` are copied verbatim
from Codex-X `examples/` at revision
`8f018fddd3ee1a68464e4df8765eb370ede0c76f`, copyright (c) 2026 yynxxxxx,
under the MIT license reproduced above. `allowlist.json` records their exact
SHA-256 hashes. Only the three software-development and three writing examples
listed there are distributed. No upstream default registry or remote sync source
is included. Attribution stays outside template bodies to avoid injecting it
into model instructions. Selection creates an editable, disabled local copy;
updates to bundled examples never replace saved or active user instructions.


### Overpass and Overpass Mono fonts

Bundled unmodified variable fonts from Google Fonts (retrieved 2026-10-02):
- `https://github.com/google/fonts/blob/main/ofl/overpass/Overpass[wght].ttf`
- `https://github.com/google/fonts/blob/main/ofl/overpassmono/OverpassMono[wght].ttf`

Both use the SIL Open Font License 1.1. Full copyright and license notices are
in `src/public/licenses/Overpass-OFL.txt` and
`src/public/licenses/OverpassMono-OFL.txt`; Vite copies these to `dist/licenses/`
so they accompany the bundled font files. No runtime font CDN is used.

SHA-256 of the vendored files:
- Overpass: `970717df17a7f9911dee45f60695d05bfa9d745fa0a11fc5c348371fa21f0073`
- Overpass Mono: `49f230e10251608f0ae1a2ce46be768d7b9ddcbe5cdca2e9f6b762fcbce1ae4f`
