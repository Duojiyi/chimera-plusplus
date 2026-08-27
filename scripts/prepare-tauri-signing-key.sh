#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is empty or missing" >&2
  exit 1
fi

raw="$TAURI_SIGNING_PRIVATE_KEY"
key_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
key_path="$key_dir/tauri_signing.key"
mkdir -p "$key_dir"

write_key() {
  local candidate="$1"
  if [[ "$(printf '%s\n' "$candidate" | sed -n '1p')" == untrusted\ comment:* ]]; then
    printf '%s\n' "$candidate" > "$key_path"
    return 0
  fi
  return 1
}

if ! write_key "$raw"; then
  decoded=""
  if decoded=$(printf '%s' "$raw" | tr -d '\r\n' | (base64 --decode 2>/dev/null || base64 -D 2>/dev/null)); then
    if ! write_key "$decoded"; then
      decoded=""
    fi
  fi

  if [[ -z "$decoded" ]]; then
    compact=$(printf '%s' "$raw" | tr -d '\r\n')
    if [[ "$compact" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
      printf '%s\n%s\n' "untrusted comment: tauri signing key" "$compact" > "$key_path"
    else
      echo "TAURI_SIGNING_PRIVATE_KEY format is not recognized" >&2
      exit 1
    fi
  fi
fi

if [[ "$(wc -l < "$key_path" | tr -d ' ')" -lt 2 ]] ||
   [[ -z "$(sed -n '2p' "$key_path" | tr -d '\r\n')" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY did not decode to a valid two-line minisign key" >&2
  exit 1
fi

key_b64=$(base64 < "$key_path" | tr -d '\r\n')
if [[ -z "$key_b64" ]]; then
  echo "Unable to encode the Tauri signing key" >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  # The re-encoded value differs byte-for-byte from whatever GitHub recorded
  # as the raw secret, so GitHub Actions' automatic log redaction (which
  # matches on the exact registered secret string) will not catch it. Register
  # it explicitly so the runtime masks it in logs too.
  printf '::add-mask::%s\n' "$key_b64"
  printf 'TAURI_SIGNING_PRIVATE_KEY=%s\n' "$key_b64" >> "$GITHUB_ENV"
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
    printf 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%s\n' "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" >> "$GITHUB_ENV"
  fi
else
  export TAURI_SIGNING_PRIVATE_KEY="$key_b64"
  echo "Tauri signing key normalized for the current shell"
fi
