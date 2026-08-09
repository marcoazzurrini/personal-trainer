#!/usr/bin/env bash
# Builds skill/SKILL.md from the template, injecting the production API token.
# The token comes from skill/.env (gitignored): API_TOKEN=...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
TEMPLATE="$SCRIPT_DIR/SKILL.template.md"
OUTPUT="$SCRIPT_DIR/SKILL.md"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Create it with: API_TOKEN=<production token>" >&2
  exit 1
fi

API_TOKEN=$(grep '^API_TOKEN=' "$ENV_FILE" | cut -d= -f2)
if [[ -z "$API_TOKEN" ]]; then
  echo "Error: API_TOKEN not found in $ENV_FILE" >&2
  exit 1
fi

sed "s/{{API_TOKEN}}/$API_TOKEN/g" "$TEMPLATE" > "$OUTPUT"

# The frontmatter is load-bearing and fragile (see the fmt note below), so the
# render is verified rather than trusted: the file must open with a YAML block
# that still carries allowed-tools as a top-level key at column zero. The
# documented failure mode is a formatter indenting it into the description
# string, after which the skill loads without permission to run anything —
# this check is the guard, not care.
if [[ "$(head -1 "$OUTPUT")" != "---" ]] \
  || ! grep -q '^allowed-tools:' "$OUTPUT" \
  || ! grep -q '^description:' "$OUTPUT"; then
  echo "Error: $OUTPUT frontmatter is broken — name, description and allowed-tools must be top-level YAML keys. Did a formatter touch skill/?" >&2
  exit 1
fi

echo "Generated $OUTPUT"

# Rotating the token. The server accepts two values while a rotation is in
# flight (API_TOKEN and API_TOKEN_PREVIOUS), because live conversations hold
# the old one in context for as long as they run. The procedure:
#   1. Put the NEW value in skill/.env (API_TOKEN=...).
#   2. On the deployed function, set API_TOKEN to the new value and
#      API_TOKEN_PREVIOUS to the old one (supabase secrets set).
#   3. Re-run this script so SKILL.md carries the new token.
#   4. Once no conversation still holds the old value, unset
#      API_TOKEN_PREVIOUS — from then on, old transcripts hold a dead secret.

# Never run deno fmt over this folder. SKILL.md opens with a YAML block that
# declares the skill's name, its description (what makes it trigger at all),
# and allowed-tools: Bash. deno fmt indents the keys following the long
# description line; YAML reads an indented line as a continuation of the
# previous value, so allowed-tools disappears into the description string and
# the skill loads without permission to run curl. skill/ is excluded in both
# deno.json and lefthook.yml — keep it that way.
