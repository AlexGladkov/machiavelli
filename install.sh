#!/usr/bin/env bash
# install.sh — Machiavelli adapter installer
# Supports --host claude|codex|opencode|all (default: claude for backwards compatibility).
# Supports --uninstall to remove a previously wired host adapter.
# Idempotent: safe to run multiple times.
# Usage: bash install.sh [--host claude|codex|opencode|all] [--uninstall]
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()  { echo -e "${CYAN}[mach]${RESET} $*"; }
ok()    { echo -e "${GREEN}[ok]${RESET}   $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET} $*"; }
fail()  { echo -e "${RED}[fail]${RESET} $*" >&2; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
HOST="claude"  # default: backwards compatible
UNINSTALL=0
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
    --uninstall)
      UNINSTALL=1
      ;;
    --help|-h)
      echo "Usage: bash install.sh [--host claude|codex|opencode|all] [--uninstall]"
      echo ""
      echo "  --host claude     Install Claude Code adapter (default)"
      echo "  --host codex      Install Codex adapter (auto-wires AGENTS.md + hooks.json)"
      echo "  --host opencode   Install OpenCode adapter"
      echo "  --host all        Install all adapters"
      echo "  --uninstall       Remove the wired adapter (codex: removes markers + hook)"
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

# ── 2. Resolve CORE_PATH (bootstrap if piped: curl … | bash) ─────────────────
CORE_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
if [[ ! -f "${CORE_PATH}/core/machiavelli.cjs" ]]; then
  # Run via `curl … | bash` — no repo on disk. Clone it ourselves.
  REPO_URL="${MACH_REPO:-https://github.com/AlexGladkov/machiavelli.git}"
  TARGET="${MACH_HOME:-$HOME/.machiavelli}"
  command -v git >/dev/null 2>&1 || fail "git is required to bootstrap the install"
  if [[ -d "${TARGET}/.git" ]]; then
    info "Updating existing checkout at ${TARGET}"
    git -C "${TARGET}" pull --ff-only --quiet || warn "git pull failed; using existing checkout"
  else
    info "Cloning ${REPO_URL} → ${TARGET}"
    git clone --depth 1 --quiet "${REPO_URL}" "${TARGET}" || fail "git clone failed"
  fi
  CORE_PATH="${TARGET}"
fi
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

# Resolve the CLI binary to use inside Codex instructions.
# Prefer a brew-installed `machiavelli` binary; otherwise fall back to node invocation.
_codex_cli_invocation() {
  if command -v machiavelli &>/dev/null; then
    echo "machiavelli"
  else
    echo "node \"${CORE_PATH}/core/machiavelli.cjs\""
  fi
}

# Python3-based idempotent marker-block writer for AGENTS.md.
# Usage: _agents_md_upsert <agents_file> <section_content_file>
_agents_md_upsert() {
  local AGENTS_FILE="$1"
  local SECTION_FILE="$2"
  python3 - "$AGENTS_FILE" "$SECTION_FILE" <<'PYEOF'
import sys, os, pathlib

agents_path = pathlib.Path(sys.argv[1])
section_path = pathlib.Path(sys.argv[2])

START = "<!-- machiavelli:start -->"
END   = "<!-- machiavelli:end -->"

section_content = section_path.read_text()
new_block = f"{START}\n{section_content}\n{END}"

if agents_path.exists():
    original = agents_path.read_text()
else:
    original = ""

if START in original and END in original:
    # Replace existing block between markers (idempotent update)
    pre  = original[:original.index(START)]
    post = original[original.index(END) + len(END):]
    updated = pre + new_block + post
else:
    # Append block with a blank-line separator
    sep = "\n\n" if original and not original.endswith("\n\n") else ("\n" if original else "")
    updated = original + sep + new_block + "\n"

agents_path.write_text(updated)
print(f"[ok] AGENTS.md upserted: {agents_path}")
PYEOF
}

# Python3-based idempotent marker removal for AGENTS.md.
_agents_md_remove() {
  local AGENTS_FILE="$1"
  python3 - "$AGENTS_FILE" <<'PYEOF'
import sys, pathlib

agents_path = pathlib.Path(sys.argv[1])
START = "<!-- machiavelli:start -->"
END   = "<!-- machiavelli:end -->"

if not agents_path.exists():
    print("[ok] AGENTS.md not found — nothing to remove")
    sys.exit(0)

original = agents_path.read_text()
if START not in original:
    print("[ok] No machiavelli block in AGENTS.md — nothing to remove")
    sys.exit(0)

pre  = original[:original.index(START)].rstrip("\n")
post = original[original.index(END) + len(END):]
# Collapse any double blank lines left behind
updated = pre + ("\n" if pre else "") + post.lstrip("\n")
agents_path.write_text(updated)
print(f"[ok] machiavelli block removed from: {agents_path}")
PYEOF
}

# Python3-based idempotent hooks.json upsert for Codex.
# Adds a UserPromptSubmit hook entry if absent; no-op if already present.
_codex_hook_upsert() {
  local HOOKS_FILE="$1"
  local CLI="$2"
  python3 - "$HOOKS_FILE" "$CLI" <<'PYEOF'
import sys, json, pathlib

hooks_path = pathlib.Path(sys.argv[1])
cli_cmd    = sys.argv[2]

HOOK_CMD = f"{cli_cmd} status --json 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin).get('data',{{}}); print('[machiavelli] facts=' + str(d.get('factCount',0)) + ' people=' + str(d.get('personCount',0))) if d.get('egoInitialized') else None\" 2>/dev/null || true"

HOOK_ENTRY = {
    "type": "command",
    "command": HOOK_CMD
}

if hooks_path.exists():
    try:
        data = json.loads(hooks_path.read_text())
    except Exception:
        data = {}
else:
    data = {}

hooks = data.get("UserPromptSubmit", [])

# Idempotency: skip if a machiavelli hook entry already present
for entry in hooks:
    if isinstance(entry, dict) and "machiavelli" in entry.get("command", ""):
        print("[ok] hooks.json: machiavelli UserPromptSubmit hook already present")
        sys.exit(0)

hooks.append(HOOK_ENTRY)
data["UserPromptSubmit"] = hooks

hooks_path.parent.mkdir(parents=True, exist_ok=True)
hooks_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"[ok] hooks.json upserted: {hooks_path}")
PYEOF
}

# Python3-based hook removal for Codex uninstall.
_codex_hook_remove() {
  local HOOKS_FILE="$1"
  python3 - "$HOOKS_FILE" <<'PYEOF'
import sys, json, pathlib

hooks_path = pathlib.Path(sys.argv[1])
if not hooks_path.exists():
    print("[ok] hooks.json not found — nothing to remove")
    sys.exit(0)

try:
    data = json.loads(hooks_path.read_text())
except Exception:
    print("[ok] hooks.json unreadable — nothing to remove")
    sys.exit(0)

hooks = data.get("UserPromptSubmit", [])
filtered = [e for e in hooks if not (isinstance(e, dict) and "machiavelli" in e.get("command", ""))]

if len(filtered) == len(hooks):
    print("[ok] No machiavelli hook in hooks.json — nothing to remove")
    sys.exit(0)

data["UserPromptSubmit"] = filtered
if not filtered:
    data.pop("UserPromptSubmit", None)
hooks_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"[ok] machiavelli hook removed from: {hooks_path}")
PYEOF
}

uninstall_codex() {
  local CODEX_HOME="${HOME}/.codex"
  local AGENTS_FILE="${CODEX_HOME}/AGENTS.md"
  local HOOKS_FILE="${CODEX_HOME}/hooks.json"
  local REF_DIR="${CODEX_HOME}/machiavelli"

  info "Uninstalling Codex adapter..."

  # Remove marker section from AGENTS.md
  _agents_md_remove "$AGENTS_FILE"

  # Remove machiavelli hook from hooks.json
  _codex_hook_remove "$HOOKS_FILE"

  # Remove reference files directory
  if [ -d "$REF_DIR" ]; then
    rm -rf "$REF_DIR"
    ok "Removed: $REF_DIR"
  fi

  ok "Codex adapter uninstalled."
}

install_codex() {
  local CODEX_HOME="${HOME}/.codex"
  local AGENTS_FILE="${CODEX_HOME}/AGENTS.md"
  local HOOKS_FILE="${CODEX_HOME}/hooks.json"
  local REF_DIR="${CODEX_HOME}/machiavelli"

  mkdir -p "$CODEX_HOME" "$REF_DIR"

  info "Installing Codex adapter (auto-wiring)..."

  # Determine CLI invocation string for codex instructions
  local CLI
  CLI="$(_codex_cli_invocation)"

  # ── 1. Write per-command reference files ─────────────────────────────────
  info "Writing reference files to ${REF_DIR}/"
  for CMD in mach-init mach-person mach-fact mach-advice mach-daily mach-profile; do
    local SRC="${CORE_PATH}/adapters/codex/commands/${CMD}.md"
    if [ -f "$SRC" ]; then
      sed "s|{{CORE_PATH}}|${CORE_PATH}|g" "$SRC" > "${REF_DIR}/${CMD}.md"
      ok "  ${REF_DIR}/${CMD}.md"
    fi
  done

  # ── 2. Build AGENTS.md section content ───────────────────────────────────
  local SECTION_FILE
  SECTION_FILE="$(mktemp /tmp/mach-codex-section.XXXXXX.md)"

  cat > "$SECTION_FILE" <<SECTION
## Machiavelli — Corporate Advisor CLI

You have access to the **Machiavelli** CLI — a portable corporate ontology and strategic advisor.
Apply the following rules in every session where the user interacts with their corporate context.

### CLI invocation

```bash
${CLI} <cmd> [args] --json
```

Node.js >= 20 required. Always pass \`--json\` when calling from an agent.

### Envelope contract

Every command returns one JSON object on stdout:
\`\`\`json
{ "ok": true|false, "cmd": "<cmd>", "data": {...}, "error": null|{"code":"...","message":"..."}, "meta": {...} }
\`\`\`
- \`ok: true\` → success; consume \`data\`.
- \`ok: false\` → failure; consume \`error.code\` + \`error.message\`.
- Exit codes: 0=success, 1=internal, 2=bad args, 3=environment error.
- Parse stdout as JSON only. Stderr is human diagnostics — never parse it.

### Guard verdicts (advice/daily only)

- \`pass\` — clean; render \`data.text\`.
- \`rewrite\` — auto-cleaned; render \`data.text\`.
- \`block\` — blocked; \`ok: false\`, \`error.code="GUARD_BLOCK"\`. Show reason only.
- \`GUARD_UNAVAILABLE\` — LLM not configured; tell user to set \`MACH_LLM_KEY\`.

### Facts ≠ interpretations (hard invariant)

| Source | Label | Mutable? |
|--------|-------|----------|
| User facts (\`facts\` table) | "Факт:" | No — immutable |
| LLM profiles (lenses) | "Интерпретация (lens):" | Yes — regenerable |
| Pending graph edges | "Подсказка (не подтверждено):" | Yes — pending until confirmed |

Never present a LLM interpretation as a user fact. Never surface blocked content.

### --dry → ingest portability pattern

If \`MACH_LLM_KEY\` is not set, use Codex's own inference:

1. Get the compiled prompt:
   \`\`\`bash
   ${CLI} advice "<query>" --dry --json
   # or: ${CLI} profile <personRef> --dry --json
   \`\`\`
   \`data.prompt\` contains the full prompt. No LLM called. No consent gate.

2. Pass \`data.prompt\` to Codex's built-in model. Receive generated text.

3. Ingest profile results (profile commands only):
   \`\`\`bash
   echo "<generated-text>" | ${CLI} ingest profile <personRef> --lens <lens> --stdin --json
   \`\`\`
   Advice results are ephemeral — present raw Codex output directly to the user.

### Per-command reference

See \`${REF_DIR}/\` for per-command files.

| Command | Usage |
|---------|-------|
| init | \`${CLI} init "<name>" --json\` |
| person | \`${CLI} person "<description>" --json\` |
| fact | \`${CLI} fact <ref> "<fact>" --json\` |
| profile | \`${CLI} profile <ref> --json [--dry --lens disc,leverage,bigfive]\` |
| advice | \`${CLI} advice "<query>" --json [--dry --consent]\` |
| daily | \`${CLI} daily --json [--dry --consent]\` |
| graph | \`${CLI} graph --json [--person <ref>]\` |
| relation | \`${CLI} relation confirm <edge_id> --json\` |
| status | \`${CLI} status --json\` |
| ingest | \`${CLI} ingest profile <ref> --lens <lens> --body "<text>" --json\` |

### Privacy note

Facts are sent to the LLM provider configured via \`MACH_LLM_KEY\`.
For local privacy: \`MACH_LLM_URL=http://localhost:11434/v1 MACH_LLM_MODEL=<model>\`.
Never log or expose raw fact bodies, encryption keys, or database paths in output.

### Ethical invariants (never violate)

1. No advice involving direct harm, deception of third parties, or setups (подстава).
2. Guard verdict is final — never surface blocked content.
3. Pending relations are not facts until \`relation confirm\` is called.
4. Interpretations are labeled and never presented as user-recorded facts.
5. If \`--dry\` mode is active, label all output clearly as a simulation.
SECTION

  # ── 3. Upsert marker block in ~/.codex/AGENTS.md ─────────────────────────
  info "Wiring AGENTS.md at ${AGENTS_FILE}..."
  _agents_md_upsert "$AGENTS_FILE" "$SECTION_FILE"
  rm -f "$SECTION_FILE"

  # ── 4. Upsert UserPromptSubmit hook in ~/.codex/hooks.json ───────────────
  info "Wiring hooks.json at ${HOOKS_FILE}..."
  _codex_hook_upsert "$HOOKS_FILE" "$CLI"

  # ── 5. Reminder about codex_hooks feature flag ────────────────────────────
  ok "Codex adapter wired."
  echo ""
  echo "  ┌─── Codex auto-wiring complete ──────────────────────────────────────┐"
  echo "  │ AGENTS.md  : ${AGENTS_FILE}"
  echo "  │ hooks.json : ${HOOKS_FILE}"
  echo "  │ Commands   : ${REF_DIR}/"
  echo "  │                                                                      │"
  echo "  │ If hooks do not fire, enable them in ~/.codex/config.toml:          │"
  echo "  │   [features]                                                         │"
  echo "  │   codex_hooks = true                                                 │"
  echo "  │                                                                      │"
  echo "  │ To uninstall: bash install.sh --host codex --uninstall              │"
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
if [ "$UNINSTALL" -eq 1 ]; then
  case "$HOST" in
    codex)
      uninstall_codex
      ;;
    *)
      fail "--uninstall is currently only supported for --host codex"
      ;;
  esac
  exit 0
fi

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
