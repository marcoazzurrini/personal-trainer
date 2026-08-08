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

echo "Generated $OUTPUT"

# Never run deno fmt over this folder. SKILL.md opens with a YAML block that
# declares the skill's name, its description (what makes it trigger at all),
# and allowed-tools: Bash. deno fmt indents the keys following the long
# description line; YAML reads an indented line as a continuation of the
# previous value, so allowed-tools disappears into the description string and
# the skill loads without permission to run curl. skill/ is excluded in both
# deno.json and lefthook.yml — keep it that way.
