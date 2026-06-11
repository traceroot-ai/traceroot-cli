#!/bin/bash
# Post-edit lint hook: auto-fixes formatting, reports remaining errors to Claude.
# Exit 0 = clean, Exit 2 = errors fed back to Claude for self-correction.

INPUT=$(cat)

# Guard: jq is required to parse hook input
if ! command -v jq &>/dev/null; then
  exit 0
fi

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# --- JS/TS/JSON files: Biome ---
case "$FILE_PATH" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc)
    # Never touch generated code or the vendored OpenAPI schema.
    case "$FILE_PATH" in
      *src/api/generated/* | *openapi.json) exit 0 ;;
    esac

    # Auto-fix: format + safe lint fixes
    npx --no-install biome check --write "$FILE_PATH" >/dev/null 2>&1

    # Report any remaining (unfixable) diagnostics back to Claude
    if ! ERRORS=$(npx --no-install biome check "$FILE_PATH" 2>&1); then
      echo "$ERRORS" >&2
      exit 2
    fi
    exit 0
    ;;
esac

# Other file types: skip
exit 0
