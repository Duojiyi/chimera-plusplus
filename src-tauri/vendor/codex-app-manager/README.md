# Vendored Codex App Manager engines

This directory contains the MIT-licensed `codex-theme-engine` and
`codex-win-engine` crates copied from
[`Wangnov/Codex-App-Manager`](https://github.com/Wangnov/Codex-App-Manager)
at commit `31bd3f23f74d6e263cbeb86cb210f8fe64e281d4`.

The vendored workspace keeps the upstream engine implementation intact except
for the ZIP 9 API compatibility changes needed by Chimera++:
`ZipFile::name()` now returns a `Result<Cow<str>, ZipError>`, so callers handle
malformed entry names explicitly before using the name.