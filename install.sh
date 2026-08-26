#!/usr/bin/env bash
# install.sh — Machiavelli adapter installer
# Supports --host claude|codex|opencode|all (default: claude for backwards compatibility).
# Idempotent: safe to run multiple times.
# Usage: bash install.sh [--host claude|codex|opencode|all]
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()  { echo -e "${CYAN}[mach]${RESET} $*"; }
ok()    { echo -e "${GREEN}[ok]${RESET}   $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET} $*"; }
fail()  { echo -e "${RED}[fail]${RESET} $*" >&2; exit 1; }

# ── Parse --host flag ─────────────────────────────────────────────────────────
HOST="claude"  # default: backwards compatible
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      shift
      if [[ $# -eq 0 ]]; then
        fail "--host requires an argument: claude|codex|opencode|all"
      fi
      HOST="$1"
      ;;
    --host=*)
      HOST="${1#--host=}"
      ;;
    --help|-h)
      echo "Usage: bash install.sh [--host claude|codex|opencode|all]"
      echo ""
      echo "  --host claude     Install Claude Code adapter (default)"
      echo "  --host codex      Install Codex adapter"
      echo "  --host opencode   Install OpenCode adapter"
      echo "  --host all        Install all adapters"
      echo ""
      exit 0
      ;;
    *)
      fail "Unknown argument: $1. Run with --help for usage."
      ;;
  esac
  shift
done

case "$HOST" in
  claude|codex|opencode|all) ;;
  *) fail "--host must be one of: claude|codex|opencode|all (got: $HOST)" ;;
esac

# ── 1. Node >= 20 ────────────────────────────────────────────────────────────
info "Checking Node.js version..."
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node >= 20 from https://nodejs.org (LTS recommended)."
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(parseInt(process.versions.node)))')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20 required; found $(node --version). Upgrade via nvm or https://nodejs.org."
fi
ok "Node.js $(node --version) — OK"

# ── 2. Resolve CORE_PATH ─────────────────────────────────────────────────────
CORE_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info "CORE_PATH = $CORE_PATH"

# ── 3. SQLite driver check ───────────────────────────────────────────────────
info "Checking SQLite driver availability..."
SQLITE_OK=$(node -e "
try {
  // Node >= 22.5 has node:sqlite built-in
  const major = parseInt(process.versions.node);
  if (major >= 22) { process.stdout.write('builtin'); process.exit(0); }
  // Otherwise try better-sqlite3
  require('${CORE_PATH}/core/node_modules/better-sqlite3');
  process.stdout.write('better-sqlite3');
} catch(e) {
  process.stdout.write('none');
}
" 2>/dev/null || echo "none")

if [ "$SQLITE_OK" = "none" ]; then
  warn "No SQLite driver found."
  echo ""
  echo "  Node $(node --version) does not have the built-in node:sqlite module"
  echo "  (requires Node >= 22.5), and better-sqlite3 is not installed."
  echo ""
  read -r -p "  Install better-sqlite3 now? (y/N) " INSTALL_SQLITE
  if [[ "${INSTALL_SQLITE:-n}" =~ ^[Yy]$ ]]; then
    info "Running: npm install --prefix ${CORE_PATH}/core better-sqlite3 (optional)"
    npm install --prefix "${CORE_PATH}/core" better-sqlite3 || {
      warn "better-sqlite3 install failed — this is non-fatal."
      warn "If you run Node >= 22.5, the built-in driver will be used instead."
    }
  else
    warn "Skipping better-sqlite3 install. Core requires Node >= 22.5 for built-in SQLite."
  fi
else
  ok "SQLite driver: ${SQLITE_OK}"
fi

# ── 4. Create data/ directory ────────────────────────────────────────────────
DATA_DIR="${CORE_PATH}/data"
if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
  info "Created: $DATA_DIR"
else
  info "data/ already exists — skipping"
fi

# Ensure .gitignore exists in data/
if [ ! -f "${DATA_DIR}/.gitignore" ]; then
  printf '*\n' > "${DATA_DIR}/.gitignore"
  ok "Created data/.gitignore (excludes all files)"
fi

# ── 5. Render helper ─────────────────────────────────────────────────────────
# render_file SRC DST
# Substitutes {{CORE_PATH}} and writes rendered output to DST.
# Checks for conflicts: skips if DST exists and is not a Machiavelli file.
# Overwrites if DST is already ours.
render_file() {
  local SRC="$1"
  local DST="$2"
  local RENDERED

  if [ ! -f "$SRC" ]; then
    warn "Source not found: $SRC — skipping"
    return 0
  fi

  RENDERED="$(mktemp /tmp/mach-adapter.XXXXXX.md)"
  # Replace {{CORE_PATH}} with the actual absolute path
  sed "s|{{CORE_PATH}}|${CORE_PATH}|g" "$SRC" > "$RENDERED"

  if [ -e "$DST" ] || [ -L "$DST" ]; then
    # Check if DST belongs to something else (not a Machiavelli file)
    if ! grep -q 'Machiavelli' "$DST" 2>/dev/null; then
      warn "Conflict: $DST exists and is not a Machiavelli file — SKIPPING."
      warn "Remove it manually and re-run install.sh to replace it."
      rm -f "$RENDERED"
      return 0
    fi
    # It is ours — replace it
    rm -f "$DST"
  fi

  cp "$RENDERED" "$DST"
  rm -f "$RENDERED"
  ok "Installed: $DST"
}

# ── 6a. Claude adapter ───────────────────────────────────────────────────────
install_claude() {
  local CLAUDE_COMMANDS="${HOME}/.claude/commands"
  local CLAUDE_AGENTS="${HOME}/.claude/agents"
  mkdir -p "$CLAUDE_COMMANDS" "$CLAUDE_AGENTS"

  info "Installing Claude Code adapter..."
  render_file "${CORE_PATH}/adapters/claude/commands/mach-init.md"   "${CLAUDE_COMMANDS}/mach-init.md"
  render_file "${CORE_PATH}/adapters/claude/commands/mach-fact.md"   "${CLAUDE_COMMANDS}/mach-fact.md"
  render_file "${CORE_PATH}/adapters/claude/commands/mach-person.md" "${CLAUDE_COMMANDS}/mach-person.md"
  render_file "${CORE_PATH}/adapters/claude/commands/mach-advice.md" "${CLAUDE_COMMANDS}/mach-advice.md"
  render_file "${CORE_PATH}/adapters/claude/commands/mach-daily.md"  "${CLAUDE_COMMANDS}/mach-daily.md"
  render_file "${CORE_PATH}/adapters/claude/agents/machiavelli-advisor.md" "${CLAUDE_AGENTS}/machiavelli-advisor.md"
  ok "Claude adapter installed to ${CLAUDE_COMMANDS}/ and ${CLAUDE_AGENTS}/"
}

# ── 6b. Codex adapter ────────────────────────────────────────────────────────
install_codex() {
  # Codex does not have a universally standardized config location.
  # We install rendered files to ~/.config/machiavelli/adapters/codex/
  # and print instructions for wiring them into Codex.
  local CODEX_DST="${HOME}/.config/machiavelli/adapters/codex"
  local CODEX_CMD_DST="${CODEX_DST}/commands"
  mkdir -p "$CODEX_DST" "$CODEX_CMD_DST"

  info "Installing Codex adapter..."
  render_file "${CORE_PATH}/adapters/codex/machiavelli.md"               "${CODEX_DST}/machiavelli.md"
  render_file "${CORE_PATH}/adapters/codex/commands/mach-init.md"        "${CODEX_CMD_DST}/mach-init.md"
  render_file "${CORE_PATH}/adapters/codex/commands/mach-person.md"      "${CODEX_CMD_DST}/mach-person.md"
  render_file "${CORE_PATH}/adapters/codex/commands/mach-fact.md"        "${CODEX_CMD_DST}/mach-fact.md"
  render_file "${CORE_PATH}/adapters/codex/commands/mach-advice.md"      "${CODEX_CMD_DST}/mach-advice.md"
  render_file "${CORE_PATH}/adapters/codex/commands/mach-daily.md"       "${CODEX_CMD_DST}/mach-daily.md"
  render_file "${CORE_PATH}/adapters/codex/commands/mach-profile.md"     "${CODEX_CMD_DST}/mach-profile.md"

  ok "Codex adapter installed to ${CODEX_DST}/"
  echo ""
  echo "  ┌─── Codex wiring instructions ───────────────────────────────────────┐"
  echo "  │ Add the system prompt to your Codex agent configuration:            │"
  echo "  │   File: ${CODEX_DST}/machiavelli.md"
  echo "  │                                                                      │"
  echo "  │ Per-command files are in:                                            │"
  echo "  │   ${CODEX_CMD_DST}/"
  echo "  │                                                                      │"
  echo "  │ If Codex supports a project-level instructions file, copy or symlink │"
  echo "  │ machiavelli.md into your project root or Codex config directory.     │"
  echo "  │                                                                      │"
  echo "  │ No MACH_LLM_KEY? Use the --dry pattern:                             │"
  echo "  │   node ${CORE_PATH}/core/machiavelli.cjs advice \"<query>\" --dry --json"
  echo "  │   → pass data.prompt to Codex inference                             │"
  echo "  └──────────────────────────────────────────────────────────────────────┘"
  echo ""
}

# ── 6c. OpenCode adapter ──────────────────────────────────────────────────────
install_opencode() {
  # OpenCode does not have a universally standardized config location.
  # We install rendered files to ~/.config/machiavelli/adapters/opencode/
  # and print instructions for wiring them into OpenCode.
  local OC_DST="${HOME}/.config/machiavelli/adapters/opencode"
  local OC_CMD_DST="${OC_DST}/commands"
  mkdir -p "$OC_DST" "$OC_CMD_DST"

  info "Installing OpenCode adapter..."
  render_file "${CORE_PATH}/adapters/opencode/machiavelli.md"               "${OC_DST}/machiavelli.md"
  render_file "${CORE_PATH}/adapters/opencode/commands/mach-init.md"        "${OC_CMD_DST}/mach-init.md"
  render_file "${CORE_PATH}/adapters/opencode/commands/mach-person.md"      "${OC_CMD_DST}/mach-person.md"
  render_file "${CORE_PATH}/adapters/opencode/commands/mach-fact.md"        "${OC_CMD_DST}/mach-fact.md"
  render_file "${CORE_PATH}/adapters/opencode/commands/mach-advice.md"      "${OC_CMD_DST}/mach-advice.md"
  render_file "${CORE_PATH}/adapters/opencode/commands/mach-daily.md"       "${OC_CMD_DST}/mach-daily.md"
  render_file "${CORE_PATH}/adapters/opencode/commands/mach-profile.md"     "${OC_CMD_DST}/mach-profile.md"

  ok "OpenCode adapter installed to ${OC_DST}/"
  echo ""
  echo "  ┌─── OpenCode wiring instructions ────────────────────────────────────┐"
  echo "  │ Add the system prompt to your OpenCode agent or project config:     │"
  echo "  │   File: ${OC_DST}/machiavelli.md"
  echo "  │                                                                      │"
  echo "  │ Per-command files are in:                                            │"
  echo "  │   ${OC_CMD_DST}/"
  echo "  │                                                                      │"
  echo "  │ OpenCode project-level config: place machiavelli.md in your         │"
  echo "  │ .opencode/ directory or add its path to your OpenCode config.       │"
  echo "  │                                                                      │"
  echo "  │ No MACH_LLM_KEY? Use the --dry pattern:                             │"
  echo "  │   node ${CORE_PATH}/core/machiavelli.cjs advice \"<query>\" --dry --json"
  echo "  │   → pass data.prompt to OpenCode inference                          │"
  echo "  └──────────────────────────────────────────────────────────────────────┘"
  echo ""
}

# ── 7. Dispatch per --host ───────────────────────────────────────────────────
case "$HOST" in
  claude)
    install_claude
    ;;
  codex)
    install_codex
    ;;
  opencode)
    install_opencode
    ;;
  all)
    install_claude
    install_codex
    install_opencode
    ;;
esac

# ── 8. Write config.json ─────────────────────────────────────────────────────
CONFIG_DIR="${HOME}/.config/machiavelli"
CONFIG_FILE="${CONFIG_DIR}/config.json"
mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_FILE" <<CONFIG
{
  "corePath": "${CORE_PATH}",
  "version": "0.1.0",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hosts": ["${HOST}"]
}
CONFIG
ok "Config written: $CONFIG_FILE"

# ── 9. ENV key checks (non-fatal) ────────────────────────────────────────────
echo ""
info "Checking environment variables..."

if [ -z "${MACH_LLM_KEY:-}" ]; then
  warn "MACH_LLM_KEY is not set."
  echo "  Set your LLM API key for advice and profile generation:"
  echo "    export MACH_LLM_KEY=sk-..."
  echo "  For Anthropic (default), set MACH_LLM_KEY to your Anthropic API key."
  echo "  For OpenAI-compatible (local/OpenRouter/Z.AI), also set:"
  echo "    export MACH_LLM_URL=http://localhost:11434/v1"
  echo "    export MACH_LLM_MODEL=<model-name>"
  echo ""
  echo "  No key? Use --dry mode to get the compiled prompt and pass it to your own LLM:"
  echo "    node ${CORE_PATH}/core/machiavelli.cjs advice \"<query>\" --dry --json"
else
  ok "MACH_LLM_KEY is set"
fi

if [ -z "${MACH_KEY:-}" ]; then
  warn "MACH_KEY is not set (optional — keyring will be used or key generated on first init)."
fi

# ── 10. Final status check ────────────────────────────────────────────────────
echo ""
info "Running core status check..."
STATUS_OUT=$(node "${CORE_PATH}/core/machiavelli.cjs" status --json 2>&1) || true
echo "$STATUS_OUT"

echo ""
ok "Machiavelli install complete (host: ${HOST})."
echo ""
echo "  Quick start (Claude):"
echo "    /mach-init                    — initialize your ego-center"
echo "    /mach-person <name>           — add a person to the ontology"
echo "    /mach-fact <code> <fact>      — record an immutable fact"
echo "    /mach-advice <question>       — get strategic advice"
echo "    /mach-daily                   — daily digest"
echo ""
echo "  Quick start (Codex / OpenCode):"
echo "    node ${CORE_PATH}/core/machiavelli.cjs init \"<name>\" --json"
echo "    node ${CORE_PATH}/core/machiavelli.cjs person \"<name>\" --json"
echo "    node ${CORE_PATH}/core/machiavelli.cjs fact <code> \"<fact>\" --json"
echo "    node ${CORE_PATH}/core/machiavelli.cjs advice \"<query>\" --dry --json"
echo "      → pipe data.prompt to your host's inference, then ingest the profile result."
echo ""
echo "  Privacy reminder:"
echo "    Facts are sent to your LLM provider (MACH_LLM_KEY target)."
echo "    For local privacy: set MACH_LLM_URL=http://localhost:11434/v1"
echo "    Data is stored encrypted in: ${CORE_PATH}/data/"
echo ""
