#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

GUIDE="docs/code-model/modeling-guide.md"
MODEL_DIR=".wiki_craft/knowledge_bases/wiki-craft-1781418122616/knowledge"

if [[ "${SKIP_CODE_MODEL_HOOK:-}" == "1" ]]; then
  echo "code-model hook skipped: SKIP_CODE_MODEL_HOOK=1"
  exit 0
fi

if [[ ! -f "$GUIDE" ]]; then
  echo "code-model hook failed: missing $GUIDE" >&2
  exit 1
fi

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"

if ! printf '%s\n' "$STAGED_FILES" | grep -Eq '^backend/src/'; then
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "code-model hook failed: codex CLI was not found on PATH" >&2
  echo "Set SKIP_CODE_MODEL_HOOK=1 to bypass this hook for one commit." >&2
  exit 1
fi

PROMPT="$(cat <<'PROMPT_EOF'
You are maintaining the backend three-layer code model for this repository.

Read docs/code-model/modeling-guide.md first and follow it exactly.

Scope:
- Inspect staged backend changes under backend/src/**.
- Update only .wiki_craft/knowledge_bases/wiki-craft-1781418122616/knowledge/*.md.
- Do not create topics/, code-model/, approved/, staging/, or other nested knowledge directories.
- Do not edit backend source code, frontend code, Tauri code, README files, package files, or git metadata.
- Preserve the three-layer model:
  - L1 backend capability summary
  - L2 HTTP endpoints and CLI entrypoints
  - L3 module/class/function API pages
- Keep the documentation readable for humans and structured for AI agents.
- Keep Relations sections consistent with the guide.

Task:
Refresh the code model so it matches the currently staged backend changes. If no code-model changes are needed, make no edits and say so.
PROMPT_EOF
)"

echo "code-model hook: running Codex to refresh .wiki_craft knowledge files..."
codex exec \
  --cd "$ROOT" \
  --sandbox workspace-write \
  --ask-for-approval never \
  "$PROMPT"

echo "code-model hook: refreshed local KB knowledge at $MODEL_DIR"
