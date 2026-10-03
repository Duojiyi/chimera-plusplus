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
