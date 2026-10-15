# Bundled Fonts

These fonts are local application assets; rendering does not require a font CDN.
SIL Open Font License notices are distributed in `src/public/licenses/`.

## Noto Sans SC

- Source: https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc
- File: `NotoSansSC[wght].ttf`
- Source SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Converted with fontTools 4.63.0 and Brotli to `NotoSansSC-Variable.woff2`.
- Full character coverage and variable weights preserved; no subsetting.
- Reproduce: load the pinned TTF with `fontTools.ttLib.TTFont`, set `font.flavor = "woff2"`, then call `font.save(...)`.
- License: `src/public/licenses/NotoSansSC-OFL.txt`.

Overpass and Overpass Mono are also bundled; their OFL notices are in the same license directory.

## Overpass (patched)

- File: `Overpass-Variable.ttf` (variable, `wght` 100–900).
- Upstream SHA-256: `970717df17a7f9911dee45f60695d05bfa9d745fa0a11fc5c348371fa21f0073`
- Patch: upstream treats `periodcentered` (U+00B7 `·`) as a combining mark, so text shapers give it zero advance and attach it to the preceding letter; every ` · ` separator in the interface collapsed onto the next character. Two changes, nothing else:
  - the GDEF glyph class of `periodcentered` is changed from mark (3) to base (1);
  - `periodcentered` is removed from the mark coverage (and its mark record) of GPOS lookup 3, the MarkBasePos lookup that attached it to Latin letters.
  `head` differs only in its checksum.
- Reproduce with fontTools 4.63.0: `font = TTFont(path, recalcTimestamp=False)`; set `font["GDEF"].table.GlyphClassDef.classDefs["periodcentered"] = 1`; in `font["GPOS"].table.LookupList.Lookup[3].SubTable[0]`, pop the `periodcentered` entry from `MarkCoverage.glyphs` and the same index from `MarkArray.MarkRecord`, then set `MarkArray.MarkCount`; `font.save(path)`.
- Patched SHA-256: `bd881e331aa3eb5eb5ddd04d2ae2737d3a0f50836e0b46ac5f2f14ac7e798f1d` (checked by `tests/lib/bundledFonts.test.ts`).
- License: `src/public/licenses/Overpass-OFL.txt`. The license names no Reserved Font Name, so the modified file keeps its name.
